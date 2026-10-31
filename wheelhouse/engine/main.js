#!/usr/bin/env node
/**
 * The review engine: a small HTTP server on loopback that Wheelhouse starts as
 * the plugin's companion service when the captain clicks Start. It reads pull
 * requests with `gh`, runs each review stage through the reviewer (Claude
 * through Claude Code by default, or a local Ollama model), keeps reviews and
 * prompts in its state directory, and posts a review to GitHub only when the
 * captain clicks Post.
 *
 *   node wheelhouse/engine/main.js --port 4791 [--backend claude|ollama] [--claude-model sonnet]
 *     [--ollama-model qwen2.5:7b] [--ollama http://127.0.0.1:11434] [--context 16384]
 *
 * `PR_REVIEW_CLAUDE_CONFIG_DIR` sets the Claude Code config directory the
 * reviewer runs with (`default` for Claude Code's own default), for a
 * Wheelhouse whose own `CLAUDE_CONFIG_DIR` points elsewhere.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { readSettings } from './config.js';
import { createGitHub, ghRunner } from './github.js';
import { createHandler } from './http.js';
import { createClaude, createOllama } from './model.js';
import { createReviews } from './review.js';
import { createStore, defaultStateDir } from './store.js';

const { values } = parseArgs({
	options: {
		port: { type: 'string', default: '4791' },
		host: { type: 'string', default: '127.0.0.1' },
		backend: { type: 'string' },
		'claude-model': { type: 'string' },
		'ollama-model': { type: 'string' },
		ollama: { type: 'string' },
		context: { type: 'string' },
		'state-dir': { type: 'string' }
	}
});

const version = JSON.parse(
	readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
).version;
const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

const store = createStore(values['state-dir'] || defaultStateDir());

/** The reviewer the settings name. */
function reviewer(s) {
	if (s.backend === 'ollama')
		return createOllama({ url: s.ollamaUrl, model: s.ollamaModel, contextTokens: s.contextTokens });
	const env = { ...process.env };
	const dir = process.env.PR_REVIEW_CLAUDE_CONFIG_DIR;
	if (dir === 'default') delete env.CLAUDE_CONFIG_DIR;
	else if (dir) env.CLAUDE_CONFIG_DIR = dir;
	return createClaude({ model: s.claudeModel, cwd: path.join(store.dir, 'claude'), env });
}

let settings = readSettings({
	backend: values.backend,
	claudeModel: values['claude-model'],
	ollamaModel: values['ollama-model'],
	ollamaUrl: values.ollama,
	contextTokens: values.context
});
let model = reviewer(settings);
const config = {
	get: () => settings,
	set(next) {
		const merged = readSettings({ ...settings, ...(next && typeof next === 'object' ? next : {}) });
		if (JSON.stringify(merged) !== JSON.stringify(settings)) {
			settings = merged;
			model = reviewer(settings);
			log(`settings: ${JSON.stringify(settings)}`);
		}
		return settings;
	}
};

const reviews = createReviews({
	github: createGitHub(ghRunner()),
	store,
	model: () => model,
	log
});
const handle = createHandler({ reviews, store, config, version, model: () => model });
const server = createServer((req, res) => {
	handle(req, res).catch((e) => {
		log(`request failed: ${e?.stack || e}`);
		if (!res.headersSent) res.statusCode = 500;
		res.end();
	});
});
if (values.host !== '127.0.0.1' && values.host !== 'localhost' && values.host !== '::1') {
	log('The engine listens on loopback only.');
	process.exit(2);
}
server.listen(Number(values.port), values.host, () => {
	log(
		`pr-review engine ${version} on http://${values.host}:${values.port}/ (reviewer ${model.name}, state ${store.dir})`
	);
});
const quit = () => {
	reviews.stop();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
