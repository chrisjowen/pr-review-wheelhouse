/**
 * The plugin's settings, read the same way by the Wheelhouse side (from
 * `plugins.json`) and by the engine (from its command line, and from the
 * review tab, which hands the engine the current settings as it connects so a
 * change applies without restarting the engine).
 *
 * `backend` picks who reviews: `claude` (the default; Claude through Claude
 * Code's headless mode, `claudeModel`) or `ollama` (a local model,
 * `ollamaModel` at `ollamaUrl`, reading `contextTokens` at once).
 */

export const BACKENDS = /** @type {const} */ (['claude', 'ollama']);

export const DEFAULTS = {
	backend: /** @type {'claude' | 'ollama'} */ ('claude'),
	claudeModel: 'sonnet',
	ollamaModel: 'qwen2.5:7b',
	ollamaUrl: 'http://127.0.0.1:11434',
	contextTokens: 16384,
	extraGenerated: /** @type {string[]} */ ([])
};

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const MODEL = /^[\w.:/-]{1,100}$/;
const name = (v, fallback) => {
	const s = typeof v === 'string' ? v.trim() : '';
	return MODEL.test(s) ? s : fallback;
};

/** Each setting, falling back to its default when missing or of the wrong kind. */
export function readSettings(settings) {
	const s = isRecord(settings) ? settings : {};
	let url = DEFAULTS.ollamaUrl;
	if (typeof s.ollamaUrl === 'string') {
		try {
			const u = new URL(s.ollamaUrl.trim());
			if (u.protocol === 'http:' || u.protocol === 'https:') url = u.origin;
		} catch {
			// not a URL: keep the default
		}
	}
	const ctx = Number(s.contextTokens);
	return {
		backend: BACKENDS.includes(s.backend) ? s.backend : DEFAULTS.backend,
		claudeModel: name(s.claudeModel, DEFAULTS.claudeModel),
		ollamaModel: name(s.ollamaModel, DEFAULTS.ollamaModel),
		ollamaUrl: url,
		contextTokens:
			Number.isFinite(ctx) && ctx > 0
				? Math.min(131072, Math.max(4096, Math.round(ctx)))
				: DEFAULTS.contextTokens,
		extraGenerated:
			Array.isArray(s.extraGenerated) && s.extraGenerated.every((p) => typeof p === 'string')
				? s.extraGenerated.slice(0, 50)
				: DEFAULTS.extraGenerated
	};
}

/** The reviewer in plain words, for pages: "Claude (sonnet)" or the Ollama model's name. */
export function reviewerLabel(s) {
	return s.backend === 'claude' ? `Claude (${s.claudeModel})` : s.ollamaModel;
}
