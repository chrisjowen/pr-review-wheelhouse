/**
 * The pull request's structure as a diagram, worked out from the diff alone
 * (no model, so the same diff always draws the same picture): the changed
 * source and test files, each with the declarations it adds, changes or
 * removes (functions, classes, types), and the imports between them that the
 * PR adds, removes or keeps. Files left to right in import order, so a file
 * sits left of what it imports; an unchanged file or a package appears only
 * when an added or removed import reaches it.
 *
 * The SVG carries its own light and dark colours, so it reads the same in
 * the chat and inline in the review on GitHub, where posting puts it.
 *
 * @typedef {import('./diff.js').DiffFile & { kind?: string }} File
 * @typedef {'added' | 'removed' | 'changed'} Change
 * @typedef {{ name: string; change: Change }} Decl
 * @typedef {{
 *   id: string; label: string; dir: string;
 *   kind: 'file' | 'context' | 'package';
 *   status: 'added' | 'deleted' | 'renamed' | 'modified' | 'context' | 'package';
 *   add: number; del: number; decls: Decl[]
 * }} Node
 * @typedef {{ from: string; to: string; state: 'added' | 'removed' | 'kept' }} Edge
 * @typedef {{ nodes: Node[]; edges: Edge[]; omitted: number }} Structure
 */

/** At most this many changed files are drawn; the rest are counted. */
export const MAX_FILES = 18;
const MAX_PACKAGES = 8;
const MAX_CONTEXT = 8;
const MAX_DECLS = 5;

const JS = /\.(m|c)?(j|t)sx?$|\.(svelte|vue|astro)$/i;
const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.svelte', '.vue'];
const PY = /\.py$/i;
const GO = /\.go$/i;
const RS = /\.rs$/i;
const CSS = /\.(s?css|less)$/i;

const base = (p) => p.split('/').pop() ?? p;
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** A path with `.` and `..` worked out; null when it climbs out of the repository. */
function normalize(p) {
	const out = [];
	for (const part of p.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (!out.length) return null;
			out.pop();
		} else out.push(part);
	}
	return out.join('/');
}

/** What a line imports, as written: a path, a module or a package. */
export function importsOf(path, text) {
	const t = String(text);
	const out = [];
	const push = (m) => m && out.push(m);
	if (JS.test(path)) {
		push(t.match(/^\s*(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/)?.[1]);
		push(t.match(/^\s*\}\s*from\s*['"]([^'"]+)['"]/)?.[1]);
		push(t.match(/^\s*import\s*['"]([^'"]+)['"]/)?.[1]);
		for (const m of t.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1]);
	} else if (PY.test(path)) {
		const from = t.match(/^\s*from\s+(\.*[\w.]*)\s+import\b/);
		if (from) push(from[1]);
		else {
			const imp = t.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/);
			if (imp) for (const m of imp[1].split(',')) push(m.trim());
		}
	} else if (GO.test(path)) {
		push(t.match(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/)?.[1]);
		push(t.match(/^\t(?:[\w.]+ )?"([^"\s]+)"$/)?.[1]);
	} else if (RS.test(path)) {
		const mod = t.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/);
		if (mod) push(`mod:${mod[1]}`);
		push(t.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:crate|super|self)(?:::\w+)+)/)?.[1]);
	} else if (CSS.test(path)) push(t.match(/^\s*@(?:import|use|forward)\s+['"]([^'"]+)['"]/)?.[1]);
	return [...new Set(out)];
}

/**
 * Where an import leads: one of the PR's files, an unchanged file of the
 * repository (its likely path), or a package.
 *
 * @param {string} path the importing file
 * @param {string} spec what it imports, as written
 * @param {Set<string>} known every path the PR touches
 * @returns {{ kind: 'file' | 'context' | 'package'; id: string } | null}
 */
