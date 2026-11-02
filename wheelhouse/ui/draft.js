/**
 * What a finished review turns into, shared by the page (which shows the
 * drafts) and the engine (which posts the GitHub one only on the captain's
 * click): a suggested verdict, a GitHub pull request review with inline
 * comments, and a message asking Firstmate for the changes. Pure functions of
 * the review; nothing here sends anything.
 *
 * A change request or kept suggestion becomes an inline comment only when its
 * lines sit inside one hunk of the diff, since GitHub refuses a comment
 * anywhere else; the rest go in the review's body with their file and lines.
 *
 * The captain's card decisions count too: an accepted concern is a change
 * request when its verdict blocks (security, acceptance criteria, tests,
 * performance) and a suggestion otherwise, a comment is a comment, and
 * accepted praise goes under "What works well".
 */

import { cardPoints } from './cards.js';

export const VERDICTS = /** @type {const} */ (['APPROVE', 'COMMENT', 'REQUEST_CHANGES']);
export const VERDICT_LABEL = {
	APPROVE: 'Approve',
	COMMENT: 'Comment',
	REQUEST_CHANGES: 'Request changes'
};

/** A point's place: `file:from-to`, the file alone, or null for the PR as a whole. */
const where = (x) =>
	!x.file
		? null
		: x.from
			? `${x.file}:${x.from}${x.to && x.to !== x.from ? `-${x.to}` : ''}`
			: x.file;

/** The quality findings the captain kept. */
export function keptFindings(review) {
	const findings = review?.results?.quality?.findings ?? [];
	return findings.filter((f) => review.decisions?.[f.id] === 'keep');
}

/** Change requests, then kept suggestions, then what the card decisions add, as one list of review points. */
export function reviewPoints(review) {
	return [
		...(review?.requests ?? []).map((r) => ({
			kind: /** @type {const} */ ('change'),
			file: r.file,
			from: r.from ?? null,
			to: r.to ?? r.from ?? null,
			text: r.text
		})),
		...keptFindings(review).map((f) => ({
			kind: /** @type {const} */ ('suggestion'),
			file: f.file,
			from: f.from ?? null,
			to: f.to ?? f.from ?? null,
			text: f.suggestion ? `${f.title}. ${f.suggestion}` : f.title
		})),
		...cardPoints(review).points
	];
}

const LABEL = {
	change: '**Change requested:**',
	suggestion: '**Suggestion:**',
	comment: '**Comment:**'
};

/** Approve with nothing asked, comment with only suggestions or comments, request changes once any change is asked. */
export function suggestVerdict(review) {
	const points = reviewPoints(review);
	if (points.some((p) => p.kind === 'change')) return 'REQUEST_CHANGES';
	if (points.length) return 'COMMENT';
	return 'APPROVE';
}

/** The hunk (index) of a file holding a new-side line, or -1. */
function hunkOf(file, n) {
	return (file?.hunks ?? []).findIndex((h) => h.lines.some((l) => l.n === n && l.t !== '-'));
}

/**
 * The GitHub review: `event`, `body` and inline `comments` as the pull
 * request reviews API takes them (side RIGHT, multi-line with `start_line`).
 *
 * @param {any} review
 * @param {{ event?: string; summary?: string }} [o]
 */
export function draftReview(review, { event, summary } = {}) {
	const ev = VERDICTS.includes(/** @type {any} */ (event)) ? event : suggestVerdict(review);
	const files = new Map((review?.files ?? []).map((f) => [f.path, f]));
	const comments = [];
	const loose = [];
	const points = reviewPoints(review);
	for (const p of points) {
		const label = LABEL[p.kind];
		const file = files.get(p.file);
		const end = p.to ?? p.from;
		const h = end ? hunkOf(file, end) : -1;
		if (p.from && h >= 0) {
			const c = { path: p.file, line: end, side: 'RIGHT', body: `${label} ${p.text}` };
			if (p.from < end && hunkOf(file, p.from) === h) {
				c.start_line = p.from;
				c.start_side = 'RIGHT';
			}
			comments.push(c);
		} else loose.push({ ...p, label });
	}
	const n = (kind) => points.filter((p) => p.kind === kind).length;
	const count = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
	const changes = n('change');
	const others = [
		n('suggestion') ? count(n('suggestion'), 'suggestion') : '',
		n('comment') ? count(n('comment'), 'comment') : ''
	].filter(Boolean);
	const lines = [];
	const lead =
		summary?.trim() ||
		(ev === 'APPROVE'
			? 'Looks good to me.'
			: ev === 'REQUEST_CHANGES'
				? `${count(changes, 'change')} requested${others.length ? `, and ${others.join(' and ')}` : ''}; see the comments.`
				: `${others.join(' and ') || 'Nothing'}, none blocking; see the comments.`);
	lines.push(lead);
	if (loose.length) {
		lines.push('');
		for (const p of loose)
			lines.push(`- ${p.label} ${where(p) ? `\`${where(p)}\`: ` : ''}${p.text}`);
	}
	const { praise } = cardPoints(review);
	if (praise.length) {
		lines.push('', '**What works well:**');
		for (const p of praise) lines.push(`- ${p.file ? `\`${p.file}\`: ` : ''}${p.text}`);
	}
	return { event: ev, body: lines.join('\n'), comments };
}

/**
 * The message asking Firstmate to make the changes: the PR's URL, then each
 * point with its file and lines.
 */
export function firstmateMessage(review) {
	const pr = review?.pr ?? {};
	const points = reviewPoints(review);
	const lines = [
		`Review fixes for ${pr.url ?? 'the pull request'}${pr.title ? ` (${pr.title})` : ''}.`,
		points.length
			? 'From my review, please make these changes on the PR branch:'
			: 'My review asked for no changes.'
	];
	points.forEach((p, i) =>
		lines.push(
			`${i + 1}. ${p.kind === 'change' ? 'Change' : p.kind === 'comment' ? 'Comment' : 'Suggestion'}${where(p) ? ` at ${where(p)}` : ''}: ${p.text}`
		)
	);
	return lines.join('\n');
}

/** Wheelhouse's chat with the message waiting in its box; nothing is sent until the captain sends it. */
export function firstmateHref(text) {
	return `/?draft=${encodeURIComponent(text)}`;
}
