import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { createGitHub } from '../wheelhouse/engine/github.js';
import { createHandler } from '../wheelhouse/engine/http.js';
import { createReviews } from '../wheelhouse/engine/review.js';
import { memoryStore } from '../wheelhouse/engine/store.js';
import { ANSWERS, fakeGh, fakeModel, PR_URL, sampleView } from './helpers.js';

const window = new Window({ url: 'http://127.0.0.1:4310/projects/lumen/pr-review/review' });
const gh = fakeGh({ view: sampleView({ title: 'Draw <img src=x onerror=alert(1)> boards' }) });
const model = fakeModel(ANSWERS);
const reviews = createReviews({
	github: createGitHub(gh.run),
	store: memoryStore(),
	model: () => model
});
const handle = createHandler({
	reviews,
	store: memoryStore(),
	version: '0.1.0',
	model: () => model,
	config: { get: () => ({}), set: (c) => c }
});
const server = createServer((req, res) => void handle(req, res));
let engineUrl;

before(async () => {
	await new Promise((res) => server.listen(0, '127.0.0.1', res));
	engineUrl = `http://127.0.0.1:${server.address().port}`;
	for (const k of [
		'window',
		'document',
		'HTMLElement',
		'customElements',
		'Node',
		'localStorage',
		'navigator'
	]) {
		Object.defineProperty(globalThis, k, {
			value: k === 'window' ? window : window[k],
			configurable: true,
			writable: true
		});
	}
	await import('../wheelhouse/ui/index.js');
});
after(async () => {
	server.close();
	await window.happyDOM.close();
});

const DATA = {
	schema: 'pr-review-tab.v1',
	project: 'lumen',
	prs: [
		{
			number: 48,
			title: 'Draw boards',
			url: PR_URL,
			author: 'samchen',
			isDraft: false,
			updatedAt: new Date().toISOString(),
			additions: 480,
			deletions: 8,
			changedFiles: 11,
			branch: 'b'
		}
	],
	reason: null,
	settings: { backend: 'ollama', ollamaModel: 'fake:7b', claudeModel: 'sonnet' }
};

function mount(host) {
	const el = document.createElement('pr-review-tab');
	el.host = host;
	el.entry = {
		key: 'k',
		slot: 'project.tab',
		pluginId: 'pr-review',
		contributionId: 'review',
		title: 'PR review',
		projectId: 'lumen'
	};
	document.body.append(el);
	globalThis.__el = el;
	el.data = DATA;
	return el;
}
const $ = (el, sel) => el.shadowRoot.querySelector(sel);
const $$ = (el, sel) => [...el.shadowRoot.querySelectorAll(sel)];
const text = (el) => el.shadowRoot.textContent.replace(/\s+/g, ' ');
const button = (el, label) => $$(el, 'button').find((b) => b.textContent.trim() === label);
async function until(fn, ms = 4000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(
		`timed out: ${globalThis.__el ? globalThis.__el.shadowRoot.querySelector('.app')?.textContent.replace(/\s+/g, ' ').slice(0, 900) : ''}`
	);
}
const running = () => ({
	launched: [],
	async service() {
		return { state: 'running', url: engineUrl, launchable: false, hint: null };
	},
	async launch() {}
});

