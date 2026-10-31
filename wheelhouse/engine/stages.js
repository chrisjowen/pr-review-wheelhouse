/**
 * The review's stages: the walkthrough first, then the quality pass, then
 * 1-4 stops of 1-3 files holding the important logic, then the skim pile; the
 * generated files are hidden. The walkthrough pass proposes the stops as JSON;
 * `reconcilePlan` holds that proposal to the real file list, so a small model
 * that misnames a path, invents one, calls source "generated", puts a test in
 * a stop or leaves the biggest change out can't lose a file or hide real code.
 *
 * @typedef {import('./diff.js').DiffFile} DiffFile
 * @typedef {import('./classify.js').Kind} Kind
 * @typedef {{ title: string; files: string[]; why: string }} Stop
 * @typedef {{ stops: Stop[]; skim: string[]; generated: string[]; source: 'model' | 'heuristic' | 'mixed' }} Plan
 * @typedef {{ id: string; kind: 'walkthrough' | 'quality' | 'change' | 'skim'; title: string; short: string; files: string[]; why?: string }} Stage
 */

export const MAX_STOPS = 4;
export const MAX_STOP_FILES = 3;
/** A source file changing this many lines is never left out of the stops. */
const BIG_CHANGE = 40;

const churn = (f) => f.add + f.del;
const base = (p) => p.split('/').pop() ?? p;
const dirOf = (p) => p.slice(0, p.length - base(p).length);

/**
 * The changed files as the walkthrough pass reads them: one line each with
 * its kind and size, generated files collapsed into one line per folder.
 *
 * @param {(DiffFile & { kind: Kind })[]} files
 */
export function manifestText(files) {
	const lines = [];
	const generated = new Map();
	for (const f of files) {
		if (f.kind === 'generated') {
			const dir = dirOf(f.path) || './';
			generated.set(dir, (generated.get(dir) ?? 0) + 1);
			continue;
		}
		const status = f.status === 'modified' ? '' : `, ${f.status}`;
		lines.push(`- ${f.path} (${f.kind}${status}, +${f.add} -${f.del})`);
	}
	for (const [dir, n] of generated)
		lines.push(`- ${dir} (generated, ${n} file${n === 1 ? '' : 's'}; hidden from review)`);
	return lines.join('\n');
}

/**
 * A plan without the model: the biggest source changes become stops, each
 * joined by up to two other changed source files from the same folder.
 *
 * @param {(DiffFile & { kind: Kind })[]} files
 * @returns {Plan}
 */
export function heuristicPlan(files) {
	const generated = files.filter((f) => f.kind === 'generated').map((f) => f.path);
	const source = files
		.filter((f) => f.kind === 'source' && !f.binary)
		.sort((a, b) => churn(b) - churn(a));
	const used = new Set();
	const stops = [];
	for (const f of source) {
		if (stops.length >= MAX_STOPS) break;
		if (used.has(f.path) || churn(f) < 10) continue;
		const mates = source
			.filter(
				(g) => g !== f && !used.has(g.path) && dirOf(g.path) === dirOf(f.path) && churn(g) >= 10
			)
			.slice(0, MAX_STOP_FILES - 1);
		const group = [f, ...mates];
		for (const g of group) used.add(g.path);
		stops.push({
			title: `Changes in ${base(f.path)}`,
			files: group.map((g) => g.path),
			why:
				group.length > 1
					? `The largest source change here, read with ${group.length - 1} related file${group.length > 2 ? 's' : ''} from the same folder.`
					: 'One of the largest source changes in the pull request.'
		});
	}
	if (!stops.length && source[0]) {
		stops.push({
			title: `Changes in ${base(source[0].path)}`,
			files: [source[0].path],
			why: 'The largest source change in the pull request.'
		});
		used.add(source[0].path);
	}
	const skim = files.filter((f) => f.kind !== 'generated' && !used.has(f.path)).map((f) => f.path);
	return { stops, skim, generated, source: 'heuristic' };
}

/**
 * Finds the real path a model meant: exact, then with a stray kind or `a/`
 * `b/` prefix dropped, then by a unique ending.
 *
 * @param {string} said
 * @param {string[]} paths
 */
