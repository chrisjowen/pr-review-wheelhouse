import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createGitHub } from '../wheelhouse/engine/github.js';
import { createHandler, loopbackOrigin } from '../wheelhouse/engine/http.js';
import { DEFAULT_PROMPTS } from '../wheelhouse/engine/prompts.js';
import { createReviews } from '../wheelhouse/engine/review.js';
import { createStore } from '../wheelhouse/engine/store.js';
import { ANSWERS, fakeGh, fakeModel, PR_URL } from './helpers.js';

const dir = mkdtempSync(path.join(tmpdir(), 'pr-review-'));
const store = createStore(dir);
const model = fakeModel(ANSWERS);
const reviews = createReviews({ github: createGitHub(fakeGh().run), store, model: () => model });
let settings = { model: 'fake:7b' };
const handle = createHandler({
	reviews,
	store,
	version: '0.1.0',
	model: () => model,
	config: { get: () => settings, set: (c) => (settings = { ...settings, ...c }) }
});
const server = createServer((req, res) => void handle(req, res));
let base;
before(
	() =>
		new Promise((res) =>
			server.listen(0, '127.0.0.1', () => res((base = `http://127.0.0.1:${server.address().port}`)))
		)
);
after(() => {
	server.close();
	rmSync(dir, { recursive: true, force: true });
});

const WH = 'http://127.0.0.1:4310';
const call = (method, p, body, headers = {}) =>
	fetch(`${base}${p}`, {
		method,
		headers: {
			origin: WH,
			...(body ? { 'content-type': 'application/json', 'x-pr-review': '1' } : {}),
			...headers
		},
		body: body ? JSON.stringify(body) : undefined
	});

describe('who may use the engine', () => {
	it('knows a page on this computer', () => {
		for (const o of [
			'http://127.0.0.1:4310',
			'http://localhost:5173',
			'http://5173.localhost:4310',
			'http://[::1]:4310'
		])
			assert.ok(loopbackOrigin(o), o);
		for (const o of ['https://evil.example', 'http://127.0.0.1.evil.example', 'null', 'file://x'])
			assert.ok(!loopbackOrigin(o), o);
	});

	it('answers its health check with its identity', async () => {
		const res = await fetch(`${base}/health`);
		assert.deepEqual(await res.json(), {
			service: 'pr-review-engine',
			version: '0.1.0',
			model: 'fake:7b'
		});
	});

	it('refuses a page from another site', async () => {
		const res = await call('GET', '/api/reviews', null, { origin: 'https://evil.example' });
		assert.equal(res.status, 403);
		assert.equal(res.headers.get('access-control-allow-origin'), null);
	});

	it('refuses a changing request without its header, so a plain form cannot post', async () => {
		const res = await fetch(`${base}/api/reviews`, {
			method: 'POST',
			headers: { origin: WH, 'content-type': 'text/plain' },
			body: JSON.stringify({ url: PR_URL })
		});
		assert.equal(res.status, 403);
	});

	it('answers a loopback page’s preflight, naming that page', async () => {
		const res = await fetch(`${base}/api/reviews`, {
			method: 'OPTIONS',
			headers: {
				origin: WH,
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type,x-pr-review'
			}
		});
		assert.equal(res.status, 204);
		assert.equal(res.headers.get('access-control-allow-origin'), WH);
		assert.match(res.headers.get('access-control-allow-headers'), /x-pr-review/);
	});

	it('serves a page that closes itself once the engine has started', async () => {
		const res = await fetch(`${base}/started`);
		assert.match(await res.text(), /The PR review engine is running/);
	});
});

describe('the prompts', () => {
	it('starts from the defaults, keeps the captain’s edits on disk, and restores a default when emptied', async () => {
		let got = await (await call('GET', '/api/prompts')).json();
		assert.deepEqual(got.prompts, DEFAULT_PROMPTS);
		got = await (
			await call('PUT', '/api/prompts', {
				prompts: { quality: 'Only nesting.', overall: 'Be kind.' }
			})
		).json();
		assert.equal(got.prompts.quality, 'Only nesting.');
		assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'prompts.json'), 'utf8')), {
			overall: 'Be kind.',
			quality: 'Only nesting.'
		});
		got = await (await call('PUT', '/api/prompts', { prompts: { overall: '' } })).json();
		assert.equal(got.prompts.overall, DEFAULT_PROMPTS.overall);
		assert.equal(got.prompts.quality, 'Only nesting.');
	});
});

