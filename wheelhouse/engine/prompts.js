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

import { diffText, excerpt, fileDiffText, lineSpan } from './diff.js';
import { manifestText } from './stages.js';
import { CARD_VERDICTS, cardsOf, isConcern, verdictOf, VERDICT_IDS } from '../ui/cards.js';

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
		'its commits, its checks and any validation evidence it reports. List what it was asked to do. ' +
		'Group the changed source files into ' +
		'2-4 key stops of 1-3 files each, in the order a reviewer should read them (what others depend on ' +
		'first); everything else is the skim pile, and generated files stay hidden.',
	quality:
		'Read the source diff for structure and naming: deep nesting, long functions doing several jobs, ' +
		'duplicated logic, unclear or misleading names, dense one-liners. Give each such change a card, the ' +
		'most important first, and a card too for structure done notably well.',
	change:
		'For this stop, give each change that matters its own card: what it does, why it is shaped this way, ' +
		'and the one verdict it earns. Rate the stop simple, moderate or complex. Offer one or two real ' +
		'alternative approaches with their trade-offs, then say which you would pick.',
	skim:
		'Summarise each remaining file in one line and give it a risk level. Give a card to anything that ' +
		'changes behaviour and was not covered by an earlier stop, and to tests or docs worth a closer look.'
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
	chat: 12_000,
	cardChat: 8000
};

/** How many cards each pass may write: enough for the changes that matter, few enough to stay cheap. */
const MAX_CARDS = { quality: 8, change: 8, skim: 6 };

const JSON_RULES =
	'Answer with one JSON object only, no prose around it. Write for the reviewer in plain English. ' +
	'Inside strings you may use **bold** and `code`. Use file paths exactly as listed.';

/** One card, as each card-writing pass answers it. */
const CARD_SHAPE = `{ "verdict": "${VERDICT_IDS.join(' | ')}", "also": "optional second verdict from the same list, or null", "severity": "low | medium | high (only with security)", "title": "the finding in one line", "why": "2-4 sentences: what the change does and why it earns this verdict", "suggestion": "for a concern: the concrete change to make; else empty", "ask": "the number of the acceptance item this checks, or null", "asked": "for ac: what was asked, quoted; else empty", "file": "exact/path", "from": 12, "to": 30, "more": [{ "file": "exact/path", "from": 40, "to": 44 }], "take": "1-2 sentences opening this card's chat, in your own voice", "questions": ["up to 2 short questions the reviewer might ask about it"] }`;

/** The verdicts and how to use them, said once before a card-writing pass's answer shape. */
const CARD_RULES = [
	'Cards: one card per change, a hunk or the few hunks that do one job together. Give each card exactly ' +
		'one main verdict from this fixed set:',
	...CARD_VERDICTS.map((v) => `- ${v.id} (${v.label}): ${v.meaning}`),
	'Ask first what a change does well, then what is wrong. lgtm or explain is the honest default; exemplary ' +
		'when it is worth copying. Raise a concern only when you can point to the lines, and give every ' +
		'concern a suggestion. Add "also" only when a second verdict truly applies too. Use ac only against ' +
		'an acceptance item listed above, and give security a severity. "more" lists other lines the same ' +
		'change spans (at most 2); leave it empty when there are none.'
].join('\n');

