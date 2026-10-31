/**
 * What kind of file a changed path is, from its name alone: generated output
 * (hidden from review), docs, tests, config, assets (images, fonts) or source. The walkthrough pass
 * builds on this rather than trusting a small local model to tell a bundle
 * from a source file.
 *
 * @typedef {'generated' | 'docs' | 'test' | 'config' | 'asset' | 'source'} Kind
 */

const LOCKFILES = new Set([
	'package-lock.json',
	'npm-shrinkwrap.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lockb',
	'bun.lock',
	'Cargo.lock',
	'go.sum',
	'poetry.lock',
	'uv.lock',
	'Gemfile.lock',
	'composer.lock',
	'mix.lock',
	'Podfile.lock',
	'flake.lock'
]);

const GENERATED = [
	/(^|\/)(dist|build|out|vendor|node_modules|\.next|\.svelte-kit|coverage)\//,
	/(^|\/)__snapshots__\//,
	/\.(min\.(js|css)|map|snap|lock)$/,
	/(^|[._-])generated\.[^/]+$/,
	/_pb2?\.(py|go)$|\.pb\.go$/
];
const TEST = [
	/(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\//,
	/\.(test|spec|integration\.test|e2e)\.[cm]?[jt]sx?$/,
	/_test\.(go|py|rb|exs?)$/,
	/(^|\/)test_[^/]+\.py$/
];
const DOCS = [/\.(md|mdx|markdown|rst|adoc|txt)$/i, /(^|\/)(docs?|LICENSE|CHANGELOG)(\/|$)/];
const ASSET =
	/\.(png|jpe?g|gif|webp|avif|ico|svg|bmp|pdf|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|zip|gz)$/i;
const CONFIG = [
	/(^|\/)\.[^/]+$/,
	/(^|\/)\.(github|husky|vscode|devcontainer)\//,
	/\.(json|ya?ml|toml|ini|cfg|conf|env)$/,
	/(^|\/)(Dockerfile|Makefile|Procfile|justfile)$/
];

/** A matcher for the captain's own extra generated patterns: `*` matches any part of a name, `dir/` a folder. */
export function patternMatcher(patterns = []) {
	const res = patterns
		.filter((p) => typeof p === 'string' && p.trim())
		.map((p) => {
			const t = p.trim();
			const esc = t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
			if (t.endsWith('/')) return new RegExp(`(^|/)${esc}`);
			return t.includes('/') ? new RegExp(`^${esc}$`) : new RegExp(`(^|/)${esc}$`);
		});
	return (path) => res.some((r) => r.test(path));
}

/**
 * @param {string} path
 * @param {{ extraGenerated?: (path: string) => boolean }} [o]
 * @returns {Kind}
 */
export function kindOf(path, { extraGenerated } = {}) {
	const name = path.split('/').pop() ?? path;
	if (LOCKFILES.has(name) || GENERATED.some((r) => r.test(path)) || extraGenerated?.(path))
		return 'generated';
	if (ASSET.test(path)) return 'asset';
	if (TEST.some((r) => r.test(path))) return 'test';
	if (DOCS.some((r) => r.test(path))) return 'docs';
	if (CONFIG.some((r) => r.test(path))) return 'config';
	return 'source';
}
