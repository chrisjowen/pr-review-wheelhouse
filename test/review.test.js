import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHub } from '../wheelhouse/engine/github.js';
import { createReviews } from '../wheelhouse/engine/review.js';
import { memoryStore } from '../wheelhouse/engine/store.js';
import { ANSWERS, fakeGh, fakeModel, PR_URL, sampleView, stageOfMessages } from './helpers.js';

const ID = 'acme__lumen__48';

function setup({
	answers = ANSWERS,
	gh = fakeGh(),
	model = fakeModel(answers),
	store = memoryStore()
} = {}) {
	let t = 1_000;
	const reviews = createReviews({
		github: createGitHub(gh.run),
		store,
		model: () => model,
		now: () => ++t
	});
	return { reviews, gh, model, store };
}

describe('opening a review', () => {
	it('reads the PR and its diff with gh, hides generated files and plans from the files', async () => {
		const { reviews, gh } = setup();
		const r = await reviews.open(PR_URL);
		assert.equal(r.id, ID);
		assert.deepEqual(gh.calls.map((c) => c.argv.slice(0, 2).join(' ')).sort(), [
			'pr diff',
			'pr view'
		]);
		assert.ok(gh.calls.every((c) => c.argv.includes('acme/lumen')));
		assert.equal(r.pr.title, 'Draw returned subgraphs on the board');
		assert.equal(r.pr.headSha, 'a'.repeat(40));
		assert.deepEqual(
			r.pr.checks.map((c) => `${c.name}:${c.state}`),
			['test:pass', 'lint:fail', 'deploy:pending']
		);
		assert.deepEqual(
			r.pr.images.map((i) => i.alt),
			['Board after', 'Two adapters'],
			'https images only'
		);
		assert.deepEqual(
			r.files.find((f) => f.path === 'dist/bundle.js').hunks,
			[],
			'generated diffs are dropped'
		);
		assert.equal(r.plan.source, 'heuristic');
		assert.ok(['queued', 'running'].includes(r.runs.walkthrough.state));
		await reviews.settled();
	});

	it('refuses something that is not a PR URL', async () => {
		const { reviews } = setup();
		await assert.rejects(reviews.open('https://example.com/x'), { status: 400 });
	});
});

