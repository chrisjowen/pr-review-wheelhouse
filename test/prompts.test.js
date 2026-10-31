import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kindOf } from '../wheelhouse/engine/classify.js';
import { parseDiff } from '../wheelhouse/engine/diff.js';
import { imagesOf } from '../wheelhouse/engine/github.js';
import {
	anchor,
	changeMessages,
	chatMessages,
	DEFAULT_PROMPTS,
	parseJson,
	qualityMessages,
	readChange,
	readPrompts,
	readQuality,
	readSkim,
	readWalkthrough,
	skimMessages,
	walkthroughMessages
} from '../wheelhouse/engine/prompts.js';
import { resolvePath } from '../wheelhouse/engine/stages.js';
import { ANSWERS, PR_URL, sampleDiff, sampleView } from './helpers.js';

const files = parseDiff(sampleDiff()).map((f) => ({ ...f, kind: kindOf(f.path) }));
const pick = (...paths) => paths.map((p) => files.find((f) => f.path === p));
const view = sampleView();
const pr = {
	title: view.title,
	body: view.body,
	url: PR_URL,
	author: 'samchen',
	commits: view.commits.map((c) => ({ sha: c.oid, msg: c.messageHeadline })),
	checks: [
		{ name: 'test', state: 'pass' },
		{ name: 'lint', state: 'fail' }
	]
};
const custom = readPrompts({
	overall: 'OVERALL: be a pirate.',
	walkthrough: 'WALK: tell the story.',
	quality: 'QUALITY: hunt nesting.',
	change: 'CHANGE: annotate.',
	skim: 'SKIM: one line each.'
});

describe('the captain’s prompts', () => {
	it('fall back to the defaults when missing, empty or not text', () => {
		assert.deepEqual(readPrompts(null), DEFAULT_PROMPTS);
		const p = readPrompts({ overall: '  ', quality: 42, skim: 'Mine.' });
		assert.equal(p.overall, DEFAULT_PROMPTS.overall);
		assert.equal(p.quality, DEFAULT_PROMPTS.quality);
		assert.equal(p.skim, 'Mine.');
	});
});

