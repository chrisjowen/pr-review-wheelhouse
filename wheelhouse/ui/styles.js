/**
 * The review's styles, drawn with the host page's CSS variables (Wheelhouse's,
 * or the web app's, which use the same names) so they follow its light and
 * dark themes. `TOKENS` maps those variables onto the review's own, with
 * fallbacks for a page that sets none; the chat (`chat-styles.js`) and the
 * tab (`STYLE`, its pull request picker and prompts) both start from it.
 */

export const TOKENS = `
:host {
	--rv-ink: var(--foreground, #1d2733);
	--rv-ink-2: color-mix(in srgb, var(--foreground, #1d2733) 82%, transparent);
	--rv-muted: var(--muted-foreground, #6b7480);
	--rv-paper: var(--background, #f6f2e9);
	--rv-card: var(--card, #fffdf8);
	--rv-panel: var(--panel, var(--card, #fbf8f1));
	--rv-rule: var(--border, #e6dfd0);
	--rv-hair: var(--hair, var(--border, #e6dfd0));
	--rv-navy: var(--primary, #1e3a4f);
	--rv-on-navy: var(--primary-foreground, #fff);
	--rv-brass: var(--brass, #9a6b1f);
	--rv-sea: var(--sea, #2f6f8f);
	--rv-ok: var(--success, #2d6a3e);
	--rv-warn: var(--warning, var(--amber, #a2541b));
	--rv-bad: var(--danger, #9a3b2c);
	--rv-brass-soft: color-mix(in srgb, var(--rv-brass) 14%, transparent);
	--rv-sea-soft: color-mix(in srgb, var(--rv-sea) 12%, transparent);
	--rv-ok-soft: color-mix(in srgb, var(--rv-ok) 13%, transparent);
	--rv-warn-soft: color-mix(in srgb, var(--rv-warn) 13%, transparent);
	--rv-add: var(--add-bg, color-mix(in srgb, var(--rv-ok) 11%, transparent));
	--rv-del: var(--del-bg, color-mix(in srgb, var(--rv-bad) 10%, transparent));
	--rv-hunk: var(--hunk-bg, color-mix(in srgb, var(--rv-sea) 8%, var(--rv-card)));
	--rv-hot: color-mix(in srgb, var(--rv-brass) 16%, transparent);
	--rv-shadow: var(--shadow, 0 1px 2px rgb(29 39 51 / 6%), 0 8px 24px -12px rgb(29 39 51 / 18%));
	--rv-radius: var(--radius, 10px);
	--rv-serif: var(--font-display, 'Newsreader', Georgia, serif);
	--rv-sans: var(--font-sans, 'Inter', system-ui, sans-serif);
	--rv-mono: var(--font-mono, 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace);
	display: block;
	flex: 1 1 auto;
	min-height: 0;
	color: var(--rv-ink);
	font: 14px/1.55 var(--rv-sans);
	container-type: inline-size;
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; }
button[disabled] { cursor: default; }
a { color: var(--rv-sea); }
:focus-visible { outline: 2px solid var(--ring, var(--rv-sea)); outline-offset: 2px; border-radius: 4px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
`;

