import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import plugin, { ENGINE, readPrs, ROOT } from '../wheelhouse/server/index.js';

const provider = plugin.providers[0];
const service = plugin.services[0];
const project = { id: 'docket', name: 'docket' };
const prs = [
	{
		number: 47,
		title: 'Older',
		url: 'https://github.com/acme/docket/pull/47',
		author: { login: 'sam' },
		isDraft: false,
		updatedAt: '2026-10-01T00:00:00Z',
		additions: 5,
		deletions: 1,
		changedFiles: 2,
		headRefName: 'a'
	},
	{
		number: 48,
		title: 'Newer',
		url: 'https://github.com/acme/docket/pull/48',
		author: { login: 'ines' },
		isDraft: true,
		updatedAt: '2026-10-30T00:00:00Z',
		additions: 50,
		deletions: 9,
		changedFiles: 7,
		headRefName: 'b'
	},
	{ number: 'x', title: 'Broken' },
	{ number: 49, title: 'Not GitHub', url: 'javascript:alert(1)' }
];
const ctx = (exec, settings = {}) => ({ project, settings, exec });

describe('the open pull requests', () => {
	it('lists them newest first with gh in the project clone, and hands the tab the settings', async () => {
		const calls = [];
		const r = await provider.fetch(
			ctx(
				async (req) => {
					calls.push(req);
					return { ok: true, stdout: JSON.stringify(prs) };
				},
				{ backend: 'ollama' }
			)
		);
		assert.equal(calls[0].cwd, 'project');
		assert.deepEqual(calls[0].argv.slice(0, 4), ['gh', 'pr', 'list', '--state']);
		assert.ok(calls[0].timeoutMs < provider.timeoutMs);
		assert.equal(r.available, true);
		assert.deepEqual(
			r.value.prs.map((p) => [p.number, p.author, p.isDraft]),
			[
				[48, 'ines', true],
				[47, 'sam', false]
			]
		);
		assert.equal(r.value.reason, null);
		assert.equal(r.value.settings.backend, 'ollama');
		assert.equal(r.value.project, 'docket');
	});

	it('still shows the tab, with the reason, when gh cannot list them', async () => {
		for (const [said, reason] of [
			['spawn gh ENOENT', /isn’t installed/],
			['To get started with GitHub CLI, please run:  gh auth login', /isn’t signed in/],
			['no git remotes found', /no GitHub remote/],
			['something odd', /couldn’t be listed/]
		]) {
			const r = await provider.fetch(
				ctx(async () => ({ ok: false, reason: said, stderr: said, stdout: '' }))
			);
			assert.equal(r.available, true);
			assert.deepEqual(r.value.prs, []);
			assert.match(r.value.reason, reason);
		}
		assert.equal(readPrs('not json'), null);
	});

	it('is not available without a project', async () => {
		const r = await provider.fetch({
			project: null,
			settings: {},
			exec: async () => ({ ok: true, stdout: '[]' })
		});
		assert.equal(r.available, false);
	});
});

describe('the engine service', () => {
	it('runs this repository’s engine with node on loopback, on a port Wheelhouse keeps', async () => {
		const asked = [];
		const r = await service.resolve({
			settings: { claudeModel: 'opus', contextTokens: 8192 },
			servicePort: async (p) => (asked.push(p), 4799)
		});
		assert.equal(asked[0], 4791);
		assert.equal(r.available, true);
		assert.equal(r.spec.url, 'http://127.0.0.1:4799');
		assert.equal(r.spec.binds, 'loopback');
		assert.deepEqual(r.spec.identity, {
			url: 'http://127.0.0.1:4799/health',
			path: ['service'],
			value: 'pr-review-engine'
		});
		assert.equal(r.spec.argv[0], process.execPath);
		assert.equal(r.spec.argv[1], ENGINE);
		assert.deepEqual(r.spec.argv.slice(2), [
			'--port',
			'4799',
			'--backend',
			'claude',
			'--claude-model',
			'opus',
			'--ollama-model',
			'qwen2.5:7b',
			'--ollama',
			'http://127.0.0.1:11434',
			'--context',
			'8192'
		]);
		assert.equal(r.spec.cwd, ROOT);
		assert.match(r.hint, /main\.js --port 4799 --backend claude$/);
	});
});
