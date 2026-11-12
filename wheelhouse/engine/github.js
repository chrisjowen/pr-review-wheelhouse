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

/** The branch a review's diagrams are committed to, apart from every PR's own. */
export const DIAGRAM_BRANCH = 'pr-review-diagrams';

const OWN_PR_NOTE =
	'GitHub doesn’t let you approve or request changes on your own pull request, so this was posted as a comment.';
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

		/**
		 * Posts a review on the head the review was drafted against. GitHub takes
		 * no verdict on the captain's own pull request, so there it goes up as a
		 * comment, and the answer says so.
		 */
		async post(pr, { event, body, comments }) {
			const send = (ev) =>
				run(
					[
						'api',
						'-X',
						'POST',
						`repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
						'--input',
						'-'
					],
					{ input: JSON.stringify({ commit_id: pr.headSha, event: ev, body, comments }) }
				);
			let ev = event;
			let note = null;
			let r = await send(ev);
			if (!r.ok && ev !== 'COMMENT' && /own pull request/i.test(`${r.stdout}\n${r.stderr}`)) {
				ev = 'COMMENT';
				note = OWN_PR_NOTE;
				r = await send(ev);
			}
			if (!r.ok) throw fail('GitHub didn’t take the review', r);
			let out = {};
			try {
				out = JSON.parse(r.stdout);
			} catch {
				// posted, but gh's answer was not JSON
			}
			return { url: out.html_url ?? pr.url, id: out.id ?? null, event: ev, note };
		},

		/**
		 * Files for a review to show, such as its diagrams, committed with the
		 * Git data API to the repository's own `pr-review-diagrams` branch, a
		 * branch of their own that nothing merges, so the PR's branch is never
		 * touched and GitHub shows them to whoever can see the repository.
		 * Answers each file's address at that commit. Only posting a review,
		 * on the captain's click, reaches this.
		 *
		 * @param {{ owner: string; repo: string; number: number; headSha?: string }} pr
		 * @param {{ path: string; content: string }[]} files
		 */
		async attach(pr, files) {
			const repo = `repos/${pr.owner}/${pr.repo}`;
			const send = async (method, path, body, what) => {
				const r = await run(['api', '-X', method, `${repo}/${path}`, '--input', '-'], {
					input: JSON.stringify(body)
				});
				if (!r.ok) throw fail(what, r);
				try {
					return JSON.parse(r.stdout);
				} catch {
					throw new GitHubError('gh answered with something that isn’t JSON.');
				}
			};
			const ref = await run(['api', `${repo}/git/ref/heads/${DIAGRAM_BRANCH}`]);
			if (!ref.ok && !/not found|404/i.test(ref.stderr))
				throw fail('The diagram branch couldn’t be read', ref);
			let tip = null;
			let tree = null;
			if (ref.ok) {
				tip = JSON.parse(ref.stdout).object?.sha ?? null;
				const commit = await run(['api', `${repo}/git/commits/${tip}`]);
				if (!commit.ok) throw fail('The diagram branch couldn’t be read', commit);
				tree = JSON.parse(commit.stdout).tree?.sha ?? null;
			}
			const made = await send(
				'POST',
				'git/trees',
				{
					...(tree ? { base_tree: tree } : {}),
					tree: files.map((f) => ({
						path: f.path,
						mode: '100644',
						type: 'blob',
						content: f.content
					}))
				},
				'The diagram couldn’t be stored'
			);
			const sha = String(pr.headSha ?? '').slice(0, 7);
			const commit = await send(
				'POST',
				'git/commits',
				{
					message: `Diagrams for #${pr.number}${sha ? ` at ${sha}` : ''}, from the PR review`,
					tree: made.sha,
					parents: tip ? [tip] : []
				},
				'The diagram couldn’t be committed'
			);
			if (tip)
				await send(
					'PATCH',
					`git/refs/heads/${DIAGRAM_BRANCH}`,
					{ sha: commit.sha, force: false },
					'The diagram branch couldn’t be moved'
				);
			else
				await send(
					'POST',
					'git/refs',
					{ ref: `refs/heads/${DIAGRAM_BRANCH}`, sha: commit.sha },
					'The diagram branch couldn’t be made'
				);
			return files.map(
				(f) =>
					`https://github.com/${pr.owner}/${pr.repo}/raw/${commit.sha}/${f.path.split('/').map(encodeURIComponent).join('/')}`
			);
		},

		/** Who gh is signed in as, or null when it can't say. */
		async login() {
			const r = await run(['api', 'user', '--jq', '.login'], { timeoutMs: 15_000 });
			return r.ok ? r.stdout.trim() || null : null;
		},

		/**
		 * One file as it is at a commit, for the chat's file drawer: its text, or
		 * null when the file isn't there (deleted at that commit).
		 */
		async file(pr, path) {
			const clean = String(path ?? '');
			if (
				!clean ||
				clean.length > 1000 ||
				clean.split('/').some((x) => !x || x === '.' || x === '..')
			)
				throw new GitHubError('That isn’t a file in this pull request.', 400);
			if (!/^[0-9a-f]{7,64}$/i.test(pr.headSha ?? ''))
				throw new GitHubError('This review doesn’t know the commit it was made at.', 400);
			const enc = clean.split('/').map(encodeURIComponent).join('/');
			const r = await run(
				[
					'api',
					'-H',
					'Accept: application/vnd.github.raw',
					`repos/${pr.owner}/${pr.repo}/contents/${enc}?ref=${pr.headSha}`
				],
				{ timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 }
			);
			if (r.ok) return r.stdout;
			if (/not found|404/i.test(r.stderr)) return null;
			throw fail('The file couldn’t be read', r);
		},

		/**
		 * The project as a whole, for the chat's context: the repository's
		 * description, language and topics, and the start of its README.
		 */
		async project(owner, repo) {
			const [meta, readme] = await Promise.all([
				run(['api', `repos/${owner}/${repo}`], { timeoutMs: 20_000 }),
				run(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${owner}/${repo}/readme`], {
					timeoutMs: 20_000,
					maxBytes: 2 * 1024 * 1024
				})
			]);
			if (!meta.ok) throw fail('The project couldn’t be read', meta);
			let r;
			try {
				r = JSON.parse(meta.stdout);
			} catch {
				throw new GitHubError('gh answered with something that isn’t JSON.');
			}
			return {
				repo: `${owner}/${repo}`,
				url: String(r.html_url ?? `https://github.com/${owner}/${repo}`),
				description: String(r.description ?? ''),
				language: r.language ? String(r.language) : null,
				topics: Array.isArray(r.topics) ? r.topics.map(String).slice(0, 12) : [],
				stars: Number(r.stargazers_count ?? 0),
				branch: String(r.default_branch ?? 'main'),
				readme: readme.ok ? readme.stdout.slice(0, 6000) : null
			};
		}
	};
}
