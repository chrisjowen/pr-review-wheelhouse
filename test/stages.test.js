import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kindOf, patternMatcher } from '../wheelhouse/engine/classify.js';
import { parseDiff } from '../wheelhouse/engine/diff.js';
import {
	heuristicPlan,
	manifestText,
	MAX_STOPS,
	reconcilePlan,
	resolvePath,
	stagesOf
} from '../wheelhouse/engine/stages.js';
import { sampleDiff } from './helpers.js';

const files = parseDiff(sampleDiff()).map((f) => ({ ...f, kind: kindOf(f.path) }));
const kinds = new Map(files.map((f) => [f.path, f.kind]));
const all = (plan) =>
	[...plan.stops.flatMap((s) => s.files), ...plan.skim, ...plan.generated].sort();

describe('what kind of file a path is', () => {
	for (const [path, kind] of [
		['wheelhouse/docket/dist/bundled/adapter-neo4j/dist/index.js', 'generated'],
		['package-lock.json', 'generated'],
		['web/app.min.js', 'generated'],
		['src/__snapshots__/board.test.ts.snap', 'generated'],
		['api/service_pb2.py', 'generated'],
		['packages/a/src/search.test.ts', 'test'],
		['packages/a/src/neo4j-projection.integration.test.ts', 'test'],
		['test/fixtures/adapters/fake.mjs', 'test'],
		['pkg/search_test.go', 'test'],
		['README.md', 'docs'],
		['.docket/decisions/board.md', 'docs'],
		['docs/adapter-spec.md', 'docs'],
		['package.json', 'config'],
		['.github/workflows/ci.yml', 'config'],
		['Dockerfile', 'config'],
		['packages/a/src/search.ts', 'source'],
		['assets/logo.png', 'asset'],
		['packages/docket-ui/src/mcp-app/app.svelte', 'source']
	]) {
		it(`${path} is ${kind}`, () => assert.equal(kindOf(path), kind));
	}

	it('takes the captain’s own generated patterns', () => {
		const extra = patternMatcher(['*.gen.ts', 'schema/', 'api/openapi.yaml']);
		assert.equal(kindOf('src/client.gen.ts', { extraGenerated: extra }), 'generated');
		assert.equal(kindOf('schema/a.ts', { extraGenerated: extra }), 'generated');
		assert.equal(kindOf('api/openapi.yaml', { extraGenerated: extra }), 'generated');
		assert.equal(kindOf('src/client.ts', { extraGenerated: extra }), 'source');
	});
});

describe('the manifest the walkthrough reads', () => {
	it('lists each file with its kind and size, and folds generated files by folder', () => {
		const text = manifestText(files);
		assert.match(text, /- src\/search\.ts \(source, \+42 -3\)/);
		assert.match(text, /- src\/util\/helpers\.ts \(source, added, \+4 -0\)/);
		assert.match(text, /- dist\/ \(generated, 1 file; hidden from review\)/);
		assert.match(text, /- \.\/ \(generated, 1 file; hidden from review\)/);
		assert.doesNotMatch(text, /bundle\.js|package-lock/);
	});
});

describe('grouping without the model', () => {
	it('makes stops of the biggest source changes, with folder-mates', () => {
		const plan = heuristicPlan(files);
		assert.equal(plan.source, 'heuristic');
		assert.deepEqual(plan.stops[0].files, ['src/search.ts', 'src/legacy.ts']);
		assert.deepEqual(plan.generated.sort(), ['dist/bundle.js', 'package-lock.json']);
		assert.ok(plan.skim.includes('test/search.test.ts'));
		assert.ok(plan.skim.includes('src/util/helpers.ts'), 'too small for a stop');
		assert.deepEqual(all(plan), files.map((f) => f.path).sort(), 'every file somewhere, once');
	});
});

describe('finding the path a model meant', () => {
	const paths = files.map((f) => f.path);
	it('takes exact paths, and strips stray prefixes, quotes and notes', () => {
		assert.equal(resolvePath('src/search.ts', paths), 'src/search.ts');
		assert.equal(resolvePath('b/src/search.ts', paths), 'src/search.ts');
		assert.equal(resolvePath('test/src/search.ts', paths), 'src/search.ts');
		assert.equal(resolvePath('source src/types.ts', paths), 'src/types.ts');
		assert.equal(resolvePath('`src/legacy.ts` (+25 -5)', paths), 'src/legacy.ts');
	});
	it('matches a unique ending, and nothing when it is ambiguous or unknown', () => {
		assert.equal(resolvePath('legacy.ts', paths), 'src/legacy.ts');
		assert.equal(resolvePath('guide.md', paths), 'docs/guide.md');
		assert.equal(resolvePath('nowhere.ts', paths), null);
		assert.equal(resolvePath(42, paths), null);
	});
});