export function resolveImport(path, spec, known) {
	const dir = dirOf(path);
	const firstKnown = (cands) => cands.find((c) => c !== null && known.has(c)) ?? null;
	if (JS.test(path) || CSS.test(path)) {
		if (!/^\.{1,2}\//.test(spec)) return { kind: 'package', id: packageOf(spec) };
		const p = normalize(`${dir}/${spec}`);
		if (p === null) return null;
		const stem = p.replace(/\.(m|c)?js$/, '');
		const hit = firstKnown([
			p,
			...JS_EXTS.map((e) => stem + e),
			...JS_EXTS.map((e) => `${p}/index${e}`)
		]);
		return hit ? { kind: 'file', id: hit } : { kind: 'context', id: p };
	}
	if (PY.test(path)) {
		const dots = spec.match(/^\.*/)[0].length;
		const rest = spec.slice(dots).replace(/\./g, '/');
		if (dots) {
			let at = dir;
			for (let i = 1; i < dots; i++) at = dirOf(at);
			const p = normalize(`${at}/${rest}`);
			if (p === null) return null;
			const hit = firstKnown([`${p}.py`, `${p}/__init__.py`]);
			return hit ? { kind: 'file', id: hit } : { kind: 'context', id: rest ? `${p}.py` : p };
		}
		const hit = [...known].find((k) => k === `${rest}.py` || k.endsWith(`/${rest}.py`));
		const pkg = [...known].find(
			(k) => k === `${rest}/__init__.py` || k.endsWith(`/${rest}/__init__.py`)
		);
		if (hit || pkg) return { kind: 'file', id: hit ?? pkg };
		return { kind: 'package', id: spec.split('.')[0] };
	}
	if (RS.test(path)) {
		if (spec.startsWith('mod:')) {
			const name = spec.slice(4);
			const here = /(^|\/)(main|lib|mod)\.rs$/.test(path)
				? dir
				: `${dir}/${base(path).replace(/\.rs$/, '')}`;
			const p = normalize(`${here}/${name}`);
			if (p === null) return null;
			const hit = firstKnown([`${p}.rs`, `${p}/mod.rs`]);
			return hit ? { kind: 'file', id: hit } : { kind: 'context', id: `${p}.rs` };
		}
		const parts = spec.split('::');
		const root = parts[0] === 'crate' ? srcRoot(path) : dir;
		for (let n = parts.length; n > 1; n--) {
			const p = normalize(`${root}/${parts.slice(1, n).join('/')}`);
			const hit = p === null ? null : firstKnown([`${p}.rs`, `${p}/mod.rs`]);
			if (hit) return { kind: 'file', id: hit };
		}
		return null;
	}
	if (GO.test(path)) return { kind: 'package', id: spec.split('/').slice(-2).join('/') };
	return null;
}

const srcRoot = (path) => {
	const at = path.lastIndexOf('src/');
	return at >= 0 ? path.slice(0, at + 3) : 'src';
};

/** A package's name from an import: `@scope/name`, `name`, or `node:fs`. */
function packageOf(spec) {
	if (spec.startsWith('node:')) return spec;
	const parts = spec.split('/');
	return spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new']);

/** A declaration a line makes, as the diagram names it (`name()`, `class Name`, `type Name`), or null. */
export function declOf(path, text) {
	const t = String(text);
	let m;
	if (JS.test(path)) {
		if ((m = t.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/)))
			return `${m[1]}()`;
		if ((m = t.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/)))
			return `class ${m[1]}`;
		if ((m = t.match(/^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([\w$]+)/)))
			return `type ${m[1]}`;
		if ((m = t.match(/^export\s+(?:const|let|var)\s+([\w$]+)\s*=\s*(.*)$/)))
			return /^(async\s*)?(\(|[\w$]+\s*=>|function\b)/.test(m[2]) ? `${m[1]}()` : m[1];
		if (
			(m = t.match(/^\t(?:static\s+)?(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*\{\s*$/)) &&
			!KEYWORDS.has(m[1])
		)
			return `${m[1]}()`;
		return null;
	}
	if (PY.test(path)) {
		if ((m = t.match(/^(?: {4})?(?:async\s+)?def\s+(\w+)/))) return `${m[1]}()`;
		if ((m = t.match(/^class\s+(\w+)/))) return `class ${m[1]}`;
		return null;
	}
	if (GO.test(path)) {
		if ((m = t.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)/))) return `${m[1]}()`;
		if ((m = t.match(/^type\s+(\w+)/))) return `type ${m[1]}`;
		return null;
	}
	if (RS.test(path)) {
		if ((m = t.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/)))
			return `${m[1]}()`;
		if ((m = t.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|type)\s+(\w+)/)))
			return `${m[1] === 'struct' || m[1] === 'enum' ? 'type' : m[1]} ${m[2]}`;
	}
	return null;
}

