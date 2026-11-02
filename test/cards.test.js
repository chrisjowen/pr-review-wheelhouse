import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDiff } from '../wheelhouse/engine/diff.js';
import { createGitHub } from '../wheelhouse/engine/github.js';
import {
	changeMessages,
	readCards,
	readChange,
	readQuality,
	readWalkthrough,
	walkthroughMessages
} from '../wheelhouse/engine/prompts.js';
import { createReviews } from '../wheelhouse/engine/review.js';
import { resolvePath } from '../wheelhouse/engine/stages.js';
import { memoryStore } from '../wheelhouse/engine/store.js';
import {
	CARD_VERDICTS,
	cardPoints,
	cardsOf,
	deckOf,
	isBlocking,
	VERDICT_IDS
} from '../wheelhouse/ui/cards.js';
import { draftReview, firstmateMessage, suggestVerdict } from '../wheelhouse/ui/draft.js';
import {
	ANSWERS,
	CARD_ANSWERS,
	fakeGh,
	fakeModel,
	PR_URL,
	sampleDiff,
	sampleView
} from './helpers.js';

const ID = 'acme__lumen__48';
const files = parseDiff(sampleDiff());
const pick = (...paths) => files.filter((f) => paths.includes(f.path));
const resolver = (fs) => (said) =>
	resolvePath(
		said,
		fs.map((f) => f.path)
	);

function setup({ answers = CARD_ANSWERS, gh = fakeGh(), model = fakeModel(answers) } = {}) {
	let t = 1_000;
	const reviews = createReviews({
		github: createGitHub(gh.run),
		store: memoryStore(),
		model: () => model,
		now: () => ++t
	});
	return { reviews, gh, model };
}

async function reviewed(o) {
	const s = setup(o);
	await s.reviews.open(PR_URL);
	await s.reviews.settled();
	return { ...s, r: s.reviews.view(ID) };
}

describe('the verdict set', () => {
	it('is the nine verdicts, with security, acceptance criteria, tests and performance blocking', () => {
		assert.deepEqual(VERDICT_IDS, [
			'exemplary',
			'lgtm',
			'explain',
			'smell',
			'complex',
			'untested',
			'perf',
			'ac',
			'security'
		]);
		assert.deepEqual(
			CARD_VERDICTS.map((v) => v.label),
			[
				'Exemplary',
				'Looks good',
				'Explanation',
				'Code smell',
				'Over-complex',
				'Not well tested',
				'Performance risk',
				'Doesn’t meet acceptance criteria',
				'Possible security issue'
			]
		);
		assert.deepEqual(VERDICT_IDS.filter(isBlocking), ['untested', 'perf', 'ac', 'security']);
	});
});

