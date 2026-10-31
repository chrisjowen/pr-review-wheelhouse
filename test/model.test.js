import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { CLAUDE_SETTINGS, createClaude, flatten } from '../wheelhouse/engine/model.js';

/** A fake `claude`: records how it was started and answers with `lines` (stream-json). */
function fakeSpawn({ lines = [], code = 0, stderr = '', fail = null } = {}) {
	const calls = [];
	const spawn = (bin, args, opts) => {
		if (fail) throw fail;
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = new PassThrough();
		let input = '';
		child.stdin.on('data', (c) => (input += c));
		child.kill = () => {};
		calls.push({ bin, args, opts, input: () => input });
		setImmediate(() => {
			for (const l of lines) child.stdout.write(`${JSON.stringify(l)}\n`);
			child.stderr.write(stderr);
			child.stdout.end();
			child.stderr.end();
			setImmediate(() => child.emit('close', code));
		});
		return child;
	};
	return { spawn, calls };
}

const delta = (text) => ({
	type: 'stream_event',
	event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
});
const result = (text, over = {}) => ({
	type: 'result',
	is_error: false,
	result: text,
	usage: { input_tokens: 900, output_tokens: 42 },
	...over
});

describe('a conversation as one claude -p prompt', () => {
	it('sends the system message as the system prompt and one question as it is', () => {
		assert.deepEqual(
			flatten([
				{ role: 'system', content: 'Be brief.' },
				{ role: 'user', content: 'Review this.' }
			]),
			{
				system: 'Be brief.',
				prompt: 'Review this.'
			}
		);
	});

	it('writes a longer chat out turn by turn, ending on the reviewer’s question', () => {
		const { prompt } = flatten([
			{ role: 'system', content: 'S' },
			{ role: 'user', content: 'The diff.' },
			{ role: 'assistant', content: 'Understood.' },
			{ role: 'user', content: 'Why prefix?' }
		]);
		assert.equal(
			prompt,
			'The conversation so far:\n\nReviewer: The diff.\n\nYou: Understood.\n\nThe reviewer now says:\n\nWhy prefix?\n\nAnswer them.'
		);
	});
});

describe('Claude through Claude Code', () => {
	it('runs claude -p headless with nothing of the captain’s setup, and streams its answer', async () => {
		const { spawn, calls } = fakeSpawn({
			lines: [{ type: 'system', subtype: 'init' }, delta('{"a"'), delta(':1}'), result('{"a":1}')]
		});
		const model = createClaude({
			model: 'opus',
			cwd: '/tmp/pr-review-claude-test',
			env: { PATH: '/bin', HOME: '/h', CLAUDECODE: '1' },
			spawn
		});
		const seen = [];
		const out = await model.generate({
			messages: [
				{ role: 'system', content: 'Be brief.' },
				{ role: 'user', content: 'Review.' }
			],
			json: true,
			onToken: (t, n) => seen.push([t, n])
		});
		assert.equal(model.name, 'claude opus');
		assert.deepEqual(out.text, '{"a":1}');
		assert.equal(out.promptTokens, 900);
		assert.equal(out.outputTokens, 42);
		assert.deepEqual(seen, [
			['{"a"', 1],
			['{"a":1}', 2]
		]);
		const [c] = calls;
		assert.equal(c.bin, 'claude');
		assert.equal(c.input(), 'Review.');
		const flag = (f) => c.args[c.args.indexOf(f) + 1];
		assert.equal(c.args[0], '-p');
		assert.equal(flag('--output-format'), 'stream-json');
		assert.equal(flag('--setting-sources'), '', 'no user, project or local settings');
		assert.equal(flag('--settings'), CLAUDE_SETTINGS);
		assert.equal(flag('--tools'), '', 'no tools');
		assert.equal(flag('--model'), 'opus');
		assert.equal(flag('--system-prompt'), 'Be brief.');
		for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence'])
			assert.ok(c.args.includes(f), f);
		assert.ok(!c.args.includes('--bare'), 'bare would skip the captain’s sign-in');
		assert.equal(c.opts.cwd, '/tmp/pr-review-claude-test');
		assert.equal(c.opts.env.FM_NO_LOCK, '1');
		assert.equal(c.opts.env.CLAUDECODE, undefined, 'not a nested session');
	});

	it('has every hook off in its own settings', async () => {
		const { readFileSync } = await import('node:fs');
		assert.deepEqual(JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8')), { disableAllHooks: true });
	});

	it('says why when Claude Code fails or is missing', async () => {
		const failing = createClaude({
			cwd: '/tmp/pr-review-claude-test',
			spawn: fakeSpawn({
				lines: [result('Not logged in · Please run /login', { is_error: true })],
				code: 1
			}).spawn
		});
		await assert.rejects(
			failing.generate({ messages: [{ role: 'user', content: 'x' }] }),
			/Claude Code didn’t answer: Not logged in/
		);
		const missing = createClaude({
			cwd: '/tmp/pr-review-claude-test',
			spawn: () => {
				const child = new EventEmitter();
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				child.stdin = new PassThrough();
				setImmediate(() =>
					child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
				);
				return child;
			}
		});
		const check = await missing.check();
		assert.equal(check.ok, false);
		assert.match(check.reason, /isn’t installed or isn’t on the PATH/);
	});
});
