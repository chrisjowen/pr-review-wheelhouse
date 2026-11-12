/**
 * The chat review's logic (wheelhouse/ui/chat-core.js), read the way the page reads
 * it: against the engine's own deck of a real review (the web app's seeded
 * chrisjowen/docket#48) and its verdict set.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CARD_VERDICTS, deckOf } from '../wheelhouse/ui/cards.js';
import {
	codeOf,
	filesWithCards,
	fuzzy,
	markdown,
	ISSUES_ONLY,
	nextUndecided,
	parseLine,
	partKind,
	partsOf,
	readingOrder,
	tierCounts,
	verdictTable
} from '../wheelhouse/ui/chat-core.js';

const review = JSON.parse(
	readFileSync(new URL('./fixtures/docket-48.review.json', import.meta.url))
);
const deck = deckOf(review);
const vt = verdictTable(CARD_VERDICTS);
const withDecisions = (ids) =>
	deckOf({
		...review,
		cardDecisions: Object.fromEntries(
			ids.map((id) => [id, { decision: 'accept', text: '', remember: null, at: 1 }])
		)
	});

describe('what a card says in the chat', () => {
	it('files each verdict as liked, worth knowing, needing work or serious (every blocking verdict)', () => {
		const kinds = Object.fromEntries(CARD_VERDICTS.map((v) => [v.id, partKind(v.id, vt)]));
		assert.deepEqual(kinds, {
			exemplary: 'like',
			lgtm: 'like',
			explain: 'note',
			smell: 'work',
			complex: 'work',
			untested: 'serious',
			perf: 'serious',
			ac: 'serious',
			security: 'serious'
		});
		assert.equal(partKind('made-up', vt), 'note', 'an unknown verdict reads as an explanation');
	});

	it('says the main verdict with its why, then the secondary verdict with what it means', () => {
		const card = deck.cards.find((c) => c.verdict === 'security' && c.secondary === 'untested');
		const parts = partsOf(card, vt);
		assert.deepEqual(
			parts.map((p) => [p.kind, p.verdict]),
			[
				['serious', 'security'],
				['serious', 'untested']
			]
		);
		assert.equal(parts[0].text, card.why);
		assert.equal(parts[1].text, 'Behaviour that nothing in the repo checks.');
		assert.equal(partsOf({ verdict: 'lgtm', secondary: null, why: 'x' }, vt).length, 1);
	});

	it('cuts a block’s code from the diff, marking the block’s own lines, removed lines in place', () => {
		const file = review.files.find((f) => f.path.endsWith('src/subgraph-search.ts'));
		const rows = codeOf(file, 54, 56);
		assert.deepEqual(
			rows.map((r) => r.n),
			[52, 53, 54, 55, 56, 57, 58]
		);
		assert.deepEqual(
			rows.filter((r) => r.focus).map((r) => r.n),
			[54, 55, 56]
		);
		const changed = review.files.find((f) => f.path.endsWith('src/neo4j-projection.ts'));
		const mixed = codeOf(changed, 200, 202);
		assert.ok(
			mixed.some((r) => r.t === '-' && r.n === null),
			'removed lines between shown lines stay'
		);
		assert.notEqual(mixed[0].t, '-');
		assert.deepEqual(codeOf(file, 5000, 5001), [], 'lines the diff doesn’t reach');
		assert.deepEqual(codeOf(undefined, 1, 2), []);
	});
});

describe('the order the chat walks the review in', () => {
	const tierOf = (id) => deck.cards.find((c) => c.id === id).tier;

	it('files each card as a major issue, a minor one or a reference point, by its worst verdict', () => {
		const tiers = Object.fromEntries(deck.cards.map((c) => [c.id, c.tier]));
		assert.equal(tiers['stop-1:c4'], 'major', 'a possible security issue');
		assert.equal(tiers['skim:c3'], 'major', 'an explanation that is also not well tested');
		assert.equal(tiers['quality:c1'], 'minor', 'over-complex blocks nothing');
		assert.equal(tiers['stop-1:c1'], 'reference', 'looks good');
		assert.equal(tiers['generated:c1'], 'reference');
		assert.deepEqual(tierCounts(deck), { major: 5, minor: 6, reference: 9 });
		assert.deepEqual(
			deck.groups[1].stops.map((s) => s.tier),
			['major', 'minor'],
			'a stop is as serious as its worst card'
		);
	});

	it('walks only the major issues at first, most serious first, a low-severity security issue last', () => {
		const order = readingOrder(deck, ISSUES_ONLY);
		assert.deepEqual(
			order.map((x) => x.id),
			['stop-1:c3', 'stop-1:c2', 'skim:c1', 'skim:c3', 'stop-1:c4']
		);
		assert.ok(order.every((x) => x.tier === 'major'));
		assert.equal(order[0].section, 'stop-1');
		assert.equal(order[2].group, 'skim');
	});

	it('lets the minor ones in after the major ones, and the reference points last, in the passage’s order', () => {
		const minor = readingOrder(deck, { minor: true, reference: false });
		assert.deepEqual(
			minor.map((x) => x.tier),
			[...Array(5).fill('major'), ...Array(6).fill('minor')]
		);
		assert.deepEqual(
			minor.slice(5).map((x) => x.id),
			['quality:c1', 'quality:c2', 'stop-1:c5', 'stop-2:c3', 'stop-2:c4', 'quality:c3'],
			'over-complex before code smells'
		);
		const all = readingOrder(deck);
		assert.equal(all.length, deck.cards.length);
		assert.equal(new Set(all.map((x) => x.id)).size, deck.cards.length);
		assert.deepEqual(
			all.filter((x) => x.tier === 'reference').map((x) => x.id),
			deck.cards.filter((c) => c.tier === 'reference').map((c) => c.id)
		);
		assert.ok(all.slice(0, 11).every((x) => tierOf(x.id) !== 'reference'));
	});

	it('goes to the next undecided card in view, wrapping round, and stops when all are decided', () => {
		const order = readingOrder(deck, ISSUES_ONLY).map((x) => x.id);
		assert.equal(nextUndecided(deck, null, ISSUES_ONLY), order[0]);
		const some = withDecisions([order[1], order[2]]);
		assert.equal(nextUndecided(some, order[0], ISSUES_ONLY), order[3]);
		assert.equal(nextUndecided(withDecisions(order.slice(1)), order[4], ISSUES_ONLY), order[0]);
		assert.equal(nextUndecided(withDecisions(order), order[0], ISSUES_ONLY), null);
		assert.notEqual(
			nextUndecided(withDecisions(order), order[0]),
			null,
			'the minor ones and reference points are still open'
		);
	});
});

describe('what a typed line means', () => {
	it('knows the chat’s commands', () => {
		const cases = {
			next: 'next',
			'Go on': 'next',
			back: 'back',
			minor: 'minor',
			'show the minor issues': 'minor',
			'the small things': 'minor',
			accept: 'accept',
			'Accept.': 'accept',
			finish: 'finish',
			"i'm done": 'finish',
			'wrap up': 'finish',
			'the story': 'context',
			'open the file': 'open',
			cancel: 'cancel'
		};
		for (const [text, type] of Object.entries(cases))
			assert.equal(parseLine(text).type, type, text);
		assert.deepEqual(parseLine('I disagree because the timeout covers it'), {
			type: 'disagree',
			text: 'I disagree because the timeout covers it',
			arg: 'the timeout covers it'
		});
		assert.equal(parseLine('comment: add a tie-breaker').arg, 'add a tie-breaker');
		assert.equal(parseLine('go to config.ts').arg, 'config.ts');
	});
	it('treats anything else as a question, noting a line number', () => {
		assert.deepEqual(parseLine('Is it exploitable?'), { type: 'ask', text: 'Is it exploitable?' });
		assert.equal(parseLine('what does line 59 do?').line, 59);
		assert.equal(parseLine('ok, but why is this slow?').type, 'ask');
	});
	it('never takes a casual yes, or a bare “done” or “n”, as a decision or a move', () => {
		for (const text of ['ok', 'Okay', 'fine', 'sounds good', 'looks good', 'agree', 'LGTM!'])
			assert.equal(parseLine(text).type, 'agree', text);
		assert.equal(parseLine('done').type, 'ask');
		assert.equal(parseLine('n').type, 'ask');
	});
});

describe('the quick switcher’s matching', () => {
	it('prefers a match in the file’s name, and matches letters in order within it', () => {
		const a = fuzzy('proj', 'packages/a/src/neo4j-projection.ts');
		const b = fuzzy('proj', 'packages/projects/src/index.ts');
		assert.ok(a.score > b.score);
		assert.ok(fuzzy('ssts', 'src/subgraph-search.ts'));
		assert.equal(fuzzy('pkg', 'packages/a/src/index.ts'), null, 'not across folder names');
	});
});

describe('the reviewer’s Markdown', () => {
	it('marks up paragraphs, lists and code, and escapes everything else', () => {
		const html = markdown(
			'Two **things**:\n\n- `seed.scope`\n- <img src=x onerror=alert(1)>\n\n```ts\nconst a = "<b>";\n```'
		);
		assert.match(html, /<p>Two <b>things<\/b>:<\/p>/);
		assert.match(html, /<li><code>seed\.scope<\/code><\/li>/);
		assert.match(html, /<li>&lt;img src=x onerror=alert\(1\)&gt;<\/li>/);
		assert.match(html, /<pre><code>const a = &quot;&lt;b&gt;&quot;;<\/code><\/pre>/);
		assert.ok(!/<img|<script/.test(markdown('<script>alert(1)</script>')));
	});
	it('links only http(s) addresses', () => {
		assert.match(
			markdown('See https://github.com/o/r/pull/1.'),
			/<a href="https:\/\/github\.com\/o\/r\/pull\/1"/
		);
		assert.ok(!/<a /.test(markdown('javascript:alert(1)')));
	});
});

describe('the changed files beside the chat', () => {
	it('lists every file with the cards that look at it, generated files under their one card', () => {
		const files = filesWithCards(review, deck);
		assert.equal(files.length, review.files.length);
		const search = files.find((f) => f.path.endsWith('src/subgraph-search.ts'));
		assert.ok(search.cards.length >= 5);
		for (const id of search.cards) assert.ok(deck.cards.some((c) => c.id === id));
		const dist = files.filter((f) => f.generated);
		assert.equal(dist.length, 5);
		for (const f of dist) assert.deepEqual(f.cards, ['generated:c1']);
	});
});