describe('reading cards', () => {
	const stop = pick('src/legacy.ts', 'src/types.ts');
	const read = (cards, asks = []) =>
		readCards(cards, stop, resolver(stop), { stage: 'stop-1', asks, max: 8 });

	it('reads a verdict by its id or its label, and an unknown one as an explanation', () => {
		const cards = read(
			['security', 'Not well tested', 'Over-complex', 'Looks good', 'sparkly', null].map(
				(verdict, i) => ({ verdict, title: `t${i}`, file: 'src/legacy.ts', from: 121, to: 122 })
			)
		);
		assert.deepEqual(
			cards.map((c) => c.verdict),
			['security', 'untested', 'complex', 'lgtm', 'explain', 'explain']
		);
		assert.deepEqual(
			cards.map((c) => c.id),
			['stop-1:c1', 'stop-1:c2', 'stop-1:c3', 'stop-1:c4', 'stop-1:c5', 'stop-1:c6']
		);
	});

	it('holds a card to the stage’s files and lines', () => {
		const cards = read([
			{ verdict: 'smell', title: 'Ghost', file: 'nowhere.ts', from: 1 },
			{ verdict: 'smell', title: 'Elsewhere', file: 'src/search.ts', from: 12 },
			{ verdict: 'smell', title: 'Out of range', file: 'src/legacy.ts', from: 900, to: 950 },
			{ verdict: 'ac', title: 'About the whole PR' },
			{ verdict: 'smell', title: '', file: 'src/legacy.ts', from: 121 }
		]);
		assert.deepEqual(
			cards.map((c) => [c.title, c.file, c.from]),
			[
				['Out of range', 'src/legacy.ts', null],
				['About the whole PR', null, null]
			]
		);
		assert.deepEqual(cards[1].blocks, [], 'a card on no file has no blocks');
	});

	it('keeps a secondary verdict only when it differs, a severity only for security, a suggestion only for concerns', () => {
		const [a, b, c, d] = read([
			{ verdict: 'security', also: 'untested', title: 'a', severity: 'HIGH!', suggestion: 'Fix' },
			{ verdict: 'lgtm', also: 'lgtm', title: 'b', severity: 'high', suggestion: 'Ignore me' },
			{ verdict: 'lgtm', also: 'security', title: 'c', suggestion: 'Check it' },
			{ verdict: 'smell', title: 'd', suggestion: 'None' }
		]);
		assert.deepEqual([a.secondary, a.severity, a.suggestion], ['untested', 'high', 'Fix']);
		assert.deepEqual([b.secondary, b.severity, b.suggestion], [null, null, '']);
		assert.deepEqual([c.secondary, c.severity, c.suggestion], ['security', 'medium', 'Check it']);
		assert.equal(d.suggestion, '', '"None" means no suggestion');
	});

	it('ties a card to the acceptance item it checks', () => {
		const [a, b, c] = read(
			[
				{ verdict: 'ac', ask: 2, title: 'Not ranked as asked' },
				{ verdict: 'ac', ask: 7, title: 'No such item', asked: 'Said in the issue' },
				{ verdict: 'lgtm', ask: '1', title: 'Keeps it' }
			],
			['Keep the subgraph', 'Rank by score times confidence']
		);
		assert.deepEqual([a.ask, a.asked], [2, 'Rank by score times confidence']);
		assert.deepEqual([b.ask, b.asked], [null, 'Said in the issue']);
		assert.deepEqual([c.ask, c.asked], [1, '']);
	});

	it('takes at most two more blocks of the same change, and at most the cap of cards', () => {
		const [card] = read([
			{
				verdict: 'complex',
				title: 'Four jobs',
				file: 'src/legacy.ts',
				from: 121,
				to: 125,
				more: [
					{ file: 'src/types.ts', from: 21, to: 22 },
					{ file: 'src/legacy.ts', from: 121, to: 125 },
					{ file: 'nowhere.ts', from: 1 },
					{ file: 'src/types.ts', from: 24, to: 26 }
				]
			}
		]);
		assert.deepEqual(
			card.blocks.map((b) => `${b.file}:${b.from}-${b.to}`),
			['src/legacy.ts:121-125', 'src/types.ts:21-22']
		);
		const many = readCards(
			Array.from({ length: 20 }, (_, i) => ({ title: `c${i}` })),
			stop,
			resolver(stop),
			{ stage: 'quality', max: 3 }
		);
		assert.equal(many.length, 3);
	});

	it('reads the walkthrough’s acceptance items and asks the stops to cite them', () => {
		const w = readWalkthrough(CARD_ANSWERS.walkthrough);
		assert.deepEqual(w.asks, CARD_ANSWERS.walkthrough.asks);
		assert.deepEqual(readWalkthrough({}).asks, []);
		const shape = walkthroughMessages({
			prompts: { overall: 'o', walkthrough: 'w' },
			pr: { ...sampleView(), author: 'samchen', commits: [], checks: [] },
			files: []
		})[1].content;
		assert.match(shape, /"asks"/);
		const user = changeMessages({
			prompts: { overall: 'o', change: 'c' },
			pr: { title: 'T', url: PR_URL, author: 'a' },
			stage: { id: 'stop-1', title: 'S', files: ['src/legacy.ts'] },
			files: pick('src/legacy.ts'),
			walkthrough: w
		})[1].content;
		assert.match(user, /1\. Keep the subgraph each adapter returns\n2\. Rank by score/);
		assert.match(user, /"cards"/);
		assert.match(user, /- ac \(Doesn’t meet acceptance criteria\)/);
	});
});

