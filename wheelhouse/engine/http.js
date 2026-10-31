/**
 * The engine's HTTP API, answered on loopback only, for the review tab in
 * Wheelhouse's page (another origin on the same computer, hence CORS).
 *
 * Every request must name this computer as its Host (no DNS rebinding); a
 * request carrying an Origin must come from a loopback page; and anything
 * that changes something must carry the `x-pr-review` header, which a plain
 * form or image request from some other site cannot send without a CORS
 * preflight this engine refuses.
 */

import { DEFAULT_PROMPTS, PROMPT_KEYS, readPrompts } from './prompts.js';
import { GitHubError } from './github.js';
import { ReviewError } from './review.js';

export const SERVICE = 'pr-review-engine';
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost)(:\d+)?$/i;
const MAX_BODY = 1024 * 1024;

/** Whether an Origin is a page on this computer. */
export function loopbackOrigin(origin) {
	try {
		const u = new URL(origin);
		return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.test(u.host);
	} catch {
		return false;
	}
}

const STARTED = `<!doctype html><meta charset="utf-8"><title>PR review engine</title>
<body style="font:15px system-ui;margin:3rem;color:#14213d;background:#f6f2e9">
<p>The PR review engine is running. You can close this tab and go back to the review in Wheelhouse.</p>
<script>setTimeout(() => window.close(), 600)</script>`;

/**
 * @param {{
 *   reviews: ReturnType<typeof import('./review.js').createReviews>;
 *   store: { prompts(): any; savePrompts(p: any): void };
 *   config: { get(): any; set(c: any): any };
 *   version: string;
 *   model: () => { name: string; check(): Promise<{ ok: boolean; reason?: string }> };
 * }} deps
 */
export function createHandler({ reviews, store, config, version, model }) {
	const routes = [
		['GET', /^\/health$/, async () => ({ service: SERVICE, version, model: model().name })],
		[
			'GET',
			/^\/api\/status$/,
			async () => ({
				service: SERVICE,
				version,
				config: config.get(),
				model: await model().check()
			})
		],
		['PUT', /^\/api\/config$/, async (_m, body) => config.set(body)],
		[
			'GET',
			/^\/api\/prompts$/,
			async () => ({ prompts: readPrompts(store.prompts()), defaults: DEFAULT_PROMPTS })
		],
		[
			'PUT',
			/^\/api\/prompts$/,
			async (_m, body) => {
				const next = readPrompts({ ...readPrompts(store.prompts()), ...(body?.prompts ?? {}) });
				// Keep only what differs from the defaults, so a later default improvement still reaches the rest.
				store.savePrompts(
					Object.fromEntries(
						PROMPT_KEYS.filter((k) => next[k] !== DEFAULT_PROMPTS[k]).map((k) => [k, next[k]])
					)
				);
				return { prompts: next, defaults: DEFAULT_PROMPTS };
			}
		],
		['GET', /^\/api\/reviews$/, async () => ({ reviews: reviews.list() })],
		['POST', /^\/api\/reviews$/, async (_m, body) => reviews.open(String(body?.url ?? ''))],
		['GET', /^\/api\/reviews\/([\w.-]+)$/, async (m) => reviews.view(m[1])],
		['DELETE', /^\/api\/reviews\/([\w.-]+)$/, async (m) => reviews.restart(m[1])],
		[
			'POST',
			/^\/api\/reviews\/([\w.-]+)\/focus$/,
			async (m, b) => reviews.focus(m[1], String(b?.stage ?? ''))
		],
		[
			'POST',
			/^\/api\/reviews\/([\w.-]+)\/run$/,
			async (m, b) => reviews.run(m[1], String(b?.stage ?? ''))
		],
		[
			'POST',
			/^\/api\/reviews\/([\w.-]+)\/ask$/,
			async (m, b) => reviews.ask(m[1], String(b?.stage ?? ''), b ?? {})
		],
		[
			'POST',
			/^\/api\/reviews\/([\w.-]+)\/request$/,
			async (m, b) => reviews.request(m[1], String(b?.stage ?? ''), b ?? {})
		],
		[
			'POST',
			/^\/api\/reviews\/([\w.-]+)\/unrequest$/,
			async (m, b) => reviews.unrequest(m[1], String(b?.request ?? ''))
		],
		[
			'POST',
			/^\/api\/reviews\/([\w.-]+)\/decide$/,
			async (m, b) => reviews.decide(m[1], String(b?.finding ?? ''), b?.decision ?? null)
		],
		[
			'POST',
			/^\/api\/reviews\/([\w.-]+)\/mark$/,
			async (m, b) => reviews.mark(m[1], String(b?.stage ?? ''), !!b?.reviewed)
		],
		['POST', /^\/api\/reviews\/([\w.-]+)\/post$/, async (m, b) => reviews.post(m[1], b ?? {})]
	];

	/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
	return async function handle(req, res) {
		const send = (status, value, type = 'application/json') => {
			res.statusCode = status;
			res.setHeader(
				'content-type',
				type === 'application/json' ? 'application/json; charset=utf-8' : type
			);
			res.setHeader('cache-control', 'no-store');
			res.end(type === 'application/json' ? JSON.stringify(value) : value);
		};
		if (!LOOPBACK.test(req.headers.host ?? ''))
			return send(421, { error: 'This engine answers on this computer only.' });
		const origin = req.headers.origin;
		if (origin !== undefined && !loopbackOrigin(origin))
			return send(403, { error: 'Only pages on this computer may use the engine.' });
		if (origin) {
			res.setHeader('access-control-allow-origin', origin);
			res.setHeader('vary', 'Origin');
		}
		const url = new URL(req.url ?? '/', 'http://engine');
		const method = req.method ?? 'GET';
		if (method === 'OPTIONS') {
			res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE');
			res.setHeader('access-control-allow-headers', 'content-type, x-pr-review');
			res.setHeader('access-control-max-age', '600');
			if (req.headers['access-control-request-private-network'])
				res.setHeader('access-control-allow-private-network', 'true');
			res.statusCode = 204;
			return res.end();
		}
		if (method === 'GET' && (url.pathname === '/' || url.pathname === '/started'))
			return send(200, STARTED, 'text/html; charset=utf-8');
		if (method !== 'GET' && method !== 'HEAD' && !req.headers['x-pr-review'])
			return send(403, { error: 'Missing the x-pr-review header.' });
		for (const [m, re, fn] of routes) {
			if (m !== method) continue;
			const match = url.pathname.match(re);
			if (!match) continue;
			let body = null;
			if (method !== 'GET') {
				try {
					body = await readBody(req);
				} catch (e) {
					return send(400, { error: e.message });
				}
			}
			try {
				return send(200, await fn(match, body));
			} catch (e) {
				const status = e instanceof ReviewError || e instanceof GitHubError ? e.status : 500;
				return send(status, { error: e?.message || 'Something went wrong.' });
			}
		}
		return send(404, { error: 'Not found.' });
	};
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new Error('That request is too large.'));
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			if (!text) return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new Error('That request isn’t JSON.'));
			}
		});
		req.on('error', reject);
	});
}
