/**
 * The review tab's styles: the prototype's calm three columns (the passage,
 * the stage, the review mate), drawn with Wheelhouse's CSS variables so the
 * tab follows its light and dark themes.
 */

export const STYLE = `
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
	--rv-add: color-mix(in srgb, var(--rv-ok) 11%, transparent);
	--rv-del: color-mix(in srgb, var(--rv-bad) 10%, transparent);
	--rv-hot: color-mix(in srgb, var(--rv-brass) 16%, transparent);
	--rv-radius: var(--radius, 10px);
	--rv-serif: var(--font-display, 'Newsreader', Georgia, serif);
	--rv-sans: var(--font-sans, 'Inter', system-ui, sans-serif);
	--rv-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
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
code, .mono { font-family: var(--rv-mono); font-size: .86em; font-variant-ligatures: none; }
:focus-visible { outline: 2px solid var(--ring, var(--rv-sea)); outline-offset: 2px; border-radius: 4px; }
.ico { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.dim { color: var(--rv-muted); }
.add { color: var(--rv-ok); } .del { color: var(--rv-bad); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

.app { display: flex; flex-direction: column; min-height: 0; height: var(--rv-height, 100%); border-top: 1px solid var(--rv-hair); }

/* ---------- bar ---------- */
.bar { display: flex; align-items: center; gap: 14px 20px; padding: 10px 20px; border-bottom: 1px solid var(--rv-hair); flex-wrap: wrap; }
.pr-id { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex: 1 1 20rem; }
.pr-repo { color: var(--rv-muted); font-size: 13px; white-space: nowrap; }
.pr-num { color: var(--rv-brass); text-decoration: none; font-weight: 600; white-space: nowrap; }
.pr-num:hover { text-decoration: underline; }
.pr-title { font-family: var(--rv-serif); font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.bar-right { display: flex; align-items: center; gap: 14px; }
.voyage { display: flex; align-items: center; gap: 10px; }
.voyage-label { font-size: 12.5px; color: var(--rv-muted); white-space: nowrap; }
.voyage-track { width: 110px; height: 4px; border-radius: 2px; background: var(--rv-rule); overflow: hidden; }
.voyage-fill { height: 100%; width: 0; background: var(--rv-brass); transition: width .3s ease-out; }
.ghost-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 8px; border: 1px solid var(--rv-rule); background: transparent; font-size: 13px; white-space: nowrap; }
.ghost-btn:hover { background: var(--accent, rgba(0,0,0,.04)); }

/* ---------- layout ---------- */
.layout { display: grid; grid-template-columns: 236px minmax(0, 1fr) 380px; grid-template-rows: minmax(0, 1fr); flex: 1 1 auto; min-height: 0; overflow: hidden; }
.rail { border-right: 1px solid var(--rv-hair); display: flex; flex-direction: column; padding: 16px 0 14px; min-height: 0; }
.eyebrow { margin: 0; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--rv-muted); font-weight: 500; }
.rail .eyebrow { padding: 0 20px 8px; }
.stops { list-style: none; margin: 0; padding: 0 10px; flex: 1; overflow-y: auto; scrollbar-width: none; }
.stops::-webkit-scrollbar { display: none; }
.stop { position: relative; }
.stop + .stop::before { content: ''; position: absolute; left: 21px; top: -12px; height: 20px; border-left: 1.5px dashed var(--rv-rule); }
.stop-btn { width: 100%; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; align-items: start; text-align: left; border: 0; background: none; padding: 8px 10px; border-radius: 9px; margin: 3px 0; }
.stop-btn:hover { background: var(--accent, rgba(0,0,0,.04)); }
.stop.current .stop-btn { background: var(--rv-card); box-shadow: 0 0 0 1px var(--rv-rule); }
.mark { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; margin-top: 1px; border: 1.5px solid var(--rv-rule); background: var(--rv-paper); color: var(--rv-muted); font-size: 11px; font-weight: 600; }
.stop.current .mark { border-color: var(--rv-brass); color: var(--rv-brass); background: var(--rv-brass-soft); }
.stop.done .mark { border-color: var(--rv-ok); background: var(--rv-ok); color: #fff; }
.stop.done .mark .ico { width: 12px; height: 12px; stroke-width: 2.6; }
.stop-name { display: block; font-weight: 500; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; }
.stop-sub { display: block; font-size: 12px; color: var(--rv-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stop-flags { display: flex; gap: 4px; margin-top: 3px; flex-wrap: wrap; }
.flag { font-size: 11px; padding: 1px 7px; border-radius: 99px; background: var(--rv-warn-soft); color: var(--rv-warn); white-space: nowrap; }
.flag.busy { background: var(--rv-sea-soft); color: var(--rv-sea); }
.flag.bad { background: var(--rv-del); color: var(--rv-bad); }
.rail-foot { padding: 12px 20px 0; border-top: 1px solid var(--rv-hair); display: flex; flex-direction: column; gap: 10px; }
.rail-meta { margin: 0; font-size: 12px; color: var(--rv-muted); }
.finish-btn { display: inline-flex; justify-content: center; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 9px; border: 1px solid var(--rv-navy); background: transparent; color: var(--rv-navy); font-weight: 500; }
.finish-btn:hover { background: var(--rv-navy); color: var(--rv-on-navy); }
.kbd-hint { margin: 0; font-size: 11.5px; color: var(--rv-muted); }
kbd { font-family: var(--rv-mono); font-size: 11px; padding: 0 5px; border: 1px solid var(--rv-rule); border-bottom-width: 2px; border-radius: 4px; background: var(--rv-card); }

/* ---------- stage ---------- */
.stage { overflow-y: auto; padding: 26px 36px 80px; min-width: 0; min-height: 0; outline: none; }
.stage-inner { max-width: 960px; margin: 0 auto; }
.stage-head { margin-bottom: 20px; }
.stage-head h1 { font-family: var(--rv-serif); font-weight: 400; font-size: 30px; line-height: 1.18; margin: 6px 0 10px; }
.lede { font-size: 15.5px; color: var(--rv-ink-2); max-width: 72ch; margin: 0; }
.head-row { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-top: 14px; }
.rating { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--rv-muted); }
.rating-bars { display: inline-flex; gap: 3px; }
.rating-bars i { width: 18px; height: 6px; border-radius: 3px; background: var(--rv-rule); }
.rating[data-level="simple"] i:nth-child(-n+1), .rating[data-level="moderate"] i:nth-child(-n+2), .rating[data-level="complex"] i:nth-child(-n+3) { background: var(--rv-brass); }
.rating b { color: var(--rv-ink); font-weight: 600; text-transform: capitalize; }
.chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 9px; border-radius: 99px; background: var(--rv-card); border: 1px solid var(--rv-rule); color: var(--rv-ink-2); max-width: 100%; }
.chip.ok { color: var(--rv-ok); } .chip.bad { color: var(--rv-bad); border-color: color-mix(in srgb, var(--rv-bad) 40%, transparent); }
.link-btn { border: 0; background: none; padding: 0; color: var(--rv-sea); font-size: 13px; }
.link-btn:hover { text-decoration: underline; }
.link-btn[disabled] { color: var(--rv-muted); text-decoration: none; opacity: .6; }
.section { margin: 28px 0 0; }
.section h2 { font-family: var(--rv-serif); font-weight: 400; font-size: 21px; margin: 0 0 10px; }
.section > p { max-width: 72ch; color: var(--rv-ink-2); }
.card { background: var(--rv-card); border: 1px solid var(--rv-rule); border-radius: var(--rv-radius); }
.prose-card { padding: 16px 20px; }
.prose-card p { margin: 0 0 10px; } .prose-card p:last-child { margin: 0; }
.aside-note { font-size: 13px; color: var(--rv-muted); border-left: 2px solid var(--rv-rule); padding: 2px 0 2px 12px; margin: 14px 0 0; max-width: 72ch; }
.thinking { display: flex; gap: 12px; align-items: center; padding: 14px 18px; margin: 0 0 18px; border: 1px dashed var(--rv-rule); border-radius: var(--rv-radius); color: var(--rv-ink-2); font-size: 13.5px; }
.thinking.failed { border-style: solid; border-color: color-mix(in srgb, var(--rv-bad) 40%, transparent); background: var(--rv-del); }
.pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--rv-sea); animation: pulse 1.2s ease-in-out infinite; flex: none; }
@keyframes pulse { 50% { opacity: .25; transform: scale(.8); } }

.evidence-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
figure { margin: 0; }
.shot { background: var(--rv-card); border: 1px solid var(--rv-rule); border-radius: var(--rv-radius); overflow: hidden; }
.shot button { display: block; border: 0; padding: 0; background: none; width: 100%; cursor: zoom-in; }
.shot img { display: block; width: 100%; height: auto; max-height: 340px; object-fit: contain; background: var(--rv-paper); }
.shot figcaption { padding: 9px 14px; font-size: 12.5px; color: var(--rv-ink-2); border-top: 1px solid var(--rv-rule); }
.checks { list-style: none; margin: 0; padding: 0; }
.checks li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; padding: 9px 16px; border-top: 1px solid var(--rv-hair); font-size: 13.5px; }
.checks li:first-child { border-top: 0; }
.tick { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; margin-top: 1px; color: #fff; }
.tick .ico { width: 11px; height: 11px; stroke-width: 2.6; }
.tick.pass { background: var(--rv-ok); } .tick.fixed { background: var(--rv-brass); } .tick.fail { background: var(--rv-bad); }
.tick.untested, .tick.pending, .tick.skipped, .tick.neutral { background: var(--rv-rule); color: var(--rv-muted); }
.checks small { display: block; color: var(--rv-muted); font-size: 12px; }
.files-bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; margin: 6px 0 12px; background: var(--rv-rule); }
.files-bar span { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 13px; color: var(--rv-ink-2); margin: 0; padding: 0; list-style: none; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 7px; vertical-align: -1px; }
.c-key { background: var(--rv-brass); } .c-test { background: var(--rv-sea); } .c-small { background: color-mix(in srgb, var(--rv-sea) 45%, var(--rv-rule)); } .c-docs { background: color-mix(in srgb, var(--rv-brass) 30%, var(--rv-rule)); } .c-gen { background: repeating-linear-gradient(45deg, var(--rv-rule) 0 4px, transparent 4px 8px); }
.plan { list-style: none; margin: 0; padding: 0; }
.plan li { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; padding: 10px 16px; border-top: 1px solid var(--rv-hair); }
.plan li:first-child { border-top: 0; }
.plan .n { width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--rv-brass); color: var(--rv-brass); font-size: 11px; font-weight: 600; display: grid; place-items: center; }
.plan b { font-weight: 500; }
.plan small { display: block; color: var(--rv-muted); font-size: 12.5px; }
.plan .mono { font-size: 11.5px; color: var(--rv-ink-2); }
.commits { list-style: none; margin: 0; padding: 0; }
.commits li { display: flex; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--rv-hair); font-size: 13px; }
.commits li:first-child { border-top: 0; }

/* ---------- diff ---------- */
.file { margin-top: 24px; }
.file-head { position: sticky; top: -26px; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 9px 14px; background: var(--rv-paper); border-bottom: 1px solid var(--rv-rule); }
.file-head .path { font-family: var(--rv-mono); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.file-head .path span { color: var(--rv-muted); }
.file-head .counts { margin-left: auto; font-family: var(--rv-mono); font-size: 12px; white-space: nowrap; }
.hunk { margin-top: 12px; }
.note { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; padding: 12px 14px 12px 12px; background: var(--rv-card); border: 1px solid var(--rv-rule); border-bottom: 0; border-radius: var(--rv-radius) var(--rv-radius) 0 0; }
.note + .note { border-radius: 0; }
.avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--rv-navy); color: var(--rv-on-navy); display: grid; place-items: center; }
.avatar .ico { width: 16px; height: 16px; stroke-width: 1.3; }
.note-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-weight: 500; font-size: 14px; margin: 2px 0 4px; }
.note-loc { font-family: var(--rv-mono); font-size: 11.5px; color: var(--rv-muted); font-weight: 400; }
.note-body { margin: 0; color: var(--rv-ink-2); font-size: 13.5px; max-width: 80ch; }
.concern { margin: 8px 0 0; padding: 7px 10px; border-radius: 7px; background: var(--rv-warn-soft); font-size: 13px; max-width: 80ch; }
.note-actions { display: flex; gap: 14px; margin-top: 8px; }
.tag { font-size: 11px; font-weight: 500; padding: 1px 7px; border-radius: 99px; text-transform: capitalize; }
.tag-simple { background: var(--rv-sea-soft); color: var(--rv-sea); } .tag-moderate { background: var(--rv-brass-soft); color: var(--rv-brass); } .tag-complex { background: var(--rv-del); color: var(--rv-bad); }
.code { border: 1px solid var(--rv-rule); border-radius: var(--rv-radius); overflow-x: auto; background: var(--rv-card); font-family: var(--rv-mono); font-size: 12.5px; line-height: 1.6; font-variant-ligatures: none; }
.note + .code, .note ~ .code { border-radius: 0 0 var(--rv-radius) var(--rv-radius); }
.code table { border-collapse: collapse; width: 100%; }
.code td { padding: 0 10px; white-space: pre; vertical-align: top; }
.code td.ln { width: 1%; color: var(--rv-muted); opacity: .75; text-align: right; user-select: none; padding: 0 8px; font-size: 11.5px; }
.code td.ln.can { cursor: pointer; }
.code td.ln.can:hover { color: var(--rv-sea); opacity: 1; }
.code td.sg { width: 1%; padding: 0 4px 0 6px; color: var(--rv-muted); user-select: none; }
.code tr.a { background: var(--rv-add); } .code tr.a td.sg { color: var(--rv-ok); }
.code tr.d { background: var(--rv-del); } .code tr.d td.sg { color: var(--rv-bad); }
.code tr.hot { background: var(--rv-hot); } .code tr.hot td:first-child { box-shadow: inset 3px 0 0 var(--rv-brass); }
.code tr.hh td { color: var(--rv-muted); background: color-mix(in srgb, var(--rv-rule) 35%, transparent); font-size: 11.5px; }
.code tr.sel { outline: 1px solid var(--rv-sea); outline-offset: -1px; background: var(--rv-sea-soft); }
.code tr.req td:first-child { box-shadow: inset 3px 0 0 var(--rv-warn); }
.code tr.inline-req td { white-space: normal; font-family: var(--rv-sans); font-size: 13px; padding: 0; background: var(--rv-warn-soft); }
.req-box { position: sticky; left: 0; width: min(640px, 100%); padding: 8px 14px 8px 52px; white-space: normal; }
.tk-k { color: color-mix(in srgb, #7a3e8c 80%, var(--rv-ink)); } .tk-s { color: var(--rv-ok); } .tk-c { color: var(--rv-muted); font-style: italic; } .tk-n { color: var(--rv-brass); } .tk-t { color: var(--rv-sea); }
.more-lines { padding: 6px 14px; font-size: 12px; color: var(--rv-muted); }

.alts { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
.alt { padding: 14px 16px; }
.alt h3 { font-size: 14px; font-weight: 500; margin: 0 0 8px; display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; }
.alt dl { margin: 0; font-size: 13px; color: var(--rv-ink-2); display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; }
.alt dt { color: var(--rv-muted); } .alt dd { margin: 0; }
.verdict { font-size: 11px; padding: 1px 8px; border-radius: 99px; white-space: nowrap; font-weight: 500; text-transform: capitalize; }
.v-recommend { background: var(--rv-ok-soft); color: var(--rv-ok); } .v-consider { background: var(--rv-sea-soft); color: var(--rv-sea); } .v-later, .v-worse { background: var(--rv-rule); color: var(--rv-muted); }
.pick { margin: 12px 0 0; font-size: 13.5px; color: var(--rv-ink-2); display: flex; gap: 10px; align-items: flex-start; }
.pick b { color: var(--rv-ink); font-weight: 500; white-space: nowrap; }

.finding { margin-top: 14px; overflow: hidden; }
.finding-head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px 6px; }
.finding-head h3 { font-size: 15px; font-weight: 500; margin: 0; flex: 1; }
.finding-body { padding: 0 16px 12px; }
.finding-body p { margin: 0 0 10px; color: var(--rv-ink-2); font-size: 13.5px; max-width: 80ch; }
.finding .code { border-radius: 8px; margin: 0 0 10px; max-height: 300px; overflow: auto; }
.loc { font-family: var(--rv-mono); font-size: 12px; color: var(--rv-muted); }
.suggest { display: flex; gap: 8px; font-size: 13px; padding: 8px 10px; background: var(--rv-sea-soft); border-radius: 7px; }
.finding-actions { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--rv-hair); align-items: center; flex-wrap: wrap; }
.finding.dismissed { opacity: .55; }
.finding.dismissed .finding-body { display: none; }
.level { font-size: 11px; padding: 2px 8px; border-radius: 99px; white-space: nowrap; font-weight: 500; }
.level-worth { background: var(--rv-warn-soft); color: var(--rv-warn); } .level-nit { background: var(--rv-rule); color: var(--rv-muted); }
.pill-btn { border: 1px solid var(--rv-rule); background: var(--rv-card); border-radius: 7px; padding: 4px 10px; font-size: 12.5px; }
.pill-btn:hover { border-color: var(--rv-ink-2); }
.pill-btn.on { background: var(--rv-navy); color: var(--rv-on-navy); border-color: var(--rv-navy); }
.status-txt { margin-left: auto; font-size: 12px; color: var(--rv-muted); }

.group { margin-top: 24px; }
.group-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.group-head h2 { font-family: var(--rv-serif); font-weight: 400; font-size: 19px; margin: 0; }
.group-head span { font-size: 12.5px; color: var(--rv-muted); }
.rows { list-style: none; margin: 0; padding: 0; }
.row { border-top: 1px solid var(--rv-hair); }
.row:first-child { border-top: 0; }
.row-btn { width: 100%; text-align: left; border: 0; background: none; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 16px; gap: 12px; align-items: start; padding: 10px 16px; }
.row-btn:hover { background: var(--accent, rgba(0,0,0,.03)); }
.risk { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--rv-ok); opacity: .55; }
.risk-medium { background: var(--rv-brass); opacity: 1; } .risk-high { background: var(--rv-bad); opacity: 1; }
.row-path { font-family: var(--rv-mono); font-size: 12.5px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-note { display: block; font-size: 13px; color: var(--rv-ink-2); margin-top: 2px; }
.row-counts { font-family: var(--rv-mono); font-size: 12px; white-space: nowrap; margin-top: 1px; }
.chev { width: 14px; height: 14px; color: var(--rv-muted); margin-top: 3px; transition: transform .2s; }
.row.open .chev { transform: rotate(90deg); }
.row-diff { padding: 0 16px 14px; }
.row.flagged .row-path { color: var(--rv-brass); }
.gen-list { padding: 4px 16px 14px; font-family: var(--rv-mono); font-size: 12px; color: var(--rv-muted); columns: 2; column-gap: 24px; }
.gen-list div { break-inside: avoid; padding: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- chat ---------- */
.chat { border-left: 1px solid var(--rv-hair); background: var(--rv-panel); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.chat-head { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--rv-hair); }
.chat-head .avatar { width: 34px; height: 34px; }
.chat-head .avatar .ico { width: 22px; height: 22px; }
.chat-name { margin: 0; font-weight: 600; font-size: 14px; }
.chat-status { margin: 0; font-size: 12px; color: var(--rv-muted); }
.dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--rv-ok); margin-right: 5px; vertical-align: 1px; }
.dot.off { background: var(--rv-bad); }
.chat-log { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 16px 8px; scrollbar-width: none; }
.chat-log::-webkit-scrollbar { display: none; }
.divider { display: flex; align-items: center; gap: 10px; margin: 6px 0 12px; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--rv-muted); }
.divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--rv-hair); }
.msg { margin: 0 0 10px; }
.msg p { margin: 0 0 8px; } .msg p:last-child { margin: 0; }
.msg ul, .msg ol { margin: 0 0 8px; padding-left: 18px; }
.msg-agent { padding: 10px 14px; background: var(--rv-card); border: 1px solid var(--rv-rule); border-radius: 12px 12px 12px 4px; font-size: 13.5px; color: var(--rv-ink-2); }
.msg-agent strong { color: var(--rv-ink); }
.msg-agent.error { border-color: color-mix(in srgb, var(--rv-bad) 40%, transparent); }
.msg-user { margin-left: 36px; padding: 9px 13px; background: var(--rv-sea-soft); border-radius: 12px 12px 4px 12px; font-size: 13.5px; }
.msg-ctx { display: block; font-family: var(--rv-mono); font-size: 11px; color: var(--rv-sea); margin-bottom: 3px; }
.msg-change { margin-left: 36px; border: 1px solid color-mix(in srgb, var(--rv-warn) 35%, transparent); background: var(--rv-warn-soft); border-radius: 12px 12px 4px 12px; padding: 9px 13px; font-size: 13.5px; }
.msg-change .lbl { display: flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--rv-warn); margin-bottom: 3px; }
.msg-change.withdrawn { opacity: .5; text-decoration: line-through; }
.msg-meta { font-size: 11px; color: var(--rv-muted); margin: -6px 0 10px 4px; }
.typing { display: inline-flex; gap: 4px; padding: 12px 14px; background: var(--rv-card); border: 1px solid var(--rv-rule); border-radius: 12px 12px 12px 4px; margin-bottom: 10px; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--rv-muted); opacity: .4; animation: blink 1s infinite; }
.typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 50% { opacity: 1; } }
.suggests { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 12px; }
.suggest-chip { border: 1px solid var(--rv-rule); background: var(--rv-card); border-radius: 99px; padding: 5px 11px; font-size: 12.5px; color: var(--rv-ink-2); text-align: left; }
.suggest-chip:hover { border-color: var(--rv-sea); color: var(--rv-sea); }
.composer { border-top: 1px solid var(--rv-hair); padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 8px; }
.mode { display: inline-flex; align-self: flex-start; background: color-mix(in srgb, var(--rv-rule) 60%, transparent); border-radius: 8px; padding: 2px; }
.mode-btn { border: 0; background: none; padding: 4px 11px; font-size: 12.5px; border-radius: 6px; color: var(--rv-muted); }
.mode-btn.on { background: var(--rv-card); color: var(--rv-ink); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.mode-btn.change.on { color: var(--rv-warn); }
.attach-chip { display: inline-flex; align-items: center; gap: 6px; font-family: var(--rv-mono); font-size: 11.5px; padding: 3px 4px 3px 9px; border-radius: 6px; background: var(--rv-sea-soft); color: var(--rv-sea); max-width: 100%; align-self: flex-start; }
.attach-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-chip button { border: 0; background: none; color: inherit; padding: 0 4px; font-size: 14px; line-height: 1; }
.input-row { display: flex; gap: 8px; align-items: flex-end; background: var(--rv-card); border: 1px solid var(--rv-rule); border-radius: 10px; padding: 6px 6px 6px 12px; }
.input-row:focus-within { border-color: var(--rv-sea); }
.composer.change .input-row { border-color: color-mix(in srgb, var(--rv-warn) 50%, transparent); }
textarea { flex: 1; border: 0; outline: 0; resize: none; font: 13.5px/1.5 var(--rv-sans); background: none; color: var(--rv-ink); max-height: 140px; padding: 4px 0; min-width: 0; }
.send { width: 32px; height: 32px; border-radius: 8px; border: 0; background: var(--rv-navy); color: var(--rv-on-navy); display: grid; place-items: center; flex: none; }
.composer.change .send { background: var(--rv-warn); }
.composer-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.primary-btn { border: 0; background: var(--rv-brass); color: #fff; padding: 7px 14px; border-radius: 8px; font-weight: 500; font-size: 13px; }
.primary-btn:hover { filter: brightness(.94); }
.primary-btn.again { background: var(--rv-card); color: var(--rv-ok); box-shadow: inset 0 0 0 1px var(--rv-ok); }
.primary-btn.navy { background: var(--rv-navy); color: var(--rv-on-navy); }
.primary-btn[disabled] { opacity: .5; }

/* ---------- picker ---------- */
.picker { max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; overflow-y: auto; height: 100%; }
.picker h1 { font-family: var(--rv-serif); font-weight: 400; font-size: 30px; margin: 0 0 6px; }
.picker form { display: flex; gap: 8px; margin: 18px 0 8px; }
.picker input { flex: 1; min-width: 0; border: 1px solid var(--rv-rule); border-radius: 9px; padding: 9px 12px; background: var(--rv-card); color: var(--rv-ink); font: 13.5px var(--rv-sans); }
.picker input:focus { border-color: var(--rv-sea); outline: none; }
.pr-list { list-style: none; padding: 0; margin: 0; }
.pr-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 11px 16px; border-top: 1px solid var(--rv-hair); }
.pr-row:first-child { border-top: 0; }
.pr-row b { font-weight: 500; }
.pr-row small { display: block; color: var(--rv-muted); font-size: 12.5px; }
.engine-card { padding: 16px 20px; margin: 18px 0; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.engine-card p { margin: 0; flex: 1 1 22rem; }
.hint { font-family: var(--rv-mono); font-size: 12px; color: var(--rv-muted); word-break: break-all; }
.error { color: var(--rv-bad); font-size: 13px; margin: 6px 0; }

/* ---------- overlays ---------- */
.scrim { position: fixed; inset: 0; background: rgba(10,16,24,.55); z-index: 50; display: grid; place-items: center; padding: 24px; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(540px, 100vw); background: var(--rv-card); border-left: 1px solid var(--rv-rule); z-index: 51; padding: 20px 24px; overflow-y: auto; box-shadow: -8px 0 30px rgba(0,0,0,.15); }
.drawer-head { display: flex; justify-content: space-between; align-items: center; }
.drawer-head h2, .modal h2 { font-family: var(--rv-serif); font-weight: 400; font-size: 26px; margin: 0; }
.drawer-note { font-size: 13px; color: var(--rv-muted); }
.field { margin: 18px 0 0; }
.field label { display: flex; align-items: baseline; gap: 8px; font-weight: 500; font-size: 13px; margin-bottom: 2px; }
.field small { display: block; color: var(--rv-muted); font-size: 12px; margin-bottom: 6px; }
.field textarea { width: 100%; min-height: 96px; border: 1px solid var(--rv-rule); border-radius: 8px; background: var(--rv-card); padding: 10px 12px; font: 12.5px/1.55 var(--rv-mono); max-height: none; resize: vertical; }
.field textarea:focus { border-color: var(--rv-sea); }
.saved { font-size: 12px; color: var(--rv-ok); font-weight: 400; }
.drawer-foot { display: flex; justify-content: space-between; margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--rv-hair); }
.modal { background: var(--rv-card); border: 1px solid var(--rv-rule); border-radius: 14px; width: min(760px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; padding: 24px 28px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
.modal .outcome { font-size: 15px; color: var(--rv-ink-2); margin: 6px 0 16px; }
.verdicts { display: flex; gap: 8px; margin: 8px 0 16px; flex-wrap: wrap; align-items: center; }
.draft-body { width: 100%; min-height: 110px; border: 1px solid var(--rv-rule); border-radius: 8px; background: var(--rv-card); padding: 10px 12px; font: 13px/1.5 var(--rv-sans); color: var(--rv-ink); resize: vertical; }
.draft { background: var(--rv-card); border: 1px solid var(--rv-rule); border-radius: 10px; padding: 12px 16px; font-size: 13px; margin-top: 10px; }
.draft h3 { font-size: 11.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--rv-muted); margin: 0 0 6px; font-weight: 500; }
.draft ul { margin: 0; padding-left: 18px; }
.draft li { margin: 4px 0; }
.draft pre { white-space: pre-wrap; font: 12.5px/1.5 var(--rv-mono); margin: 0; }
.modal-foot { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; align-items: center; flex-wrap: wrap; }
.confirm { margin-top: 14px; padding: 12px 14px; border-radius: 9px; background: var(--rv-warn-soft); font-size: 13.5px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.confirm p { margin: 0; flex: 1 1 18rem; }
.done-note { margin-top: 14px; padding: 10px 14px; border-radius: 9px; background: var(--rv-ok-soft); font-size: 13.5px; }
.lightbox img { width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--rv-rule); display: block; }
.toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); background: var(--rv-navy); color: var(--rv-on-navy); padding: 9px 16px; border-radius: 9px; font-size: 13px; z-index: 60; }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
@container (max-width: 1180px) {
	.layout { grid-template-columns: 64px minmax(0, 1fr) 340px; }
	.stop-name, .stop-sub, .stop-flags, .rail .eyebrow, .rail-meta, .kbd-hint { display: none; }
	.stop-btn { grid-template-columns: 24px; justify-content: center; }
	.stop + .stop::before { left: 31px; }
	.rail-foot { padding: 12px 8px 0; }
	.finish-btn span { display: none; }
	.stage { padding: 22px 22px 80px; }
	.voyage { display: none; }
}
@container (max-width: 760px) {
	.layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) minmax(0, 45%); }
	.rail { border-right: 0; border-bottom: 1px solid var(--rv-hair); padding: 6px 0; }
	.stops { display: flex; overflow-x: auto; }
	.stop + .stop::before { display: none; }
	.rail-foot { display: none; }
	.chat { border-left: 0; border-top: 1px solid var(--rv-hair); }
}
`;
