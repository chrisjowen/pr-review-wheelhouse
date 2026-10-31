/**
 * The PR review tab as a custom element, `pr-review-tab`. Wheelhouse sets
 * `host` (to see and start the plugin's engine), `entry` and `data` (the
 * project's open pull requests and the plugin's settings).
 *
 * Without a review open, the tab lists the project's open pull requests and
 * takes any PR URL. With one open, it is three calm columns: the passage (the
 * stages in reading order), the stage (only that stage's code, with the
 * model's notes pinned above the hunks they discuss) and the review mate (a
 * chat that opens each stage with its take). Everything slow happens in the
 * engine, which the tab talks to directly and polls while the model works.
 *
 * All text from the model, GitHub or the PR is set as text, never as HTML.
 */

import {
	draftReview,
	firstmateHref,
	firstmateMessage,
	reviewPoints,
	suggestVerdict,
	VERDICT_LABEL,
	VERDICTS
} from './draft.js';
import { ago, h, highlight, icon, ICONS, inline, langOf, plural, rich } from './dom.js';
import { STYLE } from './styles.js';

const POLL_MS = 1200;
const ENGINE_RECHECK_MS = 5000;
const PROMPT_FIELDS = [
	['overall', 'Overall review prompt', 'Goes first at every stage, and in the chat.'],
	[
		'walkthrough',
		'Walkthrough',
		'What the PR is, why it was made, the evidence, and how to group the files.'
	],
	[
		'quality',
		'Quality pass',
		'Readability and structure only: nesting, long functions, duplication, names.'
	],
	[
		'change',
		'Key change stops',
		'Per stop: notes on the hunks, a complexity rating, alternatives and a pick.'
	],
	['skim', 'Skim pile', 'One line and a risk level for each remaining file.']
];
const KIND_LABEL = { walkthrough: 'Walkthrough', quality: 'Quality pass', skim: 'Skim pile' };
const base = (p) => p.split('/').pop() ?? p;
const dir = (p) => p.slice(0, p.length - base(p).length);
const loc = (x) =>
	x.from
		? `${base(x.file)}:${x.from}${x.to && x.to !== x.from ? `–${x.to}` : ''}`
		: base(x.file ?? '');
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
			review: null,
			opening: null,
			error: null,
			stage: 'walkthrough',
			mode: 'ask',
			attach: null,
			recent: [],
			expanded: new Set(),
			drawer: null,
			finish: null,
			lightbox: null,
			sending: false
		};
		this.prints = {};
		this.timers = {};
		this.el = null;
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
	 * The tab fills the page below where it starts, so each column scrolls on
	 * its own: as tall as the window allows, less whatever Wheelhouse draws
	 * under it (its source line and padding), measured as the overflow of the
	 * page's scrolling area.
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
		if (pr) return { url: pr, stage: null };
		const last = store.get(`pr-review.last.${this.project}`);
		return last?.url ? last : null;
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
	async open(url, stage = null) {
		this.s.opening = url;
		this.s.error = null;
		this.render();
		try {
			this.show(await this.api('POST', '/api/reviews', { url }), stage);
		} catch (e) {
			this.s.error = e.message;
			if (this.s.review) this.toast(e.message);
		}
		this.s.opening = null;
		this.render();
		this.poll();
	}

	/**
	 * Shows a review the engine already keeps, as kept, without reading the PR
	 * or running a pass; any other PR waits in the URL box for the captain's click.
	 */
	async reopen({ url, stage }) {
		const kept = this.s.recent.find((x) => x.url === url);
		try {
			if (!kept) throw new Error('not kept');
			this.show(await this.api('GET', `/api/reviews/${kept.id}`), stage);
		} catch {
			this.s.typed = url;
		}
		this.render();
		this.poll();
	}

	show(r, stage) {
		this.s.review = r;
		this.s.stage = stage && r.stages.some((x) => x.id === stage) ? stage : 'walkthrough';
		this.s.attach = null;
		this.s.expanded = new Set();
		this.prints = {};
		this.remember();
		void this.api('POST', `/api/reviews/${r.id}/focus`, { stage: this.s.stage }).catch(() => {});
	}

	close() {
		this.s.review = null;
		this.s.finish = null;
		this.s.drawer = null;
		store.set(`pr-review.last.${this.project}`, null);
		clearTimeout(this.timers.poll);
		this.prints = {};
		void this.loadRecent().then(() => this.render());
		this.render();
	}

	remember() {
		const r = this.s.review;
		if (r) store.set(`pr-review.last.${this.project}`, { url: r.pr.url, stage: this.s.stage });
	}

	busy(r = this.s.review) {
		if (!r) return false;
		if (Object.values(r.runs ?? {}).some((x) => x.state === 'running' || x.state === 'queued'))
			return true;
		return Object.values(r.chat ?? {}).some((l) => l.some((m) => m.pending));
	}

	poll() {
		clearTimeout(this.timers.poll);
		if (!this.busy()) return;
		this.timers.poll = setTimeout(async () => {
			const r = this.s.review;
			if (!r) return;
			try {
				this.take(await this.api('GET', `/api/reviews/${r.id}`));
			} catch {
				// the engine may be restarting; try again
			}
			this.poll();
		}, POLL_MS);
	}

	take(r) {
		if (!r || r.id !== this.s.review?.id) return;
		this.s.review = r;
		if (!r.stages.some((x) => x.id === this.s.stage)) this.s.stage = 'walkthrough';
		this.render();
		this.poll();
	}

	async act(method, path, body) {
		try {
			this.take(await this.api(method, `/api/reviews/${this.s.review.id}${path}`, body));
		} catch (e) {
			this.toast(e.message);
		}
	}

	go(id) {
		const r = this.s.review;
		if (!r || !r.stages.some((x) => x.id === id)) return;
		this.s.stage = id;
		this.s.attach = null;
		this.remember();
		void this.api('POST', `/api/reviews/${r.id}/focus`, { stage: id }).catch(() => {});
		this.render();
		this.el?.stage.scrollTo?.({ top: 0 });
	}

	step(d) {
		const r = this.s.review;
		const i = r.stages.findIndex((x) => x.id === this.s.stage);
		const next = r.stages[i + d];
		if (next) this.go(next.id);
	}

	async markAndNext() {
		const r = this.s.review;
		const i = r.stages.findIndex((x) => x.id === this.s.stage);
		if (!r.reviewed.includes(this.s.stage))
			await this.act('POST', '/mark', { stage: this.s.stage, reviewed: true });
		if (i === r.stages.length - 1) this.openFinish();
		else this.step(1);
	}

	async send(text) {
		const said = String(text ?? '').trim();
		if (!said || this.s.sending) return;
		this.s.sending = true;
		const body = { stage: this.s.stage, text: said, attach: this.s.attach };
		const path = this.s.mode === 'change' ? '/request' : '/ask';
		if (this.el) this.el.input.value = '';
		this.s.attach = null;
		await this.act('POST', path, body);
		if (this.s.mode === 'change') {
			this.s.mode = 'ask';
			this.toast('Change request pinned. It goes into your review.');
		}
		this.s.sending = false;
		this.render();
	}

	attachLines(file, n, extend) {
		const a = this.s.attach;
		if (extend && a && a.file === file) {
			this.s.attach = { file, from: Math.min(a.from, n), to: Math.max(a.to, n) };
		} else this.s.attach = { file, from: n, to: n };
		this.render();
		this.el?.input.focus();
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
		if (!this.s.review || !this.isConnected) return;
		const path = e.composedPath?.() ?? [];
		const typing = path.some(
			(n) => n instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)
		);
		if (e.key === 'Escape') {
			if (this.s.lightbox || this.s.finish || this.s.drawer) {
				this.s.lightbox = null;
				this.s.finish = null;
				this.s.drawer = null;
				this.renderOverlays();
			}
			return;
		}
		if (typing || e.metaKey || e.ctrlKey || e.altKey || this.s.finish || this.s.drawer) return;
		if (e.key === ']') this.step(1);
		else if (e.key === '[') this.step(-1);
	}

	// ---------- rendering ----------

	render() {
		if (!this.root) return;
		const r = this.s.review;
		if (!r) {
			if (this.el) this.prints = {};
			this.el = null;
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
			return;
		}
		if (!this.el) this.build();
		const stage = r.stages.find((x) => x.id === this.s.stage) ?? r.stages[0];
		this.renderBar(r);
		this.renderRail(r);
		this.renderStage(r, stage);
		this.renderChat(r, stage);
		this.renderComposer(r, stage);
		this.renderOverlays();
		this.size();
	}

	/** Builds the review layout once; each region then redraws only when what it shows changes. */
	build() {
		const input = h('textarea', {
			rows: 2,
			'aria-label': 'Message',
			onkeydown: (e) => {
				if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
					e.preventDefault();
					void this.send(input.value);
				}
			}
		});
		const el = {
			bar: h('header', { class: 'bar' }),
			rail: h('nav', { class: 'rail', 'aria-label': 'Review stages' }),
			stage: h('main', { class: 'stage', tabindex: '-1' }),
			chatHead: h('div', { class: 'chat-head' }),
			log: h('div', { class: 'chat-log', 'aria-live': 'polite' }),
			mode: h('div', { class: 'mode', role: 'tablist', 'aria-label': 'Message type' }),
			attach: h('div'),
			input,
			actions: h('div', { class: 'composer-actions' }),
			overlays: h('div', { class: 'overlays' })
		};
		el.composer = h(
			'form',
			{
				class: 'composer',
				onsubmit: (e) => {
					e.preventDefault();
					void this.send(input.value);
				}
			},
			el.mode,
			el.attach,
			h(
				'div',
				{ class: 'input-row' },
				input,
				h('button', { class: 'send', type: 'submit', 'aria-label': 'Send' }, icon(ICONS.arrow))
			),
			el.actions
		);
		el.stage.addEventListener('click', (e) => {
			const ln = e.target.closest?.('td.ln.can');
			if (ln) this.attachLines(ln.dataset.file, Number(ln.dataset.n), e.shiftKey);
		});
		this.root.replaceChildren(
			el.bar,
			h(
				'div',
				{ class: 'layout' },
				el.rail,
				el.stage,
				h(
					'aside',
					{ class: 'chat', 'aria-label': 'Review conversation' },
					el.chatHead,
					el.log,
					el.composer
				)
			),
			el.overlays
		);
		this.el = el;
	}

	changed(key, value) {
		const print = JSON.stringify(value);
		if (this.prints[key] === print) return false;
		this.prints[key] = print;
		return true;
	}

	renderBar(r) {
		const n = r.reviewed.length;
		if (!this.changed('bar', [r.pr.url, r.pr.title, n, r.stages.length])) return;
		this.el.bar.replaceChildren(
			h(
				'button',
				{
					class: 'ghost-btn',
					type: 'button',
					onclick: () => this.close(),
					title: 'Back to the pull requests'
				},
				icon(ICONS.back),
				'PRs'
			),
			h(
				'div',
				{ class: 'pr-id' },
				h('span', { class: 'pr-repo' }, `${r.pr.owner}/${r.pr.repo}`),
				h(
					'a',
					{ class: 'pr-num', href: r.pr.url, target: '_blank', rel: 'noopener' },
					`#${r.pr.number}`
				),
				h('span', { class: 'pr-title', title: r.pr.title }, r.pr.title)
			),
			h(
				'div',
				{ class: 'bar-right' },
				h(
					'div',
					{ class: 'voyage', 'aria-label': 'Review progress' },
					h('span', { class: 'voyage-label' }, `${n} of ${r.stages.length} reviewed`),
					h(
						'div',
						{ class: 'voyage-track' },
						h('div', { class: 'voyage-fill', style: { width: `${(n / r.stages.length) * 100}%` } })
					)
				),
				h(
					'button',
					{
						class: 'ghost-btn',
						type: 'button',
						onclick: () => void this.open(r.pr.url, this.s.stage),
						title: 'Read the PR again with gh; new commits start a fresh review'
					},
					'Check for new commits'
				),
				h(
					'button',
					{ class: 'ghost-btn', type: 'button', onclick: () => void this.openPrompts() },
					icon(ICONS.sliders),
					'Prompts'
				)
			)
		);
	}

	stageLabel(r, s) {
		if (s.kind !== 'change') return { name: KIND_LABEL[s.kind], sub: this.stageSub(r, s) };
		const stops = r.stages.filter((x) => x.kind === 'change');
		return { name: s.title, sub: `Stop ${stops.indexOf(s) + 1} · ${s.files.map(base).join(', ')}` };
	}

	stageSub(r, s) {
		const res = r.results[s.id];
		if (s.kind === 'walkthrough') return 'Read this first';
		if (s.kind === 'quality') {
			if (!res) return `${plural(s.files.length, 'source file')}`;
			const worth = res.findings.filter((f) => f.level === 'worth').length;
			return `${plural(res.findings.length, 'note')} · ${worth} worth changing`;
		}
		const hidden = r.plan?.generated?.length ?? 0;
		return `${plural(s.files.length, 'file')}${hidden ? ` · ${hidden} generated hidden` : ''}`;
	}

	renderRail(r) {
		const cur = this.s.stage;
		const items = r.stages.map((s) => ({
			id: s.id,
			l: this.stageLabel(r, s),
			done: r.reviewed.includes(s.id),
			run: r.runs[s.id]?.state ?? null,
			asks: r.requests.filter((q) => q.stage === s.id).length
		}));
		const files = r.files.length;
		const close = r.stages.filter((s) => s.kind === 'change').flatMap((s) => s.files).length;
		if (!this.changed('rail', [cur, items, files, close])) return;
		this.el.rail.replaceChildren(
			h('p', { class: 'eyebrow' }, 'Passage'),
			h(
				'ol',
				{ class: 'stops' },
				items.map((it, i) =>
					h(
						'li',
						{ class: `stop${it.id === cur ? ' current' : ''}${it.done ? ' done' : ''}` },
						h(
							'button',
							{
								class: 'stop-btn',
								type: 'button',
								'aria-current': it.id === cur ? 'step' : 'false',
								title: it.l.name,
								onclick: () => this.go(it.id)
							},
							h('span', { class: 'mark' }, it.done ? icon(ICONS.check) : String(i + 1)),
							h(
								'span',
								{},
								h('span', { class: 'stop-name' }, it.l.name),
								h('span', { class: 'stop-sub' }, it.l.sub),
								it.asks || it.run === 'running' || it.run === 'failed'
									? h(
											'span',
											{ class: 'stop-flags' },
											it.run === 'running' ? h('span', { class: 'flag busy' }, 'reading…') : null,
											it.run === 'failed'
												? h('span', { class: 'flag bad' }, 'didn’t finish')
												: null,
											it.asks
												? h('span', { class: 'flag' }, `${plural(it.asks, 'change')} asked`)
												: null
										)
									: null
							)
						)
					)
				)
			),
			h(
				'div',
				{ class: 'rail-foot' },
				h(
					'p',
					{ class: 'rail-meta' },
					`${plural(files, 'file')} changed · ${close} to read closely`
				),
				h(
					'button',
					{ class: 'finish-btn', type: 'button', onclick: () => this.openFinish() },
					icon(ICONS.anchor),
					h('span', {}, 'Finish review')
				),
				h(
					'p',
					{ class: 'kbd-hint' },
					h('kbd', {}, '['),
					' ',
					h('kbd', {}, ']'),
					' move between stops'
				)
			)
		);
	}

	// ---------- the stage ----------

	renderStage(r, stage) {
		const run = r.runs[stage.id] ?? null;
		const print = [
			stage,
			r.results[stage.id] ?? null,
			run && { state: run.state, reason: run.reason, model: run.model },
			r.requests.filter((q) => q.stage === stage.id),
			stage.kind === 'quality' ? r.decisions : null,
			stage.kind === 'walkthrough' ? [r.plan, r.pr.checks, r.results.walkthrough] : null,
			[...this.s.expanded],
			this.s.attach,
			r.posted
		];
		if (this.changed('stage', print)) {
			const keep = this.prints.stageId === stage.id ? this.el.stage.scrollTop : 0;
			this.prints.stageId = stage.id;
			const view =
				stage.kind === 'walkthrough'
					? this.walkthrough(r, stage)
					: stage.kind === 'quality'
						? this.quality(r, stage)
						: stage.kind === 'change'
							? this.change(r, stage)
							: this.skim(r, stage);
			this.el.stage.replaceChildren(h('div', { class: 'stage-inner' }, view));
			this.el.stage.scrollTop = keep;
		}
		const tokens = this.el.stage.querySelector('[data-tokens]');
		if (tokens && run) tokens.textContent = run.tokens ? ` · ${run.tokens} tokens so far` : '';
	}

	/** The banner while a stage's pass is queued, running or failed; null once it answered. */
	status(r, stage) {
		const run = r.runs[stage.id];
		const model = run?.model || this.modelName();
		if (r.results[stage.id] && run?.state !== 'running' && run?.state !== 'failed') return null;
		if (run?.state === 'failed')
			return h(
				'div',
				{ class: 'thinking failed' },
				icon(ICONS.warn),
				h(
					'span',
					{},
					h('b', {}, 'This stage didn’t finish. '),
					run.reason || 'The model gave no answer.'
				),
				h(
					'button',
					{
						class: 'pill-btn',
						type: 'button',
						onclick: () => void this.act('POST', '/run', { stage: stage.id })
					},
					'Try again'
				)
			);
		if (run?.state === 'running')
			return h(
				'div',
				{ class: 'thinking' },
				h('span', { class: 'pulse' }),
				h(
					'span',
					{},
					`${model} is reading this stage`,
					h('span', { 'data-tokens': '' }),
					stage.kind === 'walkthrough'
						? '. The PR’s own description is below meanwhile.'
						: '. The code is below meanwhile.'
				)
			);
		if (run?.state === 'queued')
			return h(
				'div',
				{ class: 'thinking' },
				h('span', { class: 'pulse' }),
				h(
					'span',
					{},
					`Waiting for ${model}: it reads one stage at a time, and this one is next once the current one finishes.`
				)
			);
		return h(
			'div',
			{ class: 'thinking' },
			h('span', {}, 'Not read yet.'),
			h(
				'button',
				{
					class: 'pill-btn',
					type: 'button',
					onclick: () => void this.act('POST', '/run', { stage: stage.id })
				},
				'Read it now'
			)
		);
	}

	head(eyebrow, title, lede, row, stage) {
		const r = this.s.review;
		const run = r.runs[stage.id];
		const again =
			r.results[stage.id] && run?.state !== 'running' && run?.state !== 'queued'
				? h(
						'button',
						{
							class: 'link-btn',
							type: 'button',
							title: 'Ask the model again, with the prompts as they are now',
							onclick: () => void this.act('POST', '/run', { stage: stage.id })
						},
						'Read again'
					)
				: null;
		return h(
			'div',
			{ class: 'stage-head' },
			h('p', { class: 'eyebrow' }, eyebrow),
			h('h1', {}, inline(title)),
			lede ? h('p', { class: 'lede' }, inline(lede)) : null,
			h('div', { class: 'head-row' }, row, again)
		);
	}

	rating(level) {
		return level
			? h(
					'span',
					{ class: 'rating', 'data-level': level },
					'Complexity ',
					h('span', { class: 'rating-bars' }, h('i'), h('i'), h('i')),
					' ',
					h('b', {}, level)
				)
			: null;
	}

	walkthrough(r, stage) {
		const w = r.results.walkthrough;
		const pr = r.pr;
		const passing = pr.checks.filter((c) => c.state === 'pass').length;
		const failing = pr.checks.filter((c) => c.state === 'fail').length;
		const chips = [
			h('span', { class: 'chip' }, `by ${pr.author}`),
			h('span', { class: 'chip' }, plural(pr.commits.length, 'commit')),
			h('span', { class: 'chip' }, pr.isDraft ? 'draft' : pr.state),
			pr.checks.length
				? h(
						'span',
						{ class: `chip ${failing ? 'bad' : 'ok'}` },
						failing
							? `${failing} of ${pr.checks.length} checks failing`
							: `${passing} of ${pr.checks.length} checks passed`
					)
				: h('span', { class: 'chip' }, 'no checks'),
			h(
				'span',
				{ class: 'chip mono' },
				h('span', { class: 'add' }, `+${pr.additions}`),
				' ',
				h('span', { class: 'del' }, `−${pr.deletions}`)
			)
		];
		const out = [
			this.head(
				'Walkthrough · read this first',
				w?.headline || pr.title,
				w?.what || null,
				chips,
				stage
			),
			this.status(r, stage)
		];
		if (w?.why)
			out.push(
				this.section('Why it was made', h('div', { class: 'card prose-card' }, rich(w.why)))
			);
		out.push(
			h(
				'details',
				{ class: 'section', open: !w ? true : null },
				h('summary', { class: 'dim' }, 'The PR’s own description'),
				h(
					'div',
					{ class: 'card prose-card' },
					pr.body.trim()
						? rich(pr.body.slice(0, 6000))
						: h('p', { class: 'dim' }, 'No description.')
				)
			)
		);
		if (pr.images.length)
			out.push(
				this.section(
					'Screenshots and evidence',
					h(
						'div',
						{ class: 'evidence-grid' },
						pr.images.map((img) =>
							h(
								'figure',
								{ class: 'shot' },
								h(
									'button',
									{
										type: 'button',
										'aria-label': `Enlarge: ${img.alt || 'screenshot'}`,
										onclick: () => ((this.s.lightbox = img), this.renderOverlays())
									},
									h('img', {
										src: img.url,
										alt: img.alt || 'Screenshot from the PR',
										loading: 'lazy'
									})
								),
								h('figcaption', {}, img.alt || 'Screenshot from the PR description')
							)
						)
					),
					h(
						'p',
						{ class: 'aside-note' },
						`${this.modelName()} reads the PR as text here, so it hasn’t seen these; they come straight from the PR description.`
					)
				)
			);
		if (w?.evidence?.length)
			out.push(
				this.section(
					'What the PR says it proved',
					h(
						'div',
						{ class: 'card' },
						h(
							'ul',
							{ class: 'checks' },
							w.evidence.map((e) =>
								h(
									'li',
									{},
									h(
										'span',
										{ class: `tick ${e.status}`, title: e.status },
										icon(
											e.status === 'fail'
												? ICONS.x
												: e.status === 'untested'
													? ICONS.skip
													: ICONS.check
										)
									),
									h('span', {}, inline(e.claim), e.detail ? h('small', {}, inline(e.detail)) : null)
								)
							)
						)
					),
					h(
						'p',
						{ class: 'aside-note' },
						'As the model read it from the description; the checks below come from GitHub.'
					)
				)
			);
		if (pr.checks.length)
			out.push(
				this.section(
					'Checks on GitHub',
					h(
						'div',
						{ class: 'card' },
						h(
							'ul',
							{ class: 'checks' },
							pr.checks.map((c) =>
								h(
									'li',
									{},
									h(
										'span',
										{ class: `tick ${c.state}`, title: c.state },
										icon(
											c.state === 'fail' ? ICONS.x : c.state === 'pass' ? ICONS.check : ICONS.skip
										)
									),
									h(
										'span',
										{},
										c.url
											? h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.name)
											: c.name,
										h('small', {}, c.state)
									)
								)
							)
						)
					)
				)
			);
		if (w?.risks?.length)
			out.push(
				this.section(
					'Risks to keep in mind',
					h(
						'div',
						{ class: 'card prose-card' },
						h(
							'ul',
							{},
							w.risks.map((x) => h('li', {}, inline(x)))
						)
					)
				)
			);
		out.push(this.filesSection(r), this.planSection(r));
		if (pr.commits.length)
			out.push(
				this.section(
					'Commits',
					h(
						'div',
						{ class: 'card' },
						h(
							'ul',
							{ class: 'commits' },
							pr.commits.map((c) =>
								h(
									'li',
									{},
									h('span', { class: 'mono dim' }, c.sha.slice(0, 7)),
									h('span', {}, c.msg)
								)
							)
						)
					)
				)
			);
		return out;
	}

	section(title, ...body) {
		return h('section', { class: 'section' }, h('h2', {}, title), body);
	}

	/** The reviewer in plain words: "Claude (sonnet)" or the Ollama model's name. */
	modelName() {
		const s = this._data?.settings;
		if (!s) return 'The reviewer';
		return s.backend === 'ollama' ? s.ollamaModel : `Claude (${s.claudeModel})`;
	}

	filesSection(r) {
		const key = new Set(r.stages.filter((s) => s.kind === 'change').flatMap((s) => s.files));
		const count = { key: 0, test: 0, small: 0, docs: 0, gen: 0 };
		for (const f of r.files) {
			if (f.kind === 'generated') count.gen++;
			else if (key.has(f.path)) count.key++;
			else if (f.kind === 'test') count.test++;
			else if (f.kind === 'docs' || f.kind === 'asset') count.docs++;
			else count.small++;
		}
		const total = r.files.length || 1;
		const seg = [
			[
				'key',
				count.key,
				`${plural(count.key, 'key source file')}, in ${plural(r.stages.filter((s) => s.kind === 'change').length, 'stop')}`
			],
			['test', count.test, plural(count.test, 'test file')],
			['small', count.small, plural(count.small, 'other source and config file')],
			['docs', count.docs, plural(count.docs, 'doc and asset file')],
			['gen', count.gen, `${plural(count.gen, 'generated file')}, hidden`]
		].filter(([, n]) => n);
		return this.section(
			`Where the ${plural(r.files.length, 'file')} went`,
			h(
				'div',
				{ class: 'files-bar', role: 'img', 'aria-label': seg.map((x) => x[2]).join(', ') },
				seg.map(([k, n]) =>
					h('span', { class: `c-${k}`, style: { width: `${(n / total) * 100}%` } })
				)
			),
			h(
				'ul',
				{ class: 'legend' },
				seg.map(([k, , label]) => h('li', {}, h('i', { class: `c-${k}` }), label))
			)
		);
	}

	planSection(r) {
		const stops = r.stages.filter((s) => s.kind === 'change');
		const said = {
			model: `${this.modelName()} grouped the files into these stops.`,
			mixed: `${this.modelName()} grouped the files; a large source file it left out was given a stop of its own.`,
			heuristic:
				r.results.walkthrough || r.runs.walkthrough?.state === 'failed'
					? 'Grouped from the files’ names and sizes: the model’s grouping wasn’t usable.'
					: 'Grouped from the files’ names and sizes for now; the walkthrough may regroup them.'
		}[r.plan?.source ?? 'heuristic'];
		return this.section(
			'The reading plan',
			stops.length
				? h(
						'div',
						{ class: 'card' },
						h(
							'ol',
							{ class: 'plan' },
							stops.map((s, i) =>
								h(
									'li',
									{},
									h('span', { class: 'n' }, String(i + 1)),
									h(
										'span',
										{},
										h('b', {}, s.title),
										h('div', { class: 'mono' }, s.files.join(' · ')),
										s.why ? h('small', {}, inline(s.why)) : null
									)
								)
							)
						)
					)
				: h(
						'p',
						{},
						'No source file changes enough to need a stop of its own; the quality pass and the skim pile cover it.'
					),
			h('p', { class: 'aside-note' }, said)
		);
	}

	quality(r, stage) {
		const q = r.results.quality;
		const findings = q?.findings ?? [];
		const worth = findings.filter((f) => f.level === 'worth').length;
		const kept = findings.filter((f) => r.decisions[f.id] === 'keep').length;
		const out = [
			this.head(
				'Quality pass · before the logic',
				'Is the code itself in good shape?',
				'Only readability and structure here: nesting, long functions, duplication, naming. Keep a note to send it to the author as a suggestion, or dismiss it.',
				q
					? [
							h('span', { class: 'chip' }, `${worth} worth changing`),
							h('span', { class: 'chip' }, plural(findings.length - worth, 'nit')),
							h('span', { class: 'chip' }, `${kept} kept`)
						]
					: [h('span', { class: 'chip' }, plural(stage.files.length, 'source file'))],
				stage
			),
			this.status(r, stage)
		];
		if (q && !findings.length)
			out.push(
				h(
					'p',
					{ class: 'aside-note' },
					`No quality problems found in ${plural(stage.files.length, 'source file')}.`
				)
			);
		for (const f of findings) {
			const d = r.decisions[f.id] ?? null;
			const file = r.files.find((x) => x.path === f.file);
			out.push(
				h(
					'article',
					{ class: `card finding${d === 'dismiss' ? ' dismissed' : ''}` },
					h(
						'div',
						{ class: 'finding-head' },
						h(
							'span',
							{ class: `level level-${f.level}` },
							f.level === 'worth' ? 'Worth changing' : 'Nit'
						),
						h('h3', {}, inline(f.title)),
						h('span', { class: 'loc' }, loc(f))
					),
					h(
						'div',
						{ class: 'finding-body' },
						f.from && file
							? this.code(file, excerptOf(file, f.from, f.to), { hot: [[f.from, f.to]], stage })
							: null,
						f.body ? h('p', {}, inline(f.body)) : null,
						f.suggestion
							? h(
									'div',
									{ class: 'suggest' },
									h('b', {}, 'Suggestion'),
									h('span', {}, inline(f.suggestion))
								)
							: null
					),
					h(
						'div',
						{ class: 'finding-actions' },
						h(
							'button',
							{
								class: `pill-btn${d === 'keep' ? ' on' : ''}`,
								type: 'button',
								'aria-pressed': String(d === 'keep'),
								onclick: () =>
									void this.act('POST', '/decide', {
										finding: f.id,
										decision: d === 'keep' ? null : 'keep'
									})
							},
							'Keep'
						),
						h(
							'button',
							{
								class: `pill-btn${d === 'dismiss' ? ' on' : ''}`,
								type: 'button',
								'aria-pressed': String(d === 'dismiss'),
								onclick: () =>
									void this.act('POST', '/decide', {
										finding: f.id,
										decision: d === 'dismiss' ? null : 'dismiss'
									})
							},
							'Dismiss'
						),
						h(
							'button',
							{
								class: 'pill-btn',
								type: 'button',
								onclick: () => {
									this.s.mode = 'ask';
									if (f.from) this.s.attach = { file: f.file, from: f.from, to: f.to };
									void this.send(
										`Tell me more about “${f.title}”. Is it worth changing in this PR?`
									);
								}
							},
							'Discuss'
						),
						h(
							'span',
							{ class: 'status-txt' },
							d === 'keep'
								? 'Goes into your review as a suggestion'
								: d === 'dismiss'
									? 'Dismissed'
									: ''
						)
					)
				)
			);
		}
		if (!q) for (const p of stage.files.slice(0, 6)) out.push(this.fileBlock(r, stage, p, []));
		return out;
	}

	change(r, stage) {
		const c = r.results[stage.id];
		const stops = r.stages.filter((s) => s.kind === 'change');
		const n = stops.indexOf(stage) + 1;
		const chips = [
			this.rating(c?.complexity),
			...stage.files.map((p) => {
				const f = r.files.find((x) => x.path === p);
				return h(
					'span',
					{ class: 'chip' },
					h('span', { class: 'mono' }, base(p)),
					f
						? [
								' ',
								h('span', { class: 'add' }, `+${f.add}`),
								' ',
								h('span', { class: 'del' }, `−${f.del}`)
							]
						: null
				);
			})
		];
		const out = [
			this.head(
				`Stop ${n} of ${stops.length} · key change`,
				stage.title,
				c?.rationale || stage.why || null,
				chips,
				stage
			),
			this.status(r, stage)
		];
		for (const p of stage.files) out.push(this.fileBlock(r, stage, p, c?.notes ?? []));
		if (c?.alternatives?.length || c?.pick)
			out.push(
				this.section(
					'Other ways to do it',
					h(
						'div',
						{ class: 'alts' },
						(c.alternatives ?? []).map((a) =>
							h(
								'div',
								{ class: 'card alt' },
								h(
									'h3',
									{},
									h('span', {}, inline(a.title)),
									h('span', { class: `verdict v-${a.verdict}` }, a.verdict)
								),
								h(
									'dl',
									{},
									h('dt', {}, 'Gains'),
									h('dd', {}, inline(a.pros || '—')),
									h('dt', {}, 'Costs'),
									h('dd', {}, inline(a.cons || '—'))
								)
							)
						)
					),
					c.pick
						? h('p', { class: 'pick' }, h('b', {}, 'My pick'), h('span', {}, inline(c.pick)))
						: null
				)
			);
		return out;
	}

	/** One file of a stage: its notes pinned above the hunks they discuss, then each hunk's code. */
	fileBlock(r, stage, path, notes) {
		const file = r.files.find((f) => f.path === path);
		if (!file) return null;
		const mine = notes.filter((n) => n.file === path);
		const head = h(
			'div',
			{ class: 'file-head' },
			h('span', { class: 'path', title: path }, h('span', {}, dir(path)), base(path)),
			file.status !== 'modified' ? h('span', { class: 'chip' }, file.status) : null,
			h(
				'span',
				{ class: 'counts' },
				h('span', { class: 'add' }, `+${file.add}`),
				' ',
				h('span', { class: 'del' }, `−${file.del}`)
			)
		);
		if (file.binary)
			return h(
				'div',
				{ class: 'file' },
				head,
				h('p', { class: 'dim' }, 'A binary file; nothing to show.')
			);
		const placed = new Set();
		const hunks = file.hunks.map((hk) => {
			const span = newSpan(hk);
			const here = mine.filter(
				(n) => !placed.has(n) && n.from && span && n.from >= span.from && n.from <= span.to
			);
			for (const n of here) placed.add(n);
			return { hk, here };
		});
		const loose = mine.filter((n) => !placed.has(n));
		return h(
			'section',
			{ class: 'file' },
			head,
			loose.map((n) =>
				h('div', { class: 'hunk' }, this.note(n, stage), h('div', { class: 'code' }))
			),
			hunks.flatMap(({ hk, here }) =>
				splitAtNotes(hk.lines, here).map((part, i) =>
					h(
						'div',
						{ class: 'hunk' },
						part.notes.map((n) => this.note(n, stage)),
						this.code(file, part.lines, {
							hot: here.map((n) => [n.from, n.to]),
							stage,
							header: i === 0 ? hk.header : null
						})
					)
				)
			)
		);
	}

	note(n, stage) {
		return h(
			'div',
			{ class: 'note' },
			h('span', { class: 'avatar' }, icon(ICONS.wheel)),
			h(
				'div',
				{},
				h(
					'p',
					{ class: 'note-title' },
					h('span', {}, inline(n.title)),
					h('span', { class: `tag tag-${n.tag}` }, n.tag),
					h('span', { class: 'note-loc' }, loc(n))
				),
				n.body ? h('p', { class: 'note-body' }, inline(n.body)) : null,
				n.concern ? h('p', { class: 'concern' }, inline(n.concern)) : null,
				h(
					'div',
					{ class: 'note-actions' },
					h(
						'button',
						{ class: 'link-btn', type: 'button', onclick: () => this.pin(n, 'ask', stage) },
						'Ask about this'
					),
					h(
						'button',
						{ class: 'link-btn', type: 'button', onclick: () => this.pin(n, 'change', stage) },
						'Request a change here'
					)
				)
			)
		);
	}

	pin(n, mode, stage) {
		this.s.mode = mode;
		this.s.attach =
			n.from && stage.files.includes(n.file) ? { file: n.file, from: n.from, to: n.to } : null;
		this.render();
		this.el?.input.focus();
	}

	/** Diff lines as a table; line numbers in the stage's files attach lines to the chat. */
	code(file, lines, { hot = [], stage, header = null, limit = 600 } = {}) {
		const r = this.s.review;
		const can = !stage || stage.kind === 'walkthrough' ? false : stage.files.includes(file.path);
		const reqs = r.requests.filter((q) => q.file === file.path && q.from);
		const a = this.s.attach?.file === file.path ? this.s.attach : null;
		const lang = langOf(file.path);
		const rows = [];
		if (header)
			rows.push(
				h(
					'tr',
					{ class: 'hh' },
					h('td', { class: 'ln' }),
					h('td', { class: 'sg' }),
					h('td', {}, header)
				)
			);
		for (const l of lines.slice(0, limit)) {
			const n = l.t === '-' ? null : l.n;
			const cls = [
				l.t === '+' ? 'a' : l.t === '-' ? 'd' : '',
				n && hot.some(([x, y]) => n >= x && n <= y) ? 'hot' : '',
				n && reqs.some((q) => n >= q.from && n <= (q.to ?? q.from)) ? 'req' : '',
				n && a && n >= a.from && n <= a.to ? 'sel' : ''
			]
				.filter(Boolean)
				.join(' ');
			rows.push(
				h(
					'tr',
					{ class: cls || null },
					h(
						'td',
						{
							class: `ln${n && can ? ' can' : ''}`,
							'data-file': n && can ? file.path : null,
							'data-n': n && can ? String(n) : null,
							title: n && can ? `Attach line ${n} to the chat (shift-click for a range)` : null
						},
						n ? String(n) : ''
					),
					h('td', { class: 'sg' }, l.t === ' ' ? '' : l.t === '-' ? '−' : '+'),
					h('td', {}, highlight(l.text, lang))
				)
			);
			if (n)
				for (const q of reqs.filter((q) => (q.to ?? q.from) === n))
					rows.push(
						h(
							'tr',
							{ class: 'inline-req' },
							h(
								'td',
								{ colspan: '3' },
								h('div', { class: 'req-box' }, h('strong', {}, 'Change requested: '), q.text)
							)
						)
					);
		}
		return h(
			'div',
			{ class: 'code' },
			h('table', {}, rows),
			lines.length > limit
				? h('div', { class: 'more-lines' }, `${lines.length - limit} more lines not shown`)
				: null
		);
	}

	skim(r, stage) {
		const sk = r.results.skim;
		const rows = new Map((sk?.files ?? []).map((f) => [f.file, f]));
		const generated = r.files.filter((f) => f.kind === 'generated');
		const out = [
			this.head(
				'Skim pile · the rest',
				'The skim pile',
				`${plural(stage.files.length, 'file')} left after the stops, one line each. Expand any row to see its diff.`,
				[
					h('span', { class: 'chip' }, plural(stage.files.length, 'file')),
					generated.length
						? h('span', { class: 'chip' }, `${generated.length} generated hidden`)
						: null
				],
				stage
			),
			this.status(r, stage)
		];
		out.push(
			h(
				'div',
				{ class: 'group' },
				h(
					'div',
					{ class: 'group-head' },
					h('h2', {}, 'Files'),
					h('span', {}, sk ? 'risk as the model rated it' : 'not rated yet')
				),
				h(
					'div',
					{ class: 'card' },
					h(
						'ul',
						{ class: 'rows' },
						stage.files.map((p) => {
							const f = r.files.find((x) => x.path === p);
							const row = rows.get(p);
							const open = this.s.expanded.has(p);
							return h(
								'li',
								{
									class: `row${open ? ' open' : ''}${row && row.risk !== 'low' ? ' flagged' : ''}`
								},
								h(
									'button',
									{
										class: 'row-btn',
										type: 'button',
										'aria-expanded': String(open),
										onclick: () => {
											if (open) this.s.expanded.delete(p);
											else this.s.expanded.add(p);
											this.render();
										}
									},
									h('span', {
										class: `risk risk-${row?.risk ?? 'low'}`,
										title: `${row?.risk ?? 'unrated'} risk`
									}),
									h(
										'span',
										{},
										h('span', { class: 'row-path', title: p }, p),
										h(
											'span',
											{ class: 'row-note' },
											row?.note
												? inline(row.note)
												: f?.kind
													? `${f.kind}${f.status !== 'modified' ? `, ${f.status}` : ''}`
													: ''
										)
									),
									h(
										'span',
										{ class: 'row-counts' },
										h('span', { class: 'add' }, `+${f?.add ?? 0}`),
										' ',
										h('span', { class: 'del' }, `−${f?.del ?? 0}`)
									),
									icon(ICONS.chev, 'ico chev')
								),
								open && f
									? h(
											'div',
											{ class: 'row-diff' },
											f.binary
												? h('p', { class: 'dim' }, 'A binary file.')
												: f.hunks.map((hk) => this.code(f, hk.lines, { stage, header: hk.header }))
										)
									: null
							);
						})
					)
				)
			)
		);
		if (generated.length)
			out.push(
				h(
					'div',
					{ class: 'group' },
					h(
						'div',
						{ class: 'group-head' },
						h('h2', {}, 'Generated, hidden'),
						h('span', {}, 'build output, lockfiles and snapshots')
					),
					h(
						'div',
						{ class: 'card' },
						h(
							'div',
							{ class: 'gen-list' },
							generated.map((f) => h('div', { title: f.path }, f.path))
						)
					)
				)
			);
		return out;
	}

	// ---------- the chat ----------

	renderChat(r, stage) {
		const engineOk = this.s.engine?.state === 'running';
		if (this.changed('chatHead', [engineOk, this.modelName()]))
			this.el.chatHead.replaceChildren(
				h('span', { class: 'avatar' }, icon(ICONS.wheel)),
				h(
					'div',
					{},
					h('p', { class: 'chat-name' }, 'Review mate'),
					h(
						'p',
						{ class: 'chat-status' },
						h('span', { class: `dot${engineOk ? '' : ' off'}` }),
						this._data?.settings?.backend === 'ollama'
							? `${this.modelName()} on this computer`
							: `${this.modelName()} through Claude Code`
					)
				)
			);
		const res = r.results[stage.id];
		const run = r.runs[stage.id];
		const list = r.chat[stage.id] ?? [];
		const print = [stage.id, stage.title, res?.take, res?.questions, run?.state, run?.reason, list];
		if (!this.changed('chat', print)) return;
		const log = this.el.log;
		// A stage's chat opens at the top of its take; after that it follows new messages.
		const fresh = this.prints.chatStage !== stage.id;
		const stick = !fresh && log.scrollHeight - log.scrollTop - log.clientHeight < 60;
		this.prints.chatStage = stage.id;
		const label = stage.kind === 'change' ? stage.title : KIND_LABEL[stage.kind];
		const items = [h('div', { class: 'divider' }, label)];
		if (res?.take?.length) {
			items.push(
				h(
					'div',
					{ class: 'msg msg-agent' },
					res.take.map((t) => rich(t))
				)
			);
			if (res.questions?.length)
				items.push(
					h(
						'div',
						{ class: 'suggests' },
						res.questions.map((q) =>
							h(
								'button',
								{
									class: 'suggest-chip',
									type: 'button',
									onclick: () => ((this.s.mode = 'ask'), void this.send(q))
								},
								q
							)
						)
					)
				);
		} else if (run?.state === 'failed') {
			items.push(
				h(
					'div',
					{ class: 'msg msg-agent error' },
					h(
						'p',
						{},
						`I couldn’t read this stage: ${run.reason || 'no answer'}. Try again from the banner on the left.`
					)
				)
			);
		} else if (run?.state === 'running' || run?.state === 'queued') {
			items.push(h('div', { class: 'typing', 'aria-label': 'Reading' }, h('i'), h('i'), h('i')));
		}
		for (const m of list) {
			const ctx = m.attach ? h('span', { class: 'msg-ctx' }, loc(m.attach)) : null;
			if (m.role === 'user') items.push(h('div', { class: 'msg msg-user' }, ctx, m.text));
			else if (m.role === 'change')
				items.push(
					h(
						'div',
						{ class: `msg msg-change${m.withdrawn ? ' withdrawn' : ''}` },
						h('span', { class: 'lbl' }, 'Change requested'),
						ctx,
						m.text,
						!m.withdrawn && m.request
							? h(
									'div',
									{},
									h(
										'button',
										{
											class: 'link-btn',
											type: 'button',
											onclick: () => void this.act('POST', '/unrequest', { request: m.request })
										},
										'Withdraw'
									)
								)
							: null
					)
				);
			else if (m.pending && !m.text)
				items.push(
					h('div', { class: 'typing', 'aria-label': 'Answering' }, h('i'), h('i'), h('i'))
				);
			else items.push(h('div', { class: `msg msg-agent${m.error ? ' error' : ''}` }, rich(m.text)));
		}
		log.replaceChildren(...items);
		if (fresh) log.scrollTop = 0;
		else if (stick) log.scrollTop = log.scrollHeight;
	}

	renderComposer(r, stage) {
		const i = r.stages.findIndex((x) => x.id === stage.id);
		const last = i === r.stages.length - 1;
		const done = r.reviewed.includes(stage.id);
		const a = this.s.attach;
		const print = [this.s.mode, a, i, last, done, r.stages.length];
		if (!this.changed('composer', print)) return;
		const el = this.el;
		el.composer.classList.toggle('change', this.s.mode === 'change');
		el.mode.replaceChildren(
			...[
				['ask', 'Ask'],
				['change', 'Request change']
			].map(([m, label]) =>
				h(
					'button',
					{
						type: 'button',
						role: 'tab',
						class: `mode-btn ${m}${this.s.mode === m ? ' on' : ''}`,
						'aria-selected': String(this.s.mode === m),
						onclick: () => ((this.s.mode = m), this.render(), el.input.focus())
					},
					label
				)
			)
		);
		el.input.placeholder =
			this.s.mode === 'change'
				? 'What should the author change?'
				: stage.kind === 'change'
					? 'Ask about this stop…'
					: 'Ask about this stage…';
		el.attach.replaceChildren(
			a
				? h(
						'span',
						{ class: 'attach-chip' },
						h('span', {}, `${a.file}:${a.from}${a.to !== a.from ? `–${a.to}` : ''}`),
						h(
							'button',
							{
								type: 'button',
								'aria-label': 'Remove the attached lines',
								onclick: () => ((this.s.attach = null), this.render())
							},
							'×'
						)
					)
				: ''
		);
		el.actions.replaceChildren(
			h(
				'button',
				{ type: 'button', class: 'link-btn', disabled: i === 0, onclick: () => this.step(-1) },
				'Previous'
			),
			h(
				'button',
				{
					type: 'button',
					class: `primary-btn${done && !last ? ' again' : ''}`,
					onclick: () => void this.markAndNext()
				},
				last
					? done
						? 'Finish review'
						: 'Mark reviewed, finish'
					: done
						? 'Reviewed · next stop'
						: 'Mark reviewed, next stop'
			)
		);
	}

	// ---------- the picker ----------

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
				'A walkthrough first, then a quality pass, then the important changes a few files at a time, then a skim of the rest, with a reviewer to talk each stage through.'
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
											`${x.reviewed} of ${x.stages} stages reviewed · ${ago(x.updatedAt)}${x.posted ? ' · posted to GitHub' : ''}`
										)
									),
									h(
										'button',
										{
											class: 'pill-btn',
											type: 'button',
											disabled: !running,
											onclick: () => void this.open(x.url)
										},
										'Continue'
									)
								)
							)
						)
					)
				)
			);
		return h('div', { class: 'picker' }, out);
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

	// ---------- overlays ----------

	renderOverlays() {
		const box = this.root?.querySelector('.overlays');
		if (!box) return;
		const items = [];
		if (this.s.drawer) items.push(...this.drawer());
		if (this.s.finish && this.s.review) items.push(this.finishModal());
		if (this.s.lightbox)
			items.push(
				h(
					'div',
					{
						class: 'scrim',
						onclick: (e) =>
							e.target === e.currentTarget && ((this.s.lightbox = null), this.renderOverlays())
					},
					h(
						'div',
						{
							class: 'modal lightbox',
							role: 'dialog',
							'aria-modal': 'true',
							'aria-label': this.s.lightbox.alt || 'Screenshot'
						},
						h('img', { src: this.s.lightbox.url, alt: this.s.lightbox.alt || '' }),
						h(
							'div',
							{ class: 'modal-foot' },
							h('span', { class: 'dim' }, this.s.lightbox.alt),
							h(
								'button',
								{
									class: 'ghost-btn',
									type: 'button',
									onclick: () => ((this.s.lightbox = null), this.renderOverlays())
								},
								'Close'
							)
						)
					)
				)
			);
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
					'What the reviewer is told at each stage: the overall prompt first, then the stage’s own. Saved for every review as you type; use “Read again” on a stage to hear its new answer.'
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
						`Reviewer: ${this.modelName()} (Settings → Plugins → PR review)`
					),
					this.s.review
						? h(
								'button',
								{
									class: 'link-btn',
									type: 'button',
									onclick: async () => {
										if (
											!window.confirm(
												'Start this review over? Notes, change requests and the chat are forgotten.'
											)
										)
											return;
										this.s.drawer = null;
										this.prints = {};
										await this.act('DELETE', '');
										this.s.stage = 'walkthrough';
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

	openFinish() {
		const r = this.s.review;
		this.s.finish = { event: suggestVerdict(r), body: null, step: 'draft', error: null };
		this.renderOverlays();
	}

	finishModal() {
		const r = this.s.review;
		const f = this.s.finish;
		const close = () => ((this.s.finish = null), this.renderOverlays());
		const draft = draftReview(r, { event: f.event });
		const body = f.body ?? draft.body;
		const points = reviewPoints(r);
		const changes = r.requests.length;
		const kept = points.length - changes;
		const outcome =
			changes || kept
				? `You asked for ${plural(changes, 'change')} and kept ${plural(kept, 'suggestion')}, across ${r.reviewed.length} of ${r.stages.length} reviewed stages.`
				: `No changes asked and no suggestions kept; ${r.reviewed.length} of ${r.stages.length} stages reviewed.`;
		const ta = h('textarea', {
			class: 'draft-body',
			'data-key': 'finish-body',
			'aria-label': 'Review summary',
			oninput: () => (this.s.finish.body = ta.value)
		});
		ta.value = body;
		const message = firstmateMessage(r);
		const pr = `${r.pr.owner}/${r.pr.repo}#${r.pr.number}`;
		let tail = null;
		if (f.step === 'confirm')
			tail = h(
				'div',
				{ class: 'confirm', role: 'alert' },
				h(
					'p',
					{},
					`This posts a “${VERDICT_LABEL[f.event]}” review with ${plural(draft.comments.length, 'inline comment')} to ${pr} on GitHub, as you. Post it?`
				),
				h(
					'button',
					{
						class: 'ghost-btn',
						type: 'button',
						onclick: () => ((this.s.finish.step = 'draft'), this.renderOverlays())
					},
					'Not yet'
				),
				h(
					'button',
					{
						class: 'primary-btn navy',
						type: 'button',
						'data-key': 'post-confirm',
						onclick: () => void this.post(body, draft.comments)
					},
					'Post review'
				)
			);
		else if (f.step === 'posting')
			tail = h('div', { class: 'confirm' }, h('p', {}, 'Posting to GitHub…'));
		else if (f.step === 'error') tail = h('div', { class: 'confirm' }, h('p', {}, f.error));
		else if (f.step === 'firstmate')
			tail = h(
				'div',
				{ class: 'draft' },
				h('h3', {}, 'The message to Firstmate'),
				h('pre', {}, message),
				h(
					'div',
					{ class: 'modal-foot' },
					h(
						'span',
						{ class: 'dim' },
						'It opens in Wheelhouse’s chat box; nothing is sent until you send it there.'
					),
					h(
						'a',
						{
							class: 'primary-btn navy',
							href: firstmateHref(message),
							style: { textDecoration: 'none' }
						},
						'Open in Firstmate’s chat'
					)
				)
			);
		if (r.posted)
			tail = [
				tail,
				h(
					'p',
					{ class: 'done-note' },
					`Posted to GitHub ${ago(r.posted.at)} as “${VERDICT_LABEL[r.posted.event] ?? r.posted.event}”. `,
					h('a', { href: r.posted.url, target: '_blank', rel: 'noopener' }, 'See it on GitHub')
				)
			];
		return h(
			'div',
			{ class: 'scrim', onclick: (e) => e.target === e.currentTarget && close() },
			h(
				'div',
				{ class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'finish-title' },
				h('p', { class: 'eyebrow' }, 'Making port'),
				h('h2', { id: 'finish-title' }, 'Finish the review'),
				h('p', { class: 'outcome' }, outcome),
				h('p', { class: 'eyebrow' }, 'Verdict'),
				h(
					'div',
					{ class: 'verdicts' },
					VERDICTS.map((v) =>
						h(
							'button',
							{
								class: `pill-btn${f.event === v ? ' on' : ''}`,
								type: 'button',
								'aria-pressed': String(f.event === v),
								onclick: () => (
									(this.s.finish.event = v),
									(this.s.finish.body = null),
									this.renderOverlays()
								)
							},
							VERDICT_LABEL[v]
						)
					),
					f.event === suggestVerdict(r)
						? h('span', { class: 'dim' }, 'suggested from your notes')
						: null
				),
				ta,
				points.length
					? h(
							'div',
							{ class: 'draft' },
							h(
								'h3',
								{},
								`${plural(draft.comments.length, 'inline comment')}${draft.comments.length < points.length ? `, ${points.length - draft.comments.length} in the summary` : ''}`
							),
							h(
								'ul',
								{},
								points.map((p) =>
									h(
										'li',
										{},
										h('b', {}, p.kind === 'change' ? 'Change: ' : 'Suggestion: '),
										p.file ? h('span', { class: 'mono' }, `${loc(p)} `) : null,
										inline(p.text)
									)
								)
							)
						)
					: null,
				h(
					'div',
					{ class: 'modal-foot' },
					h('button', { class: 'ghost-btn', type: 'button', onclick: close }, 'Back to the review'),
					h(
						'button',
						{ class: 'ghost-btn', type: 'button', onclick: () => void this.copy(body, draft) },
						'Copy review'
					),
					h(
						'button',
						{
							class: 'ghost-btn',
							type: 'button',
							disabled: !points.length,
							title: points.length ? null : 'Nothing to fix',
							onclick: () => ((this.s.finish.step = 'firstmate'), this.renderOverlays())
						},
						'Send to Firstmate'
					),
					h(
						'button',
						{
							class: 'primary-btn navy',
							type: 'button',
							onclick: () => ((this.s.finish.step = 'confirm'), this.renderOverlays())
						},
						'Post to GitHub'
					)
				),
				tail
			)
		);
	}

	async post(body, comments) {
		const f = this.s.finish;
		f.step = 'posting';
		this.renderOverlays();
		try {
			this.take(
				await this.api('POST', `/api/reviews/${this.s.review.id}/post`, {
					event: f.event,
					body,
					comments,
					confirm: true
				})
			);
			this.s.finish.step = 'draft';
			this.toast('Posted to GitHub.');
		} catch (e) {
			if (this.s.finish) Object.assign(this.s.finish, { step: 'error', error: e.message });
		}
		this.renderOverlays();
	}

	async copy(body, draft) {
		const text = [
			body,
			'',
			...draft.comments.map(
				(c) => `- ${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line} ${c.body}`
			)
		]
			.join('\n')
			.trim();
		try {
			await navigator.clipboard.writeText(text);
			this.toast('Review copied.');
		} catch {
			this.toast('The clipboard isn’t available here.');
		}
	}
}

/** The diff lines a new-side range covers, with the removed lines just before them. */
function excerptOf(file, from, to) {
	const flat = file.hunks.flatMap((x) => x.lines);
	const inc = flat.map((l) => l.t !== '-' && l.n >= from && l.n <= to);
	for (let i = 0; i < flat.length; i++) {
		if (flat[i].t !== '-') continue;
		let j = i;
		while (j < flat.length && flat[j].t === '-') j++;
		if (j < flat.length && inc[j]) for (let k = i; k < j; k++) inc[k] = true;
		i = j - 1;
	}
	return flat.filter((_, i) => inc[i]);
}

/**
 * A hunk cut where each note starts, so a note sits right above its lines
 * even in a long new file: `[{ notes, lines }]`, the first part holding the
 * lines before any note.
 */
export function splitAtNotes(lines, notes) {
	const sorted = [...notes].sort((a, b) => a.from - b.from);
	const parts = [{ notes: [], lines: [] }];
	let k = 0;
	for (const l of lines) {
		while (k < sorted.length && l.n !== undefined && l.n >= sorted[k].from) {
			const last = parts.at(-1);
			if (last.lines.length || !last.notes.length) parts.push({ notes: [sorted[k]], lines: [] });
			else last.notes.push(sorted[k]);
			k++;
		}
		parts.at(-1).lines.push(l);
	}
	return parts.filter((p) => p.lines.length || p.notes.length);
}

/** The nearest ancestor that scrolls (or the page's own scrolling element). */
function scrollerOf(el) {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const o = window.getComputedStyle(p).overflowY;
		if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
	}
	return document.scrollingElement;
}

function newSpan(hunk) {
	const ns = hunk.lines.filter((l) => l.n !== undefined).map((l) => l.n);
	return ns.length ? { from: Math.min(...ns), to: Math.max(...ns) } : null;
}

if (!customElements.get('pr-review-tab')) customElements.define('pr-review-tab', PrReviewTab);
