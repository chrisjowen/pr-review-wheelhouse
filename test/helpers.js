/**
 * Fixtures: a made-up pull request (its gh JSON and its diff), a fake `gh`
 * and a fake model that answers each stage from a script.
 */

/** A unified diff line block: `n` numbered lines starting at `from`, each `<prefix><word> n`. */
export const lines = (prefix, word, from, n) =>
	Array.from({ length: n }, (_, i) => `${prefix}${word} ${from + i}`);

/** One file's diff text. `hunks` is `[{ old, new, lines }]`. */
export function fileDiff(
	path,
	{ status = 'modified', from = path, hunks = [], binary = false } = {}
) {
	const out = [`diff --git a/${from} b/${path}`];
	if (status === 'added') out.push('new file mode 100644', 'index 0000000..1111111');
	else if (status === 'deleted') out.push('deleted file mode 100644', 'index 1111111..0000000');
	else if (status === 'renamed')
		out.push('similarity index 90%', `rename from ${from}`, `rename to ${path}`);
	else out.push('index 1111111..2222222 100644');
	if (binary) {
		out.push(`Binary files a/${from} and b/${path} differ`);
		return out.join('\n');
	}
	out.push(status === 'added' ? '--- /dev/null' : `--- a/${from}`);
	out.push(status === 'deleted' ? '+++ /dev/null' : `+++ b/${path}`);
	for (const h of hunks) {
		const oldN = h.lines.filter((l) => l[0] !== '+').length;
		const newN = h.lines.filter((l) => l[0] !== '-').length;
		out.push(`@@ -${h.old},${oldN} +${h.new},${newN} @@ ${h.ctx ?? ''}`.trimEnd());
		out.push(...h.lines);
	}
	return out.join('\n');
}

/** The made-up PR's diff: three source files, a test, docs, config, a bundle and a lockfile. */
export function sampleDiff() {
	return (
		[
			fileDiff('src/search.ts', {
				hunks: [
					{
						old: 10,
						new: 10,
						ctx: 'export function search()',
						lines: [
							' const a = 1',
							...lines('-', 'old', 11, 3),
							...lines('+', 'board', 11, 30),
							' return a'
						]
					},
					{ old: 80, new: 107, lines: [' keep', ...lines('+', 'paths', 108, 12), ' end'] }
				]
			}),
			fileDiff('src/legacy.ts', {
				hunks: [
					{
						old: 120,
						new: 120,
						lines: [
							' ctx',
							...lines('+', 'graphOf', 121, 25),
							...lines('-', 'gone', 121, 5),
							' ctx'
						]
					}
				]
			}),
			fileDiff('src/types.ts', {
				hunks: [{ old: 20, new: 20, lines: [' type A', ...lines('+', 'via', 21, 6), ' }'] }]
			}),
			fileDiff('src/util/helpers.ts', {
				status: 'added',
				hunks: [{ old: 0, new: 1, lines: lines('+', 'helper', 1, 4) }]
			}),
			fileDiff('test/search.test.ts', {
				status: 'added',
				hunks: [{ old: 0, new: 1, lines: lines('+', 'it', 1, 40) }]
			}),
			fileDiff('README.md', {
				hunks: [{ old: 3, new: 3, lines: [' # x', '-old line', '+new line', ' y'] }]
			}),
			fileDiff('package.json', {
				hunks: [{ old: 2, new: 2, lines: [' {', '-"version": "1"', '+"version": "2"', ' }'] }]
			}),
			fileDiff('dist/bundle.js', {
				hunks: [{ old: 1, new: 1, lines: lines('+', 'minified', 1, 300) }]
			}),
			fileDiff('package-lock.json', {
				hunks: [{ old: 1, new: 1, lines: lines('+', 'lock', 1, 50) }]
			}),
			fileDiff('docs/guide.md', {
				status: 'renamed',
				from: 'docs/old-guide.md',
				hunks: [{ old: 1, new: 1, lines: [' a', '+b'] }]
			}),
			fileDiff('assets/logo.png', { binary: true })
		].join('\n') + '\n'
	);
}

export const PR_URL = 'https://github.com/acme/lumen/pull/48';

/** `gh pr view --json` for the made-up PR. */
export function sampleView(over = {}) {
	return {
		number: 48,
		title: 'Draw returned subgraphs on the board',
		body:
			'## Intent\nKeep the subgraph each adapter returns.\n\n![Board after](https://github.com/user-attachments/assets/abc)\n' +
			'<img width="600" alt="Two adapters" src="https://github.com/user-attachments/assets/def" />\n' +
			'![local](http://example.com/no.png)',
		url: PR_URL,
		author: { login: 'samchen' },
		state: 'OPEN',
		isDraft: false,
		baseRefName: 'main',
		headRefName: 'feat/board',
		headRefOid: 'a'.repeat(40),
		additions: 480,
		deletions: 8,
		changedFiles: 11,
		createdAt: '2026-10-30T10:00:00Z',
		commits: [
			{ oid: 'c0ffee1234567', messageHeadline: 'feat: draw returned subgraphs' },
			{ oid: 'beef00123456', messageHeadline: 'fix: path why' }
		],
		statusCheckRollup: [
			{
				__typename: 'CheckRun',
				name: 'test',
				status: 'COMPLETED',
				conclusion: 'SUCCESS',
				detailsUrl: 'https://github.com/acme/lumen/actions/runs/1'
			},
			{
				__typename: 'StatusContext',
				context: 'lint',
				state: 'FAILURE',
				targetUrl: 'https://ci.example/2'
			},
			{ __typename: 'CheckRun', name: 'deploy', status: 'IN_PROGRESS', conclusion: '' }
		],
		...over
	};
}