describe('cards and the older shapes', () => {
	it('gives a quality pass with cards its concerns as findings too', () => {
		const q = readQuality(CARD_ANSWERS.quality, pick('src/search.ts', 'src/types.ts'), resolvePath);
		assert.deepEqual(
			q.cards.map((c) => [c.id, c.verdict]),
			[
				['quality:c1', 'smell'],
				['quality:c2', 'lgtm']
			]
		);
		assert.deepEqual(
			q.findings.map((f) => [f.id, f.title, f.level, f.from, f.suggestion]),
			[['q1', 'The same spread eleven times', 'nit', 12, 'One optional() helper.']]
		);
	});

	it('gives a stop with cards each card as a note on its lines', () => {
		const stop = pick('src/legacy.ts', 'src/types.ts');
		const c = readChange(CARD_ANSWERS.change(fakeStopMessages(stop)), stop, resolvePath, {
			stage: 'stop-1'
		});
		assert.equal(c.cards.length, 3);
		assert.deepEqual(
			c.notes.map((n) => [n.title, n.tag, n.concern]),
			[
				['Possible security issue: Reads other scopes', 'moderate', 'Count only edges in scope.'],
				['Exemplary: One read in a transaction', 'simple', ''],
				[
					'Doesn’t meet acceptance criteria: Never multiplies the score',
					'moderate',
					'Multiply the score in.'
				]
			]
		);
	});

	it('reads an answer in the older shape as cards made from its findings and notes', () => {
		const q = readQuality(ANSWERS.quality, pick('src/search.ts', 'src/legacy.ts'), resolvePath);
		assert.deepEqual(
			q.cards.map((c) => [c.id, c.verdict, c.title, c.legacy]),
			[
				['quality:q2', 'smell', 'Duplicated merge', true],
				['quality:q1', 'smell', 'Long function', true],
				['quality:q3', 'smell', 'Out of range', true]
			]
		);
		const stop = pick('src/legacy.ts');
		const c = readChange(ANSWERS.change(fakeStopMessages(stop)), stop, resolvePath, {
			stage: 'stop-1'
		});
		assert.deepEqual(
			c.cards.map((x) => [x.id, x.verdict, x.file]),
			[['stop-1:n1', 'explain', 'src/legacy.ts']]
		);
	});

	it('reads a review kept from before cards as cards', () => {
		const kept = {
			stages: [
				{ id: 'quality', kind: 'quality' },
				{ id: 'stop-1', kind: 'change' }
			],
			results: {
				quality: { findings: [{ id: 'q1', title: 'Long', file: 'a.ts', from: 1, to: 2 }] },
				'stop-1': { notes: [{ id: 'n1', title: 'Core', file: 'a.ts', from: 3, concern: 'Racy' }] }
			}
		};
		assert.equal(cardsOf(kept.stages[0], null).length, 0);
		const deck = deckOf(kept);
		assert.deepEqual(
			deck.cards.map((c) => [c.id, c.verdict, c.group]),
			[
				['stop-1:n1', 'smell', 'key'],
				['quality:q1', 'smell', 'quality']
			]
		);
	});
});

describe('the deck', () => {
	it('lays the review out in the passage groups, generated hidden, cards in reading order', async () => {
		const { r } = await reviewed();
		const deck = deckOf(r);
		assert.deepEqual(
			deck.groups.map((g) => [g.id, g.title, !!g.hidden, g.state]),
			[
				['walkthrough', 'Walkthrough', false, 'done'],
				['key', 'Key changes', false, 'done'],
				['quality', 'Quality pass', false, 'done'],
				['skim', 'Skim pile', false, 'done'],
				['generated', 'Generated', true, 'done']
			]
		);
		const key = deck.groups[1];
		assert.deepEqual(
			key.stops.map((s) => [s.stage, s.title, s.cards]),
			[
				['stop-1', 'Keep the subgraph', ['stop-1:c1', 'stop-1:c2', 'stop-1:c3']],
				['stop-2', 'Build the board', ['stop-2:c1', 'stop-2:c2', 'stop-2:c3']]
			]
		);
		assert.deepEqual(
			deck.cards.map((c) => c.id),
			[...key.cards, 'quality:c1', 'quality:c2', 'skim:c1', 'generated:c1']
		);
		assert.deepEqual(deck.groups[4].files, ['dist/bundle.js', 'package-lock.json']);
		assert.equal(deck.cards.at(-1).title, '2 generated files, hidden from the review');
		assert.equal(deck.counts.security, 2);
		assert.equal(deck.counts.lgtm, 2);
		assert.equal(key.look, 4, 'four concerns to look at in the key changes');
	});

	it('lists every concern in the review in the quality pass’s checklist', async () => {
		const { r } = await reviewed();
		const q = deckOf(r).groups[2];
		assert.deepEqual(q.cards, ['quality:c1', 'quality:c2']);
		assert.deepEqual(
			q.checklist.map((c) => [c.card, c.group, c.verdict, c.blocking]),
			[
				['stop-1:c1', 'key', 'security', true],
				['stop-1:c3', 'key', 'ac', true],
				['stop-2:c1', 'key', 'security', true],
				['stop-2:c3', 'key', 'ac', true],
				['quality:c1', 'quality', 'smell', false]
			]
		);
	});

	it('links each acceptance item to the cards that check it', async () => {
		const { r } = await reviewed();
		assert.deepEqual(deckOf(r).groups[0].asks, [
			{ n: 1, text: 'Keep the subgraph each adapter returns', cards: [] },
			{ n: 2, text: 'Rank by score times path confidence', cards: ['stop-1:c3', 'stop-2:c3'] }
		]);
	});

	it('shows a stage still running as running', async () => {
		const { reviews } = setup();
		await reviews.open(PR_URL);
		const deck = deckOf(reviews.view(ID));
		assert.ok(['queued', 'running'].includes(deck.groups[0].state));
		assert.deepEqual(
			deck.cards.map((c) => c.id),
			['generated:c1']
		);
		await reviews.settled();
	});
});

