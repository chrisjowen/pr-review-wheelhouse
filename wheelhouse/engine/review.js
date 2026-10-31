/**
 * Review sessions: one per pull request, kept per PR head so reopening a PR
 * costs nothing and a new push starts a fresh review.
 *
 * Opening a review reads the PR, sorts its files and plans the stages from
 * the files alone, then queues the walkthrough pass. When the walkthrough
 * answers, its proposed stops replace that plan (held to the real files by
 * `reconcilePlan`) and the other stages are queued behind it, one model call
 * at a time: Ollama runs one request at a time anyway, and a chat question or
 * the stage the captain is looking at goes first. A stage that fails says why
 * and can be run again; nothing is ever posted or sent from here except by
 * `post`, which only the captain's click reaches.
 *
 * @typedef {import('./model.js').Model} Model
 */

import { kindOf, patternMatcher } from './classify.js';
import { excerpt, parseDiff } from './diff.js';
import {
	changeMessages,
	chatMessages,
	parseJson,
	qualityMessages,
	readChange,
	readPrompts,
	readQuality,
	readSkim,
	readWalkthrough,
	skimMessages,
	walkthroughMessages
} from './prompts.js';
import { heuristicPlan, reconcilePlan, resolvePath, stagesOf } from './stages.js';
import { draftReview, VERDICTS } from '../ui/draft.js';

export class ReviewError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

export const SCHEMA = 'pr-review.v1';

/**
 * @param {{
 *   github: { load(url: string): Promise<{ pr: any; diff: string }>; post(pr: any, review: any): Promise<{ url: string }> };
 *   store: ReturnType<typeof import('./store.js').memoryStore>;
 *   model: () => Model;
 *   config?: () => { extraGenerated?: string[] };
 *   now?: () => number;
 *   log?: (line: string) => void;
 * }} deps
 */