describe('a review over HTTP', () => {
	it('opens a PR, runs its stages and keeps it on disk', async () => {
		const opened = await call('POST', '/api/reviews', { url: PR_URL });
		assert.equal(opened.status, 200);
		const { id } = await opened.json();
		await reviews.settled();
		const r = await (await call('GET', `/api/reviews/${id}`)).json();
		assert.equal(r.runs.skim.state, 'done');
		assert.ok(
			JSON.parse(readFileSync(path.join(dir, 'reviews', `${id}.json`), 'utf8')).results.quality
		);
		const list = await (await call('GET', '/api/reviews')).json();
		assert.deepEqual(
			list.reviews.map((x) => x.number),
			[48]
		);
	});

	it('says why a request failed, with a fitting status', async () => {
		let res = await call('POST', '/api/reviews', { url: 'not a pr' });
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /isn’t a GitHub pull request URL/);
		res = await call('GET', '/api/reviews/nope__nope__1');
		assert.equal(res.status, 404);
		res = await call('POST', '/api/reviews/acme__lumen__48/post', { event: 'COMMENT' });
		assert.equal(res.status, 400);
	});

	it('answers every review with its deck of cards, and takes a card’s decision and question', async () => {
		const id = 'acme__lumen__48';
		const r = await (await call('GET', `/api/reviews/${id}`)).json();
		assert.deepEqual(
			r.deck.groups.map((g) => g.id),
			['walkthrough', 'key', 'quality', 'skim', 'generated']
		);
		const card = r.deck.cards.find((c) => c.group === 'key');
		assert.ok(card, 'a stop’s notes read as cards');
		let res = await call('POST', `/api/reviews/${id}/card`, {
			card: card.id,
			decision: 'disagree',
			text: 'Fine here',
			remember: 'pr'
		});
		assert.equal(res.status, 200);
		const decided = await res.json();
		assert.equal(decided.deck.cards.find((c) => c.id === card.id).decision.decision, 'disagree');
		assert.deepEqual(
			decided.deck.remember.map((m) => [m.card, m.scope]),
			[[card.id, 'pr']]
		);
		assert.equal(
			JSON.parse(readFileSync(path.join(dir, 'reviews', `${id}.json`), 'utf8')).deck,
			undefined,
			'the deck is never kept'
		);
		res = await call('POST', `/api/reviews/${id}/card`, { card: 'stop-9:c1', decision: 'accept' });
		assert.equal(res.status, 404);
		res = await call('POST', `/api/reviews/${id}/ask`, {
			stage: card.stage,
			card: card.id,
			text: 'Why?'
		});
		assert.equal(res.status, 200);
		await reviews.settled();
		const after = await (await call('GET', `/api/reviews/${id}`)).json();
		assert.equal(after.chat[card.id].at(-1).text, 'Because every new field is optional.');
	});

	it('takes the plugin’s settings from the tab', async () => {
		const res = await call('PUT', '/api/config', { model: 'llama3.1' });
		assert.equal((await res.json()).model, 'llama3.1');
	});
});

describe('what the chat reads through the engine', () => {
	it('answers a changed file, the project and who gh is', async () => {
		await call('POST', '/api/reviews', { url: PR_URL });
		const file = await call('GET', '/api/reviews/acme__lumen__48/file?path=src%2Fsearch.ts');
		assert.equal(file.status, 404, 'the fake gh keeps no file text');
		assert.match((await file.json()).error, /isn’t there at the PR’s head/);
		const other = await call('GET', '/api/reviews/acme__lumen__48/file?path=nope.ts');
		assert.match((await other.json()).error, /isn’t part of this pull request/);
		const project = await call('GET', '/api/reviews/acme__lumen__48/project');
		assert.equal((await project.json()).description, 'Graph search on a board');
		const who = await call('GET', '/api/identity');
		assert.deepEqual(await who.json(), { login: 'reviewer' });
		await reviews.settled();
	});
});
