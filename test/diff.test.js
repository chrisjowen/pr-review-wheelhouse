import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	commentableLines,
	diffText,
	excerpt,
	fileDiffText,
	lineSpan,
	parseDiff
} from '../wheelhouse/engine/diff.js';
import { sampleDiff } from './helpers.js';

const files = parseDiff(sampleDiff());
const byPath = (p) => files.find((f) => f.path === p);

describe('reading a diff', () => {
	it('reads every file, with what happened to it', () => {
		assert.equal(files.length, 11);
		assert.equal(byPath('src/search.ts').status, 'modified');
		assert.equal(byPath('src/util/helpers.ts').status, 'added');
		const renamed = byPath('docs/guide.md');
		assert.equal(renamed.status, 'renamed');
		assert.equal(renamed.oldPath, 'docs/old-guide.md');
		assert.equal(byPath('assets/logo.png').binary, true);
	});

	it('counts lines and numbers them on both sides', () => {
		const f = byPath('src/legacy.ts');
		assert.equal(f.add, 25);
		assert.equal(f.del, 5);
		const [h] = f.hunks;
		assert.equal(h.newStart, 120);
		assert.deepEqual(h.lines[0], { t: ' ', o: 120, n: 120, text: 'ctx' });
		assert.deepEqual(h.lines[1], { t: '+', n: 121, text: 'graphOf 121' });
		const removed = h.lines.find((l) => l.t === '-');
		assert.equal(removed.o, 121);
		assert.equal(removed.n, undefined);
		assert.equal(h.lines.at(-1).n, 146);
	});

	it('keeps the hunk header context', () => {
		assert.equal(byPath('src/search.ts').hunks[0].ctx, 'export function search()');
	});

	it('knows which lines a review comment can sit on', () => {
		const f = byPath('src/search.ts');
		const ok = commentableLines(f);
		assert.ok(ok.has(10) && ok.has(40) && ok.has(41) && ok.has(108));
		assert.ok(!ok.has(60), 'between hunks');
		assert.deepEqual(lineSpan(f), { from: 10, to: 120 });
		assert.equal(lineSpan(byPath('assets/logo.png')), null);
	});
});

describe('the diff as the model reads it', () => {
	it('numbers each line by its new-side line and marks removed ones', () => {
		const text = fileDiffText(byPath('src/legacy.ts'));
		assert.match(text, /^### src\/legacy\.ts \(modified, \+25 -5\)/);
		assert.match(text, /\n {2}121 \+ graphOf 121\n/);
		assert.match(text, /\n {4}- - gone 121\n/);
	});

	it('cuts a long file at its budget and says how much is left out', () => {
		const text = fileDiffText(byPath('src/search.ts'), 300);
		assert.ok(text.length < 400);
		assert.match(text, /more diff lines not shown/);
	});

	it('shares one budget across files, giving short files all they need', () => {
		const small = byPath('src/types.ts');
		const big = byPath('test/search.test.ts');
		const text = diffText([small, big], 1500);
		assert.ok(text.includes(fileDiffText(small)), 'the short file is whole');
		assert.ok(text.length <= 1700);
		assert.match(text, /### test\/search\.test\.ts/);
	});
});

describe('an excerpt of a diff', () => {
	it('takes the new-side range and the lines removed just before it', () => {
		const got = excerpt(byPath('src/search.ts'), 11, 12);
		assert.deepEqual(
			got.map((l) => l.t + (l.n ?? l.o)),
			['-11', '-12', '-13', '+11', '+12']
		);
	});
});
