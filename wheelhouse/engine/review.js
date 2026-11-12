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
 * Each card-writing pass (the stops, the quality pass, the skim pile) writes
 * one card per change in the same call, so cards cost no extra calls. Every
 * card has its own chat thread (`chat[cardId]`) and the captain's decision
 * on it (`cardDecisions[cardId]`: accept, disagree or comment, with what to
 * remember). Reading a stage again, or a new plan for it, writes new cards
 * and so drops the old cards' threads and decisions.
 *
 * @typedef {import('./model.js').Model} Model
 */

import { kindOf } from './classify.js';
import { diagramsOf } from './diagram.js';
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
import { cardsOf, DECISIONS, findCard, REMEMBER_SCOPES } from '../ui/cards.js';
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
 *   now?: () => number;
 *   log?: (line: string) => void;
 * }} deps
 */
export function createReviews({ github, store, model, now = Date.now, log = () => {} }) {
	/** @type {Map<string, any>} */
	const live = new Map();
	/** Each job holds the review it was queued for, so a replaced review's jobs never touch the new one. */
	/** A chat job's `thread` is the stage's own id or one of its cards' ids. */
	/** @type {{ id: string; r: any; kind: 'stage' | 'chat'; stage: string; thread: string; at: number }[]} */
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
				r.cardDecisions ??= {};
				// A review kept from before diagrams draws them from its diff, as a new one does.
				r.diagrams ??= diagramsOf(r);
				live.set(id, r);
			}
		}
		if (!r) throw new ReviewError('There is no such review.', 404);
		return r;
	};
	/** A review replaced by a restart or a new head is never written again. */
	const isLive = (r) => live.get(r.id) === r;
	const save = (r) => {
		if (!isLive(r)) return;
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

	function enqueue(id, kind, stage, thread = stage) {
		const r = get(id);
		const same = (j) => j?.r === r && j.kind === 'stage' && j.stage === stage;
		if (kind === 'stage' && (queue.some(same) || same(currentJob))) return;
		queue.push({ id, r, kind, stage, thread, at: now() });
		if (kind === 'stage') r.runs[stage] = { state: 'queued', tokens: 0, model: null, at: now() };
		void pump();
	}

	/** Chat first; then the stage being looked at; then the walkthrough; then stages in order. */
	function pick() {
		if (!queue.length) return null;
		const rank = (j) => {
			if (j.kind === 'chat') return [0, j.at];
			if (focus.get(j.id) === j.stage) return [1, j.at];
			if (j.stage === 'walkthrough') return [2, j.at];
			return [3, j.r.stages.findIndex((s) => s.id === j.stage)];
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
					if (job.kind === 'stage') await runStage(job.r, job.stage, current.signal);
					else await runChat(job.r, job.stage, job.thread, current.signal);
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

	async function runStage(r, stageId, signal) {
		if (!isLive(r)) return;
		const stage = r.stages.find((s) => s.id === stageId);
		if (!stage) return;
		const m = model();
		const run = { state: 'running', tokens: 0, model: m.name, at: now() };
		r.runs[stageId] = run;
		r.rev++;
		const p = prompts();
		const files = filesOf(r, stage.files);
		const asks = r.results.walkthrough?.asks ?? [];
		let messages;
		if (stage.kind === 'walkthrough')
			messages = walkthroughMessages({
				prompts: p,
				pr: r.pr,
				files: r.files,
				images: r.pr.images
			});
		else if (stage.kind === 'quality')
			messages = qualityMessages({ prompts: p, pr: r.pr, files, asks });
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
				covered: r.stages.filter((s) => s.kind === 'change').flatMap((s) => s.files),
				asks
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
			if (!isLive(r)) return;
			r.runs[stageId] = { ...run, state: 'failed', reason: e.message };
			if (stage.kind === 'walkthrough' && !Object.keys(r.results).length) queueRest(r);
			save(r);
			return;
		}
		if (!isLive(r)) return;
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
			// New cards replace the old ones, and with them their threads and decisions.
			if (r.results[stageId]) dropCards(r, stageId);
			r.results[stageId] = read(raw, files, resolvePath, { stage: stageId, asks });
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
				dropCards(r, s.id);
				r.reviewed = r.reviewed.filter((x) => x !== s.id);
			}
		}
		const ids = new Set(next.map((s) => s.id));
		for (const id of Object.keys(r.results)) if (!ids.has(id)) delete r.results[id];
		for (const id of new Set(r.stages.map((s) => s.id))) if (!ids.has(id)) dropCards(r, id);
		r.requests = r.requests.filter((q) => ids.has(q.stage));
		r.plan = plan;
		r.stages = next;
	}

	/** Forgets a stage's cards' chat threads and the captain's decisions on them. */
	function dropCards(r, stageId) {
		const mine = (k) => k.startsWith(`${stageId}:`);
		for (const k of Object.keys(r.chat)) if (mine(k)) delete r.chat[k];
		for (const k of Object.keys(r.cardDecisions ?? {})) if (mine(k)) delete r.cardDecisions[k];
	}

	/** A stage's card by id, or a 404. */
	function cardIn(r, stage, cardId) {
		const card = cardsOf(stage, r.results[stage.id]).find((c) => c.id === cardId);
		if (!card) throw new ReviewError('There is no such card.', 404);
		return card;
	}

	function queueRest(r) {
		for (const s of r.stages)
			if (s.id !== 'walkthrough' && !r.results[s.id] && r.runs[s.id]?.state !== 'running')
				enqueue(r.id, 'stage', s.id);
	}

	// ---------- chat ----------

	async function runChat(r, stageId, thread, signal) {
		if (!isLive(r)) return;
		const stage = r.stages.find((s) => s.id === stageId);
		const list = r.chat[thread] ?? [];
		const reply = list.findLast((x) => x.role === 'assistant' && x.pending);
		if (!stage || !reply) return;
		const card =
			thread === stageId
				? null
				: (cardsOf(stage, r.results[stageId]).find((c) => c.id === thread) ?? null);
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
		const files = filesOf(
			r,
			stage.kind === 'walkthrough' ? [] : card ? card.blocks.map((b) => b.file) : stage.files
		);
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
					card,
					asks: r.results.walkthrough?.asks ?? [],
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
		if (!isLive(r)) return;
		reply.pending = false;
		save(r);
	}

	/** Drops a review's queued jobs and stops the one running for it. */
	function forget(id) {
		for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === id) queue.splice(i, 1);
		if (currentJob?.id === id) current?.abort();
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
					decided: Object.keys(r.cardDecisions ?? {}).length,
					posted: r.posted ?? null
				}));
		},

		/** Opens (or reopens) the review of a pull request; a new head starts afresh. */
		async open(url) {
			const { pr, diff } = await github.load(url);
			const id = `${pr.owner}__${pr.repo}__${pr.number}`;
			let kept;
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
			if (kept) forget(id);
			const files = parseDiff(diff).map((f) => {
				const kind = kindOf(f.path);
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
				cardDecisions: {},
				reviewed: [],
				posted: null,
				diagrams: diagramsOf({ pr, files }),
				previous: kept ? { headSha: kept.pr.headSha, at: kept.updatedAt } : null
			};
			live.set(id, r);
			save(r);
			enqueue(id, 'stage', 'walkthrough');
			return r;
		},

		view: (id) => get(id),

		/**
		 * One of the review's changed files whole, at the head the review was made
		 * at, so it lines up with the review's diff. Only text files the review
		 * changes are read, so this reads nothing else from GitHub.
		 */
		async file(id, path) {
			const r = get(id);
			const f = r.files.find((x) => x.path === path);
			if (!f) throw new ReviewError('That file isn’t part of this pull request.', 404);
			if (f.binary)
				throw new ReviewError('That’s a binary file, so it can’t be read as text.', 415);
			if (!github.file) throw new ReviewError('This host can’t read whole files.', 501);
			const text = await github.file(r.pr, path);
			if (text === null)
				throw new ReviewError('That file isn’t there at the PR’s head (it was deleted).', 404);
			return { path, sha: r.pr.headSha, text };
		},

		/** The review's project as a whole: its description, topics and the start of its README. */
		async project(id) {
			const r = get(id);
			if (!github.project) throw new ReviewError('This host can’t read the project.', 501);
			return github.project(r.pr.owner, r.pr.repo);
		},

		/** Who posts: the GitHub login the host is signed in as, or null. */
		async identity() {
			return { login: github.login ? await github.login() : null };
		},

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

		/**
		 * A question in a stage's chat, or in one card's chat when `card` names
		 * one of the stage's cards; the answer arrives in `chat[stage]` or
		 * `chat[card]`.
		 */
		ask(id, stageId, { text, attach = null, card = null }) {
			const r = get(id);
			const stage = stageOf(r, stageId);
			const said = String(text ?? '')
				.trim()
				.slice(0, 4000);
			if (!said) throw new ReviewError('Say something to ask.');
			const thread = card ? cardIn(r, stage, String(card)).id : stageId;
			const at = checkAttach(r, stage, attach);
			const list = (r.chat[thread] ??= []);
			list.push({ role: 'user', text: said, attach: at, at: now() });
			list.push({ role: 'assistant', text: '', pending: true, at: now() });
			save(r);
			enqueue(id, 'chat', stageId, thread);
			return r;
		},

		/**
		 * The captain's decision on a card: `accept`, `disagree` (with an
		 * optional reason) or `comment` (with its text), and optionally who to
		 * remember a disagreement or comment for (`pr`, `me` or `repo`), kept
		 * for a later memory. `null` takes the decision back.
		 */
		decideCard(id, cardId, { decision = null, text = '', remember = null } = {}) {
			const r = get(id);
			if (!findCard(r, cardId)) throw new ReviewError('There is no such card.', 404);
			r.cardDecisions ??= {};
			if (decision === null) {
				delete r.cardDecisions[cardId];
				save(r);
				return r;
			}
			if (!DECISIONS.includes(decision)) throw new ReviewError('Pick accept, disagree or comment.');
			const said = String(text ?? '')
				.trim()
				.slice(0, 4000);
			if (decision === 'comment' && !said) throw new ReviewError('Say what to comment.');
			if (remember !== null && !REMEMBER_SCOPES.includes(remember))
				throw new ReviewError('Remember it for this PR, for you or for this repo.');
			if (remember && decision === 'accept')
				throw new ReviewError('Only a disagreement or a comment is remembered.');
			r.cardDecisions[cardId] = { decision, text: said, remember, at: now() };
			save(r);
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
			forget(id);
			live.delete(id);
			store.removeReview(id);
			return this.open(r.pr.url);
		},

		/**
		 * Posts the review to GitHub. Only the captain's click on "Post to GitHub"
		 * reaches this, with `confirm: true` and the draft they saw. With
		 * `diagrams`, the review's diagrams go up first, committed to the
		 * repository's diagram branch (`github.attach`), and the review shows
		 * them; if they can't go up, the review still posts, and says why.
		 */
		async post(id, { event, body, comments, confirm, diagrams = false }) {
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
			const pictures = [];
			let unattached = null;
			if (diagrams === true && r.diagrams?.length) {
				try {
					if (!github.attach) throw new Error('this host can’t attach files to a pull request');
					const urls = await github.attach(
						r.pr,
						r.diagrams.map((d) => ({ path: d.file, content: d.svg }))
					);
					r.diagrams.forEach((d, i) => urls[i] && pictures.push({ title: d.title, url: urls[i] }));
					const alt = (d) => d.alt.replace(/[[\]\n]/g, ' ');
					sent.body += r.diagrams
						.map((d, i) =>
							urls[i]
								? `\n\n**${d.title}** (worked out from the diff: each changed file with what it adds, changes or removes, and the imports it adds or removes)\n\n![${alt(d)}](${urls[i]})`
								: ''
						)
						.join('');
				} catch (e) {
					unattached = `The diagram couldn’t be attached: ${String(e.message).replace(/\.$/, '')}.`;
				}
			}
			let done;
			try {
				done = await github.post(r.pr, sent);
			} catch (e) {
				throw new ReviewError(e.message, 502);
			}
			// A host's GitHub may post it as something else (a comment on the captain's own PR), and say why.
			r.posted = {
				at: now(),
				url: done.url,
				event: VERDICTS.includes(done.event) ? done.event : event,
				note:
					[typeof done.note === 'string' && done.note ? done.note : null, unattached]
						.filter(Boolean)
						.join(' ') || null,
				diagrams: pictures
			};
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