/** Whether a file is drawn: changed source or tests the diff shows. */
const drawn = (f) =>
	!f.binary &&
	(f.kind === 'source' || f.kind === 'test') &&
	(JS.test(f.path) || PY.test(f.path) || GO.test(f.path) || RS.test(f.path) || CSS.test(f.path));

/**
 * The PR's structure from its diff: the files, what each declares, and the
 * imports between them.
 *
 * @param {File[]} files
 * @returns {Structure}
 */
export function structureOf(files) {
	const candidates = files.filter(drawn);
	// Source before tests, then the biggest changes, then by path, so the cut is the same every time.
	const ranked = [...candidates].sort(
		(a, b) =>
			(a.kind === 'test') - (b.kind === 'test') ||
			b.add + b.del - (a.add + a.del) ||
			a.path.localeCompare(b.path)
	);
	const picked = ranked.slice(0, MAX_FILES);
	const known = new Set(files.map((f) => f.path));
	const pickedPaths = new Set(picked.map((f) => f.path));
	/** @type {Map<string, Node>} */
	const nodes = new Map();
	for (const f of picked)
		nodes.set(f.path, {
			id: f.path,
			label: base(f.path),
			dir: dirOf(f.path),
			kind: 'file',
			status: f.status,
			add: f.add,
			del: f.del,
			decls: declsOf(f)
		});
	/** @type {Map<string, { from: string; to: string; kind: string; add: boolean; del: boolean; ctx: boolean }>} */
	const seen = new Map();
	for (const f of picked)
		for (const h of f.hunks ?? [])
			for (const l of h.lines) {
				const side = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
				for (const spec of importsOf(f.path, l.text)) {
					const to = resolveImport(f.path, spec, known);
					if (!to || to.id === f.path) continue;
					const key = `${f.path}\n${to.id}`;
					const e = seen.get(key) ?? {
						from: f.path,
						to: to.id,
						kind: to.kind,
						add: false,
						del: false,
						ctx: false
					};
					e[side] = true;
					seen.set(key, e);
				}
			}
	/** @type {Edge[]} */
	const edges = [];
	const extra = { context: new Map(), package: new Map() };
	for (const e of seen.values()) {
		const state = e.ctx || (e.add && e.del) ? 'kept' : e.add ? 'added' : 'removed';
		if (e.kind === 'file' && !pickedPaths.has(e.to)) continue;
		// An unchanged file or a package is worth a box only when the PR adds or removes an import of it.
		if (e.kind !== 'file') {
			if (state === 'kept') continue;
			const bag = extra[e.kind === 'package' ? 'package' : 'context'];
			bag.set(e.to, (bag.get(e.to) ?? 0) + 1);
		}
		edges.push({ from: e.from, to: e.to, state });
	}
	const top = (bag, n) =>
		[...bag]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
			.map(([id]) => id);
	for (const id of top(extra.context, MAX_CONTEXT))
		nodes.set(id, {
			id,
			label: base(id),
			dir: dirOf(id),
			kind: 'context',
			status: 'context',
			add: 0,
			del: 0,
			decls: []
		});
	for (const id of top(extra.package, MAX_PACKAGES))
		nodes.set(id, {
			id,
			label: id,
			dir: '',
			kind: 'package',
			status: 'package',
			add: 0,
			del: 0,
			decls: []
		});
	return {
		nodes: [...nodes.values()],
		edges: edges
			.filter((e) => nodes.has(e.to))
			.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
		omitted: candidates.length - picked.length
	};
}

