/**
 * The PR review tab as a custom element, `pr-review-tab`. Wheelhouse sets
 * `host` (to see and start the plugin's engine), `entry` and `data` (the
 * project's open pull requests and the plugin's settings).
 *
 * Without a review open, the tab lists the project's open pull requests and
 * takes any PR URL. With one open, it is the chat review (`pr-review-chat`,
 * from `chat.js`, the same screen the PR review web app shows), on this
 * computer: the engine reads and posts with the local `gh` sign-in, and the
 * reviewer is Claude through Claude Code (or a local model), so a private
 * repository works and nothing is paid per review.
 *
 * All text from the model, GitHub or the PR is set as text, never as HTML.
 */

import { ago, h, plural } from './dom.js';
import { STYLE } from './styles.js';
import './chat.js';

export { reviewMarkdown } from './draft.js';

const ENGINE_RECHECK_MS = 5000;
const PROMPT_FIELDS = [
	['overall', 'Overall review prompt', 'Goes first at every stage, and in the chat.'],
	[
		'walkthrough',
		'Walkthrough',
		'What the PR is, why it was made, the evidence, what was asked, and how to group the files.'
	],
	[
		'quality',
		'Quality pass',
		'Readability and structure only: nesting, long functions, duplication, names.'
	],
	['change', 'Key change stops', 'Per stop: a verdict on each change, with its lines.'],
	['skim', 'Skim pile', 'One line and a risk level for each remaining file.']
];
const store = {
	get(k) {
		try {
			return JSON.parse(localStorage.getItem(k) ?? 'null');
		} catch {
			return null;
		}
	},
	set(k, v) {
		try {
			localStorage.setItem(k, JSON.stringify(v));
		} catch {
			// private window: the tab still works, it just won't remember
		}
	}
};