/** The tab around the chat: the engine, the pull request picker, the prompts and the toast. */
export const STYLE = `${TOKENS}
code, .mono { font-family: var(--rv-mono); font-size: .86em; font-variant-ligatures: none; }
.dim { color: var(--rv-muted); }
.add { color: var(--rv-ok); } .del { color: var(--rv-bad); }

.app { display: flex; flex-direction: column; min-height: 0; height: var(--rv-height, 100%); border-top: 1px solid var(--rv-hair); }
.app > pr-review-chat { flex: 1 1 auto; min-height: 0; }

.eyebrow { margin: 0; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--rv-muted); font-weight: 500; }
.lede { font-size: 15.5px; color: var(--rv-ink-2); max-width: 72ch; margin: 0; }
.ghost-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 8px; border: 1px solid var(--rv-rule); background: transparent; font-size: 13px; white-space: nowrap; }
.ghost-btn:hover { background: var(--accent, rgba(0,0,0,.04)); }
.link-btn { border: 0; background: none; padding: 0; color: var(--rv-sea); font-size: 13px; }
.link-btn:hover { text-decoration: underline; }
.link-btn[disabled] { color: var(--rv-muted); text-decoration: none; opacity: .6; }
.pill-btn { border: 1px solid var(--rv-rule); background: var(--rv-card); border-radius: 7px; padding: 4px 10px; font-size: 12.5px; }
.pill-btn:hover { border-color: var(--rv-ink-2); }
.primary-btn { border: 0; background: var(--rv-brass); color: #fff; padding: 7px 14px; border-radius: 8px; font-weight: 500; font-size: 13px; }
.primary-btn:hover { filter: brightness(.94); }
.primary-btn.navy { background: var(--rv-navy); color: var(--rv-on-navy); }
.primary-btn[disabled] { opacity: .5; }
.section { margin: 28px 0 0; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.section h2 { font-family: var(--rv-serif); font-weight: 400; font-size: 21px; margin: 0 0 10px; }
.card { background: var(--rv-card); border: 1px solid var(--rv-rule); border-radius: var(--rv-radius); }

/* ---------- picker ---------- */
.picker { max-width: 860px; width: 100%; margin: 0 auto; padding: 32px 24px 64px; overflow-y: auto; height: 100%; }
.picker h1 { font-family: var(--rv-serif); font-weight: 400; font-size: 30px; margin: 0 0 6px; }
.picker form { display: flex; gap: 8px; margin: 18px 0 8px; }
.picker input { flex: 1; min-width: 0; border: 1px solid var(--rv-rule); border-radius: 9px; padding: 9px 12px; background: var(--rv-card); color: var(--rv-ink); font: 13.5px var(--rv-sans); }
.picker input:focus { border-color: var(--rv-sea); outline: none; }
.pr-list { list-style: none; padding: 0; margin: 0; }
.pr-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 11px 16px; border-top: 1px solid var(--rv-hair); }
.pr-row:first-child { border-top: 0; }
.pr-row b { font-weight: 500; }
.pr-row small { display: block; color: var(--rv-muted); font-size: 12.5px; }
.pr-num { color: var(--rv-brass); text-decoration: none; font-weight: 600; white-space: nowrap; }
.pr-num:hover { text-decoration: underline; }
.engine-card { padding: 16px 20px; margin: 18px 0; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.engine-card p { margin: 0; flex: 1 1 22rem; }
.hint { font-family: var(--rv-mono); font-size: 12px; color: var(--rv-muted); word-break: break-all; }
.error { color: var(--rv-bad); font-size: 13px; margin: 6px 0; }

/* ---------- the prompts drawer and the toast ---------- */
.scrim { position: fixed; inset: 0; background: rgba(10,16,24,.55); z-index: 50; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(540px, 100%); background: var(--rv-card); border-left: 1px solid var(--rv-rule); z-index: 51; padding: 20px 24px; overflow-y: auto; box-shadow: -8px 0 30px rgba(0,0,0,.15); }
.drawer-head { display: flex; justify-content: space-between; align-items: center; }
.drawer-head h2 { font-family: var(--rv-serif); font-weight: 400; font-size: 26px; margin: 0; }
.drawer-note { font-size: 13px; color: var(--rv-muted); }
.field { margin: 18px 0 0; }
.field label { display: flex; align-items: baseline; gap: 8px; font-weight: 500; font-size: 13px; margin-bottom: 2px; }
.field small { display: block; color: var(--rv-muted); font-size: 12px; margin-bottom: 6px; }
.field textarea { width: 100%; min-height: 96px; border: 1px solid var(--rv-rule); border-radius: 8px; background: var(--rv-card); color: var(--rv-ink); padding: 10px 12px; font: 12.5px/1.55 var(--rv-mono); resize: vertical; }
.field textarea:focus { border-color: var(--rv-sea); outline: none; }
.saved { font-size: 12px; color: var(--rv-ok); font-weight: 400; }
.drawer-foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--rv-hair); }
.toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--rv-navy); color: var(--rv-on-navy); padding: 9px 16px; border-radius: 9px; font-size: 13px; z-index: 60; }
`;
