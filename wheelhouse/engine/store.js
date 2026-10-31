/**
 * The engine's own records, as JSON files in its state directory: the
 * captain's prompts (`prompts.json`) and one file per reviewed pull request
 * (`reviews/<owner>__<repo>__<number>.json`). Each write goes through a
 * temporary file and a rename, so a crash never leaves half a file.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** `$PR_REVIEW_STATE_DIR`, else `$XDG_STATE_HOME/pr-review-wheelhouse`, else `~/.local/state/pr-review-wheelhouse`. */
export function defaultStateDir(env = process.env) {
	if (env.PR_REVIEW_STATE_DIR) return env.PR_REVIEW_STATE_DIR;
	const base = env.XDG_STATE_HOME || path.join(env.HOME || homedir(), '.local', 'state');
	return path.join(base, 'pr-review-wheelhouse');
}

const safe = (name) => name.replace(/[^\w.-]+/g, '_');

/** @param {string} dir */
export function createStore(dir) {
	mkdirSync(path.join(dir, 'reviews'), { recursive: true });
	const file = (name) => path.join(dir, name);
	const read = (name) => {
		try {
			return JSON.parse(readFileSync(file(name), 'utf8'));
		} catch {
			return null;
		}
	};
	const write = (name, value) => {
		const to = file(name);
		const tmp = `${to}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(value));
		renameSync(tmp, to);
	};
	const reviewName = (id) => path.join('reviews', `${safe(id)}.json`);
	return {
		dir,
		prompts: () => read('prompts.json'),
		savePrompts: (p) => write('prompts.json', p),
		review: (id) => read(reviewName(id)),
		saveReview: (r) => write(reviewName(r.id), r),
		removeReview: (id) => rmSync(file(reviewName(id)), { force: true }),
		reviewIds: () => {
			try {
				return readdirSync(path.join(dir, 'reviews'))
					.filter((f) => f.endsWith('.json'))
					.map((f) => f.slice(0, -5));
			} catch {
				return [];
			}
		}
	};
}

/** The same interface, in memory, for tests. */
export function memoryStore() {
	let prompts = null;
	const reviews = new Map();
	const copy = (v) => (v === null || v === undefined ? null : structuredClone(v));
	return {
		dir: null,
		prompts: () => copy(prompts),
		savePrompts: (p) => (prompts = copy(p)),
		review: (id) => copy(reviews.get(id)),
		saveReview: (r) => reviews.set(r.id, copy(r)),
		removeReview: (id) => reviews.delete(id),
		reviewIds: () => [...reviews.keys()]
	};
}
