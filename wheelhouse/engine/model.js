/**
 * The local model, behind one small interface so the review never knows
 * which model answers and tests can hand it a fake:
 *
 *   model.generate({ messages, json, onToken, signal }) -> { text, promptTokens, outputTokens, ms }
 *   model.check() -> { ok: true } | { ok: false, reason }
 *
 * `createOllama` is the real one: Ollama's /api/chat on this computer,
 * streamed so the page can show progress, with a context window big enough
 * for one stage's diff (Ollama's default of 2048 tokens is not).
 *
 * @typedef {{ role: 'system' | 'user' | 'assistant'; content: string }} Message
 * @typedef {{ messages: Message[]; json?: boolean; onToken?: (text: string, count: number) => void; signal?: AbortSignal }} GenerateRequest
 * @typedef {{ text: string; promptTokens: number; outputTokens: number; ms: number }} Generated
 * @typedef {{ name: string; generate(r: GenerateRequest): Promise<Generated>; check(): Promise<{ ok: true } | { ok: false; reason: string }> }} Model
 */

export class ModelError extends Error {}

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