const SHAPES = {
	walkthrough: `{
  "headline": "one sentence: what the PR does",
  "what": "2-4 sentences: what changed, in plain language",
  "why": "1-3 sentences: why it was made",
  "evidence": [{ "claim": "what was shown to work", "status": "pass | fail | untested | fixed", "detail": "how, briefly" }],
  "risks": ["short risk"],
  "asks": ["each thing the description or its linked issue asks the PR to do, one short item each; [] when it says none"],
  "stops": [{ "title": "3-6 words", "files": ["exact/path"], "why": "why read these together, and why at this point" }],
  "take": ["2-4 short paragraphs opening the review in the chat"],
  "questions": ["up to 3 short questions the reviewer might ask you next"]
}`,
	quality: `{
  "take": ["1-3 short paragraphs opening the quality pass in the chat"],
  "cards": [${CARD_SHAPE}],
  "questions": ["up to 3 short questions"]
}`,
	change: `{
  "take": ["2-3 short paragraphs opening this stop in the chat"],
  "complexity": "simple | moderate | complex",
  "rationale": "one sentence: why that rating",
  "cards": [${CARD_SHAPE}],
  "alternatives": [{ "title": "short", "pros": "what it gains", "cons": "what it costs", "verdict": "recommend | consider | later | worse" }],
  "pick": "one or two sentences: which approach you would pick",
  "questions": ["up to 3 short questions"]
}`,
	skim: `{
  "take": ["1-2 short paragraphs opening the skim pile in the chat"],
  "files": [{ "file": "exact/path", "risk": "low | medium | high", "note": "one line: what changed" }],
  "cards": [${CARD_SHAPE}],
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

/** What the PR was asked to do, numbered so a card can cite an item. */
function asksText(asks) {
	if (!asks?.length) return 'Acceptance items: none listed.';
	return `Acceptance items (what the PR was asked to do):\n${asks.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
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
export function qualityMessages({ prompts, pr, files, asks = [] }) {
	return [
		{ role: 'system', content: `${prompts.overall}\n\n${JSON_RULES}` },
		{
			role: 'user',
			content: [
				prompts.quality,
				'',
				prHeader(pr),
				asksText(asks),
				'',
				DIFF_KEY,
				'',
				diffText(files, BUDGET.quality),
				'',
				`Write at most ${MAX_CARDS.quality - 2} cards, the most important first, on structure and naming ` +
					'only; correctness belongs to the stops. It is fine to write none.',
				'',
				CARD_RULES,
				'',
				`Answer with this JSON shape:\n${SHAPES.quality}`
			].join('\n')
		}
	];
}

/** @returns {Message[]} */
export function changeMessages({ prompts, pr, stage, files, walkthrough }) {
	const asks = walkthrough?.asks ?? [];
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
				asksText(asks),
				'',
				DIFF_KEY,
				'',
				diffText(files, BUDGET.change),
				'',
				`Write 2-${MAX_CARDS.change - 2} cards on the changes that matter most, in reading order. Skip ` +
					'imports, constants and boilerplate; spend the cards on logic.',
				'',
				CARD_RULES,
				'',
				`Answer with this JSON shape:\n${SHAPES.change}`
			].join('\n')
		}
	];
}

/** @returns {Message[]} */
export function skimMessages({ prompts, pr, files, covered = [], asks = [] }) {
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
				asksText(asks),
				'',
				DIFF_KEY,
				'',
				files.map((f) => fileDiffText(f, each)).join('\n\n'),
				'',
				`Give every file above exactly one entry in "files". Write at most ${MAX_CARDS.skim - 2} cards, ` +
					'only for changes worth a closer look; it is fine to write none.',
				'',
				CARD_RULES,
				'',
				`Answer with this JSON shape:\n${SHAPES.skim}`
			].join('\n')
		}
	];
}

/**
 * A chat turn beside one stage, or beside one card: what the stage (or the
 * card) said, its diff, the lines the reviewer attached, then the
 * conversation so far. A card's chat reads the card, the lines it sits on,
 * the diff of only its own files and the PR's acceptance items, so it costs
 * less than the stage's.
 *
 * @param {{ prompts: Prompts; pr: any; stage: any; files: DiffFile[]; result: any; card?: import('../ui/cards.js').Card | null; asks?: string[]; history: { role: 'user' | 'assistant'; text: string }[]; message: string; attach?: { file: string; from: number; to: number } | null; lines?: string }} o
 * @returns {Message[]}
 */
