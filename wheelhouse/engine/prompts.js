/**
 * What the local model is told at each stage, and how its answers are read.
 *
 * Each stage is one pass: the captain's overall prompt and the stage's own
 * prompt (both editable), then only that stage's context (the PR's
 * description, commits and checks for the walkthrough; that stage's diff for
 * the others), then a fixed description of the JSON to answer with. The JSON
 * part is not editable, so a reworded prompt cannot break reading the answer.
 * Every answer is read defensively: a field of the wrong kind falls back, a
 * line range is held to the lines the diff shows, and a file the stage does
 * not hold is dropped.
 *
 * @typedef {import('./diff.js').DiffFile} DiffFile
 * @typedef {{ overall: string; walkthrough: string; quality: string; change: string; skim: string }} Prompts
 * @typedef {{ role: 'system' | 'user' | 'assistant'; content: string }} Message
 */

import { diffText, fileDiffText, lineSpan } from './diff.js';
import { manifestText } from './stages.js';

export const PROMPT_KEYS = /** @type {const} */ ([
	'overall',
	'walkthrough',
	'quality',
	'change',
	'skim'
]);

/** @type {Prompts} */
export const DEFAULT_PROMPTS = {
	overall:
		'You are reviewing a pull request with a senior engineer. Be brief and concrete. ' +
		'Lead with what matters for correctness and maintainability; skip style nits a linter would catch. ' +
		'For every change, say what it does in plain language, how complex it really is, what you would have ' +
		'done differently and why, and end with at most two questions for the reviewer. Never claim something ' +
		'is tested unless you found the test.',
	walkthrough:
		'Explain what this PR does and why, for someone who has not read the issue. Use the PR description, ' +
		'its commits, its checks and any validation evidence it reports. Group the changed source files into ' +
		'2-4 key stops of 1-3 files each, in the order a reviewer should read them (what others depend on ' +
		'first); everything else is the skim pile, and generated files stay hidden.',
	quality:
		'Read the source diff for code-quality problems only: deep nesting, long functions doing several ' +
		'jobs, duplicated logic, unclear or misleading names, dense one-liners. Rank them, and say which are ' +
		'worth changing now and which are nits.',
	change:
		'For this stop, annotate the important hunks with your reasoning: what each does, why it is shaped ' +
		'this way, and anything surprising or risky. Rate the stop simple, moderate or complex. Offer one or ' +
		'two real alternative approaches with their trade-offs, then say which you would pick.',
	skim:
		'Summarise each remaining file in one line and give it a risk level. Call out anything that changes ' +
		'behaviour and was not covered by an earlier stop.'
};

/** Prompts as stored, each falling back to its default when missing or empty. */
export function readPrompts(stored) {
	const s = stored && typeof stored === 'object' ? stored : {};
	/** @type {Record<string, string>} */
	const out = {};
	for (const k of PROMPT_KEYS) {
		const v = s[k];
		out[k] = typeof v === 'string' && v.trim() ? v.slice(0, 4000) : DEFAULT_PROMPTS[k];
	}
	return /** @type {Prompts} */ (out);
}

const BUDGET = {
	body: 6000,
	walkthroughEvidence: 2500,
	quality: 20_000,
	change: 24_000,
	skimEach: 1500,
	skim: 16_000,
	chat: 12_000
};

const JSON_RULES =
	'Answer with one JSON object only, no prose around it. Write for the reviewer in plain English. ' +
	'Inside strings you may use **bold** and `code`. Use file paths exactly as listed.';

const SHAPES = {
	walkthrough: `{
  "headline": "one sentence: what the PR does",
  "what": "2-4 sentences: what changed, in plain language",
  "why": "1-3 sentences: why it was made",
  "evidence": [{ "claim": "what was shown to work", "status": "pass | fail | untested | fixed", "detail": "how, briefly" }],
  "risks": ["short risk"],
  "stops": [{ "title": "3-6 words", "files": ["exact/path"], "why": "why read these together, and why at this point" }],
  "take": ["2-4 short paragraphs opening the review in the chat"],
  "questions": ["up to 3 short questions the reviewer might ask you next"]
}`,
	quality: `{
  "take": ["1-3 short paragraphs opening the quality pass in the chat"],
  "findings": [{ "title": "short", "level": "worth | nit", "file": "exact/path", "from": 12, "to": 30, "body": "what is wrong and why it matters", "suggestion": "the change, in one sentence" }],
  "questions": ["up to 3 short questions"]
}`,
	change: `{
  "take": ["2-3 short paragraphs opening this stop in the chat"],
  "complexity": "simple | moderate | complex",
  "rationale": "one sentence: why that rating",
  "notes": [{ "file": "exact/path", "from": 12, "to": 30, "tag": "simple | moderate | complex", "title": "short", "body": "what this hunk does and why", "concern": "optional: anything risky or surprising" }],
  "alternatives": [{ "title": "short", "pros": "what it gains", "cons": "what it costs", "verdict": "recommend | consider | later | worse" }],
  "pick": "one or two sentences: which approach you would pick",
  "questions": ["up to 3 short questions"]
}`,
	skim: `{
  "take": ["1-2 short paragraphs opening the skim pile in the chat"],
  "files": [{ "file": "exact/path", "risk": "low | medium | high", "note": "one line: what changed" }],
  "questions": ["up to 3 short questions"]
}`
};