export function createReviews({
	github,
	store,
	model,
	config = () => ({}),
	now = Date.now,
	log = () => {}
}) {
	/** @type {Map<string, any>} */
	const live = new Map();
	/** @type {{ id: string; kind: 'stage' | 'chat'; stage: string; at: number }[]} */
	const queue = [];
	/** Which stage the captain is looking at, per review, so it runs first. */
	const focus = new Map();
	let working = false;
	/** @type {AbortController | null} */
	let current = null;
	let currentJob = null;
	const idle = new Set();

	const get = (id) => {
		let r = live.get(id);
		if (!r) {
			r = store.review(id);
			if (r?.schema !== SCHEMA) r = null;
			if (r) {
				// A run that was going when the engine stopped did not finish.
				for (const [stage, run] of Object.entries(r.runs ?? {}))
					if (run.state === 'running' || run.state === 'queued')
						r.runs[stage] = {
							...run,
							state: 'failed',
							reason: 'The engine stopped before this finished.'
						};
				for (const list of Object.values(r.chat ?? {}))
					for (const m of list)
						if (m.pending)
							Object.assign(m, {
								pending: false,
								error: true,
								text: m.text || 'The engine stopped before I answered.'
							});
				live.set(id, r);
			}
		}
		if (!r) throw new ReviewError('There is no such review.', 404);
		return r;
	};
	const save = (r) => {
		r.rev = (r.rev ?? 0) + 1;
		r.updatedAt = now();
		store.saveReview(r);
	};
	const stageOf = (r, id) => {
		const s = r.stages.find((x) => x.id === id);
		if (!s) throw new ReviewError('There is no such stage.', 404);
		return s;
	};
	const filesOf = (r, paths) => paths.map((p) => r.files.find((f) => f.path === p)).filter(Boolean);
	const prompts = () => readPrompts(store.prompts());

	// ---------- the queue ----------

	function enqueue(id, kind, stage) {
		if (
			kind === 'stage' &&
			queue.some((j) => j.id === id && j.kind === 'stage' && j.stage === stage)
		)
			return;
		if (
			kind === 'stage' &&
			currentJob?.id === id &&
			currentJob.kind === 'stage' &&
			currentJob.stage === stage
		)
			return;
		queue.push({ id, kind, stage, at: now() });
		if (kind === 'stage') {
			const r = get(id);
			r.runs[stage] = { state: 'queued', tokens: 0, model: null, at: now() };
		}
		void pump();
	}

	/** Chat first; then the stage being looked at; then the walkthrough; then stages in order. */
	function pick() {
		if (!queue.length) return null;
		const rank = (j) => {
			if (j.kind === 'chat') return [0, j.at];
			if (focus.get(j.id) === j.stage) return [1, j.at];
			if (j.stage === 'walkthrough') return [2, j.at];
			const r = live.get(j.id);
			const i = r ? r.stages.findIndex((s) => s.id === j.stage) : 99;
			return [3, i];
		};
		let best = 0;
		for (let i = 1; i < queue.length; i++) {
			const [a, b] = rank(queue[i]);
			const [c, d] = rank(queue[best]);
			if (a < c || (a === c && b < d)) best = i;
		}
		return queue.splice(best, 1)[0];
	}

	async function pump() {
		if (working) return;
		working = true;
		try {
			let job;
			while ((job = pick())) {
				currentJob = job;
				current = new AbortController();
				try {
					if (job.kind === 'stage') await runStage(job.id, job.stage, current.signal);
					else await runChat(job.id, job.stage, current.signal);
				} catch (e) {
					log(`job ${job.kind} ${job.id} ${job.stage} failed: ${e?.stack || e}`);
				}
				currentJob = null;
				current = null;
			}
		} finally {
			working = false;
			for (const f of idle) f();
			idle.clear();
		}
	}

	// ---------- stages ----------

	async function runStage(id, stageId, signal) {
		const r = get(id);
		const stage = r.stages.find((s) => s.id === stageId);
		if (!stage) return;
		const m = model();
		const run = { state: 'running', tokens: 0, model: m.name, at: now() };
		r.runs[stageId] = run;
		r.rev++;
		const p = prompts();
		const files = filesOf(r, stage.files);
		let messages;
		if (stage.kind === 'walkthrough')
			messages = walkthroughMessages({
				prompts: p,
				pr: r.pr,
				files: r.files,
				images: r.pr.images
			});
		else if (stage.kind === 'quality') messages = qualityMessages({ prompts: p, pr: r.pr, files });
		else if (stage.kind === 'change')
			messages = changeMessages({
				prompts: p,
				pr: r.pr,
				stage,
				files,
				walkthrough: r.results.walkthrough
			});
		else
			messages = skimMessages({
				prompts: p,
				pr: r.pr,
				files,
				covered: r.stages.filter((s) => s.kind === 'change').flatMap((s) => s.files)
			});
		let out;
		try {
			const check = await m.check();
			if (!check.ok) throw new Error(check.reason);
			out = await m.generate({
				messages,
				json: true,
				signal,
				onToken: (_text, count) => {
					run.tokens = count;
					r.rev++;
				}
			});
		} catch (e) {
			r.runs[stageId] = { ...run, state: 'failed', reason: e.message };
			if (stage.kind === 'walkthrough' && !Object.keys(r.results).length) queueRest(r);
			save(r);
			return;
		}
		const raw = parseJson(out.text);
		const finished = {
			...run,
			state: 'done',
			tokens: out.outputTokens,
			promptTokens: out.promptTokens,
			ms: out.ms
		};
		if (!raw) {
			r.runs[stageId] = {
				...finished,
				state: 'failed',
				reason: `${m.name} didn’t answer with JSON.`
			};
			if (stage.kind === 'walkthrough' && !Object.keys(r.results).length) queueRest(r);
			save(r);
			return;
		}
		if (stage.kind === 'walkthrough') {
			const wt = readWalkthrough(raw);
			const plan = reconcilePlan(r.files, wt.stops);
			const { stops, ...said } = wt;
			void stops;
			r.results.walkthrough = { ...said, plan: plan.source };
			replan(r, plan);
			r.runs[stageId] = finished;
			queueRest(r);
		} else {
			const read =
				stage.kind === 'quality' ? readQuality : stage.kind === 'change' ? readChange : readSkim;
			r.results[stageId] = read(raw, files, resolvePath);
			r.runs[stageId] = finished;
		}
		save(r);
	}

	/** Takes a new plan; a stage whose files changed loses what was said about it. */
	function replan(r, plan) {
		const kinds = new Map(r.files.map((f) => [f.path, f.kind]));
		const next = stagesOf(plan, kinds);
		const before = new Map(r.stages.map((s) => [s.id, s.files.join('\n')]));
		for (const s of next) {
			if (s.id === 'walkthrough') continue;
			if (before.get(s.id) !== s.files.join('\n')) {
				delete r.results[s.id];
				delete r.runs[s.id];
				delete r.chat[s.id];
				r.reviewed = r.reviewed.filter((x) => x !== s.id);
			}
		}
		const ids = new Set(next.map((s) => s.id));
		for (const id of Object.keys(r.results)) if (!ids.has(id)) delete r.results[id];
		r.requests = r.requests.filter((q) => ids.has(q.stage));
		r.plan = plan;
		r.stages = next;
	}

	function queueRest(r) {
		for (const s of r.stages)
			if (s.id !== 'walkthrough' && !r.results[s.id] && r.runs[s.id]?.state !== 'running')
				enqueue(r.id, 'stage', s.id);
	}

	// ---------- chat ----------

	async function runChat(id, stageId, signal) {
		const r = get(id);
		const stage = r.stages.find((s) => s.id === stageId);
		const list = r.chat[stageId] ?? [];
		const reply = list.findLast((x) => x.role === 'assistant' && x.pending);
		if (!stage || !reply) return;
		const asked = list[list.indexOf(reply) - 1];
		const history = list
			.slice(0, list.indexOf(reply) - 1)
			.filter((x) => !x.pending && !x.error)
			.map((x) =>
				x.role === 'change'
					? {
							role: /** @type {const} */ ('user'),
							text: `I asked the author for a change: ${x.text}`
						}
					: { role: x.role === 'user' ? 'user' : 'assistant', text: x.text }
			);
		const files = filesOf(r, stage.kind === 'walkthrough' ? [] : stage.files);
		const attach = asked?.attach ?? null;
		const lines = attach
			? excerpt(
					r.files.find((f) => f.path === attach.file),
					attach.from,
					attach.to
				)
					.map((l) => `${l.t === '-' ? '-' : l.n} ${l.t} ${l.text}`)
					.join('\n')
			: '';
		const m = model();
		reply.model = m.name;
		try {
			const check = await m.check();
			if (!check.ok) throw new Error(check.reason);
			const out = await m.generate({
				messages: chatMessages({
					prompts: prompts(),
					pr: r.pr,
					stage,
					files,
					result: r.results[stageId] ?? null,
					history,
					message: asked?.text ?? '',
					attach,
					lines
				}),
				signal,
				onToken: (text) => {
					reply.text = text;
					r.rev++;
				}
			});
			reply.text = out.text.trim() || '(no answer)';
		} catch (e) {
			reply.text = `I couldn’t answer: ${e.message}`;
			reply.error = true;
		}
		reply.pending = false;
		save(r);
	}

	// ---------- the API ----------

	return {
		/** Reviews kept, newest first. */
		list() {
			return store
				.reviewIds()
				.map((id) => {
					try {
						return get(id);
					} catch {
						return null;
					}
				})
				.filter(Boolean)
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((r) => ({
					id: r.id,
					url: r.pr.url,
					repo: `${r.pr.owner}/${r.pr.repo}`,
					number: r.pr.number,
					title: r.pr.title,
					updatedAt: r.updatedAt,
					reviewed: r.reviewed.length,
					stages: r.stages.length,
					posted: r.posted ?? null
				}));
		},

		/** Opens (or reopens) the review of a pull request; a new head starts afresh. */
		async open(url) {
			const { pr, diff } = await github.load(url);
			const id = `${pr.owner}__${pr.repo}__${pr.number}`;
			let kept = null;
			try {
				kept = get(id);
			} catch {
				kept = null;
			}
			if (kept && kept.pr.headSha === pr.headSha) {
				kept.pr = { ...kept.pr, ...pr };
				if (!kept.results.walkthrough && kept.runs.walkthrough?.state !== 'running')
					enqueue(id, 'stage', 'walkthrough');
				else queueRest(kept);
				save(kept);
				return kept;
			}
			const extra = patternMatcher(config().extraGenerated ?? []);
			const files = parseDiff(diff).map((f) => {
				const kind = kindOf(f.path, { extraGenerated: extra });
				return kind === 'generated' ? { ...f, kind, hunks: [] } : { ...f, kind };
			});
			const plan = heuristicPlan(files);
			const r = {
				schema: SCHEMA,
				id,
				rev: 0,
				openedAt: now(),
				updatedAt: now(),
				pr,
				files,
				plan,
				stages: stagesOf(plan, new Map(files.map((f) => [f.path, f.kind]))),
				results: {},
				runs: {},
				chat: {},
				requests: [],
				decisions: {},
				reviewed: [],
				posted: null,
				previous: kept ? { headSha: kept.pr.headSha, at: kept.updatedAt } : null
			};
			live.set(id, r);
			save(r);
			enqueue(id, 'stage', 'walkthrough');
			return r;
		},

		view: (id) => get(id),

		/** The stage the captain is looking at; its pass runs next. */
		focus(id, stageId) {
			const r = get(id);
			stageOf(r, stageId);
			focus.set(id, stageId);
			return r;
		},

		/** Runs a stage's pass (again). */
		run(id, stageId) {
			const r = get(id);
			stageOf(r, stageId);
			if (r.runs[stageId]?.state === 'running') return r;
			enqueue(id, 'stage', stageId);
			save(r);
			return r;
		},

		ask(id, stageId, { text, attach = null }) {
			const r = get(id);
			const stage = stageOf(r, stageId);
			const said = String(text ?? '')
				.trim()
				.slice(0, 4000);
			if (!said) throw new ReviewError('Say something to ask.');
			const at = checkAttach(r, stage, attach);
			const list = (r.chat[stageId] ??= []);
			list.push({ role: 'user', text: said, attach: at, at: now() });
			list.push({ role: 'assistant', text: '', pending: true, at: now() });
			save(r);
			enqueue(id, 'chat', stageId);
			return r;
		},

		/** A change the captain asks the author for, pinned to lines when it has them. */
		request(id, stageId, { text, attach = null }) {
			const r = get(id);
			const stage = stageOf(r, stageId);
			const said = String(text ?? '')
				.trim()
				.slice(0, 4000);
			if (!said) throw new ReviewError('Say what should change.');
			const at = checkAttach(r, stage, attach);
			const file = at?.file ?? (stage.files.length === 1 ? stage.files[0] : null);
			const req = {
				id: `r${now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
				stage: stageId,
				file,
				from: at?.from ?? null,
				to: at?.to ?? null,
				text: said,
				at: now()
			};
			r.requests.push(req);
			(r.chat[stageId] ??= []).push({
				role: 'change',
				text: said,
				attach: at,
				request: req.id,
				at: now()
			});
			save(r);
			return r;
		},

		unrequest(id, requestId) {
			const r = get(id);
			r.requests = r.requests.filter((q) => q.id !== requestId);
			for (const list of Object.values(r.chat))
				for (const m of list) if (m.request === requestId) m.withdrawn = true;
			save(r);
			return r;
		},

		decide(id, findingId, decision) {
			const r = get(id);
			if (decision === 'keep' || decision === 'dismiss') r.decisions[findingId] = decision;
			else delete r.decisions[findingId];
			save(r);
			return r;
		},

		mark(id, stageId, reviewed) {
			const r = get(id);
			stageOf(r, stageId);
			r.reviewed = r.reviewed.filter((x) => x !== stageId);
			if (reviewed) r.reviewed.push(stageId);
			save(r);
			return r;
		},

		/** Forgets the review and starts it again from the PR as it is now. */
		async restart(id) {
			const r = get(id);
			for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
			if (currentJob?.id === id) current?.abort();
			live.delete(id);
			store.removeReview(id);
			return this.open(r.pr.url);
		},

		/**
		 * Posts the review to GitHub. Only the captain's click on "Post to GitHub"
		 * reaches this, with `confirm: true` and the draft they saw.
		 */
		async post(id, { event, body, comments, confirm }) {
			const r = get(id);
			if (confirm !== true) throw new ReviewError('Posting needs the captain’s confirmation.');
			if (!VERDICTS.includes(event))
				throw new ReviewError('Pick approve, comment or request changes.');
			const draft = draftReview(r, { event });
			const sent = {
				event,
				body: typeof body === 'string' && body.trim() ? body.slice(0, 60_000) : draft.body,
				comments: Array.isArray(comments)
					? comments.filter(isComment).slice(0, 100)
					: draft.comments
			};
			let done;
			try {
				done = await github.post(r.pr, sent);
			} catch (e) {
				throw new ReviewError(e.message, 502);
			}
			r.posted = { at: now(), url: done.url, event };
			save(r);
			return r;
		},

		/** Resolves once nothing is queued or running (for tests). */
		settled() {
			return working || queue.length ? new Promise((res) => idle.add(res)) : Promise.resolve();
		},

		stop() {
			queue.length = 0;
			current?.abort();
		}
	};
}

const isComment = (c) =>
	c &&
	typeof c.path === 'string' &&
	Number.isInteger(c.line) &&
	typeof c.body === 'string' &&
	(c.start_line === undefined || Number.isInteger(c.start_line));

/** An attached line range, held to the stage's files and the diff's lines. */
function checkAttach(r, stage, attach) {
	if (!attach || typeof attach !== 'object') return null;
	const file = r.files.find((f) => f.path === attach.file);
	if (!file || (stage.files.length && !stage.files.includes(file.path))) return null;
	let from = Number(attach.from);
	let to = Number(attach.to ?? attach.from);
	if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
	if (to < from) [from, to] = [to, from];
	return { file: file.path, from, to: Math.min(to, from + 200) };
}