export function chatMessages({
	prompts,
	pr,
	stage,
	files,
	result,
	card = null,
	asks = [],
	history,
	message,
	attach,
	lines
}) {
	const stagePrompt = prompts[stage.kind === 'change' ? 'change' : stage.kind] ?? '';
	const context = card
		? cardContext({ pr, stage, files, card, asks })
		: [
				prHeader(pr),
				stage.kind === 'walkthrough'
					? `Description:\n${(pr.body || '').slice(0, BUDGET.body)}`
					: '',
				`You are discussing this stage of the review: ${stage.title}.`,
				result ? `What you said about it:\n${summaryOf(stage.kind, result)}` : '',
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

/** What a card's chat reads before the conversation. */
function cardContext({ pr, stage, files, card, asks }) {
	const v = verdictOf(card.verdict);
	const also = card.secondary ? `, and also ${verdictOf(card.secondary).label}` : '';
	const own = files.filter((f) => card.blocks.some((b) => b.file === f.path));
	const blocks = card.blocks
		.filter((b) => b.from)
		.map((b) => {
			const f = files.find((x) => x.path === b.file);
			const rows = excerpt(f, b.from, b.to ?? b.from).map(
				(l) => `${l.t === '-' ? '    -' : String(l.n).padStart(5)} ${l.t} ${l.text}`
			);
			return `${b.file}:${b.from}-${b.to ?? b.from}\n${rows.join('\n')}`;
		});
	return [
		prHeader(pr),
		asksText(asks),
		`You are discussing one card of the review, in ${stage.title}.`,
		[
			`Your verdict: ${v.label}${card.severity ? ` (${card.severity} severity)` : ''}${also}. ${card.title}`,
			card.why ? `Why: ${card.why}` : '',
			card.suggestion ? `Your suggestion: ${card.suggestion}` : '',
			card.asked ? `What was asked: ${card.asked}` : '',
			card.take ? `Your take: ${card.take}` : ''
		]
			.filter(Boolean)
			.join('\n'),
		blocks.length ? `The lines it is about:\n\n${blocks.join('\n\n')}` : '',
		own.length ? `${DIFF_KEY}\n\n${diffText(own, BUDGET.cardChat)}` : ''
	]
		.filter(Boolean)
		.join('\n\n');
}

/** A card in one line, for a summary. */
const cardLine = (c) =>
	`- ${verdictOf(c.verdict).label}${c.secondary ? ` + ${verdictOf(c.secondary).label}` : ''}: ${c.title}${c.file ? ` (${c.file}:${c.from ?? '?'})` : ''}`;

/** A stage's answer, shortened to what the chat needs to remember. */
export function summaryOf(kind, r) {
	const take = (r.take ?? []).join(' ');
	if (kind === 'walkthrough') return [r.headline, r.what, r.why, take].filter(Boolean).join(' ');
	if (Array.isArray(r.cards) && r.cards.length && kind !== 'skim')
		return [
			take,
			kind === 'change' ? `Complexity: ${r.complexity}. ${r.rationale}` : '',
			...r.cards.map(cardLine),
			r.pick ? `Pick: ${r.pick}` : ''
		]
			.filter(Boolean)
			.join('\n');
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
	return [
		take,
		...(r.files ?? []).map((f) => `- ${f.file} (${f.risk}): ${f.note}`),
		...(r.cards ?? []).map(cardLine)
	].join('\n');
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
		asks: strs(r.asks, 10, 300),
		stops: Array.isArray(r.stops) ? r.stops : [],
		take: strs(r.take, 4, 900),
		questions: strs(r.questions, 3, 300)
	};
}

/** A verdict as a model may say it: its id, its label or a near miss. */
const VERDICT_WORDS = [
	['exemplary', 'exemplary'],
	['lgtm', 'lgtm'],
	['looksgood', 'lgtm'],
	['good', 'lgtm'],
	['explain', 'explain'],
	['neutral', 'explain'],
	['smell', 'smell'],
	['codesmell', 'smell'],
	['complex', 'complex'],
	['overcomplex', 'complex'],
	['untested', 'untested'],
	['notwelltested', 'untested'],
	['test', 'untested'],
	['perf', 'perf'],
	['ac', 'ac'],
	['acceptance', 'ac'],
	['doesntmeet', 'ac'],
	['brief', 'ac'],
	['security', 'security'],
	['possiblesecurity', 'security']
];
function verdictWord(v, fallback) {
	const s = str(v, 60)
		.toLowerCase()
		.replace(/[^a-z]/g, '');
	if (!s || s === 'null' || s === 'none') return fallback;
	if (VERDICT_IDS.includes(/** @type {any} */ (s))) return s;
	return VERDICT_WORDS.find(([w]) => s.startsWith(w))?.[1] ?? fallback;
}

/**
 * The cards a pass wrote, held to the stage's files: a card citing a file the
 * stage does not hold is dropped (a card citing none is about the change as a
 * whole), an unknown verdict reads as an explanation, a secondary verdict the
 * same as the main one is dropped, a suggestion is kept for concerns only,
 * and only security carries a severity.
 *
 * @param {unknown} raw the answer's `cards`
 * @param {import('./diff.js').DiffFile[]} files the stage's files
 * @param {(said: string) => string | null} resolve
 * @param {{ stage: string; asks?: string[]; max: number }} o
 * @returns {import('../ui/cards.js').Card[]}
 */
export function readCards(raw, files, resolve, { stage, asks = [], max }) {
	const out = [];
	for (const c of objs(raw, max * 2)) {
		if (out.length >= max) break;
		const title = str(c.title, 200);
		if (!title) continue;
		const named = str(c.file ?? c.path, 300);
		const at = named ? anchor(c, files, resolve) : { file: null, from: null, to: null };
		if (!at) continue;
		const verdict = /** @type {any} */ (verdictWord(c.verdict, 'explain'));
		let secondary = verdictWord(c.also ?? c.secondary, null);
		if (secondary === verdict) secondary = null;
		const blocks = at.file ? [at] : [];
		for (const b of objs(c.more, 2)) {
			const more = anchor(b, files, resolve);
			if (more && !blocks.some((x) => x.file === more.file && x.from === more.from))
				blocks.push(more);
		}
		const n = Number.parseInt(c.ask, 10);
		const ask = n >= 1 && n <= asks.length ? n : null;
		const concern = isConcern(verdict) || (secondary !== null && isConcern(secondary));
		out.push({
			id: `${stage}:c${out.length + 1}`,
			stage,
			verdict,
			secondary: /** @type {any} */ (secondary),
			severity:
				verdict === 'security' || secondary === 'security'
					? /** @type {any} */ (oneOf(c.severity, ['low', 'medium', 'high'], 'medium'))
					: null,
			title,
			why: str(c.why, 1200),
			suggestion: concern ? said(c.suggestion, 600) : '',
			ask,
			asked: said(c.asked, 400) || (verdict === 'ac' && ask ? asks[ask - 1] : ''),
			...at,
			blocks,
			take: str(c.take, 600),
			questions: strs(c.questions, 2, 300)
		});
	}
	return out;
}

/**
 * The quality pass: its cards, and the same concerns as `findings` (the
 * shape a page from before cards reads). An answer in that older shape, with
 * `findings` and no `cards`, still reads, and its findings become cards.
 */
export function readQuality(raw, files, resolvePath, { stage = 'quality', asks = [] } = {}) {
	const r = raw ?? {};
	const resolve = pathResolver(files, resolvePath);
	const take = strs(r.take, 3, 900);
	const questions = strs(r.questions, 3, 300);
	if (Array.isArray(r.cards)) {
		const cards = readCards(r.cards, files, resolve, { stage, asks, max: MAX_CARDS.quality });
		const findings = cards
			.filter((c) => c.file && isConcern(c.verdict))
			.map((c, i) => ({
				id: `q${i + 1}`,
				title: c.title,
				level: /** @type {'worth' | 'nit'} */ (
					c.verdict === 'smell' && !c.secondary ? 'nit' : 'worth'
				),
				file: c.file,
				from: c.from,
				to: c.to,
				body: c.why,
				suggestion: c.suggestion
			}));
		return { take, cards, findings, questions };
	}
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
	const cards = cardsOf({ id: stage, kind: 'quality' }, { findings });
	return { take, cards, findings, questions };
}

/**
 * A stop: its cards, and each card as a `note` pinned to its lines (the
 * shape a page from before cards reads). An answer in that older shape, with
 * `notes` and no `cards`, still reads, and its notes become cards.
 */
export function readChange(raw, files, resolvePath, { stage = 'stop', asks = [] } = {}) {
	const r = raw ?? {};
	const resolve = pathResolver(files, resolvePath);
	let cards = null;
	const notes = [];
	if (Array.isArray(r.cards)) {
		cards = readCards(r.cards, files, resolve, { stage, asks, max: MAX_CARDS.change });
		for (const c of cards)
			if (c.file)
				notes.push({
					id: `n${notes.length + 1}`,
					file: c.file,
					from: c.from,
					to: c.to,
					tag: /** @type {'simple' | 'moderate' | 'complex'} */ (
						c.verdict === 'complex' ? 'complex' : isConcern(c.verdict) ? 'moderate' : 'simple'
					),
					title: `${verdictOf(c.verdict).label}: ${c.title}`,
					body: c.why,
					concern: isConcern(c.verdict) ? c.suggestion || c.why : ''
				});
	} else
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
		cards: cards ?? cardsOf({ id: stage, kind: 'change' }, { notes }),
		questions: strs(r.questions, 3, 300)
	};
}

/** The skim pile: one row for every file in it, and cards for the few worth a closer look. */
export function readSkim(raw, files, resolvePath, { stage = 'skim', asks = [] } = {}) {
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
	return {
		take: strs(r.take, 2, 900),
		files: rows,
		cards: readCards(r.cards, files, resolve, { stage, asks, max: MAX_CARDS.skim }),
		questions: strs(r.questions, 3, 300)
	};
}