describe('deciding on a card', () => {
	it('keeps accept, disagree with what to remember, and comment, and takes one back', async () => {
		const { reviews } = await reviewed();
		reviews.decideCard(ID, 'stop-1:c1', { decision: 'accept' });
		reviews.decideCard(ID, 'quality:c1', {
			decision: 'disagree',
			text: 'We like the spreads',
			remember: 'repo'
		});
		reviews.decideCard(ID, 'skim:c1', {
			decision: 'comment',
			text: 'Nice cleanup',
			remember: 'me'
		});
		const deck = deckOf(reviews.view(ID));
		const by = Object.fromEntries(deck.cards.map((c) => [c.id, c.decision]));
		assert.equal(by['stop-1:c1'].decision, 'accept');
		assert.deepEqual(
			deck.remember.map((m) => [m.card, m.scope, m.verdict, m.decision, m.text, m.repo]),
			[
				['quality:c1', 'repo', 'smell', 'disagree', 'We like the spreads', 'acme/lumen'],
				['skim:c1', 'me', 'lgtm', 'comment', 'Nice cleanup', 'acme/lumen']
			]
		);
		assert.equal(
			deck.groups[2].checklist.find((c) => c.card === 'quality:c1').decision,
			'disagree'
		);
		reviews.decideCard(ID, 'stop-1:c1', { decision: null });
		assert.equal(reviews.view(ID).cardDecisions['stop-1:c1'], undefined);
	});

	it('refuses an unknown card, decision or scope, a comment with nothing said, and remembering an accept', async () => {
		const { reviews } = await reviewed();
		assert.throws(() => reviews.decideCard(ID, 'stop-9:c1', { decision: 'accept' }), {
			status: 404
		});
		assert.throws(() => reviews.decideCard(ID, 'stop-1:c1', { decision: 'merge' }), {
			status: 400
		});
		assert.throws(() => reviews.decideCard(ID, 'stop-1:c1', { decision: 'comment', text: ' ' }), {
			status: 400
		});
		assert.throws(
			() => reviews.decideCard(ID, 'stop-1:c1', { decision: 'disagree', remember: 'world' }),
			{ status: 400 }
		);
		assert.throws(
			() => reviews.decideCard(ID, 'stop-1:c1', { decision: 'accept', remember: 'pr' }),
			{ status: 400 }
		);
		reviews.decideCard(ID, 'generated:c1', { decision: 'accept' });
		assert.equal(reviews.view(ID).cardDecisions['generated:c1'].decision, 'accept');
	});
});

describe('a card’s chat', () => {
	it('answers in the card’s own thread, reading the card, its lines and only its files', async () => {
		const { reviews, model } = await reviewed();
		reviews.ask(ID, 'stop-1', { text: 'How would it leak?', card: 'stop-1:c1' });
		await reviews.settled();
		const r = reviews.view(ID);
		assert.deepEqual(
			r.chat['stop-1:c1'].map((m) => [m.role, m.text]),
			[
				['user', 'How would it leak?'],
				['assistant', 'Because every new field is optional.']
			]
		);
		assert.equal(r.chat['stop-1'], undefined, 'the stage’s own thread is untouched');
		const sent = model.calls
			.at(-1)
			.messages.map((m) => m.content)
			.join('\n');
		assert.match(
			sent,
			/Your verdict: Possible security issue \(medium severity\), and also Not well tested\. Reads other scopes/
		);
		assert.match(sent, /Your suggestion: Count only edges in scope\./);
		assert.match(sent, /2\. Rank by score times path confidence/);
		assert.match(sent, /The lines it is about:\n\nsrc\/legacy\.ts:121-123\n {2}121 \+ graphOf 121/);
		assert.doesNotMatch(sent, /board 11/, 'no other stage’s diff');
	});

	it('refuses a card that is not the stage’s', async () => {
		const { reviews } = await reviewed();
		assert.throws(() => reviews.ask(ID, 'stop-2', { text: 'Hm?', card: 'stop-1:c1' }), {
			status: 404
		});
	});

	it('forgets a stage’s cards’ threads and decisions when the stage is read again', async () => {
		const { reviews } = await reviewed();
		reviews.ask(ID, 'stop-1', { text: 'Why?', card: 'stop-1:c1' });
		reviews.ask(ID, 'stop-1', { text: 'And the stop?' });
		reviews.decideCard(ID, 'stop-1:c1', { decision: 'accept' });
		reviews.decideCard(ID, 'stop-2:c1', { decision: 'accept' });
		await reviews.settled();
		reviews.run(ID, 'stop-1');
		await reviews.settled();
		const r = reviews.view(ID);
		assert.equal(r.chat['stop-1:c1'], undefined);
		assert.equal(r.chat['stop-1'].length, 2, 'the stage’s own thread stays');
		assert.equal(r.cardDecisions['stop-1:c1'], undefined);
		assert.equal(r.cardDecisions['stop-2:c1'].decision, 'accept');
	});
});