/**
 * A fake `gh`: answers `pr view` and `pr diff` for the made-up PR, records
 * every call, and answers `api` (posting a review) with `onPost`.
 */
export function fakeGh({ view = sampleView(), diff = sampleDiff(), onPost } = {}) {
	const calls = [];
	const run = async (argv, o = {}) => {
		calls.push({ argv, input: o.input });
		if (argv[0] === 'pr' && argv[1] === 'view')
			return { ok: true, stdout: JSON.stringify(view), stderr: '' };
		if (argv[0] === 'pr' && argv[1] === 'diff') return { ok: true, stdout: diff, stderr: '' };
		if (argv[0] === 'api')
			return onPost
				? onPost(JSON.parse(o.input))
				: {
						ok: true,
						stdout: JSON.stringify({ id: 9, html_url: `${PR_URL}#pullrequestreview-9` }),
						stderr: ''
					};
		return { ok: false, stdout: '', stderr: 'unknown command' };
	};
	return { run, calls };
}

/** Which stage a set of messages is for, from the JSON shape it asks for. */
export function stageOfMessages(messages) {
	const last = messages.at(-1)?.content ?? '';
	if (!last.includes('Answer with this JSON shape')) return 'chat';
	if (last.includes('"headline"')) return 'walkthrough';
	if (last.includes('"findings"')) return 'quality';
	if (last.includes('"complexity"')) return 'change';
	return 'skim';
}

/**
 * A fake model. `answers[stage]` is a JSON value or a function of the
 * messages; chat answers come from `answers.chat`. Every call is recorded.
 */
export function fakeModel(answers = {}, { name = 'fake:7b', ok = true } = {}) {
	const calls = [];
	return {
		name,
		calls,
		async check() {
			return ok ? { ok: true } : { ok: false, reason: 'Ollama isn’t answering.' };
		},
		async generate({ messages, json, onToken }) {
			const stage = stageOfMessages(messages);
			calls.push({ stage, messages, json });
			let a = answers[stage];
			if (typeof a === 'function') a = a(messages);
			if (a instanceof Error) throw a;
			const text = typeof a === 'string' ? a : JSON.stringify(a ?? {});
			onToken?.(text, 1);
			return { text, promptTokens: 100, outputTokens: 10, ms: 5 };
		}
	};
}

/** Answers that read well for the made-up PR. */
export const ANSWERS = {
	walkthrough: {
		headline: 'The board now draws the subgraph adapters return.',
		what: 'Search keeps returned nodes and edges.',
		why: 'Guessed neighbours went against the spec.',
		evidence: [
			{ claim: 'Board draws it', status: 'pass', detail: 'live' },
			{ claim: 'Neo4j', status: 'weird' }
		],
		risks: ['Path why can quote another adapter'],
		stops: [
			{
				title: 'Keep the subgraph',
				files: ['src/legacy.ts', 'source src/types.ts'],
				why: 'Where it was dropped.'
			},
			{
				title: 'Build the board',
				files: ['b/src/search.ts', 'dist/bundle.js', 'nowhere.ts'],
				why: 'The heart.'
			}
		],
		take: ['This looks big but it is not.', 'Two stops.'],
		questions: ['Why not v2?', 'Riskiest part?']
	},
	quality: {
		take: ['Mostly tidy.'],
		findings: [
			{
				title: 'Long function',
				level: 'nit',
				file: 'src/search.ts',
				from: 12,
				to: 30,
				body: 'Four jobs.',
				suggestion: 'Split it.'
			},
			{
				title: 'Duplicated merge',
				level: 'worth',
				file: 'legacy.ts',
				from: 130,
				to: 125,
				body: 'Twice.',
				suggestion: 'One helper.'
			},
			{ title: 'Ghost file', level: 'worth', file: 'nope.ts', from: 1, to: 2 },
			{ title: 'Out of range', level: 'nit', file: 'src/search.ts', from: 900, to: 950 }
		],
		questions: ['Show me the duplicate']
	},
	change: (messages) => {
		const files = messages
			.at(-1)
			.content.match(/Its files: (.*)/)[1]
			.split(', ');
		return {
			take: [`About ${files.join(' and ')}.`],
			complexity: 'Complex!',
			rationale: 'Lots interacts.',
			notes: [
				{
					file: files[0],
					from: 12,
					to: 20,
					tag: 'moderate',
					title: 'The core',
					body: 'Does things.',
					concern: 'None'
				}
			],
			alternatives: [{ title: 'Do less', pros: 'Simple', cons: 'Weaker', verdict: 'recommend' }],
			pick: 'Keep it.',
			questions: ['What past 60 nodes?']
		};
	},
	skim: {
		take: ['Low risk.'],
		files: [
			{ file: 'README.md', risk: 'low', note: 'One line.' },
			{ file: 'src/util/helpers.ts', risk: 'medium', note: 'New helper.' }
		],
		questions: []
	},
	chat: 'Because every new field is optional.'
};
