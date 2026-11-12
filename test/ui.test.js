/**
 * The tab in a page (happy-dom), against the real engine over HTTP with a
 * fake `gh` and a fake model: the engine and the pull request picker, then
 * the chat review (`pr-review-chat`) as Wheelhouse hosts it, then a host
 * that turns some finishes off.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { createGitHub } from '../wheelhouse/engine/github.js';
import { createHandler } from '../wheelhouse/engine/http.js';
import { createReviews } from '../wheelhouse/engine/review.js';
import { memoryStore } from '../wheelhouse/engine/store.js';
import { CARD_ANSWERS, fakeGh, fakeModel, PR_URL, sampleView } from './helpers.js';

const ID = 'acme__lumen__48';
const window = new Window({
	url: 'http://127.0.0.1:4310/projects/lumen/pr-review/review',
	// The chat paces its messages; with reduced motion it barely waits.
	settings: { device: { prefersReducedMotion: 'reduce' } }
});
const LEGACY = Array.from({ length: 160 }, (_, i) => `line ${i + 1} of legacy`).join('\n');

/** An engine on loopback with its own store, `gh` and model. */
async function engine(gh = fakeGh()) {
	const model = fakeModel(CARD_ANSWERS);
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
	await new Promise((res) => server.listen(0, '127.0.0.1', res));
	return {
		gh,
		model,
		reviews,
		url: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((res) => server.close(res))
	};
}