export function resolvePath(said, paths) {
	if (typeof said !== 'string') return null;
	let p = said
		.trim()
		.replace(/\s*\(.*\)$/, '')
		.replace(/^`|`$/g, '')
		.replace(/^(\.\/|[ab]\/)/, '');
	if (paths.includes(p)) return p;
	p = p.replace(/^(source|test|tests|docs|config|generated)[\s/:]+/i, '');
	if (paths.includes(p)) return p;
	const ends = paths.filter((q) => q.endsWith(`/${p}`) || p.endsWith(`/${q}`));
	return ends.length === 1 ? ends[0] : null;
}

/**
 * Holds the model's proposed grouping to the real files.
 *
 * @param {(DiffFile & { kind: Kind })[]} files
 * @param {unknown} proposed the walkthrough's `stops` (and anything else it said)
 * @returns {Plan}
 */
export function reconcilePlan(files, proposed) {
	const fallback = heuristicPlan(files);
	const paths = files.map((f) => f.path);
	const byPath = new Map(files.map((f) => [f.path, f]));
	const raw = Array.isArray(proposed) ? proposed : [];
	const used = new Set();
	/** @type {Stop[]} */
	const stops = [];
	for (const s of raw) {
		if (stops.length >= MAX_STOPS) break;
		if (!s || typeof s !== 'object') continue;
		const list = Array.isArray(s.files) ? s.files : typeof s.file === 'string' ? [s.file] : [];
		const kept = [];
		for (const said of list) {
			const p = resolvePath(said, paths);
			if (!p || used.has(p) || kept.includes(p)) continue;
			const f = byPath.get(p);
			// Stops hold source; a test, doc or config file the model picks stays in the skim pile.
			if (!f || f.kind !== 'source' || f.binary) continue;
			if (kept.length < MAX_STOP_FILES) kept.push(p);
		}
		if (!kept.length) continue;
		for (const p of kept) used.add(p);
		const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 80) : '';
		stops.push({
			title: title || `Changes in ${base(kept[0])}`,
			files: kept,
			why: typeof s.why === 'string' ? s.why.trim().slice(0, 400) : ''
		});
	}
	if (!stops.length) return fallback;

	let source = 'model';
	// The biggest source change always gets read closely.
	const biggest = files
		.filter((f) => f.kind === 'source' && !f.binary && !used.has(f.path) && churn(f) >= BIG_CHANGE)
		.sort((a, b) => churn(b) - churn(a));
	for (const f of biggest) {
		const most = Math.max(...stops.flatMap((s) => s.files.map((p) => churn(byPath.get(p)))));
		if (churn(f) < most / 2) break;
		if (stops.length < MAX_STOPS) {
			stops.push({
				title: `Changes in ${base(f.path)}`,
				files: [f.path],
				why: 'A large source change the walkthrough did not group; read it closely.'
			});
			used.add(f.path);
			source = 'mixed';
		}
	}
	const skim = files.filter((f) => f.kind !== 'generated' && !used.has(f.path)).map((f) => f.path);
	return { stops, skim, generated: fallback.generated, source };
}

/**
 * The stages a plan reads as, in order. The quality pass reads the source
 * files (every reviewable file when there is no source).
 *
 * @param {Plan} plan
 * @param {Map<string, Kind>} [kinds]
 * @returns {Stage[]}
 */
export function stagesOf(plan, kinds = new Map()) {
	const reviewable = [...plan.stops.flatMap((s) => s.files), ...plan.skim];
	const source = reviewable.filter((p) => kinds.get(p) === 'source');
	return [
		{
			id: 'walkthrough',
			kind: 'walkthrough',
			title: 'What this PR does, and why',
			short: 'Walkthrough',
			files: []
		},
		{
			id: 'quality',
			kind: 'quality',
			title: 'Quality pass',
			short: 'Quality pass',
			files: source.length ? source : reviewable
		},
		...plan.stops.map((s, i) => ({
			id: `stop-${i + 1}`,
			kind: /** @type {const} */ ('change'),
			title: s.title,
			short: s.title,
			files: s.files,
			why: s.why
		})),
		{ id: 'skim', kind: 'skim', title: 'The skim pile', short: 'Skim pile', files: plan.skim }
	];
}
