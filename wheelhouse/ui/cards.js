/**
 * The review as cards: one card per change, each with one main verdict from a
 * fixed set and at most one secondary one. Shared by the engine (which reads
 * the model's cards and drafts the review from the captain's decisions) and a
 * page (which shows them). Pure functions of the review; nothing here calls
 * anything.
 *
 * The stage passes write the cards (`results[stage].cards`). `deckOf` lays
 * them out the way a page reads them: the passage groups (Walkthrough, Key
 * changes, Quality pass, Skim pile, Generated), every card in reading order
 * with its tier (major, minor or reference point) and the captain's decision
 * on it, the quality pass's checklist of every
 * concern in the review, and the disagreements the captain asked to remember.
 * A review kept from before cards (quality findings and stop notes only) still
 * reads as cards: `cardsOf` makes them from what those passes said.
 *
 * @typedef {'exemplary' | 'lgtm' | 'explain' | 'smell' | 'complex' | 'untested' | 'perf' | 'ac' | 'security'} Verdict
 * @typedef {'praise' | 'neutral' | 'concern'} Family
 * @typedef {{ file: string; from: number | null; to: number | null }} Block
 * @typedef {{
 *   id: string; stage: string; verdict: Verdict; secondary: Verdict | null;
 *   severity: 'low' | 'medium' | 'high' | null; title: string; why: string; suggestion: string;
 *   ask: number | null; asked: string; file: string | null; from: number | null; to: number | null;
 *   blocks: Block[]; take: string; questions: string[]; legacy?: boolean
 * }} Card
 * @typedef {'accept' | 'disagree' | 'comment'} Decision
 * @typedef {'pr' | 'me' | 'repo'} RememberScope
 * @typedef {{ decision: Decision; text: string; remember: RememberScope | null; at: number }} CardDecision
 */

/**
 * The verdicts, in the order a page lists them. `blocking` concerns make the
 * suggested review "Request changes" once accepted; the others are
 * non-blocking suggestions. Praise accepted goes under "What works well";
 * an accepted explanation is only noted.
 */
export const CARD_VERDICTS = /** @type {const} */ ([
	{
		id: 'exemplary',
		label: 'Exemplary',
		family: 'praise',
		blocking: false,
		meaning: 'Worth copying. Better than it needed to be.'
	},
	{
		id: 'lgtm',
		label: 'Looks good',
		family: 'praise',
		blocking: false,
		meaning: 'Does what it should, cleanly. Nothing to ask.'
	},
	{
		id: 'explain',
		label: 'Explanation',
		family: 'neutral',
		blocking: false,
		meaning: 'No verdict needed, but it helps to understand this.'
	},
	{
		id: 'smell',
		label: 'Code smell',
		family: 'concern',
		blocking: false,
		meaning: 'Works today, but invites a future mistake.'
	},
	{
		id: 'complex',
		label: 'Over-complex',
		family: 'concern',
		blocking: false,
		meaning: 'Correct, but harder to check than it has to be.'
	},
	{
		id: 'untested',
		label: 'Not well tested',
		family: 'concern',
		blocking: true,
		meaning: 'Behaviour that nothing in the repo checks.'
	},
	{
		id: 'perf',
		label: 'Performance risk',
		family: 'concern',
		blocking: true,
		meaning: 'Fine at small sizes; may fail at real ones.'
	},
	{
		id: 'ac',
		label: 'Doesn’t meet acceptance criteria',
		family: 'concern',
		blocking: true,
		meaning: 'Differs from what the task or issue asked for.'
	},
	{
		id: 'security',
		label: 'Possible security issue',
		family: 'concern',
		blocking: true,
		meaning: 'Could expose data or access. Always has a severity.'
	}
]);

export const VERDICT_IDS = /** @type {Verdict[]} */ (CARD_VERDICTS.map((v) => v.id));
export const DECISIONS = /** @type {const} */ (['accept', 'disagree', 'comment']);
/** Who a disagreement should be remembered for: this PR, the captain in every repo, or everyone reviewing this repo. */
export const REMEMBER_SCOPES = /** @type {const} */ (['pr', 'me', 'repo']);

const BY_ID = new Map(CARD_VERDICTS.map((v) => [v.id, v]));
/** @param {string} v */
export const verdictOf = (v) => BY_ID.get(/** @type {any} */ (v)) ?? BY_ID.get('explain');
export const isConcern = (v) => verdictOf(v).family === 'concern';
export const isPraise = (v) => verdictOf(v).family === 'praise';
export const isBlocking = (v) => verdictOf(v).blocking;

/**
 * How much a card matters, which decides when the chat reaches it: the major
 * issues (a blocking concern) first, then, only when asked, the minor ones (a
 * concern that doesn't block). A card with no concern at all (praise, an
 * explanation) is only a reference point, hidden unless asked for. A
 * secondary verdict counts as much as the main one.
 */
export const TIERS = /** @type {const} */ (['major', 'minor', 'reference']);

