import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDiff } from '../wheelhouse/engine/diff.js';
import {
	draftReview,
	firstmateHref,
	firstmateMessage,
	keptFindings,
	reviewPoints,
	suggestVerdict
} from '../wheelhouse/ui/draft.js';
import { PR_URL, sampleDiff } from './helpers.js';

const files = parseDiff(sampleDiff());
const findings = [
	{
		id: 'q1',
		title: 'Long function',
		level: 'worth',
		file: 'src/search.ts',
		from: 12,
		to: 30,
		suggestion: 'Split it.'
	},
	{
		id: 'q2',
		title: 'Name',
		level: 'nit',
		file: 'src/legacy.ts',
		from: 121,
		to: 121,
		suggestion: ''
	},
	{
		id: 'q3',
		title: 'Dismissed one',
		level: 'nit',
		file: 'src/legacy.ts',
		from: 122,
		to: 122,
		suggestion: 'x'
	}
];
const review = (over = {}) => ({
	pr: { url: PR_URL, title: 'Draw returned subgraphs' },
	files,
	results: { quality: { findings } },
	decisions: { q1: 'keep', q2: 'keep', q3: 'dismiss' },
	requests: [
		{
			id: 'r1',
			stage: 'stop-1',
			file: 'src/search.ts',
			from: 108,
			to: 110,
			text: 'Build each path’s why from its own adapter.'
		},
		{
			id: 'r2',
			stage: 'stop-1',
			file: 'src/search.ts',
			from: 40,
			to: 108,
			text: 'Spans two hunks.'
		},
		{ id: 'r3', stage: 'stop-2', file: 'src/search.ts', from: 60, to: 60, text: 'Between hunks.' },
		{
			id: 'r4',
			stage: 'walkthrough',
			file: null,
			from: null,
			to: null,
			text: 'Tidy the description.'
		}
	],
	...over
});

describe('the suggested verdict', () => {
	it('requests changes once any change is asked, comments with only suggestions, else approves', () => {
		assert.equal(suggestVerdict(review()), 'REQUEST_CHANGES');
		assert.equal(suggestVerdict(review({ requests: [] })), 'COMMENT');
		assert.equal(suggestVerdict(review({ requests: [], decisions: {} })), 'APPROVE');
	});
});

describe('the review points', () => {
	it('are the change requests, then the suggestions kept', () => {
		assert.deepEqual(
			keptFindings(review()).map((f) => f.id),
			['q1', 'q2']
		);
		assert.deepEqual(
			reviewPoints(review()).map((p) => [p.kind, p.file, p.from]),
			[
				['change', 'src/search.ts', 108],
				['change', 'src/search.ts', 40],
				['change', 'src/search.ts', 60],
				['change', null, null],
				['suggestion', 'src/search.ts', 12],
				['suggestion', 'src/legacy.ts', 121]
			]
		);
	});
});

describe('drafting the GitHub review', () => {
	it('puts points inside one hunk inline, multi-line when they span lines', () => {
		const d = draftReview(review());
		assert.equal(d.event, 'REQUEST_CHANGES');
		assert.deepEqual(d.comments[0], {
			path: 'src/search.ts',
			line: 110,
			side: 'RIGHT',
			start_line: 108,
			start_side: 'RIGHT',
			body: '**Change requested:** Build each path’s why from its own adapter.'
		});
		const spanning = d.comments.find((c) => c.body.includes('Spans two hunks'));
		assert.equal(spanning.line, 108, 'ends inside a hunk, so it sits on its last line');
		assert.equal(spanning.start_line, undefined, 'but cannot start in another hunk');
		assert.deepEqual(
			d.comments.map((c) => c.body.split(' ')[0]),
			['**Change', '**Change', '**Suggestion:**', '**Suggestion:**']
		);
		assert.equal(d.comments.find((c) => c.path === 'src/legacy.ts').body, '**Suggestion:** Name');
	});

	it('puts points it cannot anchor in the body, with their place', () => {
		const d = draftReview(review());
		assert.match(d.body, /^4 changes requested, and 2 suggestions; see the comments\./);
		assert.match(d.body, /- \*\*Change requested:\*\* `src\/search\.ts:60`: Between hunks\./);
		assert.match(d.body, /\n- \*\*Change requested:\*\* Tidy the description\.$/);
		assert.doesNotMatch(d.body, /Build each path/);
	});

	it('takes the verdict and summary the captain chose', () => {
		const d = draftReview(review(), { event: 'COMMENT', summary: 'Nice work; a few thoughts.' });
		assert.equal(d.event, 'COMMENT');
		assert.match(d.body, /^Nice work; a few thoughts\./);
		assert.equal(draftReview(review(), { event: 'MERGE' }).event, 'REQUEST_CHANGES');
		assert.equal(draftReview(review({ requests: [], decisions: {} })).body, 'Looks good to me.');
	});
});

describe('the message to Firstmate', () => {
	it('names the PR by its URL and lists each point with its place', () => {
		const text = firstmateMessage(review());
		assert.equal(
			text,
			[
				`Review fixes for ${PR_URL} (Draw returned subgraphs).`,
				'From my review, please make these changes on the PR branch:',
				'1. Change at src/search.ts:108-110: Build each path’s why from its own adapter.',
				'2. Change at src/search.ts:40-108: Spans two hunks.',
				'3. Change at src/search.ts:60: Between hunks.',
				'4. Change: Tidy the description.',
				'5. Suggestion at src/search.ts:12-30: Long function. Split it.',
				'6. Suggestion at src/legacy.ts:121: Name'
			].join('\n')
		);
	});

	it('opens Wheelhouse’s chat with it waiting in the box', () => {
		assert.equal(firstmateHref('Fix a & b'), '/?draft=Fix%20a%20%26%20b');
	});
});
