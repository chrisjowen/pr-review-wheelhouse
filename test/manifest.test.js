import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { DEFAULTS, readSettings, reviewerLabel } from '../wheelhouse/engine/config.js';
import plugin from '../wheelhouse/server/index.js';

const manifest = JSON.parse(
	readFileSync(new URL('../.wheelhouse-plugin/plugin.json', import.meta.url), 'utf8')
);
// A copy of Wheelhouse's packages/plugin-sdk/plugin.schema.json.
const schema = JSON.parse(
	readFileSync(new URL('./fixtures/plugin.schema.json', import.meta.url), 'utf8')
);

describe('the manifest', () => {
	it('follows the Wheelhouse plugin schema', () => {
		const validate = new Ajv2020({ strict: false }).compile(schema);
		assert.ok(validate(manifest), JSON.stringify(validate.errors));
	});

	it('is off until turned on, and names entries that exist', () => {
		assert.equal(manifest.wheelhouse.enabledByDefault, false);
		assert.ok(existsSync(new URL(`../${manifest.wheelhouse.server}`, import.meta.url)));
		assert.ok(existsSync(new URL(`../${manifest.wheelhouse.ui}`, import.meta.url)));
	});

	it('lists exactly what the server entry contributes and runs', () => {
		assert.deepEqual(
			plugin.contributions.map((c) => ({ id: c.id, slot: c.slot })),
			manifest.wheelhouse.contributions
		);
		assert.deepEqual(
			plugin.services.map((s) => ({ id: s.id, scope: s.scope })),
			manifest.wheelhouse.services
		);
		for (const c of plugin.contributions) {
			assert.ok(plugin.providers.some((p) => p.id === c.provider));
			// An installed plugin's element tag starts with its id and a dash.
			assert.ok(c.render.element.startsWith(`${manifest.name}-`));
		}
	});

	it('stays within the provider limits Wheelhouse allows', () => {
		for (const p of plugin.providers) {
			assert.equal(p.scope, 'project');
			assert.ok(p.timeoutMs <= 10_000);
		}
	});

	it('offers the same defaults the code falls back to', () => {
		const s = manifest.wheelhouse.settings;
		assert.equal(s.backend.default, DEFAULTS.backend);
		assert.deepEqual(
			s.backend.options.map((o) => o.value),
			['claude', 'ollama']
		);
		assert.equal(s.claudeModel.default, DEFAULTS.claudeModel);
		assert.equal(s.ollamaModel.default, DEFAULTS.ollamaModel);
		assert.equal(s.ollamaUrl.default, DEFAULTS.ollamaUrl);
		assert.equal(s.contextTokens.default, DEFAULTS.contextTokens);
		assert.deepEqual(s.extraGenerated.default, DEFAULTS.extraGenerated);
		assert.deepEqual(readSettings({}), DEFAULTS);
	});

	it('agrees with package.json on the version', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		assert.equal(pkg.version, manifest.version);
	});
});

describe('the settings', () => {
	it('fall back one by one when missing or of the wrong kind', () => {
		assert.equal(DEFAULTS.backend, 'claude', 'Claude reviews unless told otherwise');
		assert.deepEqual(
			readSettings({
				backend: 'gpt',
				ollamaModel: 'llama3.1',
				ollamaUrl: 'ftp://x',
				contextTokens: 100,
				extraGenerated: [1]
			}),
			{ ...DEFAULTS, ollamaModel: 'llama3.1', contextTokens: 4096 }
		);
		assert.equal(readSettings({ backend: 'ollama' }).backend, 'ollama');
		assert.equal(
			readSettings({ claudeModel: 'bad model; rm -rf' }).claudeModel,
			DEFAULTS.claudeModel
		);
		assert.equal(
			readSettings({ ollamaUrl: 'http://127.0.0.1:11500/api' }).ollamaUrl,
			'http://127.0.0.1:11500'
		);
		assert.equal(reviewerLabel(DEFAULTS), 'Claude (sonnet)');
		assert.equal(reviewerLabel({ ...DEFAULTS, backend: 'ollama' }), 'qwen2.5:7b');
	});
});