/** @param {{ verdict: string; secondary?: string | null }} card @returns {'major' | 'minor' | 'reference'} */
export function tierOf(card) {
	const vs = [card.verdict, card.secondary].filter(Boolean);
	if (vs.some(isBlocking)) return 'major';
	if (vs.some(isConcern)) return 'minor';
	return 'reference';
}

/** The groups of the passage, in reading order. */
export const GROUPS = /** @type {const} */ ([
	{ id: 'walkthrough', title: 'Walkthrough', hint: 'Read this first.' },
	{ id: 'key', title: 'Key changes', hint: 'Read closely, a stop at a time.' },
	{
		id: 'quality',
		title: 'Quality pass',
		hint: 'Structure and naming, then every concern in the review as a checklist.'
	},
	{ id: 'skim', title: 'Skim pile', hint: 'Everything else, one line each.' },
	{ id: 'generated', title: 'Generated', hint: 'Made by tools; hidden unless asked for.' }
]);

const groupOfKind = { walkthrough: 'walkthrough', change: 'key', quality: 'quality', skim: 'skim' };

/**
 * A stage's cards: the ones its pass wrote, or, for a review kept from before
 * cards, cards made from its quality findings or stop notes (marked `legacy`).
 *
 * @param {{ id: string; kind: string }} stage
 * @param {any} result the stage's result, or null before its pass has answered
 * @returns {Card[]}
 */
export function cardsOf(stage, result) {
	if (!result) return [];
	if (Array.isArray(result.cards)) return result.cards;
	const base = (over) => ({
		stage: stage.id,
		secondary: null,
		severity: null,
		suggestion: '',
		ask: null,
		asked: '',
		take: '',
		questions: [],
		legacy: true,
		...over,
		blocks: over.file ? [{ file: over.file, from: over.from, to: over.to }] : []
	});
	if (stage.kind === 'quality')
		return (result.findings ?? []).map((f) =>
			base({
				id: `${stage.id}:${f.id}`,
				verdict: 'smell',
				title: f.title,
				why: f.body ?? '',
				suggestion: f.suggestion ?? '',
				file: f.file,
				from: f.from ?? null,
				to: f.to ?? null
			})
		);
	if (stage.kind === 'change')
		return (result.notes ?? []).map((n) =>
			base({
				id: `${stage.id}:${n.id}`,
				verdict: n.concern ? 'smell' : 'explain',
				title: n.title,
				why: [n.body, n.concern].filter(Boolean).join(' '),
				file: n.file,
				from: n.from ?? null,
				to: n.to ?? null
			})
		);
	return [];
}

/**
 * The one card the generated files get, made without the model: they are
 * named, and hidden.
 *
 * @param {string[]} paths
 * @returns {Card | null}
 */
export function generatedCard(paths) {
	if (!paths.length) return null;
	const n = paths.length;
	return {
		id: 'generated:c1',
		stage: 'generated',
		verdict: 'explain',
		secondary: null,
		severity: null,
		title: `${n} generated file${n === 1 ? '' : 's'}, hidden from the review`,
		why: 'Build output, lockfiles and snapshots are made by tools, not written by hand. Skip them unless the build itself changed.',
		suggestion: '',
		ask: null,
		asked: '',
		file: null,
		from: null,
		to: null,
		blocks: [],
		take: '',
		questions: []
	};
}

/** Every card in the review, in reading order: key changes, quality pass, skim pile, generated. */
export function allCards(review) {
	const stages = review?.stages ?? [];
	const order = ['change', 'quality', 'skim'];
	const out = [];
	for (const kind of order)
		for (const s of stages.filter((x) => x.kind === kind))
			out.push(...cardsOf(s, review.results?.[s.id]));
	const g = generatedCard(review?.plan?.generated ?? []);
	if (g) out.push(g);
	return out;
}

/** One card by id, or null. */
export function findCard(review, id) {
	return allCards(review).find((c) => c.id === id) ?? null;
}

/**
 * The review laid out as cards, for a page: the groups of the passage with
 * their cards, every card in reading order with its decision, the verdict
 * counts, the acceptance items with the cards that check them, the quality
 * pass's checklist of every concern, and what the captain asked to remember.
 *
 * @param {any} review
 */
