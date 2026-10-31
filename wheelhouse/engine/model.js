/**
 * The local model, behind one small interface so the review never knows
 * which model answers and tests can hand it a fake:
 *
 *   model.generate({ messages, json, onToken, signal }) -> { text, promptTokens, outputTokens, ms }
 *   model.check() -> { ok: true } | { ok: false, reason }
 *
 * Two real ones, picked by the plugin's `backend` setting:
 *
 * - `createClaude` (the default): Claude through Claude Code's own harness,
 *   `claude -p` headless and non-interactive, with nothing of the captain's
 *   setup loaded: no settings sources, the plugin's own settings file (every
 *   hook off), no tools, no MCP servers, no slash commands, no saved session,
 *   run from the engine's own empty directory and with `FM_NO_LOCK=1`, so it
 *   never picks up Firstmate's hooks or locks.
 * - `createOllama`: Ollama's /api/chat on this computer, streamed so the page
 *   can show progress, with a context window big enough for one stage's diff
 *   (Ollama's default of 2048 tokens is not).
 *
 * @typedef {{ role: 'system' | 'user' | 'assistant'; content: string }} Message
 * @typedef {{ messages: Message[]; json?: boolean; onToken?: (text: string, count: number) => void; signal?: AbortSignal }} GenerateRequest
 * @typedef {{ text: string; promptTokens: number; outputTokens: number; ms: number }} Generated
 * @typedef {{ name: string; generate(r: GenerateRequest): Promise<Generated>; check(): Promise<{ ok: true } | { ok: false; reason: string }> }} Model
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class ModelError extends Error {}

/** The plugin's own Claude Code settings: every hook off. */
export const CLAUDE_SETTINGS = fileURLToPath(new URL('./claude-settings.json', import.meta.url));

/**
 * A conversation as one prompt for `claude -p`: the system message goes in
 * as the system prompt; one user message is the prompt as it is, and a longer
 * conversation is written out turn by turn.
 *
 * @param {Message[]} messages
 */
export function flatten(messages) {
	const system = messages
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n\n');
	const turns = messages.filter((m) => m.role !== 'system');
	if (turns.length === 1) return { system, prompt: turns[0].content };
	const last = turns.at(-1);
	const before = turns
		.slice(0, -1)
		.map((m) => `${m.role === 'user' ? 'Reviewer' : 'You'}: ${m.content}`)
		.join('\n\n');
	return {
		system,
		prompt: `The conversation so far:\n\n${before}\n\nThe reviewer now says:\n\n${last.content}\n\nAnswer them.`
	};
}

/**
 * Claude through Claude Code's headless mode.
 *
 * @param {{ model?: string; bin?: string; cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number; spawn?: typeof nodeSpawn }} o
 * @returns {Model}
 */
export function createClaude({
	model = 'sonnet',
	bin = 'claude',
	cwd,
	env = process.env,
	timeoutMs = 10 * 60_000,
	spawn = nodeSpawn
}) {
	const childEnv = () => {
		const e = { ...env, FM_NO_LOCK: '1' };
		// Not a nested session of whatever started the engine.
		for (const k of Object.keys(e))
			if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_ENTRYPOINT')) delete e[k];
		return e;
	};
	/** Runs claude once; resolves with its stdout lines as they come, and its exit. */
	const run = (args, input, onLine, signal) =>
		new Promise((resolve, reject) => {
			try {
				mkdirSync(cwd, { recursive: true });
			} catch {
				// the spawn below says why
			}
			let child;
			try {
				child = spawn(bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
			} catch (e) {
				return reject(new ModelError(`Claude Code couldn’t start: ${e.message}`));
			}
			let rest = '';
			let err = '';
			const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
			const stop = () => child.kill('SIGTERM');
			signal?.addEventListener('abort', stop, { once: true });
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				rest += chunk;
				const lines = rest.split('\n');
				rest = lines.pop() ?? '';
				for (const l of lines) onLine?.(l);
			});
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (c) => (err = (err + c).slice(-4000)));
			child.on('error', (e) => {
				clearTimeout(timer);
				reject(
					new ModelError(
						e.code === 'ENOENT'
							? 'Claude Code (`claude`) isn’t installed or isn’t on the PATH.'
							: `Claude Code couldn’t start: ${e.message}`
					)
				);
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', stop);
				if (rest) onLine?.(rest);
				resolve({ code, err });
			});
			child.stdin.on('error', () => {});
			child.stdin.end(input ?? '');
		});

	return {
		name: `claude ${model}`,
		async check() {
			try {
				const { code, err } = await run(['--version'], '', null, AbortSignal.timeout(15_000));
				return code === 0
					? { ok: true }
					: {
							ok: false,
							reason: `Claude Code didn’t answer: ${err.trim().slice(0, 200) || `exit ${code}`}`
						};
			} catch (e) {
				return { ok: false, reason: e.message };
			}
		},
		async generate({ messages, onToken, signal }) {
			const started = Date.now();
			const { system, prompt } = flatten(messages);
			const args = [
				'-p',
				'--output-format',
				'stream-json',
				'--verbose',
				'--include-partial-messages',
				'--setting-sources',
				'',
				'--settings',
				CLAUDE_SETTINGS,
				'--strict-mcp-config',
				'--tools',
				'',
				'--disable-slash-commands',
				'--no-session-persistence',
				'--model',
				model,
				'--system-prompt',
				system || 'You are a careful code reviewer.'
			];
			let text = '';
			let count = 0;
			let result = null;
			const { code, err } = await run(
				args,
				prompt,
				(line) => {
					if (!line.trim()) return;
					let m;
					try {
						m = JSON.parse(line);
					} catch {
						return;
					}
					const d = m.type === 'stream_event' ? m.event : null;
					if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
						text += d.delta.text;
						count++;
						onToken?.(text, count);
					} else if (m.type === 'result') result = m;
				},
				signal
			);
			if (signal?.aborted) throw new ModelError('Stopped.');
			if (!result || result.is_error || code !== 0) {
				const said =
					(typeof result?.result === 'string' && result.result) ||
					err.trim().split('\n').slice(-2).join(' ');
				throw new ModelError(
					`Claude Code didn’t answer${said ? `: ${said.slice(0, 300)}` : ` (exit ${code})`}`
				);
			}
			return {
				text: typeof result.result === 'string' ? result.result : text,
				promptTokens: result.usage?.input_tokens ?? 0,
				outputTokens: result.usage?.output_tokens ?? count,
				ms: Date.now() - started
			};
		}
	};
}

