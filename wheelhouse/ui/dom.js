/**
 * Small DOM helpers for the review tab. Everything the model or GitHub says
 * becomes text nodes: `h` sets text with `textContent`, `rich` turns the
 * model's **bold** and `code` into elements without parsing HTML, and links
 * keep to http(s).
 */

/**
 * An element: `h('p', { class: 'x', onclick }, 'text', child, [more])`.
 * Attributes starting with `on` become listeners; `null`, `false` and
 * `undefined` attributes and children are skipped.
 */
export function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v === null || v === undefined || v === false) continue;
		if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else if (k === 'text') el.textContent = v;
		else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
		else if (k === 'href') el.setAttribute('href', safeHref(v));
		else if (k === 'src') el.setAttribute('src', safeHref(v));
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	append(el, children);
	return el;
}

function append(el, children) {
	for (const c of children.flat(Infinity)) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
}

/** An SVG icon from path data, drawn in the current colour. */
export function icon(paths, cls = 'ico') {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', cls);
	svg.setAttribute('aria-hidden', 'true');
	for (const d of [paths].flat()) {
		if (d.startsWith('circle:')) {
			const [cx, cy, r] = d.slice(7).split(',');
			const c = document.createElementNS(NS, 'circle');
			c.setAttribute('cx', cx);
			c.setAttribute('cy', cy);
			c.setAttribute('r', r);
			svg.append(c);
		} else {
			const p = document.createElementNS(NS, 'path');
			p.setAttribute('d', d);
			svg.append(p);
		}
	}
	return svg;
}

export const ICONS = {
	check: 'M5 12.5l4.5 4.5L19 7.5',
	arrow: 'M5 12h14M13 6l6 6-6 6',
	back: 'M19 12H5M11 6l-6 6 6 6',
	chev: 'M9 6l6 6-6 6',
	skip: 'M6 12h12',
	wheel: [
		'circle:12,12,4',
		'circle:12,12,8.5',
		'M12 1.5v6M12 16.5v6M1.5 12h6M16.5 12h6M4.6 4.6l4.2 4.2M15.2 15.2l4.2 4.2M19.4 4.6l-4.2 4.2M8.8 15.2l-4.2 4.2'
	],
	anchor: ['circle:12,5,2', 'M12 7v14M5 13a7 7 0 0 0 14 0M8 10h8'],
	sliders: ['M4 6h10M4 12h16M4 18h7', 'circle:17,6,2', 'circle:14,18,2'],
	retry: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
	x: 'M6 6l12 12M18 6L6 18',
	warn: 'M12 3l9.5 17h-19zM12 10v4M12 17.5v.5'
};

/** Only http(s) and same-origin paths; anything else becomes `#`. */
export function safeHref(v) {
	const s = String(v ?? '');
	if (/^https?:\/\//i.test(s) || (s.startsWith('/') && !s.startsWith('//'))) return s;
	return '#';
}

/** Inline **bold**, *em* and `code` as elements; everything else stays text. */
export function inline(text) {
	const out = [];
	const re = /(\*\*[^*]+\*\*|`[^`]+`|(?<![\w*])\*[^*\s][^*]*\*(?!\w))/g;
	let at = 0;
	const s = String(text ?? '');
	for (const m of s.matchAll(re)) {
		if (m.index > at) out.push(s.slice(at, m.index));
		const t = m[0];
		if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
		else if (t.startsWith('`')) out.push(h('code', {}, t.slice(1, -1)));
		else out.push(h('em', {}, t.slice(1, -1)));
		at = m.index + t.length;
	}
	if (at < s.length) out.push(s.slice(at));
	return out;
}

/** Paragraphs and simple lists from the model's text. */
export function rich(text) {
	const blocks = String(text ?? '')
		.replace(/\r/g, '')
		.split(/\n{2,}/)
		.map((b) => b.trim())
		.filter(Boolean);
	return blocks.map((b) => {
		const lines = b.split('\n');
		if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
			const ordered = /^\s*\d/.test(lines[0]);
			return h(
				ordered ? 'ol' : 'ul',
				{},
				lines.map((l) => h('li', {}, inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))))
			);
		}
		return h(
			'p',
			{},
			lines.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)))
		);
	});
}

const KEYWORDS = new Set(
	(
		'abstract as async await break case catch class const continue def default defer delete do elif else enum ' +
		'export extends false final finally fn for from func function go if impl implements import in instanceof ' +
		'interface is let match mod module mut new nil none null of package private protected pub public raise ' +
		'readonly return self static struct super switch this throw true try type typeof undefined use var void ' +
		'where while with yield True False None'
	).split(' ')
);
const TOKEN =
	/(\/\/.*$|#(?![{[]).*$|\/\*.*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d_.]*\b|\b[A-Za-z_$][\w$]*\b)/g;

/**
 * One code line as spans: comments, strings, numbers, keywords and types.
 * Line by line on purpose: it never needs to see the whole file.
 */
export function highlight(line, lang) {
	const s = String(line ?? '');
	if (lang === 'plain') return [s];
	const out = [];
	let at = 0;
	for (const m of s.matchAll(TOKEN)) {
		const t = m[0];
		let cls = null;
		if (t.startsWith('//') || t.startsWith('/*')) cls = 'tk-c';
		else if (t.startsWith('#')) cls = lang === 'hash' ? 'tk-c' : null;
		else if (/^["'`]/.test(t)) cls = 'tk-s';
		else if (/^\d/.test(t)) cls = 'tk-n';
		else if (KEYWORDS.has(t)) cls = 'tk-k';
		else if (/^[A-Z][a-z]/.test(t)) cls = 'tk-t';
		if (!cls) continue;
		if (m.index > at) out.push(s.slice(at, m.index));
		out.push(h('span', { class: cls }, t));
		at = m.index + t.length;
	}
	if (at < s.length) out.push(s.slice(at));
	return out;
}

/** How a path's lines are coloured: C-like, hash comments, or plain. */
export function langOf(path) {
	if (/\.(md|txt|json|lock|csv|svg)$/i.test(path)) return 'plain';
	if (/\.(py|rb|sh|ya?ml|toml|ex|exs|r)$|(^|\/)(Dockerfile|Makefile)$/i.test(path)) return 'hash';
	return 'c';
}

/** "3 minutes ago" for an ISO time or epoch ms. */
export function ago(at, now = Date.now()) {
	const t = typeof at === 'number' ? at : Date.parse(at);
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
	const hr = Math.round(m / 60);
	if (hr < 48) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
	const d = Math.round(hr / 24);
	return `${d} day${d === 1 ? '' : 's'} ago`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