/** What a file's diff declares: added, removed, or changed (both, or a declaration a changed line sits in). */
function declsOf(f) {
	const add = new Set();
	const del = new Set();
	const touched = new Set();
	const py = PY.test(f.path);
	for (const h of f.hunks ?? []) {
		// The declaration a changed line sits in: the hunk's own, until the diff shows another, or its end.
		let within = declOf(f.path, h.ctx ?? '');
		for (const l of h.lines) {
			const d = declOf(f.path, l.text);
			if (d) {
				if (l.t !== ' ') (l.t === '+' ? add : del).add(d);
				// A declaration that ends on its own line holds nothing after it.
				within = /;\s*$/.test(l.text) ? null : d;
				continue;
			}
			if (l.t !== ' ' && within && l.text.trim()) touched.add(within);
			const ends = py ? /^[^\s#@)\]}]/.test(l.text) : /^[}\])]/.test(l.text);
			if (ends) within = null;
		}
	}
	/** @type {Decl[]} */
	const out = [];
	for (const d of add) out.push({ name: d, change: del.has(d) ? 'changed' : 'added' });
	for (const d of del) if (!add.has(d)) out.push({ name: d, change: 'removed' });
	for (const d of touched)
		if (!add.has(d) && !del.has(d) && f.status === 'modified')
			out.push({ name: d, change: 'changed' });
	return out;
}

// ---------- drawing ----------

const W = 250;
const GAP_X = 96;
const GAP_Y = 16;
const PAD = 24;
const HEAD = 44;
const LINE = 17;
const CHAR = 6.9;

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	);
/** Cuts text to `n` characters, from the end when `left` (for folders, whose end says most). */
function fit(s, n, left = false) {
	const t = String(s);
	if (t.length <= n) return t;
	return left ? `…${t.slice(t.length - n + 1)}` : `${t.slice(0, n - 1)}…`;
}

const heightOf = (n) => {
	const shown = Math.min(n.decls.length, MAX_DECLS) + (n.decls.length > MAX_DECLS ? 1 : 0);
	return n.kind === 'package' ? 32 : HEAD + (shown ? shown * LINE + 6 : 0);
};

/**
 * Columns in import order: a file left of what it imports (longest path, an
 * import cycle cut where it closes), packages last, and files with no import
 * to draw in a row of their own underneath. Within a column, by folder and
 * name, then moved toward the files they connect to.
 */
function layout(s) {
	const linked = new Set(s.edges.flatMap((e) => [e.from, e.to]));
	const ids = s.nodes.map((n) => n.id).sort();
	const out = new Map(ids.map((id) => [id, []]));
	for (const e of s.edges) out.get(e.from)?.push(e.to);
	for (const list of out.values()) list.sort();
	// Back edges, found depth-first in a fixed order, are left out of the layering.
	const back = new Set();
	const mark = new Map();
	const visit = (id) => {
		mark.set(id, 1);
		for (const to of out.get(id) ?? []) {
			if (mark.get(to) === 1) back.add(`${id}\n${to}`);
			else if (!mark.has(to)) visit(to);
		}
		mark.set(id, 2);
	};
	for (const id of ids) if (!mark.has(id)) visit(id);
	const layer = new Map();
	const depth = (id, seen = new Set()) => {
		if (layer.has(id)) return layer.get(id);
		seen.add(id);
		let d = 0;
		for (const e of s.edges)
			if (e.to === id && !back.has(`${e.from}\n${e.to}`) && !seen.has(e.from))
				d = Math.max(d, depth(e.from, seen) + 1);
		seen.delete(id);
		layer.set(id, d);
		return d;
	};
	const byId = new Map(s.nodes.map((n) => [n.id, n]));
	const graph = s.nodes.filter((n) => linked.has(n.id));
	for (const n of graph) depth(n.id);
	const files = graph.filter((n) => n.kind !== 'package');
	const last = Math.max(0, ...files.map((n) => layer.get(n.id)));
	for (const n of graph) if (n.kind === 'package') layer.set(n.id, last + 1);
	const columns = [];
	for (const n of graph) (columns[layer.get(n.id)] ??= []).push(n.id);
	const cols = columns.filter(Boolean);
	const order = (a, b) => {
		const x = byId.get(a);
		const y = byId.get(b);
		return x.dir.localeCompare(y.dir) || x.label.localeCompare(y.label);
	};
	for (const c of cols) c.sort(order);
	// A few sweeps toward the neighbours' average place, ties kept in folder order.
	const place = () => {
		const at = new Map();
		for (const c of cols) c.forEach((id, i) => at.set(id, i / Math.max(1, c.length - 1)));
		return at;
	};
	for (let sweep = 0; sweep < 4; sweep++) {
		const at = place();
		for (const c of cols) {
			const key = new Map(
				c.map((id) => {
					const near = s.edges
						.filter((e) => e.from === id || e.to === id)
						.map((e) => at.get(e.from === id ? e.to : e.from));
					return [id, near.length ? near.reduce((a, b) => a + b, 0) / near.length : at.get(id)];
				})
			);
			const before = new Map(c.map((id, i) => [id, i]));
			c.sort((a, b) => key.get(a) - key.get(b) || before.get(a) - before.get(b));
		}
	}
	const loose = s.nodes
		.filter((n) => !linked.has(n.id))
		.map((n) => n.id)
		.sort(order);
	return { cols, loose, back };
}