/** What a stage's numbered lines mean, said once before a diff. */
const DIFF_KEY =
	'Diff lines are numbered by their line in the new file; "+" is added, "-" removed (numbered "-"), ' +
	'" " unchanged. Cite lines by those numbers in "from" and "to".';

/**
 * @param {{ title: string; body: string; url: string; author: string; commits: { sha: string; msg: string }[] }} pr
 */
function prHeader(pr) {
	return `Pull request: ${pr.title}\n${pr.url}\nAuthor: ${pr.author}`;
}

function checksText(checks) {
	if (!checks?.length) return 'Checks: none reported.';
	return `Checks:\n${checks.map((c) => `- ${c.name}: ${c.state}`).join('\n')}`;
}

/**
 * The walkthrough pass: the PR's description, commits, checks and screenshots,
 * and the changed files as a manifest (not the diff: a 7B model groups files
 * far better from names and sizes than from thousands of diff lines).
 *
 * @returns {Message[]}
 */
export function walkthroughMessages({ prompts, pr, files, images = [] }) {
	const body = (pr.body || '(no description)').slice(0, BUDGET.body);
	const commits = pr.commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.msg}`).join('\n');
	const shots = images.length
		? `\nThe description links ${images.length} screenshot${images.length === 1 ? '' : 's'} (shown to the reviewer; you cannot see them): ${images.map((i) => i.alt || 'untitled').join('; ')}`
		: '';
	return [
		{ role: 'system', content: `${prompts.overall}\n\n${JSON_RULES}` },
		{
			role: 'user',
			content: [
				prompts.walkthrough,
				'',
				prHeader(pr),
				'',
				`Description:\n${body}${shots}`,
				'',
				`Commits:\n${commits || '(none)'}`,
				'',
				checksText(pr.checks),
				'',
				`Changed files (path, kind, lines added and removed):\n${manifestText(files)}`,
				'',
				'Pick stops only from the source files above. Never put a generated file in a stop. ' +
					'Put the files that hold the main logic first.',
				'',
				`Answer with this JSON shape:\n${SHAPES.walkthrough}`
			].join('\n')
		}
	];
}

/** @returns {Message[]} */
export function qualityMessages({ prompts, pr, files }) {
	return [
		{ role: 'system', content: `${prompts.overall}\n\n${JSON_RULES}` },
		{
			role: 'user',
			content: [
				prompts.quality,
				'',
				prHeader(pr),
				'',
				DIFF_KEY,
				'',
				diffText(files, BUDGET.quality),
				'',
				'Report at most 6 findings, the most important first. Only report problems you can point to in ' +
					'the lines above; it is fine to report none.',
				'',
				`Answer with this JSON shape:\n${SHAPES.quality}`
			].join('\n')
		}
	];
}

/** @returns {Message[]} */
export function changeMessages({ prompts, pr, stage, files, walkthrough }) {
	const context = walkthrough?.headline ? `The PR, in one line: ${walkthrough.headline}\n` : '';
	return [
		{ role: 'system', content: `${prompts.overall}\n\n${JSON_RULES}` },
		{
			role: 'user',
			content: [
				prompts.change,
				'',
				prHeader(pr),
				context,
				`This stop: ${stage.title}${stage.why ? ` (${stage.why})` : ''}`,
				`Its files: ${stage.files.join(', ')}`,
				'',
				DIFF_KEY,
				'',
				diffText(files, BUDGET.change),
				'',
				'Write 2-6 notes on the hunks that matter most, in reading order. Skip imports, constants and ' +
					'boilerplate; spend the notes on logic. Leave "concern" empty when there is none.',
				'',
				`Answer with this JSON shape:\n${SHAPES.change}`
			].join('\n')
		}
	];
}

/** @returns {Message[]} */
export function skimMessages({ prompts, pr, files, covered = [] }) {
	const each = Math.max(
		400,
		Math.min(BUDGET.skimEach, Math.floor(BUDGET.skim / Math.max(1, files.length)))
	);
	return [
		{ role: 'system', content: `${prompts.overall}\n\n${JSON_RULES}` },
		{
			role: 'user',
			content: [
				prompts.skim,
				'',
				prHeader(pr),
				covered.length ? `Already read closely in earlier stops: ${covered.join(', ')}` : '',
				'',
				DIFF_KEY,
				'',
				files.map((f) => fileDiffText(f, each)).join('\n\n'),
				'',
				'Give every file above exactly one entry.',
				'',
				`Answer with this JSON shape:\n${SHAPES.skim}`
			].join('\n')
		}
	];
}

/**
 * A chat turn beside one stage: what the stage said, its diff, the lines the
 * reviewer attached, then the conversation so far.
 *
 * @param {{ prompts: Prompts; pr: any; stage: any; files: DiffFile[]; result: any; history: { role: 'user' | 'assistant'; text: string }[]; message: string; attach?: { file: string; from: number; to: number } | null; lines?: string }} o
 * @returns {Message[]}
 */
export function chatMessages({
	prompts,
	pr,
	stage,
	files,
	result,
	history,
	message,
	attach,
	lines
}) {
	const stagePrompt = prompts[stage.kind === 'change' ? 'change' : stage.kind] ?? '';
	const said = result ? summaryOf(stage.kind, result) : '';
	const context = [
		prHeader(pr),
		stage.kind === 'walkthrough' ? `Description:\n${(pr.body || '').slice(0, BUDGET.body)}` : '',
		`You are discussing this stage of the review: ${stage.title}.`,
		said ? `What you said about it:\n${said}` : '',
		files.length ? `${DIFF_KEY}\n\n${diffText(files, BUDGET.chat)}` : ''
	]
		.filter(Boolean)
		.join('\n\n');
	const ask = attach
		? `About ${attach.file}:${attach.from}${attach.to !== attach.from ? `-${attach.to}` : ''}:\n${lines ?? ''}\n\n${message}`
		: message;
	return [
		{
			role: 'system',
			content:
				`${prompts.overall}\n\nThis stage's brief: ${stagePrompt}\n\n` +
				'You are the chat beside the code. Answer the reviewer in short plain prose (under 150 words ' +
				'unless asked for more); you may use **bold** and `code`. If you are not sure, say so.'
		},
		{ role: 'user', content: context },
		{ role: 'assistant', content: 'Understood. Ask me about it.' },
		...history.slice(-8).map((m) => ({ role: m.role, content: m.text })),
		{ role: 'user', content: ask }
	];
}