describe('the review the cards draft', () => {
	const review = async (decisions) => {
		const { reviews } = await reviewed();
		for (const [card, d] of Object.entries(decisions)) reviews.decideCard(ID, card, d);
		return reviews.view(ID);
	};

	it('approves when nothing is accepted but praise and explanations', async () => {
		const r = await review({
			'stop-1:c2': { decision: 'accept' },
			'generated:c1': { decision: 'accept' },
			'stop-1:c1': { decision: 'disagree', text: 'Scoped upstream' }
		});
		assert.equal(suggestVerdict(r), 'APPROVE');
		const d = draftReview(r);
		assert.deepEqual(d.comments, []);
		assert.match(
			d.body,
			/\*\*What works well:\*\*\n- `src\/legacy\.ts`: One read in a transaction/
		);
	});

	it('comments when only non-blocking concerns or comments are accepted', async () => {
		const r = await review({
			'quality:c1': { decision: 'accept' },
			'skim:c1': { decision: 'comment', text: 'Nice cleanup' }
		});
		assert.equal(suggestVerdict(r), 'COMMENT');
		const d = draftReview(r);
		assert.match(d.body, /^1 suggestion and 1 comment, none blocking/);
		assert.deepEqual(
			d.comments.map((c) => [c.path, c.start_line, c.line, c.body]),
			[
				[
					'src/search.ts',
					12,
					14,
					'**Suggestion:** Code smell: The same spread eleven times. One optional() helper.'
				],
				['src/util/helpers.ts', 1, 2, '**Comment:** Nice cleanup']
			]
		);
	});

	it('requests changes once a blocking concern is accepted, inline where its lines are', async () => {
		const r = await review({ 'stop-1:c1': { decision: 'accept' } });
		assert.equal(suggestVerdict(r), 'REQUEST_CHANGES');
		const d = draftReview(r);
		assert.deepEqual(d.comments, [
			{
				path: 'src/legacy.ts',
				line: 123,
				side: 'RIGHT',
				body: '**Change requested:** Possible security issue (medium): Reads other scopes. Count only edges in scope.',
				start_line: 121,
				start_side: 'RIGHT'
			}
		]);
		assert.match(d.body, /^1 change requested; see the comments\./);
		assert.match(
			firstmateMessage(r),
			/1\. Change at src\/legacy\.ts:121-123: Possible security issue/
		);
		assert.deepEqual(cardPoints(r).praise, []);
	});
});

describe('posting', () => {
	const posting = async (answer) => {
		const real = createGitHub(fakeGh().run);
		const github = { load: real.load, post: async () => answer };
		const reviews = createReviews({
			github,
			store: memoryStore(),
			model: () => fakeModel(CARD_ANSWERS)
		});
		await reviews.open(PR_URL);
		await reviews.settled();
		return reviews.post(ID, { event: 'APPROVE', confirm: true });
	};

	it('records what the host’s GitHub says it posted, and why', async () => {
		const r = await posting({
			url: `${PR_URL}#r1`,
			event: 'COMMENT',
			note: 'GitHub doesn’t let you approve your own pull request, so it went as a comment.'
		});
		assert.deepEqual(r.posted.event, 'COMMENT');
		assert.match(r.posted.note, /own pull request/);
	});

	it('records the event asked for when the host says nothing more', async () => {
		const r = await posting({ url: `${PR_URL}#r2`, event: 'MERGE' });
		assert.deepEqual(
			[r.posted.url, r.posted.event, r.posted.note],
			[`${PR_URL}#r2`, 'APPROVE', null]
		);
	});
});

/** The messages a stop's pass sends, enough for the fake answers to read. */
function fakeStopMessages(stop) {
	const first = stop[0].hunks[0].lines.find((l) => l.t === '+').n;
	return [
		{
			role: 'user',
			content: `Its files: ${stop.map((f) => f.path).join(', ')}\n  ${first} + x`
		}
	];
}