describe('running the stages', () => {
	it('runs the walkthrough, takes its stops, then runs every other stage once', async () => {
		const { reviews, model } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		const r = reviews.view(ID);
		assert.equal(r.plan.source, 'model');
		assert.deepEqual(
			r.stages.map((s) => [s.id, s.files.join(',')]),
			[
				['walkthrough', ''],
				['quality', 'src/legacy.ts,src/types.ts,src/search.ts,src/util/helpers.ts'],
				['stop-1', 'src/legacy.ts,src/types.ts'],
				['stop-2', 'src/search.ts'],
				[
					'skim',
					'src/util/helpers.ts,test/search.test.ts,README.md,package.json,docs/guide.md,assets/logo.png'
				]
			]
		);
		assert.deepEqual(
			model.calls.map((c) => c.stage),
			['walkthrough', 'quality', 'change', 'change', 'skim']
		);
		assert.ok(
			model.calls.every((c) => c.json),
			'stage passes ask for JSON'
		);
		for (const s of r.stages) assert.equal(r.runs[s.id].state, 'done', s.id);
		assert.equal(
			r.results.walkthrough.headline,
			'The board now draws the subgraph adapters return.'
		);
		assert.equal(r.results.walkthrough.stops, undefined, 'the plan holds the stops');
		assert.equal(r.results['stop-1'].notes[0].file, 'src/legacy.ts');
		assert.equal(r.results['stop-2'].complexity, 'complex');
		assert.equal(r.results.skim.files.length, 6);
	});

	it('runs the stage the captain is looking at before the others', async () => {
		const { reviews, model } = setup();
		await reviews.open(PR_URL);
		reviews.focus(ID, 'skim');
		await reviews.settled();
		assert.deepEqual(
			model.calls.map((c) => c.stage),
			['walkthrough', 'skim', 'quality', 'change', 'change']
		);
	});

	it('still plans and runs the rest when the walkthrough fails, and says why', async () => {
		const { reviews, model } = setup({ answers: { ...ANSWERS, walkthrough: 'not json at all' } });
		await reviews.open(PR_URL);
		await reviews.settled();
		const r = reviews.view(ID);
		assert.equal(r.runs.walkthrough.state, 'failed');
		assert.match(r.runs.walkthrough.reason, /didn’t answer with JSON/);
		assert.equal(r.plan.source, 'heuristic');
		assert.ok(model.calls.length > 1);
		assert.equal(r.runs.quality.state, 'done');
	});

	it('says plainly when the model is not there', async () => {
		const { reviews } = setup({ model: fakeModel(ANSWERS, { ok: false }) });
		await reviews.open(PR_URL);
		await reviews.settled();
		const r = reviews.view(ID);
		assert.equal(r.runs.walkthrough.state, 'failed');
		assert.equal(r.runs.walkthrough.reason, 'Ollama isn’t answering.');
	});

	it('runs a stage again on request, with the prompts as they are now', async () => {
		const { reviews, model, store } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		store.savePrompts({ quality: 'Only look for nesting.' });
		reviews.run(ID, 'quality');
		await reviews.settled();
		assert.equal(model.calls.at(-1).stage, 'quality');
		assert.match(model.calls.at(-1).messages[1].content, /^Only look for nesting\./);
	});

	it('forgets what was said about a stop whose files a new walkthrough changes', async () => {
		let second = false;
		const answers = {
			...ANSWERS,
			walkthrough: () =>
				second
					? {
							...ANSWERS.walkthrough,
							stops: [
								ANSWERS.walkthrough.stops[0],
								{ title: 'Helpers', files: ['src/util/helpers.ts'] }
							]
						}
					: ANSWERS.walkthrough
		};
		const { reviews } = setup({ answers });
		await reviews.open(PR_URL);
		await reviews.settled();
		reviews.mark(ID, 'stop-1', true);
		reviews.mark(ID, 'stop-2', true);
		second = true;
		reviews.run(ID, 'walkthrough');
		await reviews.settled();
		const r = reviews.view(ID);
		assert.deepEqual(r.reviewed, ['stop-1'], 'stop-1 kept its files, stop-2 did not');
		assert.equal(r.stages.find((s) => s.id === 'stop-2').title, 'Helpers');
		assert.equal(r.runs['stop-2'].state, 'done', 'and was run again');
	});
});

describe('reopening a review', () => {
	it('keeps the review while the PR’s head is the same', async () => {
		const store = memoryStore();
		const a = setup({ store });
		await a.reviews.open(PR_URL);
		await a.reviews.settled();
		a.reviews.mark(ID, 'walkthrough', true);
		const b = setup({ store });
		const r = await b.reviews.open(PR_URL);
		await b.reviews.settled();
		assert.deepEqual(r.reviewed, ['walkthrough']);
		assert.equal(b.model.calls.length, 0, 'nothing is asked again');
	});

	it('starts afresh when the PR has a new head, and says so', async () => {
		const store = memoryStore();
		const a = setup({ store });
		await a.reviews.open(PR_URL);
		await a.reviews.settled();
		const b = setup({ store, gh: fakeGh({ view: sampleView({ headRefOid: 'b'.repeat(40) }) }) });
		const r = await b.reviews.open(PR_URL);
		assert.equal(r.previous.headSha, 'a'.repeat(40));
		assert.deepEqual(r.results, {});
		await b.reviews.settled();
	});

	it('marks a run the engine was killed during as failed', async () => {
		const store = memoryStore();
		store.saveReview({
			schema: 'pr-review.v1',
			id: ID,
			rev: 1,
			updatedAt: 1,
			pr: { url: PR_URL, headSha: 'x' },
			stages: [],
			runs: { quality: { state: 'running' } },
			chat: { quality: [{ role: 'assistant', text: '', pending: true }] },
			results: {},
			requests: [],
			decisions: {},
			reviewed: []
		});
		const { reviews } = setup({ store });
		const r = reviews.view(ID);
		assert.equal(r.runs.quality.state, 'failed');
		assert.equal(r.chat.quality[0].pending, false);
		assert.equal(r.chat.quality[0].error, true);
	});
});