before(async () => {
	for (const k of [
		'window',
		'document',
		'HTMLElement',
		'customElements',
		'Node',
		'localStorage',
		'navigator',
		'matchMedia'
	]) {
		Object.defineProperty(globalThis, k, {
			value:
				k === 'window' ? window : k === 'matchMedia' ? window.matchMedia.bind(window) : window[k],
			configurable: true,
			writable: true
		});
	}
	await import('../wheelhouse/ui/index.js');
});
after(async () => {
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
	settings: { backend: 'claude', ollamaModel: 'fake:7b', claudeModel: 'sonnet' }
};

function mount(host, data = DATA) {
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
	el.data = data;
	return el;
}
const $ = (el, sel) => el.shadowRoot.querySelector(sel);
const $$ = (el, sel) => [...el.shadowRoot.querySelectorAll(sel)];
const text = (el) => el.shadowRoot.textContent.replace(/\s+/g, ' ');
const button = (el, label) => $$(el, 'button').find((b) => b.textContent.trim() === label);
/** The chat's own shadow root, inside the tab's. */
const chat = (el) => $(el, 'pr-review-chat')?.shadowRoot ?? null;
const inChat = (el, sel) => chat(el)?.querySelector(sel) ?? null;
const allInChat = (el, sel) => [...(chat(el)?.querySelectorAll(sel) ?? [])];
const said = (el) => (chat(el)?.querySelector('#log')?.textContent ?? '').replace(/\s+/g, ' ');
const enabled = (el, sel) => allInChat(el, sel).filter((b) => !b.disabled);
async function until(fn, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	const el = globalThis.__el;
	throw new Error(
		`timed out: ${el ? (chat(el) ? said(el) : text(el)).slice(-900) : ''}`.replace(/\s+/g, ' ')
	);
}
/** Types a line into the chat's composer and sends it. */
function type(el, line) {
	const input = inChat(el, '#input');
	input.value = line;
	inChat(el, '#composer').requestSubmit();
}
const running = (e) => ({
	async service() {
		return { state: 'running', url: e.url, launchable: false, hint: null };
	},
	async launch() {}
});

describe('before the engine runs', () => {
	let e;
	before(async () => (e = await engine()));
	after(() => e.close());

	it('lists the open PRs and offers to start the engine', async () => {
		const launched = [];
		let up = false;
		const el = mount({
			async service() {
				return up
					? { state: 'running', url: e.url, launchable: false }
					: { state: 'stopped', url: e.url, launchable: true, hint: 'node main.js --port 4791' };
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
		assert.deepEqual(launched, [['engine', { project: null, open: `${e.url}/started` }]]);
		assert.equal($(el, '.pr-row button').disabled, false);
		el.remove();
	});
});

describe('a chat review in the tab', () => {
	let e;
	let el;
	before(async () => {
		localStorage.clear();
		e = await engine(
			fakeGh({
				view: sampleView({ title: 'Draw <img src=x onerror=alert(1)> boards' }),
				files: { 'src/legacy.ts': LEGACY }
			})
		);
		el = mount(running(e));
		await until(() => $(el, '.pr-row button') && !$(el, '.pr-row button').disabled);
		$(el, '.pr-row button').click();
		await until(() => inChat(el, '.ccard.change'), 8000);
	});
	after(async () => {
		el.remove();
		await e.reviews.settled();
		await e.close();
	});

	it('opens with an overview of the PR, its text kept as text', () => {
		const t = said(el);
		assert.match(t, /I’ve read all 11 files of this pull request/);
		assert.match(t, /The board now draws the subgraph adapters return\./);
		assert.match(t, /What was asked/);
		assert.match(t, /Keep the subgraph each adapter returns/);
		assert.match(inChat(el, '#prTitle').textContent, /Draw <img src=x onerror=alert\(1\)> boards/);
		assert.match(t, /Draw <img src=x onerror=alert\(1\)> boards/);
		assert.deepEqual(
			allInChat(el, 'img').map((i) => i.closest('[data-diagram]') !== null),
			[true],
			'no element from the PR’s text: the only image is the diagram'
		);
		assert.equal(inChat(el, '.cnum').textContent, 'acme/lumen#48');
		assert.match(inChat(el, '.cnote').textContent, /^Claude \(sonnet\) on this computer/);
	});

	it('shows how the change fits together, drawn from the diff, full size on a click', () => {
		const fig = inChat(el, '[data-diagram]');
		const img = fig.querySelector('img');
		assert.match(img.getAttribute('src'), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
		assert.match(img.getAttribute('alt'), /^How the change fits together: \d+ changed files/);
		assert.match(said(el), /How the change fits together/);
		img.click();
		assert.ok(fig.classList.contains('full'));
		img.click();
		assert.ok(!fig.classList.contains('full'));
	});

	it('goes straight to the first major issue, with context a click away, and reads the project through gh', async () => {
		assert.doesNotMatch(said(el), /do you want some context|Start the review/);
		assert.match(said(el), /then the major issues, most serious first/);
		enabled(el, '#followups [data-act="ctx:menu"]')[0].click();
		await until(() => enabled(el, '#log [data-act="ctx:project"]').length);
		enabled(el, '#log [data-act="ctx:project"]')[0].click();
		await until(() => /A board for graph search\./.test(said(el)));
		assert.match(said(el), /acme\/lumen: Graph search on a board/);
		assert.ok(
			e.gh.calls.some((c) => c.argv.join(' ') === 'api repos/acme/lumen'),
			'the repository, read with gh'
		);
	});

	it('walks the changes one at a time, each with its verdicts and its code', async () => {
		const card = inChat(el, '.ccard.change');
		const head = card.querySelector('.chead').textContent;
		assert.match(head, /^Major issue 1 of 4 · Key changes · Stop 1: Keep the subgraph/);
		assert.equal(card.querySelector('h3').textContent, 'Reads other scopes');
		assert.deepEqual(
			[...card.querySelectorAll('.cpk')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()),
			['SeriousPossible security issue · medium', 'SeriousNot well tested']
		);
		assert.match(card.querySelector('.csuggest').textContent, /Count only edges in scope\./);
		assert.ok(card.querySelector('.ccode .clines tr.foc'), 'its key lines stand out');
		assert.match(inChat(el, '#contextLine').textContent, /Talking about 1\. Reads other scopes/);
	});

	it('opens the whole file in a drawer at the card’s lines', async () => {
		inChat(el, '.ccard.change .cmini[data-open]').click();
		await until(() => allInChat(el, '#drawerLines tr').length === 160);
		assert.ok(inChat(el, '#chatapp').classList.contains('drawer-open'));
		assert.equal(inChat(el, '#drawerPath').textContent, 'src/legacy.ts');
		assert.match(inChat(el, '#drawerLines').textContent, /line 121 of legacy/);
		assert.ok(inChat(el, '#drawerLines tr.foc'), 'the card’s lines stand out');
		assert.ok(
			e.gh.calls.some((c) =>
				c.argv.includes(`repos/acme/lumen/contents/src/legacy.ts?ref=${'a'.repeat(40)}`)
			)
		);
		inChat(el, '#drawerClose').click();
		assert.ok(!inChat(el, '#chatapp').classList.contains('drawer-open'));
	});

	it('shows a binary file as a note in the drawer, never reading it whole', async () => {
		const reads = e.gh.calls.length;
		window.dispatchEvent(
			new window.KeyboardEvent('keydown', { key: 'e', ctrlKey: true, metaKey: true })
		);
		const input = inChat(el, '#swInput');
		input.value = 'logo';
		input.dispatchEvent(new window.Event('input'));
		input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
		await until(() => inChat(el, '#drawerPath').textContent === 'assets/logo.png');
		inChat(el, '#dtFull').click();
		assert.equal(inChat(el, '#dtDiff').getAttribute('aria-selected'), 'true');
		assert.match(inChat(el, '#drawerLines').textContent, /A binary file/);
		assert.equal(e.gh.calls.length, reads, 'the binary file is never fetched');
		inChat(el, '#drawerClose').click();
	});

	it('answers a question about the change in the card’s own thread', async () => {
		enabled(el, '.ccard.change [data-ask]')[0].click();
		await until(() => /Because every new field is optional\./.test(said(el)));
		const first = inChat(el, '.ccard.change').dataset.card;
		const thread = e.reviews.view(ID).chat[first];
		assert.deepEqual(
			thread.map((m) => m.role),
			['user', 'assistant']
		);
		assert.equal(thread[0].text, 'How would it leak?');
	});

	it('records a decision in the engine and moves on to the next change', async () => {
		const first = inChat(el, '.ccard.change').dataset.card;
		inChat(el, '.ccard.change [data-decide="accept"]').click();
		await until(() => allInChat(el, '.ccard.change').length === 2);
		assert.match(said(el), /Accepted\. I’ll ask for this in the review as a blocking change\./);
		assert.equal(e.reviews.view(ID).cardDecisions[first].decision, 'accept');
		assert.match(
			allInChat(el, '.ccard.change')[1].querySelector('.chead').textContent,
			/^Major issue 2 of 4 · Key changes · Stop 2/,
			'the other security issue before either acceptance criteria one'
		);
		assert.match(inChat(el, '#progressText').textContent, /^1 of 4 decided$/);
	});

	it('switches files with Ctrl/Cmd+E, and lists the passage beside the chat', async () => {
		window.dispatchEvent(
			new window.KeyboardEvent('keydown', { key: 'e', ctrlKey: true, metaKey: true })
		);
		assert.ok(inChat(el, '#switcher').classList.contains('open'));
		const input = inChat(el, '#swInput');
		input.value = 'search';
		input.dispatchEvent(new window.Event('input'));
		assert.match(inChat(el, '#swList button').textContent, /^search\.ts/);
		input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
		assert.ok(!inChat(el, '#switcher').classList.contains('open'));
		const groups = allInChat(el, '.cghead .gt').map((g) => g.textContent);
		assert.deepEqual(groups.slice(0, 2), ['Walkthrough', 'Key changes']);
		assert.ok(inChat(el, '.crowbtn.here'), 'the change being discussed');
	});

	it('takes no shortcut while the captain types elsewhere on the page', async () => {
		const outside = document.createElement('textarea');
		document.body.append(outside);
		const before = e.reviews.view(ID).cardDecisions;
		outside.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(e.reviews.view(ID).cardDecisions, before);
		outside.remove();
	});

	it('finishes with a suggested verdict and the draft', async () => {
		type(el, 'finish');
		await until(() => inChat(el, '[data-finish]'));
		const card = inChat(el, '[data-finish]');
		assert.equal(card.querySelector('input[name="ev"]:checked').value, 'REQUEST_CHANGES');
		assert.match(said(el), /You accepted at least one blocking concern, so I’d request changes\./);
		assert.equal(card.querySelector('#reviewBody').value, '1 change requested; see the comments.');
		assert.deepEqual(
			[...card.querySelectorAll('.crow button')].map((b) => b.textContent.trim()),
			['Post to GitHub as reviewer', 'Copy as Markdown', 'Send to Firstmate']
		);
		assert.ok(card.querySelector('input[name="diagrams"]').checked, 'the diagram goes with it');
		assert.match(card.textContent, /pr-review-diagrams branch of acme\/lumen/);
	});

	it('hands the change requests to Firstmate through Wheelhouse’s chat box', async () => {
		inChat(el, '[data-firstmate]').click();
		await until(() => inChat(el, 'a[href^="/?draft="]'));
		const href = inChat(el, 'a[href^="/?draft="]').getAttribute('href');
		const message = decodeURIComponent(href.slice('/?draft='.length));
		assert.match(message, new RegExp(`^Review fixes for ${PR_URL.replace(/[./]/g, '\\$&')}`));
		assert.match(
			message,
			/\n1\. Change at src\/legacy\.ts:121-123: Possible security issue \(medium\): Reads other scopes\. Count only edges in scope\.$/
		);
	});

	it('posts the review with gh only on a click, with the diagram', async () => {
		const writes = () => e.gh.calls.filter((c) => c.argv.includes('POST'));
		const posts = () => writes().filter((c) => c.argv.some((a) => a.endsWith('/reviews')));
		assert.equal(writes().length, 0);
		inChat(el, '[data-post]').click();
		await until(() => inChat(el, '.cposted'));
		assert.ok(writes().some((c) => c.argv.includes('repos/acme/lumen/git/refs')));
		const sent = JSON.parse(posts()[0].input);
		assert.match(
			sent.body,
			/!\[How the change fits together: [^\]]+\]\(https:\/\/github\.com\/acme\/lumen\/raw\/c0ffee7\//
		);
		assert.match(inChat(el, '.cposted').textContent, /With how the change fits together\./);
		assert.equal(sent.event, 'REQUEST_CHANGES');
		assert.equal(sent.commit_id, 'a'.repeat(40));
		assert.equal(sent.comments.length, 1);
		assert.match(inChat(el, '.cposted').textContent, /Request changes posted on acme\/lumen#48/);
		assert.equal(e.reviews.view(ID).posted.url, `${PR_URL}#pullrequestreview-9`);
	});

	it('goes back to the pull requests', async () => {
		inChat(el, '[data-back]').click();
		await until(() => $(el, '.picker'));
		assert.equal($(el, 'pr-review-chat'), null);
		await until(() => /Reviews you started/.test(text(el)));
		assert.match(text(el), /1 change decided/);
		assert.match(text(el), /posted to GitHub/);
	});
});

describe('the major issues first, the minor ones on request', () => {
	let e;
	let el;
	before(async () => {
		localStorage.clear();
		e = await engine();
		await e.reviews.open(PR_URL);
		await e.reviews.settled();
		localStorage.setItem('pr-review.last.lumen', JSON.stringify({ url: PR_URL }));
		el = mount(running(e));
		await until(() => inChat(el, '.ccard.change'), 8000);
	});
	after(async () => {
		el.remove();
		await e.close();
	});
	const titles = () => allInChat(el, '.ccard.change h3').map((h) => h.textContent);
	const navRows = () => allInChat(el, '#navBody .crowbtn .ct').map((x) => x.textContent);

	it('lists only the major issues in the navigator, with the rest a toggle away', () => {
		const toggles = allInChat(el, '.cview .ctoggle').map((b) => [
			b.textContent.replace(/\s+/g, ' ').trim(),
			b.getAttribute('aria-pressed')
		]);
		assert.deepEqual(toggles, [
			['Major 4', 'true'],
			['Minor 1', 'false'],
			['Reference points 5', 'false']
		]);
		assert.ok(!navRows().includes('Clear names'), 'praise stays out of the way');
		assert.ok(!navRows().includes('The same spread eleven times'), 'so does a minor issue');
		inChat(el, '[data-view="reference"]').click();
		assert.ok(navRows().includes('Clear names'));
		assert.equal(inChat(el, '[data-view="reference"]').getAttribute('aria-pressed'), 'true');
		inChat(el, '[data-view="reference"]').click();
		assert.ok(!navRows().includes('Clear names'));
	});

	it('walks every major issue, then asks before the minor ones', async () => {
		for (let i = 1; i <= 4; i++) {
			await until(() => allInChat(el, '.ccard.change').length === i);
			allInChat(el, '.ccard.change').at(-1).querySelector('[data-decide="accept"]').click();
		}
		await until(() => /That’s all 4 major issues\. There is 1 minor one too/.test(said(el)));
		assert.deepEqual(titles(), [
			'Reads other scopes',
			'Reads other scopes',
			'Never multiplies the score',
			'Never multiplies the score'
		]);
		assert.equal(inChat(el, '[data-finish]'), null, 'nothing finished without asking');
		enabled(el, '#log [data-act="more:minor"]')[0].click();
		await until(() => allInChat(el, '.ccard.change').length === 5);
		const minor = allInChat(el, '.ccard.change').at(-1);
		assert.equal(minor.querySelector('h3').textContent, 'The same spread eleven times');
		assert.match(minor.querySelector('.chead').textContent, /^Minor issue 1 of 1 · Quality pass/);
		assert.equal(inChat(el, '[data-view="minor"]').getAttribute('aria-pressed'), 'true');
	});

	it('finishes once the minor ones are decided too, never walking the reference points', async () => {
		allInChat(el, '.ccard.change').at(-1).querySelector('[data-decide="accept"]').click();
		await until(() => inChat(el, '[data-finish]'));
		assert.ok(!titles().includes('Clear names'));
		assert.doesNotMatch(said(el), /You didn’t go through/);
	});
});

describe('coming back to the tab', () => {
	let e;
	before(async () => {
		localStorage.clear();
		e = await engine();
		await e.reviews.open(PR_URL);
		await e.reviews.settled();
		localStorage.setItem('pr-review.last.lumen', JSON.stringify({ url: PR_URL }));
	});
	after(() => e.close());

	it('reopens the last review as kept, and reads the PR again only on a click', async () => {
		const reads = e.gh.calls.length;
		const passes = e.model.calls.length;
		const el = mount(running(e));
		await until(() => /I’ve read all 11 files/.test(said(el)));
		assert.equal(
			e.gh.calls.slice(reads).filter((c) => c.argv[0] === 'pr').length,
			0,
			'no gh read of the PR'
		);
		assert.equal(e.model.calls.length, passes, 'no model pass');
		assert.equal(inChat(el, '[data-link="0"]').textContent, 'Check for new commits');
		inChat(el, '[data-link="0"]').click();
		await until(() => e.gh.calls.slice(reads).filter((c) => c.argv[0] === 'pr').length === 2);
		assert.deepEqual(
			e.gh.calls
				.slice(reads)
				.filter((c) => c.argv[0] === 'pr')
				.map((c) => c.argv.slice(0, 2).join(' '))
				.sort(),
			['pr diff', 'pr view']
		);
		await until(() => /I’ve read all 11 files/.test(said(el)));
		await e.reviews.settled();
		el.remove();
	});

	it('waits for a click on a ?pr= link only when the host turns opening links off', async () => {
		const other = 'https://github.com/acme/lumen/pull/49';
		window.happyDOM.setURL(`http://127.0.0.1:4310/projects/lumen/pr-review/review?pr=${other}`);
		const reads = e.gh.calls.length;
		const passes = e.model.calls.length;
		const el = mount({ ...running(e), features: { autoOpen: false } });
		await until(() => $(el, '[data-key="pr-url"]')?.value === other);
		assert.equal($(el, 'pr-review-chat'), null);
		assert.equal(button(el, 'Review').disabled, false);
		assert.equal(e.gh.calls.length, reads, 'no gh read');
		assert.equal(e.model.calls.length, passes, 'no model pass');
		el.remove();
		window.happyDOM.setURL('http://127.0.0.1:4310/projects/lumen/pr-review/review');
	});

	it('opens a ?pr= link straight into the review, as Wheelhouse’s Review is itself the click', async () => {
		const other = 'https://github.com/acme/lumen/pull/49';
		window.happyDOM.setURL(`http://127.0.0.1:4310/projects/lumen/pr-review/review?pr=${other}`);
		const reads = e.gh.calls.length;
		const el = mount(running(e));
		await until(() => e.gh.calls.length > reads);
		assert.ok(
			e.gh.calls.slice(reads).some((c) => c.argv[1] === 'view' && c.argv[2] === '49'),
			'read PR 49 without a click'
		);
		await until(() => $(el, 'pr-review-chat'));
		assert.equal($(el, '.picker'), null, 'no picker, and nothing else, in between');
		await e.reviews.settled();
		el.remove();
		window.happyDOM.setURL('http://127.0.0.1:4310/projects/lumen/pr-review/review');
	});

	it('leaves the last review it no longer keeps in the box even when the host opens links', async () => {
		const gone = 'https://github.com/acme/lumen/pull/50';
		localStorage.setItem('pr-review.last.lumen', JSON.stringify({ url: gone }));
		const reads = e.gh.calls.length;
		const el = mount({ ...running(e), features: { autoOpen: true } });
		await until(() => $(el, '[data-key="pr-url"]')?.value === gone);
		assert.equal(e.gh.calls.length, reads, 'read no PR without a click');
		el.remove();
		localStorage.clear();
	});
});

describe('a host that is not Wheelhouse', () => {
	let e;
	before(async () => {
		localStorage.clear();
		e = await engine();
		await e.reviews.open(PR_URL);
		await e.reviews.settled();
		localStorage.setItem('pr-review.last.lumen', JSON.stringify({ url: PR_URL }));
	});
	after(() => e.close());

	it('names the reviewer as the host says', async () => {
		const el = mount(running(e), {
			...DATA,
			settings: { ...DATA.settings, label: 'Some Model', where: 'through OpenRouter' }
		});
		await until(() => inChat(el, '.cnote'));
		assert.match(inChat(el, '.cnote').textContent, /^Some Model through OpenRouter · /);
		inChat(el, '[data-link="1"]').click();
		await until(() => $(el, '.drawer-foot') && $$(el, '.field textarea').length === 5);
		assert.match($(el, '.drawer-foot').textContent, /^Reviewer: Some Model(?! \()/);
		assert.match($$(el, '.field label')[0].textContent, /Overall review prompt/);
		el.remove();
	});

	it('offers only the finishes the host allows, and copies the review as Markdown', async () => {
		const copied = [];
		const clipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
		Object.defineProperty(window.navigator, 'clipboard', {
			value: { writeText: async (t) => void copied.push(t) },
			configurable: true
		});
		const el = mount({ ...running(e), features: { post: false, firstmate: false } });
		await until(() => inChat(el, '.ccard.change'));
		type(el, 'finish');
		await until(() => inChat(el, '[data-finish]'));
		assert.deepEqual(
			allInChat(el, '[data-finish] .crow button').map((b) => b.textContent.trim()),
			['Copy as Markdown']
		);
		assert.equal(inChat(el, 'input[name="diagrams"]'), null, 'nothing to post the diagram with');
		assert.ok(inChat(el, '[data-copy]').classList.contains('primary'));
		inChat(el, '[data-copy]').click();
		await until(() => copied.length);
		assert.match(
			copied[0],
			/^## Review of \[acme\/lumen#48\]\(https:\/\/github\.com\/acme\/lumen\/pull\/48\)/
		);
		assert.match(copied[0], /\*\*Verdict:\*\* Approve/);
		el.remove();
		if (clipboard) Object.defineProperty(window.navigator, 'clipboard', clipboard);
		else delete window.navigator.clipboard;
	});
});

describe('the review as Markdown', () => {
	it('heads it with the PR, the verdict and the commit, and lists the line comments', async () => {
		const { reviewMarkdown } = await import('../wheelhouse/ui/index.js');
		const r = {
			pr: {
				owner: 'acme',
				repo: 'lumen',
				number: 48,
				url: PR_URL,
				title: 'Draw boards',
				headSha: 'abcdef1234567'
			}
		};
		const draft = {
			comments: [
				{ path: 'src/a.ts', line: 12, body: 'Name this.' },
				{ path: 'src/b.ts', start_line: 3, line: 5, body: 'Two\n\nlines.' }
			]
		};
		assert.equal(
			reviewMarkdown(r, { event: 'COMMENT' }, '  Looks good.\n', draft),
			[
				`## Review of [acme/lumen#48](${PR_URL}): Draw boards`,
				'',
				'**Verdict:** Comment · reviewed at `abcdef1`',
				'',
				'Looks good.',
				'',
				'### Line comments',
				'',
				'- `src/a.ts:12`: Name this.',
				'- `src/b.ts:3-5`: Two lines.'
			].join('\n')
		);
		assert.doesNotMatch(reviewMarkdown(r, {}, 'Fine.', { comments: [] }), /Line comments/);
	});
});