describe('before the engine runs', () => {
	it('lists the open PRs and offers to start the engine', async () => {
		const launched = [];
		let up = false;
		const el = mount({
			async service() {
				return up
					? { state: 'running', url: engineUrl, launchable: false }
					: {
							state: 'stopped',
							url: engineUrl,
							launchable: true,
							hint: 'node main.js --port 4791'
						};
			},
			async launch(id, o) {
				launched.push([id, o]);
				up = true;
			}
		});
		await until(() => button(el, 'Start the engine'));
		assert.match(text(el), /The review engine isn’t running/);
		assert.match(text(el), /#48 Draw boards/);
		assert.ok($(el, '.pr-row button').disabled, 'nothing to review with yet');
		button(el, 'Start the engine').click();
		await until(() => !button(el, 'Start the engine'));
		assert.deepEqual(launched, [['engine', { project: null, open: `${engineUrl}/started` }]]);
		assert.equal($(el, '.pr-row button').disabled, false);
		el.remove();
	});
});

describe('a review in the tab', () => {
	let el;
	before(async () => {
		localStorage.clear();
		el = mount(running());
		await until(() => $(el, '.pr-row button') && !$(el, '.pr-row button').disabled);
		$(el, '.pr-row button').click();
		await until(
			() => $(el, '.rail') && $$(el, '.stop').length === 5 && /The board now draws/.test(text(el)),
			8000
		);
	});
	after(() => el.remove());

	it('opens on the walkthrough with the model’s headline, the evidence and the reading plan', () => {
		assert.equal(
			$(el, '.stage h1').textContent,
			'The board now draws the subgraph adapters return.'
		);
		const t = text(el);
		assert.match(t, /1 of 3 checks passed|1 of 3 checks failing/);
		assert.match(t, /Screenshots and evidence/);
		assert.equal($$(el, '.shot img').length, 2);
		assert.match(t, /The reading plan/);
		assert.match(t, /Keep the subgraph/);
		assert.match(t, /fake:7b grouped the files into these stops/);
		assert.match($(el, '.chat-log').textContent, /This looks big but it is not\./);
		assert.deepEqual(
			$$(el, '.suggest-chip').map((b) => b.textContent),
			['Why not v2?', 'Riskiest part?']
		);
	});

	it('shows text from the PR as text, never as HTML', () => {
		assert.equal($(el, '.pr-title').textContent, 'Draw <img src=x onerror=alert(1)> boards');
		assert.equal($$(el, '.bar img').length, 0);
	});

	it('moves to a stop with its notes pinned above the hunk, and attaches clicked lines to the chat', async () => {
		$$(el, '.stop-btn')[2].click();
		await until(() => $(el, '.note'));
		assert.match($(el, '.stage h1').textContent, /Keep the subgraph/);
		assert.match($(el, '.note-title').textContent, /The core/);
		assert.ok($$(el, 'tr.hot').length > 0, 'the note’s lines are highlighted');
		const ln = $$(el, 'td.ln.can').find((td) => td.textContent === '121');
		ln.click();
		assert.match($(el, '.attach-chip').textContent, /src\/legacy\.ts:121/);
		const ln2 = $$(el, 'td.ln.can').find((td) => td.textContent === '123');
		ln2.dispatchEvent(new window.MouseEvent('click', { bubbles: true, shiftKey: true }));
		assert.match($(el, '.attach-chip').textContent, /src\/legacy\.ts:121–123/);
	});

	it('asks the review mate about the attached lines', async () => {
		$(el, 'textarea').value = 'Why prefix?';
		$(el, '.composer').dispatchEvent(new window.Event('submit', { cancelable: true }));
		await until(() => /Because every new field is optional/.test($(el, '.chat-log').textContent));
		assert.match($(el, '.msg-user').textContent, /legacy\.ts:121–123Why prefix\?/);
		assert.equal($(el, '.attach-chip'), null);
	});

	it('pins a change request under its line', async () => {
		button(el, 'Request change').click();
		$$(el, 'td.ln.can')
			.find((td) => td.textContent === '125')
			.click();
		$(el, 'textarea').value = 'Comment the prefix rule.';
		$(el, '.composer').dispatchEvent(new window.Event('submit', { cancelable: true }));
		await until(() => $(el, 'tr.inline-req'));
		assert.match($(el, 'tr.inline-req').textContent, /Change requested: Comment the prefix rule\./);
		assert.match($(el, '.msg-change').textContent, /Change requested/);
		await until(() => /1 change asked/.test($(el, '.rail').textContent));
	});

	it('keeps a quality finding as a suggestion', async () => {
		$$(el, '.stop-btn')[1].click();
		await until(() => $(el, '.finding'));
		const keep = $$(el, '.finding')[0].querySelector('button');
		keep.click();
		await until(() => /Goes into your review as a suggestion/.test(text(el)));
	});

	it('marks a stage reviewed and moves on', async () => {
		button(el, 'Mark reviewed, next stop').click();
		await until(() => /Stop 1 of 2/.test($(el, '.stage .eyebrow').textContent));
		assert.match($(el, '.voyage-label').textContent, /1 of 5 reviewed/);
	});

	it('drafts the review, and posts it only after the captain confirms', async () => {
		button(el, 'Finish review').click();
		await until(() => $(el, '.modal'));
		assert.equal($(el, '.verdicts .pill-btn.on').textContent, 'Request changes');
		assert.match($(el, '.draft-body').value, /^1 change requested, and 1 suggestion/);
		assert.ok(!gh.calls.some((c) => c.argv[0] === 'api'));
		button(el, 'Post to GitHub').click();
		assert.match(
			$(el, '.confirm').textContent,
			/posts a “Request changes” review with 2 inline comments to acme\/lumen#48/
		);
		assert.ok(!gh.calls.some((c) => c.argv[0] === 'api'), 'still nothing posted');
		button(el, 'Post review').click();
		await until(() => $(el, '.done-note'));
		const sent = JSON.parse(gh.calls.find((c) => c.argv[0] === 'api').input);
		assert.equal(sent.event, 'REQUEST_CHANGES');
		assert.equal(sent.comments.length, 2);
	});

	it('hands the change requests to Firstmate through the chat box', async () => {
		button(el, 'Send to Firstmate').click();
		const link = $$(el, 'a').find((a) => a.textContent === 'Open in Firstmate’s chat');
		const href = link.getAttribute('href');
		assert.match(href, /^\/\?draft=/);
		const message = decodeURIComponent(href.slice('/?draft='.length));
		assert.match(message, new RegExp(`^Review fixes for ${PR_URL.replace(/[./]/g, '\\$&')}`));
		assert.match(message, /1\. Change at src\/legacy\.ts:125: Comment the prefix rule\./);
	});

	it('edits the prompts in a drawer', async () => {
		$$(el, '.modal-foot .ghost-btn')[0].click();
		button(el, 'Prompts').click();
		await until(() => $$(el, '.field textarea').length === 5);
		assert.match($$(el, '.field label')[0].textContent, /Overall review prompt/);
	});
});

describe('coming back to the tab', () => {
	it('reopens the last review as kept, and reads the PR again only on a click', async () => {
		const reads = gh.calls.length;
		const passes = model.calls.length;
		const el = mount(running());
		await until(() => $(el, '.rail'));
		assert.match($(el, '.voyage-label').textContent, /1 of 5 reviewed/, 'as it was kept');
		await reviews.settled();
		assert.equal(gh.calls.length, reads, 'no gh read');
		assert.equal(model.calls.length, passes, 'no model pass');
		button(el, 'Check for new commits').click();
		await until(() => gh.calls.length > reads);
		assert.deepEqual(
			gh.calls
				.slice(reads)
				.map((c) => c.argv.slice(0, 2).join(' '))
				.sort(),
			['pr diff', 'pr view']
		);
		await reviews.settled();
		el.remove();
	});

	it('waits for a click before reviewing a ?pr= link it doesn’t keep', async () => {
		const other = 'https://github.com/acme/lumen/pull/49';
		window.happyDOM.setURL(`http://127.0.0.1:4310/projects/lumen/pr-review/review?pr=${other}`);
		const reads = gh.calls.length;
		const passes = model.calls.length;
		const el = mount(running());
		await until(() => $(el, '[data-key="pr-url"]')?.value === other);
		assert.equal($(el, '.rail'), null);
		assert.equal(button(el, 'Review').disabled, false);
		assert.equal(gh.calls.length, reads, 'no gh read');
		assert.equal(model.calls.length, passes, 'no model pass');
		el.remove();
		window.happyDOM.setURL('http://127.0.0.1:4310/projects/lumen/pr-review/review');
	});
});

describe('placing notes on a long hunk', () => {
	it('cuts the hunk where each note starts', async () => {
		const { splitAtNotes } = await import('../wheelhouse/ui/index.js');
		const lines = Array.from({ length: 10 }, (_, i) => ({ t: '+', n: i + 1, text: `l${i + 1}` }));
		const parts = splitAtNotes(lines, [
			{ id: 'b', from: 6, to: 7 },
			{ id: 'a', from: 3, to: 4 },
			{ id: 'c', from: 6, to: 6 }
		]);
		assert.deepEqual(
			parts.map((p) => [p.notes.map((n) => n.id).join(''), p.lines[0].n, p.lines.at(-1).n]),
			[
				['', 1, 2],
				['a', 3, 5],
				['bc', 6, 10]
			]
		);
		assert.deepEqual(
			splitAtNotes(lines, [{ id: 'a', from: 1, to: 2 }]).map((p) => p.notes.length),
			[1]
		);
	});
});

describe('the model’s text', () => {
	it('turns paragraphs, headings and lists into elements, and HTML into text', async () => {
		const { rich } = await import('../wheelhouse/ui/dom.js');
		const box = document.createElement('div');
		box.append(
			...rich(
				'## Intent\n\nSmallest fix, pick one:\n- **Cypher** side\n- TS side\n\nI’d pick `Cypher`. <img src=x onerror=alert(1)>'
			)
		);
		assert.deepEqual(
			[...box.children].map((c) => c.tagName),
			['H4', 'P', 'UL', 'P']
		);
		assert.equal(box.querySelectorAll('li').length, 2);
		assert.equal(box.querySelector('li strong').textContent, 'Cypher');
		assert.equal(box.querySelector('img'), null);
		assert.match(box.textContent, /<img src=x onerror=alert\(1\)>/);
	});
});