describe('holding the model’s grouping to the real files', () => {
	it('keeps the model’s stops, titles and order', () => {
		const plan = reconcilePlan(files, [
			{
				title: 'Keep the subgraph',
				files: ['src/legacy.ts', 'src/types.ts'],
				why: 'Where it was dropped.'
			},
			{ title: 'Build the board', files: ['src/search.ts'], why: 'The heart.' }
		]);
		assert.equal(plan.source, 'model');
		assert.deepEqual(
			plan.stops.map((s) => [s.title, s.files]),
			[
				['Keep the subgraph', ['src/legacy.ts', 'src/types.ts']],
				['Build the board', ['src/search.ts']]
			]
		);
		assert.deepEqual(all(plan), files.map((f) => f.path).sort());
	});

	it('never puts generated, test, docs, binary or unknown files in a stop', () => {
		const plan = reconcilePlan(files, [
			{ title: 'Bundle', files: ['dist/bundle.js', 'package-lock.json'] },
			{ title: 'Tests', files: ['test/search.test.ts', 'README.md', 'assets/logo.png'] },
			{ title: 'Real', files: ['src/search.ts', 'made/up.ts'] }
		]);
		assert.deepEqual(
			plan.stops.map((s) => s.files),
			[['src/search.ts']]
		);
		assert.ok(plan.generated.includes('dist/bundle.js'));
		assert.ok(plan.skim.includes('test/search.test.ts'));
	});

	it('gives each file one stop, at most three files a stop and at most four stops', () => {
		const plan = reconcilePlan(files, [
			{
				title: 'A',
				files: ['src/search.ts', 'src/legacy.ts', 'src/types.ts', 'src/util/helpers.ts']
			},
			{ title: 'B', files: ['src/search.ts'] },
			{ title: 'C', files: ['src/util/helpers.ts'] },
			{ title: 'D', files: ['src/util/helpers.ts'] },
			...Array.from({ length: 6 }, (_, i) => ({ title: `E${i}`, files: ['src/types.ts'] }))
		]);
		assert.deepEqual(
			plan.stops.map((s) => s.files),
			[['src/search.ts', 'src/legacy.ts', 'src/types.ts'], ['src/util/helpers.ts']]
		);
		assert.ok(plan.stops.length <= MAX_STOPS);
		assert.deepEqual(all(plan), files.map((f) => f.path).sort());
	});

	it('adds the biggest source change when the model left it out', () => {
		const plan = reconcilePlan(files, [{ title: 'Types', files: ['src/types.ts'] }]);
		assert.equal(plan.source, 'mixed');
		assert.deepEqual(
			plan.stops.map((s) => s.files[0]),
			['src/types.ts', 'src/search.ts']
		);
		assert.match(plan.stops[1].why, /did not group/);
	});

	it('falls back to its own grouping when the model proposes nothing usable', () => {
		for (const said of [
			undefined,
			'stops',
			[],
			[{ title: 'x', files: ['dist/bundle.js'] }],
			[null, 3]
		]) {
			const plan = reconcilePlan(files, said);
			assert.equal(plan.source, 'heuristic');
			assert.deepEqual(plan, heuristicPlan(files));
		}
	});

	it('names a stop after its first file when the model gives no title', () => {
		const plan = reconcilePlan(files, [{ files: ['src/search.ts'] }]);
		assert.equal(plan.stops[0].title, 'Changes in search.ts');
	});
});

describe('the stages a plan reads as', () => {
	it('is the walkthrough, the quality pass over source, each stop, then the skim pile', () => {
		const plan = reconcilePlan(files, [
			{ title: 'Keep', files: ['src/legacy.ts'] },
			{ title: 'Build', files: ['src/search.ts', 'src/types.ts'] }
		]);
		const stages = stagesOf(plan, kinds);
		assert.deepEqual(
			stages.map((s) => [s.id, s.kind]),
			[
				['walkthrough', 'walkthrough'],
				['quality', 'quality'],
				['stop-1', 'change'],
				['stop-2', 'change'],
				['skim', 'skim']
			]
		);
		assert.deepEqual(stages[1].files.sort(), [
			'src/legacy.ts',
			'src/search.ts',
			'src/types.ts',
			'src/util/helpers.ts'
		]);
		assert.deepEqual(stages[4].files, plan.skim);
		assert.ok(
			!stages.some((s) => s.files.includes('dist/bundle.js')),
			'generated files are never shown'
		);
	});
});
