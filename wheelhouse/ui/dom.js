/**
 * Small DOM helpers for the review tab. Everything the model or GitHub says
 * becomes text nodes: `h` sets text with `textContent`, and links keep to
 * http(s).
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

/** Only http(s) and same-origin paths; anything else becomes `#`. */
export function safeHref(v) {
	const s = String(v ?? '');
	if (/^https?:\/\//i.test(s) || (s.startsWith('/') && !s.startsWith('//'))) return s;
	return '#';
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