describe('the chat beside a stage', () => {
	it('answers a question with the stage’s context and the attached lines', async () => {
		const { reviews, model } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		reviews.ask(ID, 'stop-1', {
			text: 'Why prefix?',
			attach: { file: 'src/legacy.ts', from: 122, to: 121 }
		});
		await reviews.settled();
		const r = reviews.view(ID);
		assert.deepEqual(
			r.chat['stop-1'].map((m) => [m.role, m.text]),
			[
				['user', 'Why prefix?'],
				['assistant', 'Because every new field is optional.']
			]
		);
		assert.deepEqual(r.chat['stop-1'][0].attach, { file: 'src/legacy.ts', from: 121, to: 122 });
		const call = model.calls.at(-1);
		assert.equal(call.stage, 'chat');
		assert.ok(!call.json, 'chat answers in prose');
		assert.match(
			call.messages.at(-1).content,
			/^About src\/legacy\.ts:121-122:\n121 \+ graphOf 121\n122 \+ graphOf 122\n\nWhy prefix\?/
		);
	});

	it('ignores lines from files the stage does not hold', async () => {
		const { reviews } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		reviews.ask(ID, 'stop-1', {
			text: 'And this?',
			attach: { file: 'src/search.ts', from: 11, to: 12 }
		});
		assert.equal(reviews.view(ID).chat['stop-1'][0].attach, null);
		await reviews.settled();
	});

	it('says why when the model cannot answer', async () => {
		const { reviews } = setup({
			answers: { ...ANSWERS, chat: new Error('Ollama stopped answering.') }
		});
		await reviews.open(PR_URL);
		await reviews.settled();
		reviews.ask(ID, 'walkthrough', { text: 'Hello?' });
		await reviews.settled();
		const reply = reviews.view(ID).chat.walkthrough[1];
		assert.equal(reply.error, true);
		assert.match(reply.text, /^I couldn’t answer: Ollama stopped answering\./);
	});

	it('refuses an empty question', async () => {
		const { reviews } = setup();
		await reviews.open(PR_URL);
		assert.throws(() => reviews.ask(ID, 'walkthrough', { text: '  ' }), /Say something/);
		await reviews.settled();
	});
});

describe('change requests and decisions', () => {
	it('pins a change request to its lines, without asking the model', async () => {
		const { reviews, model } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		const before = model.calls.length;
		reviews.request(ID, 'stop-2', {
			text: 'Build the why per adapter.',
			attach: { file: 'src/search.ts', from: 108, to: 110 }
		});
		const r = reviews.view(ID);
		assert.deepEqual(
			r.requests.map((q) => [q.stage, q.file, q.from, q.to, q.text]),
			[['stop-2', 'src/search.ts', 108, 110, 'Build the why per adapter.']]
		);
		assert.equal(r.chat['stop-2'].at(-1).role, 'change');
		assert.equal(model.calls.length, before);
		reviews.unrequest(ID, r.requests[0].id);
		assert.deepEqual(reviews.view(ID).requests, []);
		assert.equal(reviews.view(ID).chat['stop-2'].at(-1).withdrawn, true);
	});

	it('takes a one-file stop’s file when no lines are attached', async () => {
		const { reviews } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		reviews.request(ID, 'stop-2', { text: 'Split this file.' });
		assert.equal(reviews.view(ID).requests[0].file, 'src/search.ts');
	});

	it('keeps, dismisses and forgets findings, and marks stages reviewed', async () => {
		const { reviews } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		reviews.decide(ID, 'q1', 'keep');
		reviews.decide(ID, 'q2', 'dismiss');
		reviews.decide(ID, 'q2', null);
		reviews.mark(ID, 'quality', true);
		reviews.mark(ID, 'quality', true);
		const r = reviews.view(ID);
		assert.deepEqual(r.decisions, { q1: 'keep' });
		assert.deepEqual(r.reviewed, ['quality']);
		assert.throws(() => reviews.mark(ID, 'nope', true), { status: 404 });
	});
});

