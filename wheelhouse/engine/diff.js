/**
 * Reads `gh pr diff` output (a unified git diff) into files and hunks, with
 * each line's old and new line numbers, and writes a stage's diff back out as
 * compact text for the model, numbered by new-side line so it can cite lines.
 *
 * @typedef {{ t: ' ' | '+' | '-'; o?: number; n?: number; text: string }} DiffLine
 * @typedef {{ header: string; ctx: string; oldStart: number; newStart: number; lines: DiffLine[] }} Hunk
 * @typedef {{
 *   path: string;
 *   oldPath: string | null;
 *   status: 'added' | 'deleted' | 'renamed' | 'modified';
 *   binary: boolean;
 *   add: number;
 *   del: number;
 *   hunks: Hunk[];
 * }} DiffFile
 */

const unquote = (p) =>
	p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p;
const strip = (p) => unquote(p).replace(/^[ab]\//, '');

/** @param {string} text @returns {DiffFile[]} */
export function parseDiff(text) {
	/** @type {DiffFile[]} */
	const files = [];
	/** @type {DiffFile | null} */
	let cur = null;
	/** @type {Hunk | null} */
	let hunk = null;
	let o = 0;
	let n = 0;
	for (const line of String(text).split('\n')) {
		if (line.startsWith('diff --git ')) {
			const m = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
			const path = m ? m[2] : line.slice(11);
			cur = { path, oldPath: null, status: 'modified', binary: false, add: 0, del: 0, hunks: [] };
			files.push(cur);
			hunk = null;
			continue;
		}
		if (!cur) continue;
		if (!hunk) {
			if (line.startsWith('new file')) cur.status = 'added';
			else if (line.startsWith('deleted file')) cur.status = 'deleted';
			else if (line.startsWith('rename from ')) {
				cur.status = 'renamed';
				cur.oldPath = line.slice(12);
			} else if (line.startsWith('rename to ')) cur.path = line.slice(10);
			else if (line.startsWith('Binary files ')) cur.binary = true;
			else if (line.startsWith('+++ ') && line !== '+++ /dev/null') cur.path = strip(line.slice(4));
			else if (line.startsWith('--- ') && line !== '--- /dev/null' && cur.status !== 'added') {
				const old = strip(line.slice(4));
				if (old !== cur.path) cur.oldPath = old;
			}
		}
		const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
		if (m) {
			o = Number(m[1]);
			n = Number(m[2]);
			hunk = { header: line, ctx: m[3], oldStart: o, newStart: n, lines: [] };
			cur.hunks.push(hunk);
			continue;
		}
		if (!hunk) continue;
		const t = line[0];
		const body = line.slice(1);
		if (t === '+') {
			cur.add++;
			hunk.lines.push({ t: '+', n: n++, text: body });
		} else if (t === '-') {
			cur.del++;
			hunk.lines.push({ t: '-', o: o++, text: body });
		} else if (t === ' ') {
			hunk.lines.push({ t: ' ', o: o++, n: n++, text: body });
		}
	}
	return files;
}

/** The new-side line numbers a GitHub review comment can sit on: those inside a hunk. */
export function commentableLines(file) {
	const lines = new Set();
	for (const h of file?.hunks ?? []) for (const l of h.lines) if (l.n !== undefined) lines.add(l.n);
	return lines;
}

/** The first and last new-side line a file's diff shows, or null for none. */
export function lineSpan(file) {
	let lo = Infinity;
	let hi = -Infinity;
	for (const h of file?.hunks ?? [])
		for (const l of h.lines)
			if (l.n !== undefined) {
				lo = Math.min(lo, l.n);
				hi = Math.max(hi, l.n);
			}
	return lo === Infinity ? null : { from: lo, to: hi };
}

/**
 * One file's diff as the model reads it: a header, then each hunk with every
 * line numbered by its new-side line (removed lines are numbered `-`), cut at
 * `budget` characters with a note saying how much was left out.
 */
export function fileDiffText(file, budget = Infinity) {
	const head = `### ${file.path} (${file.status}, +${file.add} -${file.del})`;
	if (file.binary) return `${head}\n(binary file)`;
	const out = [head];
	let used = head.length;
	let shown = 0;
	const total = file.hunks.reduce((s, h) => s + h.lines.length, 0);
	for (const h of file.hunks) {
		const hh = `@@ ${h.ctx}`.trimEnd();
		if (used + hh.length > budget) break;
		out.push(hh);
		used += hh.length + 1;
		for (const l of h.lines) {
			const row = `${l.t === '-' ? '    -' : String(l.n).padStart(5)} ${l.t} ${l.text}`;
			if (used + row.length > budget) break;
			out.push(row);
			used += row.length + 1;
			shown++;
		}
		if (used >= budget) break;
	}
	if (shown < total) out.push(`(… ${total - shown} more diff lines not shown)`);
	return out.join('\n');
}

/**
 * Several files' diffs within one character budget: each file gets an equal
 * share, and what a short file leaves is handed on to the longer ones.
 */
export function diffText(files, budget) {
	const sizes = files.map((f) => fileDiffText(f).length);
	const shares = new Array(files.length).fill(0);
	let left = budget;
	let open = files.map((_, i) => i);
	while (open.length && left > 0) {
		const each = Math.floor(left / open.length);
		const next = [];
		for (const i of open) {
			const want = sizes[i] - shares[i];
			const give = Math.min(want, each);
			shares[i] += give;
			left -= give;
			if (shares[i] < sizes[i]) next.push(i);
		}
		if (next.length === open.length && each === 0) break;
		open = next;
	}
	return files.map((f, i) => fileDiffText(f, Math.max(shares[i], 200))).join('\n\n');
}

/** The diff lines a range covers on the new side, plus the removed lines just before them. */
export function excerpt(file, from, to) {
	const flat = (file?.hunks ?? []).flatMap((h) => h.lines);
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