/** A stage's answer, shortened to what the chat needs to remember. */
export function summaryOf(kind, r) {
	const take = (r.take ?? []).join(' ');
	if (kind === 'walkthrough') return [r.headline, r.what, r.why, take].filter(Boolean).join(' ');
	if (kind === 'quality')
		return [
			take,
			...(r.findings ?? []).map(
				(f) => `- ${f.title} (${f.level}, ${f.file}:${f.from ?? '?'}): ${f.suggestion}`
			)
		].join('\n');
	if (kind === 'change')
		return [
			take,
			`Complexity: ${r.complexity}. ${r.rationale}`,
			...(r.notes ?? []).map(
				(n) =>
					`- ${n.file}:${n.from ?? '?'} ${n.title}${n.concern ? ` (concern: ${n.concern})` : ''}`
			),
			r.pick ? `Pick: ${r.pick}` : ''
		].join('\n');
	return [take, ...(r.files ?? []).map((f) => `- ${f.file} (${f.risk}): ${f.note}`)].join('\n');
}

// ---------- reading answers ----------

/** The JSON object in a model's answer, or null. */
export function parseJson(text) {
	const s = String(text ?? '').trim();
	try {
		const v = JSON.parse(s);
		return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
	} catch {
		const a = s.indexOf('{');
		const b = s.lastIndexOf('}');
		if (a < 0 || b <= a) return null;
		try {
			const v = JSON.parse(s.slice(a, b + 1));
			return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
		} catch {
			return null;
		}
	}
}