export class PrReviewTab extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
		/** @type {any} */
		this._data = null;
		this.host = null;
		this.entry = null;
		this.s = {
			engine: null,
			base: null,
			/** @type {{ id: string; url: string } | null} the review the chat shows */
			review: null,
			opening: null,
			error: null,
			recent: [],
			drawer: null,
			typed: null,
			toastText: null
		};
		this.prints = {};
		this.timers = {};
		this.chat = null;
		this.onKey = (e) => this.key(e);
		this.onResize = () => this.size();
	}

	set data(v) {
		const first = !this._data;
		this._data = v;
		if (this.isConnected) {
			this.render();
			if (first) void this.connect();
		}
	}
	get data() {
		return this._data;
	}

	connectedCallback() {
		const style = document.createElement('style');
		style.textContent = STYLE;
		this.shadowRoot.replaceChildren(style);
		this.root = h('div', { class: 'app' });
		this.shadowRoot.append(this.root);
		window.addEventListener('keydown', this.onKey);
		window.addEventListener('resize', this.onResize);
		this.prints = {};
		this.chat = null;
		this.render();
		void this.connect();
	}

	disconnectedCallback() {
		window.removeEventListener('keydown', this.onKey);
		window.removeEventListener('resize', this.onResize);
		for (const t of Object.values(this.timers)) clearTimeout(t);
	}

	get project() {
		return this.entry?.projectId ?? this._data?.project ?? 'fleet';
	}

	/**
	 * The tab fills the page below where it starts, so the chat scrolls on its
	 * own: as tall as the window allows, less whatever Wheelhouse draws under
	 * it (its source line and padding), measured as the overflow of the page's
	 * scrolling area.
	 */
	size() {
		const top = Math.max(0, this.getBoundingClientRect().top);
		const room = Math.max(480, window.innerHeight - top);
		this.style.setProperty('--rv-height', `${room}px`);
		const scroller = scrollerOf(this);
		const over = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
		// A flex parent may give the tab less than that; then its own box is the room there is.
		const given = this.getBoundingClientRect().height;
		const fit = Math.max(480, Math.min(room - Math.max(0, over), given >= 480 ? given : room));
		if (fit !== room) this.style.setProperty('--rv-height', `${fit}px`);
	}

	// ---------- the engine ----------

	/** Finds the engine once at a time; a second call while one runs waits for it. */
	connect() {
		this.connecting ??= this.reconnect().finally(() => (this.connecting = null));
		return this.connecting;
	}

	async reconnect() {
		clearTimeout(this.timers.engine);
		if (!this.host?.service) {
			this.s.engine = { state: 'unavailable', reason: 'Wheelhouse didn’t give the tab its host.' };
			return this.render();
		}
		let view;
		try {
			view = await this.host.service('engine', { project: null });
		} catch (e) {
			view = { state: 'unavailable', reason: e.message };
		}
		const was = this.s.engine?.state;
		this.s.engine = view ?? { state: 'unavailable', reason: 'The plugin declares no engine.' };
		if (view?.state === 'running' && view.url) {
			this.s.base = view.url.replace(/\/+$/, '');
			if (was !== 'running') {
				await this.api('PUT', '/api/config', this._data?.settings ?? {}).catch(() => {});
				await this.loadRecent();
				const want = this.wanted();
				if (want && !this.s.review) await this.reopen(want);
			}
		} else {
			this.timers.engine = setTimeout(() => void this.connect(), ENGINE_RECHECK_MS);
		}
		this.render();
	}

	/** A review to open: the page's `?pr=` (a URL or a number), else the one open last here. */
	wanted() {
		let pr = null;
		try {
			pr = new URL(window.location.href).searchParams.get('pr');
		} catch {
			pr = null;
		}
		if (pr && /^\d+$/.test(pr)) {
			const known = (this._data?.prs ?? []).find((p) => String(p.number) === pr);
			pr = known?.url ?? null;
		}
		if (pr) return { url: pr, linked: true };
		const last = store.get(`pr-review.last.${this.project}`);
		return last?.url ? { url: last.url, linked: false } : null;
	}

	async start() {
		const view = this.s.engine;
		this.s.engine = { ...(view ?? {}), state: 'starting' };
		this.render();
		try {
			await this.host.launch('engine', {
				project: null,
				open: view?.url ? `${view.url.replace(/\/+$/, '')}/started` : null
			});
		} catch (e) {
			this.toast(`Couldn’t start the engine: ${e.message}`);
		}
		this.s.engine = null;
		await this.connect();
	}

	async api(method, path, body) {
		if (!this.s.base) throw new Error('The review engine isn’t running.');
		const res = await fetch(`${this.s.base}${path}`, {
			method,
			headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-pr-review': '1' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const out = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(out.error || `The engine answered ${res.status}.`);
		return out;
	}

	async loadRecent() {
		try {
			this.s.recent = (await this.api('GET', '/api/reviews')).reviews ?? [];
		} catch {
			this.s.recent = [];
		}
	}

	// ---------- a review ----------

	/**
	 * Reads a PR with gh and opens its review, starting the passes a new head
	 * needs. Only the captain's click reaches this.
	 */
	async open(url) {
		this.s.opening = url;
		this.s.error = null;
		this.render();
		try {
			const r = await this.api('POST', '/api/reviews', { url });
			this.show({ id: r.id, url: r.pr.url }, true);
		} catch (e) {
			this.s.error = e.message;
			if (this.s.review) this.toast(e.message);
		}
		this.s.opening = null;
		this.render();
	}

	/**
	 * Shows a review the engine already keeps, as kept, without reading the PR
	 * or running a pass. A ?pr= link is a click on Review (Wheelhouse's Review
	 * on a chat card), so a PR the engine doesn't keep opens straight away,
	 * unless the host turns `autoOpen` off; the review open last here, if the
	 * engine no longer keeps it, waits in the URL box for the captain's click.
	 */
	async reopen({ url, linked }) {
		const kept = this.s.recent.find((x) => x.url === url);
		if (kept) this.show({ id: kept.id, url: kept.url });
		else if (linked && this.feature('autoOpen')) await this.open(url);
		else this.s.typed = url;
		this.render();
	}

	/** What the host lets the tab do; Wheelhouse sets none of these, so it gets the defaults. */
	feature(name) {
		const f = this.host?.features ?? {};
		const defaults = { post: true, firstmate: true, autoOpen: true };
		return name in f ? !!f[name] : defaults[name];
	}

	/** Puts a review in the chat; `fresh` draws the chat again even for the same review (it was read again). */
	show(r, fresh = false) {
		if (fresh || this.s.review?.id !== r.id) this.chat = null;
		this.s.review = r;
		store.set(`pr-review.last.${this.project}`, { url: r.url });
	}

	close() {
		this.s.review = null;
		this.s.drawer = null;
		this.chat = null;
		store.set(`pr-review.last.${this.project}`, null);
		this.prints = {};
		void this.loadRecent().then(() => this.render());
		this.render();
	}

	/** The reviewer in plain words: the host's label, else the setting's model. */
	modelName() {
		const s = this._data?.settings;
		if (!s) return 'The reviewer';
		if (s.label) return s.label;
		return s.backend === 'ollama' ? s.ollamaModel : `Claude (${s.claudeModel})`;
	}

	/**
	 * The chat's host on this computer: the engine keeps the review and runs
	 * the reviewer; GitHub is the engine's `gh`, signed in as the captain.
	 *
	 * @returns {import('./chat.js').ChatHost}
	 */
	chatHost(r) {
		const where = this._data?.settings?.where ?? 'on this computer';
		return {
			pr: r.url,
			id: r.id,
			api: (method, path, body) => this.api(method, path, body),
			identity: {
				login: () => this.api('GET', '/api/identity').then((x) => x.login ?? null)
			},
			reviewer: { live: true, name: this.modelName() },
			github: {
				post: this.feature('post'),
				file: (review, path) =>
					this.api(
						'GET',
						`/api/reviews/${encodeURIComponent(review.id)}/file?path=${encodeURIComponent(path)}`
					).then((x) => x.text),
				project: (review) =>
					this.api('GET', `/api/reviews/${encodeURIComponent(review.id)}/project`)
			},
			features: { firstmate: this.feature('firstmate') },
			back: { title: 'Back to the pull requests', onClick: () => this.close() },
			links: [
				{ text: 'Check for new commits', onClick: () => void this.open(r.url) },
				{ text: 'Prompts', onClick: () => void this.openPrompts() }
			],
			note: `${this.modelName()} ${where}`
		};
	}

	toast(text) {
		this.s.toastText = text;
		clearTimeout(this.timers.toast);
		this.timers.toast = setTimeout(() => {
			this.s.toastText = null;
			this.renderOverlays();
		}, 2600);
		this.renderOverlays();
	}

	key(e) {
		if (e.key === 'Escape' && this.s.drawer && this.isConnected) {
			this.s.drawer = null;
			this.renderOverlays();
		}
	}

	// ---------- rendering ----------

	render() {
		if (!this.root) return;
		const r = this.s.review;
		if (r) {
			if (!this.chat) {
				this.prints = {};
				const chat = document.createElement('pr-review-chat');
				chat.host = this.chatHost(r);
				this.chat = chat;
				this.root.replaceChildren(chat, h('div', { class: 'overlays' }));
			}
			this.renderOverlays();
			this.size();
			return;
		}
		this.chat = null;
		const e = this.s.engine;
		const shown = [
			this._data,
			e?.state,
			e?.reason,
			e?.launchable,
			this.s.recent,
			this.s.opening,
			this.s.error
		];
		if (!this.changed('picker', shown) && this.root.firstChild) return this.renderOverlays();
		const typing = this.shadowRoot.activeElement?.dataset?.key === 'pr-url';
		this.root.replaceChildren(this.picker(), h('div', { class: 'overlays' }));
		if (typing) this.root.querySelector('[data-key="pr-url"]')?.focus();
		this.renderOverlays();
		this.size();
	}

	changed(key, value) {
		const print = JSON.stringify(value);
		if (this.prints[key] === print) return false;
		this.prints[key] = print;
		return true;
	}

	section(title, ...body) {
		return h('section', { class: 'section' }, h('h2', {}, title), ...body);
	}

	picker() {
		const d = this._data;
		const e = this.s.engine;
		const running = e?.state === 'running';
		const out = [
			h('p', { class: 'eyebrow' }, 'PR review'),
			h('h1', {}, 'Review a pull request'),
			h(
				'p',
				{ class: 'lede' },
				'A reviewer reads the whole PR, then walks you through it in a chat, one change at a time: what it likes, what needs work and what is serious, with the code. You decide each one, then post your review to GitHub.'
			)
		];
		if (!running) out.push(this.engineCard(e));
		const input = h('input', {
			type: 'url',
			name: 'url',
			placeholder: 'https://github.com/owner/repo/pull/123',
			'aria-label': 'Pull request URL',
			'data-key': 'pr-url',
			required: true,
			// The picker redraws as the engine and PR list change; what was typed stays.
			oninput: () => (this.s.typed = input.value)
		});
		input.value = this.s.typed ?? '';
		out.push(
			h(
				'form',
				{
					onsubmit: (ev) => {
						ev.preventDefault();
						if (running) void this.open(input.value.trim());
					}
				},
				input,
				h(
					'button',
					{ class: 'primary-btn navy', type: 'submit', disabled: !running || !!this.s.opening },
					this.s.opening ? 'Opening…' : 'Review'
				)
			)
		);
		if (this.s.opening) out.push(h('p', { class: 'dim' }, `Reading ${this.s.opening} with gh…`));
		if (this.s.error) out.push(h('p', { class: 'error' }, this.s.error));
		const prs = d?.prs ?? [];
		out.push(
			this.section(
				'Open pull requests',
				prs.length
					? h(
							'div',
							{ class: 'card' },
							h(
								'ul',
								{ class: 'pr-list' },
								prs.map((p) =>
									h(
										'li',
										{ class: 'pr-row' },
										h(
											'span',
											{},
											h(
												'a',
												{ class: 'pr-num', href: p.url, target: '_blank', rel: 'noopener' },
												`#${p.number}`
											),
											' ',
											h('b', {}, p.title),
											h(
												'small',
												{},
												`${p.author}${p.isDraft ? ' · draft' : ''} · ${plural(p.changedFiles, 'file')} · `,
												h('span', { class: 'add' }, `+${p.additions}`),
												' ',
												h('span', { class: 'del' }, `−${p.deletions}`),
												p.updatedAt ? ` · updated ${ago(p.updatedAt)}` : ''
											)
										),
										h(
											'button',
											{
												class: 'pill-btn',
												type: 'button',
												disabled: !running || !!this.s.opening,
												onclick: () => void this.open(p.url)
											},
											'Review'
										)
									)
								)
							)
						)
					: h(
							'p',
							{ class: 'dim' },
							d?.reason ??
								(d
									? 'No open pull requests. Paste any PR URL above to review it.'
									: 'Reading the open pull requests…')
						)
			)
		);
		if (this.s.recent.length)
			out.push(
				this.section(
					'Reviews you started',
					h(
						'div',
						{ class: 'card' },
						h(
							'ul',
							{ class: 'pr-list' },
							this.s.recent.slice(0, 12).map((x) =>
								h(
									'li',
									{ class: 'pr-row' },
									h(
										'span',
										{},
										h('span', { class: 'dim' }, `${x.repo} `),
										h(
											'a',
											{ class: 'pr-num', href: x.url, target: '_blank', rel: 'noopener' },
											`#${x.number}`
										),
										' ',
										h('b', {}, x.title),
										h(
											'small',
											{},
											`${x.decided ? `${plural(x.decided, 'change')} decided · ` : ''}${ago(x.updatedAt)}${x.posted ? ' · posted to GitHub' : ''}`
										)
									),
									h(
										'button',
										{
											class: 'pill-btn',
											type: 'button',
											disabled: !running,
											onclick: () => this.continue(x)
										},
										'Continue'
									)
								)
							)
						)
					)
				)
			);
		if (running)
			out.push(
				h(
					'p',
					{ class: 'dim', style: { marginTop: '28px' } },
					h(
						'button',
						{ class: 'link-btn', type: 'button', onclick: () => void this.openPrompts() },
						'Review prompts'
					),
					`: what ${this.modelName()} is told at each stage.`
				)
			);
		return h('div', { class: 'picker' }, out);
	}

	/** Picks a kept review up where it was, as kept, without reading the PR again. */
	continue(x) {
		this.show({ id: x.id, url: x.url });
		this.render();
	}

	engineCard(e) {
		const state = e?.state ?? 'checking';
		const text =
			state === 'starting'
				? 'Starting the review engine…'
				: state === 'checking'
					? 'Looking for the review engine…'
					: state === 'unavailable'
						? `The review engine can’t run here: ${e.reason ?? 'no reason given'}`
						: state === 'occupied'
							? `Something else is answering on the engine’s port (${e.url}).`
							: state === 'failed'
								? `The review engine didn’t start: ${e.reason ?? 'see its log'}`
								: 'The review engine isn’t running. It reads pull requests with gh and runs the reviewer (Claude Code, or Ollama) on this computer; start it to review.';
		return h(
			'div',
			{ class: 'card engine-card' },
			h(
				'p',
				{},
				text,
				e?.hint
					? h(
							'span',
							{ class: 'hint', style: { display: 'block', marginTop: '6px' } },
							`Or by hand: ${e.hint}`
						)
					: null
			),
			e?.launchable
				? h(
						'button',
						{ class: 'primary-btn navy', type: 'button', onclick: () => void this.start() },
						'Start the engine'
					)
				: null
		);
	}

	// ---------- overlays: the prompts drawer and the toast ----------

	renderOverlays() {
		const box = this.root?.querySelector('.overlays');
		if (!box) return;
		const items = [];
		if (this.s.drawer) items.push(...this.drawer());
		if (this.s.toastText)
			items.push(h('div', { class: 'toast', role: 'status' }, this.s.toastText));
		const focused = this.shadowRoot.activeElement;
		const keep = focused && box.contains(focused) ? focused.dataset.key : null;
		box.replaceChildren(...items);
		if (keep) box.querySelector(`[data-key="${keep}"]`)?.focus();
	}

	async openPrompts() {
		this.s.drawer = { prompts: null, defaults: null, saved: null };
		this.renderOverlays();
		try {
			const p = await this.api('GET', '/api/prompts');
			this.s.drawer = { prompts: p.prompts, defaults: p.defaults, saved: null };
		} catch (e) {
			this.s.drawer = null;
			this.toast(e.message);
		}
		this.renderOverlays();
	}

	drawer() {
		const d = this.s.drawer;
		const close = () => ((this.s.drawer = null), this.renderOverlays());
		const save = async (key, value) => {
			try {
				const p = await this.api('PUT', '/api/prompts', { prompts: { [key]: value } });
				this.s.drawer = { ...this.s.drawer, prompts: p.prompts, saved: key };
			} catch (e) {
				this.toast(e.message);
			}
			this.renderOverlays();
		};
		const r = this.s.review;
		return [
			h('div', { class: 'scrim', onclick: close }),
			h(
				'aside',
				{ class: 'drawer', role: 'dialog', 'aria-label': 'Review prompts' },
				h(
					'div',
					{ class: 'drawer-head' },
					h('h2', {}, 'Review prompts'),
					h('button', { class: 'ghost-btn', type: 'button', onclick: close }, 'Close')
				),
				h(
					'p',
					{ class: 'drawer-note' },
					'What the reviewer is told at each stage: the overall prompt first, then the stage’s own. Saved for every review as you type; a review starts using them the next time a stage is read.'
				),
				!d.prompts
					? h('p', { class: 'dim' }, 'Loading…')
					: PROMPT_FIELDS.map(([key, label, help]) => {
							const ta = h('textarea', {
								'data-key': `prompt-${key}`,
								rows: key === 'overall' ? 6 : 4,
								oninput: () => {
									clearTimeout(this.timers[`p-${key}`]);
									this.timers[`p-${key}`] = setTimeout(() => void save(key, ta.value), 700);
								}
							});
							ta.value = d.prompts[key];
							return h(
								'div',
								{ class: 'field' },
								h(
									'label',
									{},
									label,
									d.saved === key ? h('span', { class: 'saved' }, 'Saved') : null
								),
								h('small', {}, help),
								ta,
								d.prompts[key] !== d.defaults[key]
									? h(
											'button',
											{ class: 'link-btn', type: 'button', onclick: () => void save(key, '') },
											'Restore the default'
										)
									: null
							);
						}),
				h(
					'div',
					{ class: 'drawer-foot' },
					h(
						'span',
						{ class: 'dim' },
						this._data?.settings?.where
							? `Reviewer: ${this.modelName()}`
							: `Reviewer: ${this.modelName()} (Settings → Plugins → PR review)`
					),
					r
						? h(
								'button',
								{
									class: 'link-btn',
									type: 'button',
									onclick: async () => {
										if (
											!window.confirm(
												'Start this review over with the prompts as they are now? Your decisions and the chat are forgotten.'
											)
										)
											return;
										this.s.drawer = null;
										try {
											const fresh = await this.api(
												'DELETE',
												`/api/reviews/${encodeURIComponent(r.id)}`
											);
											this.show({ id: fresh.id, url: fresh.pr.url }, true);
										} catch (e) {
											this.toast(e.message);
										}
										this.render();
									}
								},
								'Start the review over'
							)
						: null
				)
			)
		];
	}
}

/** The nearest ancestor that scrolls (or the page's own scrolling element). */
function scrollerOf(el) {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const o = window.getComputedStyle(p).overflowY;
		if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
	}
	return document.scrollingElement;
}

if (!customElements.get('pr-review-tab')) customElements.define('pr-review-tab', PrReviewTab);
