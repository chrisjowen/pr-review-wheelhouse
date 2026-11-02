import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
	CLAUDE_SETTINGS,
	createClaude,
	createOpenAI,
	flatten,
	ModelError
} from '../wheelhouse/engine/model.js';

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

/** A fake fetch that answers with a server-sent event stream, cut into the given chunks. */
function fakeFetch(chunks, { status = 200, said = '' } = {}) {
	const calls = [];
	const get = async (url, init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		if (status !== 200) return new Response(said, { status });
		const enc = new TextEncoder();
		return new Response(
			new ReadableStream({
				start(c) {
					for (const x of chunks) c.enqueue(enc.encode(x));
					c.close();
				}
			})
		);
	};
	return { get, calls };
}
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const piece = (content) => sse({ choices: [{ delta: { content } }] });

describe('an OpenAI-compatible provider', () => {
	const messages = [
		{ role: 'system', content: 'Be brief.' },
		{ role: 'user', content: 'Review this.' }
	];

	it('posts a streamed chat completion with the key, the cap and asks for usage', async () => {
		const f = fakeFetch([piece('ok')]);
		const model = createOpenAI({
			baseUrl: 'https://openrouter.ai/api/v1/',
			apiKey: 'sk-test',
			model: 'some/model',
			maxTokens: 4000,
			headers: { 'x-title': 'PR review' },
			fetch: f.get
		});
		assert.equal(model.name, 'some/model');
		await model.generate({ messages });
		const [call] = f.calls;
		assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
		assert.equal(call.init.method, 'POST');
		assert.deepEqual(call.init.headers, {
			'content-type': 'application/json',
			authorization: 'Bearer sk-test',
			'x-title': 'PR review'
		});
		assert.deepEqual(call.body, {
			model: 'some/model',
			messages,
			temperature: 0.2,
			max_tokens: 4000,
			stream: true,
			stream_options: { include_usage: true }
		});
	});

	it('sends no key and no cap when it has none', async () => {
		const f = fakeFetch([piece('ok')]);
		await createOpenAI({
			baseUrl: 'http://127.0.0.1:8080/v1',
			model: 'local',
			fetch: f.get
		}).generate({ messages });
		assert.equal('authorization' in f.calls[0].init.headers, false);
		assert.equal('max_tokens' in f.calls[0].body, false);
	});

	it('streams the answer, even split mid-line, and reports usage and cost', async () => {
		const stream =
			': OPENROUTER PROCESSING\n\n' +
			piece('The board ') +
			piece('draws ') +
			piece('subgraphs.') +
			sse({
				choices: [],
				usage: { prompt_tokens: 1200, completion_tokens: 30, cost: 0.0042 }
			}) +
			'data: [DONE]\n\n';
		const f = fakeFetch([stream.slice(0, 50), stream.slice(50, 51), stream.slice(51)]);
		const seen = [];
		const out = await createOpenAI({ baseUrl: 'x', model: 'm', fetch: f.get }).generate({
			messages,
			onToken: (text, count) => seen.push([text, count])
		});
		assert.equal(out.text, 'The board draws subgraphs.');
		assert.deepEqual(seen, [
			['The board ', 1],
			['The board draws ', 2],
			['The board draws subgraphs.', 3]
		]);
		assert.equal(out.promptTokens, 1200);
		assert.equal(out.outputTokens, 30);
		assert.equal(out.costUsd, 0.0042);
		assert.equal(typeof out.ms, 'number');
	});

	it('counts the pieces and reports no cost when the provider sends no usage', async () => {
		const f = fakeFetch([piece('a') + piece('b') + 'data: [DONE]']);
		const out = await createOpenAI({ baseUrl: 'x', model: 'm', fetch: f.get }).generate({
			messages
		});
		assert.equal(out.text, 'ab');
		assert.equal(out.promptTokens, 0);
		assert.equal(out.outputTokens, 2);
		assert.equal(out.costUsd, null);
	});

	it('says why when the provider refuses, errors mid-stream or isn’t there', async () => {
		const refused = fakeFetch([], { status: 402, said: 'Insufficient credits' });
		await assert.rejects(
			createOpenAI({ baseUrl: 'x', model: 'm', fetch: refused.get }).generate({ messages }),
			/The AI provider answered 402: Insufficient credits/
		);
		const broken = fakeFetch([piece('half') + sse({ error: { message: 'Rate limited' } })]);
		await assert.rejects(
			createOpenAI({ baseUrl: 'x', model: 'm', fetch: broken.get }).generate({ messages }),
			/The AI provider: Rate limited/
		);
		const gone = async () => {
			throw new Error('ECONNREFUSED');
		};
		await assert.rejects(
			createOpenAI({ baseUrl: 'x', model: 'm', fetch: gone }).generate({ messages }),
			/The AI provider isn’t answering: ECONNREFUSED/
		);
	});

	it('stops when the caller stops it', async () => {
		const stop = new AbortController();
		const get = (url, init) =>
			new Promise((_, reject) =>
				init.signal.addEventListener('abort', () => reject(init.signal.reason))
			);
		const pending = createOpenAI({ baseUrl: 'x', model: 'm', fetch: get }).generate({
			messages,
			signal: stop.signal
		});
		stop.abort();
		await assert.rejects(pending, (e) => e instanceof ModelError && e.message === 'Stopped.');
	});

	it('is ready when it has a model, without calling the provider', async () => {
		const f = fakeFetch([]);
		assert.deepEqual(await createOpenAI({ baseUrl: 'x', model: 'm', fetch: f.get }).check(), {
			ok: true
		});
		const none = await createOpenAI({ baseUrl: 'x', model: '', fetch: f.get }).check();
		assert.equal(none.ok, false);
		assert.match(none.reason, /No model is set/);
		assert.equal(f.calls.length, 0);
	});
});