export function deckOf(review) {
	const r = review ?? {};
	const stages = r.stages ?? [];
	const decisions = r.cardDecisions ?? {};
	const runs = r.runs ?? {};
	/** Where a stage's pass is: idle, queued, running, done or failed. */
	const state = (id) => runs[id]?.state ?? (r.results?.[id] ? 'done' : 'idle');
	const groupOf = new Map();
	const cards = allCards(r).map((c) => {
		const stage = stages.find((s) => s.id === c.stage);
		const group = stage ? groupOfKind[stage.kind] : 'generated';
		groupOf.set(c.id, group);
		return { ...c, group, tier: tierOf(c), decision: decisions[c.id] ?? null };
	});
	const ids = (pred) => cards.filter(pred).map((c) => c.id);
	const counts = Object.fromEntries(VERDICT_IDS.map((v) => [v, 0]));
	for (const c of cards) counts[c.verdict]++;
	const tiers = Object.fromEntries(TIERS.map((t) => [t, 0]));
	for (const c of cards) tiers[c.tier]++;
	const asks = (r.results?.walkthrough?.asks ?? []).map((text, i) => ({
		n: i + 1,
		text,
		cards: ids((c) => c.ask === i + 1)
	}));
	const stops = stages.filter((s) => s.kind === 'change');
	const quality = stages.find((s) => s.kind === 'quality');
	const skim = stages.find((s) => s.kind === 'skim');
	const concerns = cards.filter((c) => isConcern(c.verdict));
	const groups = [
		{
			...GROUPS[0],
			stages: ['walkthrough'],
			state: state('walkthrough'),
			cards: [],
			asks
		},
		{
			...GROUPS[1],
			stages: stops.map((s) => s.id),
			stops: stops.map((s) => {
				const own = cards.filter((c) => c.stage === s.id);
				return {
					stage: s.id,
					title: s.title,
					why: s.why ?? '',
					files: s.files,
					state: state(s.id),
					cards: own.map((c) => c.id),
					// Its most serious card's tier: a stop with nothing to look at is only a reference point.
					tier: TIERS.find((t) => own.some((c) => c.tier === t)) ?? 'reference'
				};
			}),
			state: groupState(stops.map((s) => state(s.id))),
			cards: ids((c) => groupOf.get(c.id) === 'key')
		},
		{
			...GROUPS[2],
			stages: quality ? [quality.id] : [],
			state: quality ? state(quality.id) : 'done',
			cards: ids((c) => groupOf.get(c.id) === 'quality'),
			checklist: concerns.map((c) => ({
				card: c.id,
				group: c.group,
				verdict: c.verdict,
				severity: c.severity,
				blocking: isBlocking(c.verdict),
				title: c.title,
				file: c.file,
				from: c.from,
				to: c.to,
				decision: c.decision?.decision ?? null
			}))
		},
		{
			...GROUPS[3],
			stages: skim ? [skim.id] : [],
			state: skim ? state(skim.id) : 'done',
			cards: ids((c) => groupOf.get(c.id) === 'skim'),
			files: skim ? (r.results?.[skim.id]?.files ?? skim.files.map((file) => ({ file }))) : []
		},
		{
			...GROUPS[4],
			hidden: true,
			stages: [],
			state: 'done',
			cards: ids((c) => groupOf.get(c.id) === 'generated'),
			files: r.plan?.generated ?? []
		}
	];
	for (const g of groups) {
		const own = cards.filter((c) => groupOf.get(c.id) === g.id);
		g.look = own.filter((c) => isConcern(c.verdict)).length;
		g.decided = own.filter((c) => c.decision).length;
	}
	return {
		verdicts: CARD_VERDICTS,
		groups,
		cards,
		counts,
		tiers,
		remember: remembered(r, cards)
	};
}

function groupState(states) {
	if (!states.length) return 'done';
	if (states.some((s) => s === 'running')) return 'running';
	if (states.some((s) => s === 'queued')) return 'queued';
	if (states.some((s) => s === 'failed')) return 'failed';
	if (states.every((s) => s === 'done')) return 'done';
	return 'idle';
}

/**
 * The disagreements and comments the captain asked to remember, as the shape
 * a later memory would take: who it is for, the kind of verdict it answers,
 * what to remember, and where it came from. Nothing reads these back yet.
 */
function remembered(r, cards) {
	const out = [];
	for (const c of cards) {
		const d = c.decision;
		if (!d?.remember) continue;
		out.push({
			card: c.id,
			scope: d.remember,
			verdict: c.verdict,
			decision: d.decision,
			text: d.text || c.title,
			file: c.file,
			repo: r.pr ? `${r.pr.owner}/${r.pr.repo}` : null,
			at: d.at
		});
	}
	return out;
}

/**
 * What the captain's card decisions put in the review: accepted concerns as
 * change requests (blocking verdicts) or suggestions, comments as comments,
 * accepted praise under "What works well". Disagreements and accepted
 * explanations add nothing.
 *
 * @returns {{ points: { kind: 'change' | 'suggestion' | 'comment'; file: string | null; from: number | null; to: number | null; text: string; card: string }[]; praise: { card: string; text: string; file: string | null }[] }}
 */
export function cardPoints(review) {
	const decisions = review?.cardDecisions ?? {};
	const points = [];
	const praise = [];
	for (const c of allCards(review)) {
		const d = decisions[c.id];
		if (!d) continue;
		const at = { file: c.file, from: c.from ?? null, to: c.to ?? c.from ?? null, card: c.id };
		if (d.decision === 'comment' && d.text) points.push({ kind: 'comment', ...at, text: d.text });
		if (d.decision !== 'accept') continue;
		if (isConcern(c.verdict)) {
			const what = `${verdictOf(c.verdict).label}${c.severity ? ` (${c.severity})` : ''}`;
			const text = `${what}: ${c.suggestion ? `${c.title}. ${c.suggestion}` : c.title}`;
			points.push({ kind: isBlocking(c.verdict) ? 'change' : 'suggestion', ...at, text });
		} else if (isPraise(c.verdict)) praise.push({ card: c.id, text: c.title, file: c.file });
	}
	return { points, praise };
}
