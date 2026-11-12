/**
 * The PR's structure diagram (wheelhouse/engine/diagram.js): worked out from
 * the diff alone, so the same diff always draws the same picture.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kindOf } from '../wheelhouse/engine/classify.js';
import {
	declOf,
	diagramsOf,
	importsOf,
	MAX_FILES,
	resolveImport,
	structureOf,
	structureSvg
} from '../wheelhouse/engine/diagram.js';
import { parseDiff } from '../wheelhouse/engine/diff.js';
import { fileDiff } from './helpers.js';

const filesOf = (text) => parseDiff(text).map((f) => ({ ...f, kind: kindOf(f.path) }));

/** A PR that adds a module, moves an import from a package to it, and drops an old file. */
const DIFF = [
	fileDiff('src/board/render.ts', {
		hunks: [
			{
				old: 1,
				new: 1,
				lines: [
					" import { h } from '../dom.js';",
					"-import { layout } from 'old-layout';",
					"+import { layout } from './layout.js';",
					"+import type { Graph } from '@acme/graph/types';",
					' ',
					'-export function drawAll(g) {',
					'+export function draw(g) {',
					'   return h(layout(g));'
				]
			},
			{
				old: 40,
				new: 40,
				ctx: 'export class Board {',
				lines: ['   size() {', '-    return 1;', '+    return 2;', '   }']
			}
		]
	}),
	fileDiff('src/board/layout.ts', {
		status: 'added',
		hunks: [
			{
				old: 0,
				new: 1,
				lines: [
					"+import { legacy } from '../legacy';",
					'+export const GAP = 8;',
					'+export const layout = (g) => g;',
					'+export interface Box { x: number }'
				]
			}
		]
	}),
	fileDiff('src/legacy/index.ts', {
		status: 'deleted',
		hunks: [{ old: 1, new: 0, lines: ['-export function legacy() {}'] }]
	}),
	fileDiff('test/render.test.ts', {
		status: 'added',
		hunks: [{ old: 0, new: 1, lines: ["+import { draw } from '../src/board/render';"] }]
	}),
	fileDiff('README.md', { hunks: [{ old: 1, new: 1, lines: ['-a', '+b'] }] })
].join('\n');