/**
 * @param {{ url?: string; model?: string; contextTokens?: number; temperature?: number; fetch?: typeof fetch }} o
 * @returns {Model}
 */
export function createOllama({
	url = 'http://127.0.0.1:11434',
	model = 'qwen2.5:7b',
	contextTokens = 16384,
	temperature = 0.2,
	fetch: get = fetch
} = {}) {
	const base = url.replace(/\/+$/, '');
	return {
		name: model,
		async check() {
			let res;
			try {
				res = await get(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
			} catch {
				return {
					ok: false,
					reason: `Ollama isn’t answering at ${base}. Start it with \`ollama serve\`.`
				};
			}
			if (!res.ok) return { ok: false, reason: `Ollama answered ${res.status} at ${base}.` };
			const tags = await res.json().catch(() => ({}));
			const names = (tags.models ?? []).map((m) => m.name);
			const want = model.includes(':') ? model : `${model}:latest`;
			if (!names.includes(model) && !names.includes(want))
				return {
					ok: false,
					reason: `Ollama doesn’t have ${model}. Pull it with \`ollama pull ${model}\`.`
				};
			return { ok: true };
		},
		async generate({ messages, json = false, onToken, signal }) {
			const started = Date.now();
			let res;
			try {
				res = await get(`${base}/api/chat`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						model,
						messages,
						stream: true,
						...(json ? { format: 'json' } : {}),
						options: { num_ctx: contextTokens, temperature }
					}),
					signal
				});
			} catch (e) {
				if (signal?.aborted) throw new ModelError('Stopped.');
				throw new ModelError(`Ollama isn’t answering at ${base}: ${e.message}`);
			}
			if (!res.ok || !res.body) {
				const said = await res.text().catch(() => '');
				throw new ModelError(
					`Ollama answered ${res.status}${said ? `: ${said.slice(0, 200)}` : ''}`
				);
			}
			let text = '';
			let count = 0;
			let promptTokens = 0;
			let outputTokens = 0;
			let rest = '';
			const decoder = new TextDecoder();
			const take = (line) => {
				if (!line.trim()) return;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					return;
				}
				if (msg.error) throw new ModelError(`Ollama: ${msg.error}`);
				const piece = msg.message?.content ?? '';
				if (piece) {
					text += piece;
					count++;
					onToken?.(text, count);
				}
				if (msg.done) {
					promptTokens = msg.prompt_eval_count ?? 0;
					outputTokens = msg.eval_count ?? count;
				}
			};
			try {
				for await (const chunk of res.body) {
					rest += decoder.decode(chunk, { stream: true });
					const lines = rest.split('\n');
					rest = lines.pop() ?? '';
					for (const line of lines) take(line);
				}
				take(rest);
			} catch (e) {
				if (e instanceof ModelError) throw e;
				if (signal?.aborted) throw new ModelError('Stopped.');
				throw new ModelError(`Ollama stopped answering: ${e.message}`);
			}
			return { text, promptTokens, outputTokens, ms: Date.now() - started };
		}
	};
}