describe('posting to GitHub', () => {
	it('never posts without the captain’s confirmation', async () => {
		const { reviews, gh } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		await assert.rejects(reviews.post(ID, { event: 'COMMENT' }), /confirmation/);
		await assert.rejects(
			reviews.post(ID, { event: 'MERGE', confirm: true }),
			/approve, comment or request changes/
		);
		assert.ok(!gh.calls.some((c) => c.argv[0] === 'api'));
	});

	it('posts the draft the captain saw on the reviewed head, and records it', async () => {
		const { reviews, gh } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		reviews.request(ID, 'stop-2', {
			text: 'Per adapter.',
			attach: { file: 'src/search.ts', from: 108, to: 110 }
		});
		const r = await reviews.post(ID, {
			event: 'REQUEST_CHANGES',
			body: 'One change.',
			comments: [
				{ path: 'src/search.ts', line: 110, start_line: 108, side: 'RIGHT', body: 'Per adapter.' },
				{ path: 'x', line: 'one' }
			],
			confirm: true
		});
		const call = gh.calls.find((c) => c.argv[0] === 'api');
		assert.deepEqual(call.argv, [
			'api',
			'-X',
			'POST',
			'repos/acme/lumen/pulls/48/reviews',
			'--input',
			'-'
		]);
		const sent = JSON.parse(call.input);
		assert.equal(sent.commit_id, 'a'.repeat(40));
		assert.equal(sent.event, 'REQUEST_CHANGES');
		assert.equal(sent.body, 'One change.');
		assert.equal(sent.comments.length, 1, 'a malformed comment is dropped');
		assert.equal(r.posted.url, `${PR_URL}#pullrequestreview-9`);
	});

	it('explains GitHub refusing a verdict on your own PR', async () => {
		const gh = fakeGh({
			onPost: () => ({
				ok: false,
				stdout:
					'{"message":"Unprocessable Entity","errors":["Can not request changes on your own pull request"]}',
				stderr: 'HTTP 422'
			})
		});
		const { reviews } = setup({ gh });
		await reviews.open(PR_URL);
		await reviews.settled();
		await assert.rejects(reviews.post(ID, { event: 'REQUEST_CHANGES', confirm: true }), {
			status: 502,
			message: /your own pull request\. Post it as a comment instead\./
		});
		assert.equal(reviews.view(ID).posted, null);
	});
});

describe('starting a review over', () => {
	it('forgets everything and reads the PR again', async () => {
		const { reviews } = setup();
		await reviews.open(PR_URL);
		await reviews.settled();
		reviews.mark(ID, 'walkthrough', true);
		reviews.decide(ID, 'q1', 'keep');
		const opened = reviews.view(ID).openedAt;
		const r = await reviews.restart(ID);
		await reviews.settled();
		assert.notEqual(r.openedAt, opened);
		assert.deepEqual(r.reviewed, []);
		assert.deepEqual(r.decisions, {});
		assert.equal(reviews.view(ID).runs.walkthrough.state, 'done');
		assert.equal(reviews.list().length, 1);
	});

	it('is not undone by a pass that was still running for the old review', async () => {
		const { model, running } = holding('quality');
		const { reviews, store } = setup({ model });
		await reviews.open(PR_URL);
		await running;
		reviews.decide(ID, 'q1', 'keep');
		const opened = reviews.view(ID).openedAt;
		const r = await reviews.restart(ID);
		await reviews.settled();
		assert.notEqual(r.openedAt, opened);
		assert.equal(reviews.view(ID), r);
		assert.deepEqual(reviews.view(ID).decisions, {});
		assert.equal(store.review(ID).openedAt, r.openedAt);
		assert.deepEqual(store.review(ID).decisions, {});
	});

	it('runs the new walkthrough when the head moves while the old one is running', async () => {
		const { model, running } = holding('walkthrough');
		const view = sampleView();
		const { reviews, store } = setup({ model, gh: fakeGh({ view }) });
		await reviews.open(PR_URL);
		await running;
		view.headRefOid = 'b'.repeat(40);
		const r = await reviews.open(PR_URL);
		await reviews.settled();
		assert.equal(reviews.view(ID), r);
		assert.equal(r.runs.walkthrough.state, 'done');
		assert.equal(r.results.walkthrough.headline, ANSWERS.walkthrough.headline);
		assert.equal(store.review(ID).pr.headSha, 'b'.repeat(40));
		assert.equal(store.review(ID).runs.walkthrough.state, 'done');
	});
});

/** A model whose first pass for `stage` runs until it is stopped. */
function holding(stage) {
	const base = fakeModel(ANSWERS);
	let started;
	const running = new Promise((res) => (started = res));
	let held = false;
	const model = {
		...base,
		generate(o) {
			if (held || stageOfMessages(o.messages) !== stage) return base.generate(o);
			held = true;
			started();
			return new Promise((_res, rej) =>
				o.signal.addEventListener('abort', () => rej(new Error('stopped')))
			);
		}
	};
	return { model, running };
}
