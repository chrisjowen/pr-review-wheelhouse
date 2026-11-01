/**
 * PR review: a project tab that reviews one pull request as a guided, staged
 * discussion with a local model.
 *
 * Wheelhouse's side is small and read-only. The `prs` provider lists the
 * project's open pull requests (one `gh pr list` in the clone) and hands the
 * tab the plugin's settings. Everything slow or that writes (reading a PR's
 * diff, the reviewer's passes, the chat, the captain's prompts and reviews, posting
 * a review) lives in the companion `engine` service: a loopback HTTP server
 * from this repository that Wheelhouse starts only when the captain clicks
 * Start in the tab, and that the tab talks to directly.
 */

import { fileURLToPath } from 'node:url';
import { readSettings } from '../engine/config.js';

export const ENGINE = fileURLToPath(new URL('../engine/main.js', import.meta.url));
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ENGINE_PORT = 4791;
const TIMEOUT_MS = 9_000;
const PR_FIELDS =
	'number,title,url,author,isDraft,updatedAt,additions,deletions,changedFiles,headRefName';

/** The project's open pull requests, newest change first; never more than 30. */
export function readPrs(stdout) {
	let list;
	try {
		list = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(list)) return null;
	return list
		.filter((p) => p && Number.isInteger(p.number) && /^https:\/\/github\.com\//.test(p.url ?? ''))
		.map((p) => ({
			number: p.number,
			title: String(p.title ?? ''),
			url: p.url,
			author: p.author?.login ?? '',
			isDraft: !!p.isDraft,
			updatedAt: p.updatedAt ?? null,
			additions: Number(p.additions) || 0,
			deletions: Number(p.deletions) || 0,
			changedFiles: Number(p.changedFiles) || 0,
			branch: String(p.headRefName ?? '')
		}))
		.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
		.slice(0, 30);
}

/** Why `gh pr list` failed, in plain words. */
function why(r) {
	const said = `${r.stderr ?? ''} ${r.reason ?? ''}`;
	if (/ENOENT/.test(said)) return 'gh isn’t installed, so open pull requests can’t be listed.';
	if (/auth|login/i.test(said))
		return 'gh isn’t signed in (`gh auth login`), so open pull requests can’t be listed.';
	if (/no git remotes|not a git repository|none of the git remotes/i.test(said))
		return 'This project’s clone has no GitHub remote, so there are no pull requests to list.';
	if (/timed out|ETIMEDOUT|SIGTERM/i.test(said))
		return 'GitHub took too long to list the pull requests.';
	return 'The open pull requests couldn’t be listed.';
}

async function fetch(ctx) {
	if (!ctx.project) return { available: false, reason: 'There is no project to review.' };
	const settings = readSettings(ctx.settings);
	const r = await ctx.exec({
		argv: ['gh', 'pr', 'list', '--state', 'open', '--limit', '30', '--json', PR_FIELDS],
		cwd: 'project',
		timeoutMs: TIMEOUT_MS - 500,
		maxBytes: 512 * 1024
	});
	const prs = r.ok ? readPrs(r.stdout) : null;
	return {
		available: true,
		value: {
			schema: 'pr-review-tab.v1',
			project: ctx.project.id,
			prs: prs ?? [],
			reason: prs ? null : r.ok ? 'gh answered with something unexpected.' : why(r),
			settings
		},
		source: 'GitHub, through gh',
		observedAt: new Date().toISOString()
	};
}

/** The engine, for the whole fleet: one server reviews any project's pull requests. */
async function resolve(ctx) {
	const s = readSettings(ctx.settings);
	const port = await ctx.servicePort(ENGINE_PORT);
	const url = `http://127.0.0.1:${port}`;
	const argv = [
		process.execPath,
		ENGINE,
		'--port',
		String(port),
		'--backend',
		s.backend,
		'--claude-model',
		s.claudeModel,
		'--ollama-model',
		s.ollamaModel,
		'--ollama',
		s.ollamaUrl,
		'--context',
		String(s.contextTokens)
	];
	const env = {};
	if (process.env.PR_REVIEW_STATE_DIR) env.PR_REVIEW_STATE_DIR = process.env.PR_REVIEW_STATE_DIR;
	if (process.env.XDG_STATE_HOME) env.XDG_STATE_HOME = process.env.XDG_STATE_HOME;
	if (process.env.PR_REVIEW_CLAUDE_CONFIG_DIR)
		env.PR_REVIEW_CLAUDE_CONFIG_DIR = process.env.PR_REVIEW_CLAUDE_CONFIG_DIR;
	return {
		available: true,
		spec: {
			url,
			health: `${url}/health`,
			identity: { url: `${url}/health`, path: ['service'], value: 'pr-review-engine' },
			argv,
			cwd: ROOT,
			env,
			binds: 'loopback',
			readyTimeoutMs: 15_000
		},
		hint: `node ${ENGINE} --port ${port} --backend ${s.backend}`
	};
}

export function createPlugin() {
	return {
		providers: [{ id: 'prs', scope: 'project', ttlMs: 60_000, timeoutMs: TIMEOUT_MS, fetch }],
		contributions: [
			{
				slot: 'project.tab',
				id: 'review',
				title: 'PR review',
				provider: 'prs',
				// Wheelhouse opens a chat card's pull request here; older versions ignore it.
				opensPullRequest: '?pr={url}',
				render: { element: 'pr-review-tab' }
			}
		],
		services: [{ id: 'engine', title: 'the PR review engine', scope: 'fleet', resolve }]
	};
}

export default createPlugin();