const str = (v, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
/** Optional text, where a model's "None" or "N/A" means nothing to say. */
const said = (v, max) => {
	const s = str(v, max);
	return /^(none|n\/?a|no concerns?|nothing|-)\.?$/i.test(s) ? '' : s;
};
const strs = (v, n, max = 600) =>
	(Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
		.map((x) => str(x, max))
		.filter(Boolean)
		.slice(0, n);
const oneOf = (v, options, fallback) => {
	const s = str(v, 40).toLowerCase();
	return options.find((o) => s === o || s.startsWith(o)) ?? fallback;
};
const objs = (v, n) =>
	Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, n) : [];

/**
 * A cited file and line range, held to the stage's files and the lines their
 * diff shows: an unknown file drops the item, a range outside the diff is
 * dropped to the file alone, and a reversed range is put the right way round.
 */
export function anchor(item, files, resolve) {
	const path = resolve(str(item.file ?? item.path, 300));
	if (!path) return null;
	const file = files.find((f) => f.path === path);
	const span = lineSpan(file);
	let from = Number.parseInt(item.from ?? item.line, 10);
	let to = Number.parseInt(item.to ?? item.from ?? item.line, 10);
	if (!Number.isFinite(from)) return { file: path, from: null, to: null };
	if (!Number.isFinite(to)) to = from;
	if (to < from) [from, to] = [to, from];
	if (!span || to < span.from || from > span.to) return { file: path, from: null, to: null };
	const lo = Math.max(from, span.from);
	return { file: path, from: lo, to: Math.min(to, span.to, lo + 80) };
}

const pathResolver = (files, resolvePath) => (said) =>
	resolvePath(
		said,
		files.map((f) => f.path)
	);

/** @param {any} raw */
export function readWalkthrough(raw) {
	const r = raw ?? {};
	return {
		headline: str(r.headline, 300),
		what: str(r.what, 1200),
		why: str(r.why, 900),
		evidence: objs(r.evidence, 10)
			.map((e) => ({
				claim: str(e.claim, 300),
				status: oneOf(e.status, ['pass', 'fail', 'untested', 'fixed'], 'untested'),
				detail: str(e.detail, 300)
			}))
			.filter((e) => e.claim),
		risks: strs(r.risks, 5, 300),
		stops: Array.isArray(r.stops) ? r.stops : [],
		take: strs(r.take, 4, 900),
		questions: strs(r.questions, 3, 300)
	};
}

export function readQuality(raw, files, resolvePath) {
	const r = raw ?? {};
	const resolve = pathResolver(files, resolvePath);
	const findings = [];
	for (const f of objs(r.findings, 8)) {
		const at = anchor(f, files, resolve);
		const title = str(f.title, 200);
		if (!at || !title) continue;
		findings.push({
			id: `q${findings.length + 1}`,
			title,
			level: oneOf(f.level, ['worth', 'nit'], 'nit'),
			...at,
			body: str(f.body, 900),
			suggestion: str(f.suggestion, 400)
		});
	}
	findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'worth' ? -1 : 1));
	return { take: strs(r.take, 3, 900), findings, questions: strs(r.questions, 3, 300) };
}

export function readChange(raw, files, resolvePath) {
	const r = raw ?? {};
	const resolve = pathResolver(files, resolvePath);
	const notes = [];
	for (const n of objs(r.notes, 10)) {
		const at = anchor(n, files, resolve);
		const title = str(n.title, 200);
		if (!at || !title) continue;
		notes.push({
			id: `n${notes.length + 1}`,
			...at,
			tag: oneOf(n.tag, ['simple', 'moderate', 'complex'], 'simple'),
			title,
			body: str(n.body, 1200),
			concern: said(n.concern, 600)
		});
	}
	return {
		take: strs(r.take, 3, 900),
		complexity: oneOf(r.complexity, ['simple', 'moderate', 'complex'], 'moderate'),
		rationale: str(r.rationale, 400),
		notes,
		alternatives: objs(r.alternatives, 3)
			.map((a) => ({
				title: str(a.title, 200),
				pros: str(a.pros, 400),
				cons: str(a.cons, 400),
				verdict: oneOf(a.verdict, ['recommend', 'consider', 'later', 'worse'], 'consider')
			}))
			.filter((a) => a.title),
		pick: str(r.pick, 600),
		questions: strs(r.questions, 3, 300)
	};
}

export function readSkim(raw, files, resolvePath) {
	const r = raw ?? {};
	const resolve = pathResolver(files, resolvePath);
	const seen = new Map();
	for (const f of objs(r.files, 200)) {
		const path = resolve(str(f.file ?? f.path, 300));
		if (!path || seen.has(path)) continue;
		seen.set(path, {
			file: path,
			risk: oneOf(f.risk, ['low', 'medium', 'high'], 'low'),
			note: str(f.note, 400)
		});
	}
	// Every file in the pile gets a row, said or not.
	const rows = files.map(
		(f) => seen.get(f.path) ?? { file: f.path, risk: 'low', note: '', unsaid: true }
	);
	return { take: strs(r.take, 2, 900), files: rows, questions: strs(r.questions, 3, 300) };
}
