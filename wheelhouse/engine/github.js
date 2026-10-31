/**
 * Reads a pull request through `gh` (its description, commits, checks and
 * diff, plus the screenshots its description links), and posts a review only
 * when asked to. Commands go through `run`, so tests hand it a fake `gh`.
 *
 * @typedef {(argv: string[], o?: { input?: string; timeoutMs?: number; maxBytes?: number }) => Promise<{ ok: boolean; stdout: string; stderr: string }>} Run
 */

import { execFile } from 'node:child_process';

export class GitHubError extends Error {
	constructor(message, status = 502) {
		super(message);
		this.status = status;
	}
}

/** `gh` as a child process: an argument list, no shell. */
export function ghRunner(bin = 'gh') {
	/** @type {Run} */
	return (argv, { input, timeoutMs = 30_000, maxBytes = 32 * 1024 * 1024 } = {}) =>
		new Promise((resolve) => {
			const child = execFile(
				bin,
				argv,
				{
					timeout: timeoutMs,
					maxBuffer: maxBytes,
					env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
				},
				(err, stdout, stderr) =>
					resolve({
						ok: !err,
						stdout: String(stdout),
						stderr: String(stderr || err?.message || '')
					})
			);
			if (input !== undefined) child.stdin?.end(input);
		});
}

/**
 * A pull request's address from its URL (`https://github.com/o/r/pull/12`,
 * with or without a trailing path) or `o/r#12`; null otherwise.
 */
export function parsePrUrl(text) {
	const s = String(text ?? '').trim();
	let m = s.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
	if (!m) m = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
	if (!m) return null;
	const [, owner, repo, n] = m;
	return { owner, repo, number: Number(n), url: `https://github.com/${owner}/${repo}/pull/${n}` };
}

/** Screenshots a description links: Markdown images and `<img>` tags, http(s) only, at most 8. */
export function imagesOf(body) {
	const out = [];
	const seen = new Set();
	const add = (url, alt) => {
		if (!/^https:\/\//i.test(url) || seen.has(url)) return;
		seen.add(url);
		out.push({
			url,
			alt: String(alt ?? '')
				.trim()
				.slice(0, 160)
		});
	};
	const text = String(body ?? '');
	for (const m of text.matchAll(/!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g)) add(m[2], m[1]);
	for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
		const src = m[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
		const alt = m[0].match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1];
		if (src) add(src, alt);
	}
	return out.slice(0, 8);
}

/** A check's state in plain words: pass, fail, pending, skipped or neutral. */
export function checkState(c) {
	const s = String(c.conclusion || c.state || c.status || '').toUpperCase();
	if (['SUCCESS', 'PASS'].includes(s)) return 'pass';
	if (
		[
			'FAILURE',
			'ERROR',
			'TIMED_OUT',
			'CANCELLED',
			'ACTION_REQUIRED',
			'STARTUP_FAILURE',
			'FAIL'
		].includes(s)
	)
		return 'fail';
	if (['SKIPPED'].includes(s)) return 'skipped';
	if (['NEUTRAL', 'STALE'].includes(s)) return 'neutral';
	return 'pending';
}

const FIELDS =
	'number,title,body,url,author,state,isDraft,baseRefName,headRefName,headRefOid,commits,statusCheckRollup,additions,deletions,changedFiles,createdAt';

/** @param {Run} run */
export function createGitHub(run) {
	const fail = (what, r) => {
		const said = (r.stderr || '').trim().split('\n').slice(-2).join(' ');
		if (/auth|login|token/i.test(said))
			return new GitHubError(`${what}: gh isn’t signed in (run \`gh auth login\`).`);
		if (/not found|could not resolve/i.test(said))
			return new GitHubError(`${what}: GitHub couldn’t find it, or gh can’t see it.`);
		return new GitHubError(`${what}${said ? `: ${said.slice(0, 300)}` : '.'}`);
	};
	return {
		/** The pull request and its diff. */
		async load(url) {
			const at = parsePrUrl(url);
			if (!at) throw new GitHubError('That isn’t a GitHub pull request URL.', 400);
			const repo = `${at.owner}/${at.repo}`;
			const [view, diff] = await Promise.all([
				run(['pr', 'view', String(at.number), '--repo', repo, '--json', FIELDS]),
				run(['pr', 'diff', String(at.number), '--repo', repo], { timeoutMs: 60_000 })
			]);
			if (!view.ok) throw fail('The pull request couldn’t be read', view);
			if (!diff.ok) throw fail('The pull request’s diff couldn’t be read', diff);
			let pr;
			try {
				pr = JSON.parse(view.stdout);
			} catch {
				throw new GitHubError('gh answered with something that isn’t JSON.');
			}
			const checks = (pr.statusCheckRollup ?? []).map((c) => ({
				name: String(c.name || c.context || 'check'),
				state: checkState(c),
				url:
					typeof c.detailsUrl === 'string'
						? c.detailsUrl
						: typeof c.targetUrl === 'string'
							? c.targetUrl
							: null
			}));
			return {
				pr: {
					owner: at.owner,
					repo: at.repo,
					number: pr.number,
					url: pr.url || at.url,
					title: String(pr.title ?? ''),
					body: String(pr.body ?? ''),
					author: pr.author?.login ?? '',
					state: String(pr.state ?? '').toLowerCase(),
					isDraft: !!pr.isDraft,
					baseRef: pr.baseRefName ?? '',
					headRef: pr.headRefName ?? '',
					headSha: pr.headRefOid ?? '',
					additions: pr.additions ?? 0,
					deletions: pr.deletions ?? 0,
					changedFiles: pr.changedFiles ?? 0,
					createdAt: pr.createdAt ?? null,
					commits: (pr.commits ?? []).map((c) => ({
						sha: String(c.oid ?? ''),
						msg: String(c.messageHeadline ?? '')
					})),
					checks,
					images: imagesOf(pr.body)
				},
				diff: diff.stdout
			};
		},

		/** Posts a review on the head the review was drafted against. */
		async post(pr, { event, body, comments }) {
			const payload = { commit_id: pr.headSha, event, body, comments };
			const r = await run(
				[
					'api',
					'-X',
					'POST',
					`repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
					'--input',
					'-'
				],
				{ input: JSON.stringify(payload) }
			);
			if (!r.ok) {
				const said = `${r.stdout}\n${r.stderr}`;
				if (/own pull request/i.test(said))
					throw new GitHubError(
						'GitHub doesn’t let you approve or request changes on your own pull request. Post it as a comment instead.'
					);
				throw fail('GitHub didn’t take the review', r);
			}
			let out = {};
			try {
				out = JSON.parse(r.stdout);
			} catch {
				// posted, but gh's answer was not JSON
			}
			return { url: out.html_url ?? pr.url, id: out.id ?? null };
		}
	};
}