/**
 * The structure as an SVG picture, with its own light and dark colours.
 *
 * @param {Structure} s
 * @param {{ title?: string; subtitle?: string }} [o]
 */
export function structureSvg(s, { title = 'How the change fits together', subtitle = '' } = {}) {
	const byId = new Map(s.nodes.map((n) => [n.id, n]));
	const { cols, loose } = layout(s);
	const pos = new Map();
	const top = PAD + 74;
	let width = PAD * 2 + Math.max(1, cols.length) * W + Math.max(0, cols.length - 1) * GAP_X;
	let bottom = top;
	cols.forEach((c, ci) => {
		let y = top;
		for (const id of c) {
			const n = byId.get(id);
			pos.set(id, { x: PAD + ci * (W + GAP_X), y, h: heightOf(n) });
			y += heightOf(n) + GAP_Y;
		}
		bottom = Math.max(bottom, y);
	});
	let looseTop = bottom;
	if (loose.length) {
		const perRow = Math.max(1, Math.min(4, Math.floor((width - PAD * 2 + GAP_Y) / (W + GAP_Y))));
		width = Math.max(width, PAD * 2 + perRow * W + (perRow - 1) * GAP_Y);
		looseTop = bottom + (cols.length ? 30 : 0);
		let y = looseTop + 22;
		for (let i = 0; i < loose.length; i += perRow) {
			const row = loose.slice(i, i + perRow);
			const h = Math.max(...row.map((id) => heightOf(byId.get(id))));
			row.forEach((id, j) =>
				pos.set(id, { x: PAD + j * (W + GAP_Y), y, h: heightOf(byId.get(id)) })
			);
			y += h + GAP_Y;
		}
		bottom = y;
	}
	width = Math.max(width, LEGEND_WIDTH + PAD * 2);
	const height = bottom + PAD - GAP_Y + (s.omitted ? 20 : 0);
	const parts = [];
	parts.push(`<rect class="bg" width="${width}" height="${height}" rx="12"/>`);
	parts.push(
		`<text class="ink title" x="${PAD}" y="${PAD + 16}">${esc(title)}</text>`,
		subtitle
			? `<text class="mute small" x="${PAD}" y="${PAD + 36}">${esc(fit(subtitle, Math.floor((width - PAD * 2) / 6.4)))}</text>`
			: ''
	);
	parts.push(legend(PAD, PAD + 56));
	const head = (id) => pos.get(id).y + (byId.get(id).kind === 'package' ? 16 : 22);
	for (const e of s.edges) {
		const a = pos.get(e.from);
		const b = pos.get(e.to);
		if (!a || !b) continue;
		const forward = b.x > a.x;
		const x1 = a.x + W;
		const y1 = head(e.from);
		const x2 = forward ? b.x : b.x + (b.x === a.x ? W : 0);
		const y2 = head(e.to);
		const d = forward
			? `M${x1} ${y1} C${x1 + GAP_X / 2} ${y1} ${x2 - GAP_X / 2} ${y2} ${x2 - 6} ${y2}`
			: `M${x1} ${y1} C${x1 + 70} ${y1} ${x2 + 70} ${y2} ${x2 + 6} ${y2}`;
		parts.push(`<path class="edge ${e.state}" d="${d}" marker-end="url(#ah-${e.state})"/>`);
	}
	if (loose.length && cols.length)
		parts.push(
			`<text class="mute small" x="${PAD}" y="${looseTop + 10}">Also changed, with no import between them to draw</text>`
		);
	for (const n of s.nodes) parts.push(nodeSvg(n, pos.get(n.id)));
	if (s.omitted)
		parts.push(
			`<text class="mute small" x="${PAD}" y="${height - PAD + 6}">${s.omitted} more changed file${s.omitted === 1 ? '' : 's'} not drawn</text>`
		);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
<style>${SVG_STYLE}</style>
<defs>${['added', 'removed', 'kept']
		.map(
			(k) =>
				`<marker id="ah-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ah ${k}" d="M0 0L10 5L0 10z"/></marker>`
		)
		.join('')}</defs>
${parts.filter(Boolean).join('\n')}
</svg>`;
}

const LEGEND = [
	['box', 'added', 'added file'],
	['box', 'modified', 'changed'],
	['box', 'deleted', 'removed'],
	['box', 'context', 'unchanged'],
	['box', 'package', 'package'],
	['line', 'added', 'import added'],
	['line', 'removed', 'import removed'],
	['line', 'kept', 'import kept']
];
const legendStep = (shape, text) => (shape === 'box' ? 15 : 19) + text.length * 6.1 + 16;
const LEGEND_WIDTH = LEGEND.reduce((n, [shape, , text]) => n + legendStep(shape, text), 0);

function legend(x, y) {
	let at = x;
	return LEGEND.map(([shape, k, text]) => {
		const mark =
			shape === 'box'
				? `<rect class="stripe ${k}" x="${at}" y="${y - 9}" width="10" height="10" rx="2"/>`
				: `<path class="edge ${k}" d="M${at - 2} ${y - 4}h16"/>`;
		const label = `<text class="mute small" x="${at + (shape === 'box' ? 15 : 19)}" y="${y}">${text}</text>`;
		at += legendStep(shape, text);
		return mark + label;
	}).join('');
}

const SIGN = { added: '+', removed: '−', changed: '~' };

function nodeSvg(n, p) {
	if (!p) return '';
	const { x, y, h } = p;
	if (n.kind === 'package')
		return `<g><rect class="card pkg" x="${x}" y="${y}" width="${W}" height="${h}" rx="16"/><rect class="stripe package" x="${x + 12}" y="${y + 11}" width="10" height="10" rx="5"/><text class="ink mono" x="${x + 30}" y="${y + 20}">${esc(fit(n.label, 30))}</text></g>`;
	const dash = n.kind === 'context' ? ' dashed' : '';
	const out = [
		`<rect class="card${dash}" x="${x}" y="${y}" width="${W}" height="${h}" rx="8"/>`,
		`<rect class="stripe ${n.status}" x="${x}" y="${y}" width="5" height="${h}" rx="2"/>`,
		`<text class="mute small" x="${x + 14}" y="${y + 16}">${esc(fit(n.dir ? `${n.dir}/` : './', 34, true))}</text>`,
		`<text class="ink name" x="${x + 14}" y="${y + 34}">${esc(fit(n.label, n.kind === 'file' ? 22 : 30))}</text>`
	];
	if (n.kind === 'file') {
		const stat = n.status === 'added' ? 'new' : n.status === 'deleted' ? 'gone' : '';
		out.push(
			`<text class="small" x="${x + W - 10}" y="${y + 34}" text-anchor="end">${stat ? `<tspan class="mute">${stat} </tspan>` : ''}<tspan class="plus">+${n.add}</tspan> <tspan class="minus">−${n.del}</tspan></text>`
		);
	}
	const shown = n.decls.slice(0, MAX_DECLS);
	shown.forEach((d, i) => {
		const ly = y + HEAD + 10 + i * LINE;
		out.push(
			`<text class="mono decl ${d.change}" x="${x + 14}" y="${ly}"><tspan class="sign">${SIGN[d.change]}</tspan> ${esc(fit(d.name, Math.floor((W - 40) / CHAR)))}</text>`
		);
	});
	if (n.decls.length > MAX_DECLS)
		out.push(
			`<text class="mute small" x="${x + 14}" y="${y + HEAD + 10 + MAX_DECLS * LINE}">and ${n.decls.length - MAX_DECLS} more</text>`
		);
	return `<g>${out.join('')}</g>`;
}

const SVG_STYLE = `
text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:13px}
.title{font-size:16px;font-weight:600}.small{font-size:11.5px}.name{font-weight:600}
.mono,.mono tspan{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
.bg{fill:#ffffff}.card{fill:#f6f8fa;stroke:#d0d7de}.card.dashed{fill:#ffffff;stroke-dasharray:4 3}.card.pkg{fill:#ffffff}
.ink{fill:#1f2328}.mute{fill:#59636e}.plus{fill:#1a7f37}.minus{fill:#cf222e}
.decl{fill:#1f2328}.decl.added .sign{fill:#1a7f37}.decl.removed{fill:#59636e;text-decoration:line-through}.decl.removed .sign{fill:#cf222e}.decl.changed .sign{fill:#9a6700}
.stripe.added{fill:#1a7f37}.stripe.modified{fill:#9a6700}.stripe.renamed{fill:#8250df}.stripe.deleted{fill:#cf222e}.stripe.context{fill:#8c959f}.stripe.package{fill:#0969da}
.edge{fill:none;stroke-width:1.6}.edge.added{stroke:#1a7f37}.edge.removed{stroke:#cf222e;stroke-dasharray:5 4}.edge.kept{stroke:#8c959f;stroke-width:1.2}
.ah.added{fill:#1a7f37}.ah.removed{fill:#cf222e}.ah.kept{fill:#8c959f}
@media (prefers-color-scheme: dark){
.bg{fill:#0d1117}.card{fill:#151b23;stroke:#3d444d}.card.dashed,.card.pkg{fill:#0d1117}
.ink,.decl{fill:#f0f6fc}.mute,.decl.removed{fill:#9198a1}.plus{fill:#3fb950}.minus{fill:#f85149}
.decl.added .sign{fill:#3fb950}.decl.removed .sign{fill:#f85149}.decl.changed .sign{fill:#d29922}
.stripe.added{fill:#3fb950}.stripe.modified{fill:#d29922}.stripe.renamed{fill:#a371f7}.stripe.deleted{fill:#f85149}.stripe.context{fill:#656c76}.stripe.package{fill:#4493f8}
.edge.added{stroke:#3fb950}.edge.removed{stroke:#f85149}.edge.kept{stroke:#656c76}
.ah.added{fill:#3fb950}.ah.removed{fill:#f85149}.ah.kept{fill:#656c76}
}`;

/**
 * The diagrams a review shows and can post: for now one, the structure, when
 * the PR changes any source the diagram can read.
 *
 * @param {{ pr: { owner: string; repo: string; number: number; headSha?: string }; files: File[] }} r
 * @returns {{ id: string; title: string; alt: string; file: string; svg: string }[]}
 */
export function diagramsOf(r) {
	const s = structureOf(r.files ?? []);
	const files = s.nodes.filter((n) => n.kind === 'file');
	if (!files.length) return [];
	const count = (state) => s.edges.filter((e) => e.state === state).length;
	const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
	const dirs = new Set(files.map((f) => f.dir));
	const said = [
		`${n(files.length, 'changed file')} in ${n(dirs.size, 'folder')}`,
		`${n(count('added'), 'import')} added, ${count('removed')} removed`
	];
	const title = 'How the change fits together';
	const sha = String(r.pr.headSha ?? '').slice(0, 7);
	return [
		{
			id: 'structure',
			title,
			alt: `${title}: ${said.join('; ')}, worked out from the diff.`,
			file: `pr-${r.pr.number}/${sha || 'head'}-structure.svg`,
			svg: structureSvg(s, {
				title,
				subtitle: `${r.pr.owner}/${r.pr.repo}#${r.pr.number}${sha ? ` at ${sha}` : ''} · ${said.join(' · ')}`
			})
		}
	];
}