describe('assembling a stage’s prompt', () => {
	it('puts the overall prompt first, then the stage’s own, then its context, then the JSON shape', () => {
		const [system, user] = walkthroughMessages({
			prompts: custom,
			pr,
			files,
			images: imagesOf(pr.body)
		});
		assert.equal(system.role, 'system');
		assert.match(system.content, /^OVERALL: be a pirate\./);
		assert.match(system.content, /Answer with one JSON object only/);
		assert.match(user.content, /^WALK: tell the story\./);
		const order = [
			'WALK:',
			'Pull request:',
			'Description:',
			'Commits:',
			'Checks:',
			'Changed files',
			'Answer with this JSON shape'
		];
		const at = order.map((s) => user.content.indexOf(s));
		assert.deepEqual(
			[...at].sort((a, b) => a - b),
			at,
			'in that order'
		);
		assert.ok(at.every((i) => i >= 0));
	});

	it('gives the walkthrough the manifest, the commits, checks and screenshots, not the diff', () => {
		const user = walkthroughMessages({ prompts: custom, pr, files, images: imagesOf(pr.body) })[1]
			.content;
		assert.match(user, /- src\/search\.ts \(source, \+42 -3\)/);
		assert.match(user, /- c0ffee1 feat: draw returned subgraphs/);
		assert.match(user, /- lint: fail/);
		assert.match(user, /links 2 screenshots .*Board after; Two adapters/);
		assert.doesNotMatch(user, /board 11/, 'no diff lines');
	});

	it('gives the quality pass only its files’ diff, numbered', () => {
		const user = qualityMessages({
			prompts: custom,
			pr,
			files: pick('src/search.ts', 'src/types.ts')
		})[1].content;
		assert.match(user, /^QUALITY: hunt nesting\./);
		assert.match(user, /### src\/search\.ts/);
		assert.match(user, /\n {3}11 \+ board 11\n/);
		assert.doesNotMatch(user, /legacy\.ts|bundle\.js|graphOf/);
		assert.match(user, /"findings"/);
	});

	it('gives a stop only its own files, with the walkthrough’s headline for context', () => {
		const stage = {
			id: 'stop-1',
			kind: 'change',
			title: 'Keep the subgraph',
			why: 'Where it was dropped.',
			files: ['src/legacy.ts']
		};
		const user = changeMessages({
			prompts: custom,
			pr,
			stage,
			files: pick('src/legacy.ts'),
			walkthrough: { headline: 'Boards draw subgraphs.' }
		})[1].content;
		assert.match(user, /^CHANGE: annotate\./);
		assert.match(user, /The PR, in one line: Boards draw subgraphs\./);
		assert.match(user, /This stop: Keep the subgraph \(Where it was dropped\.\)/);
		assert.match(user, /Its files: src\/legacy\.ts/);
		assert.match(user, /graphOf 121/);
		assert.doesNotMatch(user, /board 11/);
		assert.match(user, /"complexity"/);
	});

	it('gives the skim pass each file, and says which were read closely already', () => {
		const user = skimMessages({
			prompts: custom,
			pr,
			files: pick('README.md', 'package.json'),
			covered: ['src/search.ts']
		})[1].content;
		assert.match(user, /^SKIM: one line each\./);
		assert.match(user, /Already read closely in earlier stops: src\/search\.ts/);
		assert.match(user, /### README\.md/);
		assert.match(user, /### package\.json/);
	});

	it('keeps the JSON shape even when the captain rewrites every prompt', () => {
		const stage = { id: 'stop-1', kind: 'change', title: 'x', files: ['src/legacy.ts'] };
		for (const m of [
			walkthroughMessages({ prompts: custom, pr, files }),
			qualityMessages({ prompts: custom, pr, files: pick('src/search.ts') }),
			changeMessages({ prompts: custom, pr, stage, files: pick('src/legacy.ts') }),
			skimMessages({ prompts: custom, pr, files: pick('README.md') })
		])
			assert.match(m.at(-1).content, /Answer with this JSON shape:\n\{/);
	});

	it('gives a chat turn the stage’s brief, what was said, its diff, the history and the attached lines', () => {
		const stage = {
			id: 'stop-1',
			kind: 'change',
			title: 'Keep the subgraph',
			files: ['src/legacy.ts']
		};
		const msgs = chatMessages({
			prompts: custom,
			pr,
			stage,
			files: pick('src/legacy.ts'),
			result: {
				take: ['It keeps the graph.'],
				complexity: 'moderate',
				rationale: 'Ids.',
				notes: [],
				pick: 'Keep it.'
			},
			history: [
				{ role: 'user', text: 'First question?' },
				{ role: 'assistant', text: 'First answer.' }
			],
			message: 'Why prefix?',
			attach: { file: 'src/legacy.ts', from: 121, to: 122 },
			lines: '121 + graphOf 121\n122 + graphOf 122'
		});
		assert.match(
			msgs[0].content,
			/^OVERALL: be a pirate\.\n\nThis stage's brief: CHANGE: annotate\./
		);
		assert.match(msgs[1].content, /What you said about it:\nIt keeps the graph\./);
		assert.match(msgs[1].content, /graphOf 121/);
		assert.deepEqual(
			msgs.slice(3, 5).map((m) => [m.role, m.content]),
			[
				['user', 'First question?'],
				['assistant', 'First answer.']
			]
		);
		assert.equal(msgs.at(-1).role, 'user');
		assert.match(
			msgs.at(-1).content,
			/^About src\/legacy\.ts:121-122:\n121 \+ graphOf 121\n122 \+ graphOf 122\n\nWhy prefix\?$/
		);
	});
});

describe('reading the model’s answers', () => {
	it('finds the JSON object even with prose around it', () => {
		assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
		assert.deepEqual(parseJson('Sure! Here it is:\n```json\n{"a":2}\n```'), { a: 2 });
		assert.equal(parseJson('no json'), null);
		assert.equal(parseJson('[1,2]'), null);
	});

	it('reads the walkthrough, holding statuses to the known ones', () => {
		const w = readWalkthrough(ANSWERS.walkthrough);
		assert.equal(w.headline, 'The board now draws the subgraph adapters return.');
		assert.deepEqual(
			w.evidence.map((e) => e.status),
			['pass', 'untested']
		);
		assert.equal(w.questions.length, 2);
		assert.equal(readWalkthrough(null).headline, '');
		assert.deepEqual(readWalkthrough({ take: 'one paragraph', questions: 'q?' }).take, [
			'one paragraph'
		]);
	});

	it('holds quality findings to the stage’s files and the diff’s lines', () => {
		const q = readQuality(ANSWERS.quality, pick('src/search.ts', 'src/legacy.ts'), resolvePath);
		assert.deepEqual(
			q.findings.map((f) => [f.title, f.level, f.file, f.from, f.to]),
			[
				['Duplicated merge', 'worth', 'src/legacy.ts', 125, 130],
				['Long function', 'nit', 'src/search.ts', 12, 30],
				['Out of range', 'nit', 'src/search.ts', null, null]
			],
			'worth first; a reversed range turned round; an unknown file dropped; a range off the diff kept as the file'
		);
	});

	it('anchors a range inside what the diff shows, and caps a huge one', () => {
		const f = pick('src/search.ts');
		const r = (said) => resolvePath(said, ['src/search.ts']);
		assert.deepEqual(anchor({ file: 'src/search.ts', from: 1, to: 15 }, f, r), {
			file: 'src/search.ts',
			from: 10,
			to: 15
		});
		assert.deepEqual(anchor({ file: 'src/search.ts', line: '40' }, f, r), {
			file: 'src/search.ts',
			from: 40,
			to: 40
		});
		assert.deepEqual(anchor({ file: 'src/search.ts', from: 10, to: 500 }, f, r), {
			file: 'src/search.ts',
			from: 10,
			to: 90
		});
		assert.deepEqual(
			anchor({ file: 'src/search.ts', from: 1, to: 500 }, f, r),
			{ file: 'src/search.ts', from: 10, to: 90 },
			'capped from where the diff starts'
		);
		assert.deepEqual(anchor({ file: 'src/search.ts' }, f, r), {
			file: 'src/search.ts',
			from: null,
			to: null
		});
		assert.equal(anchor({ file: 'other.ts', from: 1 }, f, r), null);
	});

	it('reads a stop, treating "None" as no concern and odd ratings as the nearest one', () => {
		const stage = { title: 'x', files: ['src/legacy.ts'] };
		const raw = ANSWERS.change([{ content: `Its files: ${stage.files.join(', ')}` }]);
		const c = readChange(raw, pick('src/legacy.ts'), resolvePath);
		assert.equal(c.complexity, 'complex');
		assert.equal(c.notes[0].concern, '');
		assert.equal(c.notes[0].file, 'src/legacy.ts');
		assert.equal(c.alternatives[0].verdict, 'recommend');
		assert.equal(readChange({ complexity: 'huge' }, [], resolvePath).complexity, 'moderate');
	});

	it('gives every skim file a row, said or not', () => {
		const s = readSkim(
			ANSWERS.skim,
			pick('README.md', 'package.json', 'src/util/helpers.ts'),
			resolvePath
		);
		assert.deepEqual(
			s.files.map((f) => [f.file, f.risk, !!f.unsaid]),
			[
				['README.md', 'low', false],
				['package.json', 'low', true],
				['src/util/helpers.ts', 'medium', false]
			]
		);
	});
});