describe('reading the structure from a diff', () => {
	it('finds what a line imports, in each language it reads', () => {
		assert.deepEqual(importsOf('a.ts', "import { x } from './x.js';"), ['./x.js']);
		assert.deepEqual(importsOf('a.ts', "} from '../y';"), ['../y']);
		assert.deepEqual(importsOf('a.js', "const z = require('zlib');"), ['zlib']);
		assert.deepEqual(importsOf('a.ts', "const m = await import('./lazy.js');"), ['./lazy.js']);
		assert.deepEqual(importsOf('a.py', 'from .models import User'), ['.models']);
		assert.deepEqual(importsOf('a.py', 'import os, json'), ['os', 'json']);
		assert.deepEqual(importsOf('a.rs', 'mod parser;'), ['mod:parser']);
		assert.deepEqual(importsOf('a.ts', 'const s = "from here";'), []);
		assert.deepEqual(importsOf('README.md', "import x from './x'"), []);
	});

	it('resolves an import to a changed file, an unchanged one or a package', () => {
		const known = new Set(['src/x.ts', 'src/lib/index.ts', 'app/models.py']);
		assert.deepEqual(resolveImport('src/a.ts', './x.js', known), { kind: 'file', id: 'src/x.ts' });
		assert.deepEqual(resolveImport('src/a.ts', './lib', known), {
			kind: 'file',
			id: 'src/lib/index.ts'
		});
		assert.deepEqual(resolveImport('src/a.ts', '../other.js', known), {
			kind: 'context',
			id: 'other.js'
		});
		assert.deepEqual(resolveImport('src/a.ts', '@scope/pkg/deep', known), {
			kind: 'package',
			id: '@scope/pkg'
		});
		assert.deepEqual(resolveImport('app/views.py', '.models', known), {
			kind: 'file',
			id: 'app/models.py'
		});
		assert.equal(resolveImport('a.ts', '../../out', known), null, 'nothing outside the repository');
	});

	it('names declarations as functions, classes and types', () => {
		assert.equal(declOf('a.ts', 'export async function load(x) {'), 'load()');
		assert.equal(declOf('a.ts', 'export const go = async () => {'), 'go()');
		assert.equal(declOf('a.ts', 'export const N = 3;'), 'N');
		assert.equal(declOf('a.ts', 'export default class Tab extends X {'), 'class Tab');
		assert.equal(declOf('a.ts', 'export type Id = string;'), 'type Id');
		assert.equal(declOf('a.ts', '\tif (x) {'), null);
		assert.equal(declOf('a.py', 'def handler(event):'), 'handler()');
		assert.equal(declOf('a.go', 'func (s *Server) Serve() error {'), 'Serve()');
	});

	it('draws the changed source and tests with what each declares, and the imports the PR adds or removes', () => {
		const s = structureOf(filesOf(DIFF));
		const node = (id) => s.nodes.find((n) => n.id === id);
		assert.deepEqual(
			s.nodes.map((n) => `${n.kind}:${n.id}`),
			[
				'file:src/board/render.ts',
				'file:src/board/layout.ts',
				'file:src/legacy/index.ts',
				'file:test/render.test.ts',
				'package:@acme/graph',
				'package:old-layout'
			],
			'source before tests; README isn’t drawn; a package only for an import added or removed'
		);
		assert.deepEqual(node('src/board/render.ts').decls, [
			{ name: 'draw()', change: 'added' },
			{ name: 'drawAll()', change: 'removed' },
			{ name: 'class Board', change: 'changed' }
		]);
		assert.deepEqual(
			node('src/board/layout.ts').decls.map((d) => d.name),
			['GAP', 'layout()', 'type Box']
		);
		assert.deepEqual(
			s.edges.map((e) => `${e.from} -> ${e.to} ${e.state}`),
			[
				'src/board/layout.ts -> src/legacy/index.ts added',
				'src/board/render.ts -> @acme/graph added',
				'src/board/render.ts -> old-layout removed',
				'src/board/render.ts -> src/board/layout.ts added',
				'test/render.test.ts -> src/board/render.ts added'
			],
			'an unchanged import of an unchanged file (../dom.js) draws nothing'
		);
		assert.deepEqual(structureOf(filesOf(DIFF)), s, 'the same diff, the same structure');
	});

	it('draws at most so many files, and counts the rest', () => {
		const many = Array.from({ length: MAX_FILES + 3 }, (_, i) =>
			fileDiff(`src/f${i}.ts`, { hunks: [{ old: 1, new: 1, lines: ['-a', '+b'] }] })
		).join('\n');
		const s = structureOf(filesOf(many));
		assert.equal(s.nodes.length, MAX_FILES);
		assert.equal(s.omitted, 3);
		assert.match(structureSvg(s), /3 more changed files not drawn/);
	});
});

describe('the diagram', () => {
	const r = { pr: { owner: 'acme', repo: 'lumen', number: 48, headSha: 'abcdef0123' } };

	it('is an SVG with its own light and dark colours, its text escaped', () => {
		const [d] = diagramsOf({ ...r, files: filesOf(DIFF) });
		assert.equal(d.id, 'structure');
		assert.equal(d.file, 'pr-48/abcdef0-structure.svg');
		assert.match(d.alt, /4 changed files in 3 folders; 4 imports added, 1 removed/);
		assert.match(d.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
		assert.match(d.svg, /@media \(prefers-color-scheme: dark\)/);
		assert.match(d.svg, /acme\/lumen#48 at abcdef0/);
		assert.match(d.svg, /class="edge removed"/);
		assert.doesNotMatch(d.svg, /<script|on\w+=/i);
		const evil = filesOf(
			fileDiff('src/<b>&.ts', {
				status: 'added',
				hunks: [{ old: 0, new: 1, lines: ['+export function x<T>() {}'] }]
			})
		);
		const svg = diagramsOf({ ...r, files: evil })[0].svg;
		assert.match(svg, /&lt;b&gt;&amp;\.ts/);
		assert.doesNotMatch(svg, /<b>/);
		assert.equal(
			diagramsOf({ ...r, files: filesOf(DIFF) })[0].svg,
			d.svg,
			'drawn the same every time'
		);
	});

	it('is left out when the PR changes no source it can read', () => {
		const docs = filesOf(fileDiff('docs/a.md', { hunks: [{ old: 1, new: 1, lines: ['+x'] }] }));
		assert.deepEqual(diagramsOf({ ...r, files: docs }), []);
	});
});
