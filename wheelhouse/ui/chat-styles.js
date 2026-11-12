/**
 * The chat review's styles (`chat.js`), on the review's tokens (`TOKENS` in
 * `styles.js`), plus a colour per verdict. They came from the web app's page
 * stylesheet; here they live in the element's shadow root, so the page's
 * own rules never reach them. The navigator and the file drawer slide over
 * the chat when the element, not the window, is narrow (container queries).
 *
 * The verdict and code colours are mixed with the host's ink, so they read on
 * a light page (where the ink is dark) and a dark one (where it's light)
 * without knowing which theme the host is in.
 */

import { TOKENS } from './styles.js';

export const CHAT_STYLE = `${TOKENS}
:host {
	display: flex;
	flex-direction: column;
	height: 100%;
}
.chatapp {
	--v-exemplary: color-mix(in srgb, #8a6fd6 72%, var(--rv-ink));
	--v-lgtm: color-mix(in srgb, #4f9d66 72%, var(--rv-ink));
	--v-explain: color-mix(in srgb, #5397b8 72%, var(--rv-ink));
	--v-smell: color-mix(in srgb, #b78f2a 72%, var(--rv-ink));
	--v-complex: color-mix(in srgb, #c67c34 72%, var(--rv-ink));
	--v-untested: color-mix(in srgb, #ca7240 72%, var(--rv-ink));
	--v-perf: color-mix(in srgb, #d0623e 72%, var(--rv-ink));
	--v-ac: color-mix(in srgb, #bc6074 72%, var(--rv-ink));
	--v-security: color-mix(in srgb, #dc4a4f 72%, var(--rv-ink));
	--focus-line: color-mix(in srgb, var(--rv-brass) 20%, var(--rv-card));
	--code-bg: color-mix(in srgb, var(--rv-card) 60%, var(--rv-paper));
	--me-bg: var(--bubble-captain, color-mix(in srgb, var(--rv-sea) 14%, var(--rv-card)));
	--tk-key: color-mix(in srgb, #b46fbc 70%, var(--rv-ink));
	--tk-str: color-mix(in srgb, #5fa070 70%, var(--rv-ink));
	--tk-com: var(--rv-muted);
	--tk-num: color-mix(in srgb, #c67c34 70%, var(--rv-ink));
	--tk-fn: color-mix(in srgb, #5d8fbf 70%, var(--rv-ink));
	--navw: 288px;
	--drawerw: min(560px, 44%);
	height: 100%;
}
.sr {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
}
.small {
	font-size: 13px;
}
.linkish {
	background: none;
	border: 0;
	padding: 0;
	color: var(--rv-muted);
	font: inherit;
	cursor: pointer;
}
.linkish:hover {
	color: var(--rv-ink);
}
.chatapp {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	font-size: 15px;
	line-height: 1.6;
}
.chatapp kbd {
	font: 11px var(--rv-mono);
	padding: 0 5px;
	border: 1px solid var(--rv-rule);
	border-bottom-width: 2px;
	border-radius: 4px;
	background: var(--rv-card);
	color: var(--rv-muted);
	white-space: nowrap;
}
.chatapp code {
	font-family: var(--rv-mono);
	font-size: 0.84em;
	background: color-mix(in srgb, var(--rv-brass) 14%, transparent);
	border-radius: 4px;
	padding: 0.05em 0.3em;
	overflow-wrap: anywhere;
}
:where(.chatapp) button {
	font: inherit;
	color: inherit;
	cursor: pointer;
}
.chatapp :focus-visible {
	outline: 2px solid var(--rv-sea);
	outline-offset: 2px;
	border-radius: 4px;
}
.only-narrow {
	display: none !important;
}
.cdim {
	color: var(--rv-muted);
}
.cpad {
	padding: 10px 14px;
}
@media (prefers-reduced-motion: reduce) {
	.chatapp *,
	.chatapp *::before {
		animation: none !important;
		transition: none !important;
		scroll-behavior: auto !important;
	}
}

/* ---------- the bar ---------- */
.cbar {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px clamp(12px, 2cqw, 20px);
	border-bottom: 1px solid var(--rv-hair);
	font-size: 14px;
	min-width: 0;
}
.cback {
	text-decoration: none;
	color: var(--rv-muted);
}
.ctitle {
	flex: 1;
	min-width: 0;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	font-family: var(--rv-serif);
	font-size: 17px;
}
.cnum {
	font: 600 13px var(--rv-sans);
	color: var(--rv-brass);
	text-decoration: none;
	margin-right: 6px;
}
.cprogress {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 12.5px;
	color: var(--rv-muted);
	white-space: nowrap;
}
.ctrack {
	width: 90px;
	height: 4px;
	border-radius: 2px;
	background: var(--rv-rule);
	overflow: hidden;
	display: block;
}
.ctrack span {
	display: block;
	height: 100%;
	width: 0;
	background: var(--rv-brass);
	transition: width 0.3s;
}
.cghost {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 5px 10px;
	border-radius: 8px;
	border: 1px solid var(--rv-rule);
	background: var(--rv-card);
	font-size: 13px;
	white-space: nowrap;
}
.cghost:hover {
	border-color: var(--rv-muted);
}
.cnote {
	font-size: 12.5px;
	color: var(--rv-muted);
	white-space: nowrap;
}

/* ---------- navigator | chat | file drawer ---------- */
.clayout {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: var(--navw) minmax(0, 1fr) 0;
	transition: grid-template-columns 0.22s ease;
}
.chatapp.drawer-open .clayout {
	grid-template-columns: var(--navw) minmax(0, 1fr) var(--drawerw);
}

/* The navigator: secondary, and visibly apart from the chat. */
.cnav {
	background: var(--rv-panel);
	border-right: 1px solid var(--rv-rule);
	display: flex;
	flex-direction: column;
	min-height: 0;
	min-width: 0;
}
.cnav-head {
	padding: 12px 14px 0;
}
.cnav-label {
	font: 600 11px var(--rv-sans);
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--rv-muted);
	margin: 0 0 8px;
	display: flex;
	justify-content: space-between;
}
.ctabs {
	display: flex;
	gap: 2px;
	background: var(--rv-paper);
	border: 1px solid var(--rv-rule);
	border-radius: 9px;
	padding: 2px;
}
.ctabs button {
	flex: 1;
	border: 0;
	background: none;
	border-radius: 7px;
	padding: 5px 8px;
	font-size: 13px;
	font-weight: 500;
	color: var(--rv-muted);
	display: inline-flex;
	gap: 6px;
	justify-content: center;
	align-items: center;
}
.ctabs button[aria-selected='true'] {
	background: var(--rv-card);
	color: var(--rv-ink);
	box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}
.ccount {
	font-size: 11.5px;
	background: var(--rv-rule);
	border-radius: 999px;
	padding: 0 6px;
}
.cnav-body {
	flex: 1;
	overflow-y: auto;
	padding: 10px 8px 16px;
	min-height: 0;
	scrollbar-width: thin;
}
.cnav-foot {
	border-top: 1px solid var(--rv-hair);
	padding: 10px 14px;
	font-size: 12px;
	color: var(--rv-muted);
	display: flex;
	flex-wrap: wrap;
	gap: 4px 12px;
}
.cgroup {
	margin: 0 0 4px;
}
.cghead {
	width: 100%;
	display: flex;
	gap: 10px;
	align-items: flex-start;
	text-align: left;
	background: none;
	border: 0;
	border-radius: 8px;
	padding: 7px 8px;
}
.cghead:hover,
.crowbtn:hover,
.cstoph:hover,
.cfrow:hover {
	background: var(--rv-card);
}
.cghead .num {
	width: 22px;
	height: 22px;
	border-radius: 50%;
	border: 1.5px solid var(--rv-rule);
	display: grid;
	place-items: center;
	font-size: 11.5px;
	font-weight: 600;
	color: var(--rv-muted);
	flex: none;
	background: var(--rv-paper);
	margin-top: 1px;
}
.cghead.done .num {
	background: var(--v-lgtm);
	border-color: var(--v-lgtm);
	color: var(--rv-card);
}
.cghead.here .num {
	border-color: var(--rv-brass);
	color: var(--rv-brass);
}
.cghead .gt {
	font-weight: 600;
	font-size: 14px;
	display: block;
}
.cghead .gs {
	font-size: 12.5px;
	color: var(--rv-muted);
	display: block;
}
.cdots {
	display: flex;
	gap: 3px;
	margin-top: 5px;
	flex-wrap: wrap;
}
.cdots i {
	width: 8px;
	height: 8px;
	border-radius: 2px;
	background: var(--v);
}
.cstoph {
	width: calc(100% - 34px);
	margin: 4px 0 1px 34px;
	font-size: 12px;
	color: var(--rv-muted);
	background: none;
	border: 0;
	text-align: left;
	padding: 3px 8px;
	border-radius: 6px;
}
.cstate {
	color: var(--rv-brass);
}
.cview {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 5px;
	padding: 2px 8px 10px;
	margin: 0 0 6px;
	border-bottom: 1px solid var(--rv-hair);
}
.cview-l {
	font-size: 12px;
	color: var(--rv-muted);
	margin-right: 2px;
}
.ctoggle {
	border: 1px solid var(--rv-rule);
	background: none;
	border-radius: 999px;
	padding: 2px 9px;
	font-size: 12px;
	color: var(--rv-muted);
}
.ctoggle b {
	font-weight: 600;
	margin-left: 2px;
}
.ctoggle.on {
	background: var(--rv-card);
	border-color: var(--rv-ink);
	color: var(--rv-ink);
}
.ctoggle:disabled {
	cursor: default;
	opacity: 1;
}
.ctoggle:not(:disabled):hover {
	border-color: var(--rv-sea);
}
.chidden {
	margin: 2px 0 4px 42px;
	font-size: 12px;
	color: var(--rv-muted);
	font-style: italic;
}
.cdiagram {
	margin: 10px 0 6px;
	border: 1px solid var(--rv-hair);
	border-radius: 10px;
	background: var(--rv-paper);
	overflow: hidden;
}
.cdiagram-box {
	overflow: auto;
	max-height: 560px;
}
.cdiagram img {
	display: block;
	width: 100%;
	height: auto;
	cursor: zoom-in;
}
.cdiagram.full img {
	width: auto;
	max-width: none;
	cursor: zoom-out;
}
.cdiagram figcaption {
	font-size: 12.5px;
	color: var(--rv-muted);
	padding: 6px 10px 8px;
	border-top: 1px solid var(--rv-hair);
}
.crows {
	list-style: none;
	margin: 0 0 4px;
	padding: 0 0 0 30px;
}
.crowbtn {
	width: 100%;
	display: flex;
	gap: 8px;
	align-items: flex-start;
	text-align: left;
	background: none;
	border: 0;
	border-radius: 6px;
	padding: 4px 8px;
	font-size: 13.5px;
	color: var(--rv-ink);
}
.crowbtn .vmark {
	color: var(--v);
	margin-top: 3px;
	width: 14px;
	height: 14px;
	flex: none;
}
.crowbtn .ct {
	flex: 1;
	min-width: 0;
	overflow-wrap: anywhere;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}
.crowbtn .cd {
	font-size: 11.5px;
	color: var(--rv-muted);
	white-space: nowrap;
	margin-top: 2px;
}
.crowbtn.here {
	background: var(--rv-card);
	box-shadow: inset 3px 0 0 var(--v);
	font-weight: 500;
}
.crowbtn.decided .ct {
	color: var(--rv-muted);
}
.cfinish {
	margin: 10px 8px 0;
	width: calc(100% - 16px);
	padding: 8px 12px;
	border-radius: 8px;
	border: 1.5px solid var(--rv-navy);
	background: transparent;
	font-weight: 600;
}
.cfinish:hover {
	background: var(--rv-navy);
	color: var(--rv-on-navy);
}
.cfilter {
	width: 100%;
	border: 1px solid var(--rv-rule);
	border-radius: 8px;
	padding: 6px 10px;
	background: var(--rv-card);
	font: 13px var(--rv-sans);
	color: var(--rv-ink);
	margin: 0 0 8px;
}
.cdir {
	font: 12px var(--rv-mono);
	color: var(--rv-muted);
	padding: 6px 8px 2px;
	overflow-wrap: anywhere;
}
.cfrow {
	width: 100%;
	display: grid;
	grid-template-columns: 14px minmax(0, 1fr) auto;
	gap: 2px 8px;
	align-items: center;
	text-align: left;
	background: none;
	border: 0;
	border-radius: 6px;
	padding: 4px 8px 4px 14px;
	font-size: 13px;
}
.cfrow.here {
	background: var(--rv-card);
	box-shadow: inset 3px 0 0 var(--rv-sea);
}
.cfi {
	color: var(--rv-muted);
}
.cfrow.viewed .cfi {
	color: var(--v-lgtm);
}
.cfrow.viewed .cfn {
	color: var(--rv-muted);
}
.cfn {
	font: 12.5px var(--rv-mono);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.cfs {
	font: 11px var(--rv-mono);
	white-space: nowrap;
}
.cfrow .cdots {
	grid-column: 2 / 4;
	margin-top: 0;
}
.a {
	color: var(--rv-ok);
}
.d {
	color: var(--rv-bad);
}

/* ---------- the chat ---------- */
.cchat {
	display: flex;
	flex-direction: column;
	min-height: 0;
	min-width: 0;
}
.cstream {
	position: relative;
	flex: 1;
	overflow-y: auto;
	overflow-x: hidden;
	padding: 24px 24px 12px;
}
.ccol {
	max-width: 780px;
	margin: 0 auto;
}
.cmsg {
	display: flex;
	gap: 12px;
	margin: 0 0 20px;
	animation: crise 0.25s ease both;
	min-width: 0;
}
@keyframes crise {
	from {
		opacity: 0;
		transform: translateY(6px);
	}
}
.cav {
	width: 30px;
	height: 30px;
	border-radius: 9px;
	background: var(--rv-navy);
	color: var(--rv-on-navy);
	display: grid;
	place-items: center;
	flex: none;
	margin-top: 2px;
	font-weight: 600;
}
.cbody {
	flex: 1;
	min-width: 0;
}
.cwho {
	font-size: 12.5px;
	color: var(--rv-muted);
	margin: 0 0 3px;
	display: flex;
	gap: 8px;
	align-items: baseline;
	flex-wrap: wrap;
}
.cwho b {
	color: var(--rv-ink);
}
.ctext p,
.ccard p {
	margin: 0 0 9px;
}
.ctext p:last-child,
.ccard p:last-child {
	margin-bottom: 0;
}
.ctext ul,
.ctext ol,
.ccard ul {
	margin: 0 0 10px;
	padding-left: 20px;
}
.chatapp pre {
	margin: 8px 0 10px;
	background: var(--code-bg);
	border: 1px solid var(--rv-rule);
	border-radius: 9px;
	padding: 10px 12px;
	overflow-x: auto;
	font: 12.5px/1.6 var(--rv-mono);
}
.chatapp pre code {
	background: none;
	padding: 0;
	font-size: inherit;
}
.cerror {
	color: var(--rv-bad);
}
.cmsg.me {
	justify-content: flex-end;
}
.cbubble {
	background: var(--me-bg);
	border-radius: 14px 14px 4px 14px;
	padding: 9px 14px;
	max-width: min(560px, 85%);
	overflow-wrap: anywhere;
}
.ctag {
	display: block;
	font-size: 12px;
	color: var(--rv-muted);
}
.cmsg.flash .ccard {
	animation: cflash 1.4s ease;
}
@keyframes cflash {
	0%,
	40% {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--rv-brass) 55%, transparent);
	}
}
.ctyping {
	display: inline-flex;
	gap: 4px;
	padding: 10px 0;
}
.ctyping i {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: var(--rv-muted);
	opacity: 0.4;
	animation: cblink 1s infinite;
}
.ctyping i:nth-child(2) {
	animation-delay: 0.15s;
}
.ctyping i:nth-child(3) {
	animation-delay: 0.3s;
}
@keyframes cblink {
	50% {
		opacity: 1;
	}
}
.cdiv {
	display: flex;
	align-items: center;
	gap: 12px;
	margin: 30px 0 18px;
	color: var(--rv-muted);
	font-size: 12.5px;
	text-align: center;
}
.cdiv::before,
.cdiv::after {
	content: '';
	flex: 1;
	height: 1px;
	background: var(--rv-rule);
}
.cdiv b {
	color: var(--rv-ink);
}
.cdiv.jump {
	font-style: italic;
}

/* Smart components inside messages */
.ccard {
	background: var(--rv-card);
	border: 1px solid var(--rv-rule);
	border-radius: 14px;
	padding: 16px 18px;
	margin: 8px 0 0;
	min-width: 0;
}
.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	align-items: center;
}
.vchip {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-weight: 600;
	font-size: 12.5px;
	color: var(--v);
	padding: 2px 10px 2px 7px;
	border-radius: 999px;
	background: color-mix(in srgb, var(--v) 10%, transparent);
	border: 1px solid color-mix(in srgb, var(--v) 38%, transparent);
	white-space: nowrap;
	text-transform: none;
	letter-spacing: 0;
}
.vchip.main {
	font-size: 13.5px;
	padding: 3px 12px 3px 8px;
	border-width: 1.5px;
}
.vchip.second {
	font-weight: 500;
}
.vchip .sev {
	font-weight: 400;
	color: var(--rv-muted);
}
.vmark {
	width: 14px;
	height: 14px;
	flex: none;
}
.cref {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	border: 1px solid var(--rv-rule);
	background: var(--rv-card);
	border-radius: 999px;
	padding: 0 9px 0 6px;
	font-size: 13px;
	line-height: 1.6;
	vertical-align: baseline;
	max-width: 100%;
	text-align: left;
}
.cref:hover {
	border-color: var(--v);
}
.cref .vmark {
	width: 13px;
	height: 13px;
	color: var(--v);
}
.cov h2 {
	font: 400 25px/1.2 var(--rv-serif);
	margin: 2px 0 6px;
	text-wrap: balance;
}
.cmeta {
	font-size: 13px;
	color: var(--rv-muted);
	display: flex;
	flex-wrap: wrap;
	gap: 4px 14px;
	margin: 0 0 12px;
}
.cgist {
	font-size: 15.5px;
}
.csub {
	font: 600 12px var(--rv-sans);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--rv-muted);
	margin: 14px 0 6px !important;
}
.cchecks {
	list-style: none;
	padding: 0 !important;
	margin: 0;
}
.cchecks li {
	display: grid;
	grid-template-columns: 22px minmax(0, 1fr) auto;
	gap: 8px;
	align-items: start;
	padding: 6px 0;
	border-top: 1px solid var(--rv-hair);
	font-size: 14px;
}
.cchecks li:first-child {
	border-top: 0;
}
.cst {
	width: 20px;
	height: 20px;
	border-radius: 50%;
	display: grid;
	place-items: center;
	font-size: 12px;
	font-weight: 700;
	color: var(--rv-card);
	margin-top: 1px;
	background: var(--rv-muted);
}
.cst.pass {
	background: var(--v-lgtm);
}
.cst.fail {
	background: var(--v-security);
}
.cst.warn {
	background: var(--v-smell);
}
.cnote {
	display: block;
	font-size: 12.5px;
	color: var(--rv-muted);
}
.clink {
	border: 0;
	background: none;
	padding: 0;
	text-align: left;
	color: var(--rv-ink);
	text-decoration: underline;
	text-decoration-color: var(--rv-rule);
	text-underline-offset: 3px;
}
.clink:hover {
	text-decoration-color: var(--rv-sea);
}
.crefs {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	justify-content: flex-end;
	max-width: 260px;
}
.cshape {
	display: flex;
	gap: 3px;
	margin: 12px 0 8px;
}
.cshape button {
	flex: 1;
	height: 8px;
	border: 0;
	padding: 0;
	border-radius: 3px;
	background: var(--v);
	opacity: 0.85;
	min-width: 0;
}
.cshape button:hover {
	opacity: 1;
	transform: scaleY(1.4);
}
.ccounts {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin: 0 0 4px;
}
.chead {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: 6px 10px;
	font-size: 12.5px;
	color: var(--rv-muted);
	margin: 0 0 10px;
}
.cwhere {
	font: 12px var(--rv-mono);
	overflow-wrap: anywhere;
}
.change h3 {
	font: 400 22px/1.22 var(--rv-serif);
	margin: 10px 0 8px;
	text-wrap: balance;
}
.ctake {
	margin: 0 0 12px;
}
.cparts {
	display: grid;
	gap: 8px;
	margin: 0 0 12px;
}
.cpart {
	border-left: 3px solid var(--k);
	background: color-mix(in srgb, var(--k) 6%, transparent);
	border-radius: 0 10px 10px 0;
	padding: 8px 12px;
	font-size: 14.5px;
}
.cpk {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 8px;
	font-size: 12px;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--k);
	margin: 0 0 3px;
}
.cpart.note {
	--k: var(--v-explain);
}
.cpart.like {
	--k: var(--v-lgtm);
}
.cpart.work {
	--k: var(--v-smell);
}
.cpart.serious {
	--k: var(--v-security);
}
.casked {
	margin: 0 0 12px;
	padding: 9px 13px;
	border-left: 3px solid var(--v-ac);
	background: var(--rv-paper);
	border-radius: 0 8px 8px 0;
	font-size: 14px;
}
.csuggest {
	margin: 0 0 12px;
	padding: 10px 14px;
	background: color-mix(in srgb, var(--rv-sea) 10%, transparent);
	border-radius: 10px;
	font-size: 14.5px;
}
.ccode {
	margin: 0 0 12px;
	border: 1px solid var(--rv-rule);
	border-radius: 10px;
	overflow: hidden;
	background: var(--code-bg);
	min-width: 0;
}
.cfile {
	display: flex;
	gap: 8px;
	align-items: center;
	padding: 6px 8px 6px 12px;
	border-bottom: 1px solid var(--rv-rule);
	font-size: 12px;
	background: var(--rv-card);
	min-width: 0;
}
.cfname {
	font-family: var(--rv-mono);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	direction: rtl;
	text-align: left;
	min-width: 0;
	flex: 1;
}
.cfrange {
	color: var(--rv-muted);
	white-space: nowrap;
	font-family: var(--rv-mono);
}
.cmini {
	border: 1px solid var(--rv-rule);
	background: var(--rv-card);
	border-radius: 7px;
	padding: 2px 8px;
	font-size: 12px;
	white-space: nowrap;
}
.cmini:hover {
	border-color: var(--rv-sea);
	color: var(--rv-sea);
}
.clines {
	overflow: auto;
	max-height: 420px;
}
.clines table {
	border-collapse: collapse;
	width: 100%;
	font: 12.5px/1.6 var(--rv-mono);
}
.clines td {
	padding: 0 10px;
	white-space: pre;
	vertical-align: top;
}
.clines td.n {
	width: 1%;
	text-align: right;
	color: var(--rv-muted);
	user-select: none;
	padding: 0 8px 0 10px;
}
.clines td.n button {
	border: 0;
	background: none;
	padding: 0;
	color: inherit;
	font: inherit;
}
.clines td.n button:hover {
	color: var(--rv-sea);
	text-decoration: underline;
}
.clines td.s {
	width: 1%;
	padding: 0 2px;
	user-select: none;
	color: var(--rv-muted);
}
.clines tr.add {
	background: var(--rv-add);
}
.clines tr.del {
	background: var(--rv-del);
}
.clines tr.foc td {
	background: var(--focus-line);
}
.clines tr.foc td.n {
	box-shadow: inset 3px 0 0 var(--rv-brass);
	color: var(--rv-ink);
	font-weight: 600;
}
.clines tr.hunk td {
	background: var(--rv-hunk);
	color: var(--rv-muted);
	font-size: 11.5px;
	padding: 2px 10px;
}
.tk-k {
	color: var(--tk-key);
}
.tk-s {
	color: var(--tk-str);
}
.tk-c {
	color: var(--tk-com);
	font-style: italic;
}
.tk-n {
	color: var(--tk-num);
}
.tk-f {
	color: var(--tk-fn);
}
.cgen {
	font: 12px var(--rv-mono);
	margin: 0 0 12px;
}
.cactions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	align-items: center;
	padding-top: 12px;
	border-top: 1px solid var(--rv-hair);
}
.cbtn {
	border: 1px solid var(--rv-rule);
	background: var(--rv-card);
	border-radius: 9px;
	padding: 7px 13px;
	font-weight: 500;
	font-size: 14px;
	display: inline-flex;
	gap: 8px;
	align-items: center;
}
.cbtn:hover {
	border-color: var(--rv-muted);
}
.cbtn.primary {
	background: var(--rv-navy);
	border-color: var(--rv-navy);
	color: var(--rv-on-navy);
}
.cbtn[disabled] {
	opacity: 0.55;
	cursor: default;
}
.cdecided {
	font-size: 13.5px;
	display: flex;
	flex-wrap: wrap;
	gap: 6px 10px;
	align-items: center;
}
.cpill {
	font-weight: 600;
	padding: 2px 10px;
	border-radius: 999px;
	border: 1px solid var(--rv-rule);
}
.cpill.accept {
	color: var(--v-lgtm);
}
.cpill.disagree {
	color: var(--v-ac);
}
.cpill.comment {
	color: var(--rv-sea);
}
.cqr {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin: 10px 0 0;
}
.cqr button {
	border: 1.5px solid var(--rv-sea);
	color: var(--rv-sea);
	background: transparent;
	border-radius: 999px;
	padding: 5px 14px;
	font-size: 14px;
	font-weight: 500;
	text-align: left;
}
.cqr button:hover:not([disabled]) {
	background: color-mix(in srgb, var(--rv-sea) 10%, transparent);
}
.cqr button.solid {
	background: var(--rv-navy);
	border-color: var(--rv-navy);
	color: var(--rv-on-navy);
}
.cqr button[disabled]:not(.solid) {
	opacity: 0.5;
	cursor: default;
}
.cform2 textarea,
.cbodytext {
	width: 100%;
	min-height: 76px;
	resize: vertical;
	border: 1px solid var(--rv-rule);
	border-radius: 9px;
	padding: 8px 11px;
	background: var(--rv-paper);
	color: var(--rv-ink);
	font: inherit;
}
.cform2 fieldset {
	border: 0;
	padding: 0;
	margin: 10px 0 0;
}
.cform2 legend {
	font-weight: 600;
	font-size: 14px;
	padding: 0;
	margin-bottom: 4px;
}
.cform2 legend span {
	font-weight: 400;
	color: var(--rv-muted);
	font-size: 12px;
	margin-left: 6px;
}
.copt {
	display: flex;
	gap: 8px;
	align-items: baseline;
	margin: 3px 0;
	font-size: 14px;
}
.cattach {
	display: block;
	margin: 12px 0 0;
}
.cattach input {
	margin-right: 6px;
}
.cattach .cdim {
	display: block;
	margin: 2px 0 0 22px;
	font-size: 12.5px;
}
.crow {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-top: 12px;
	align-items: center;
}
.cdtable {
	width: 100%;
	border-collapse: collapse;
	font-size: 13.5px;
	margin: 0 0 8px;
}
.cdtable td {
	padding: 5px 4px;
	border-top: 1px solid var(--rv-hair);
	vertical-align: top;
}
.cdtable td:last-child {
	text-align: right;
	white-space: nowrap;
	color: var(--rv-muted);
}
.cverdicts {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 8px;
	margin: 0 0 12px;
}
.cverdicts label {
	border: 1.5px solid var(--rv-rule);
	border-radius: 10px;
	padding: 9px 11px;
	display: grid;
	gap: 2px;
	cursor: pointer;
	font-size: 13px;
	color: var(--rv-muted);
	position: relative;
}
.cverdicts label b {
	color: var(--rv-ink);
	font-size: 14px;
}
.cverdicts input {
	position: absolute;
	opacity: 0;
}
.cverdicts label:has(input:checked) {
	border-color: var(--rv-navy);
	background: color-mix(in srgb, var(--rv-navy) 7%, transparent);
}
.cverdicts label:has(input:focus-visible) {
	outline: 2px solid var(--rv-sea);
	outline-offset: 2px;
}
.crec {
	font-size: 11px;
	font-weight: 600;
	color: var(--rv-brass);
	text-transform: uppercase;
	letter-spacing: 0.05em;
}
.cbodytext {
	min-height: 200px;
	font: 12.5px/1.55 var(--rv-mono);
}
.cposted {
	display: flex;
	gap: 12px;
	align-items: flex-start;
}
.cbadge {
	width: 36px;
	height: 36px;
	border-radius: 50%;
	display: grid;
	place-items: center;
	flex: none;
	color: var(--rv-card);
	font-weight: 700;
	background: var(--rv-sea);
}
.cbadge.APPROVE {
	background: var(--v-lgtm);
}
.cbadge.REQUEST_CHANGES {
	background: var(--v-security);
}
.cdetails {
	margin: 8px 0 0;
}
.cdetails summary {
	cursor: pointer;
	color: var(--rv-sea);
	font-size: 14px;
}
.creadme {
	max-height: 420px;
	overflow: auto;
}

/* The composer */
.ccompose {
	border-top: 1px solid var(--rv-hair);
	padding: 8px 24px calc(12px + env(safe-area-inset-bottom));
}
.cfollow {
	display: flex;
	gap: 6px;
	overflow-x: auto;
	padding: 2px 0 8px;
	scrollbar-width: none;
}
.cfollow::-webkit-scrollbar {
	display: none;
}
.cfollow button {
	flex: none;
	border: 1px solid var(--rv-rule);
	background: var(--rv-card);
	border-radius: 999px;
	padding: 5px 12px;
	font-size: 13px;
	white-space: nowrap;
}
.cfollow button:hover {
	border-color: var(--rv-sea);
	color: var(--rv-sea);
}
.cfollow button.lead {
	border-color: var(--rv-navy);
	font-weight: 500;
}
.cform {
	display: flex;
	gap: 8px;
	align-items: flex-end;
	background: var(--rv-card);
	border: 1px solid var(--rv-rule);
	border-radius: 14px;
	padding: 6px 6px 6px 14px;
}
.cform:focus-within {
	border-color: var(--rv-sea);
}
.cform textarea {
	flex: 1;
	border: 0;
	background: none;
	resize: none;
	padding: 6px 0;
	max-height: 140px;
	min-height: 24px;
	outline: none;
	font: inherit;
	color: var(--rv-ink);
	line-height: 1.5;
}
.csend {
	width: 36px;
	height: 36px;
	border-radius: 10px;
	border: 0;
	background: var(--rv-navy);
	color: var(--rv-on-navy);
	font-size: 18px;
	flex: none;
}
.cctx {
	font-size: 12px;
	color: var(--rv-muted);
	margin: 6px 2px 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.cctx b {
	font-weight: 500;
	color: var(--rv-ink);
}

/* ---------- the file drawer ---------- */
.cdrawer {
	background: var(--rv-card);
	border-left: 1px solid var(--rv-rule);
	display: flex;
	flex-direction: column;
	min-height: 0;
	min-width: 0;
	overflow: hidden;
}
.cdrawer-head {
	padding: 10px 12px 0 16px;
	border-bottom: 1px solid var(--rv-hair);
}
.cdrawer-top {
	display: flex;
	gap: 8px;
	align-items: center;
	min-width: 0;
}
.cdrawer-path {
	font: 12.5px var(--rv-mono);
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	direction: rtl;
	text-align: left;
}
.cicon {
	width: 32px;
	height: 32px;
	border-radius: 8px;
	border: 1px solid var(--rv-rule);
	background: var(--rv-card);
	display: grid;
	place-items: center;
	flex: none;
	text-decoration: none;
	color: var(--rv-ink);
}
.cdrawer-sub {
	display: flex;
	gap: 10px;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	margin: 6px 0 8px;
}
.cdrawer-meta {
	font: 12px var(--rv-mono);
}
.cdrawer-cards {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	padding: 0 0 8px;
	max-height: 92px;
	overflow-y: auto;
}
.cdrawer .clines {
	max-height: none;
	flex: 1;
}

/* ---------- the quick switcher ---------- */
.cswitch {
	position: fixed;
	inset: 0;
	background: rgb(15 22 30 / 40%);
	display: none;
	align-items: flex-start;
	justify-content: center;
	padding: 12vh 16px 16px;
	z-index: 60;
}
.cswitch.open {
	display: flex;
}
.csw {
	width: min(620px, 100%);
	background: var(--rv-card);
	border: 1px solid var(--rv-rule);
	border-radius: 14px;
	box-shadow: var(--rv-shadow);
	overflow: hidden;
	display: flex;
	flex-direction: column;
	max-height: 70vh;
}
.csw input {
	border: 0;
	border-bottom: 1px solid var(--rv-hair);
	padding: 14px 16px;
	font: 16px var(--rv-sans);
	background: none;
	color: var(--rv-ink);
	outline: none;
}
.csw ul {
	list-style: none;
	margin: 0;
	padding: 6px;
	overflow-y: auto;
}
.csw li button {
	width: 100%;
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	gap: 2px 10px;
	text-align: left;
	background: none;
	border: 0;
	border-radius: 8px;
	padding: 7px 10px;
}
.csw li button[aria-selected='true'] {
	background: color-mix(in srgb, var(--rv-sea) 12%, transparent);
}
.swn {
	font: 13px var(--rv-mono);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.swn.sans {
	font-family: var(--rv-sans);
}
.swn mark {
	background: color-mix(in srgb, var(--rv-brass) 25%, transparent);
	color: inherit;
	border-radius: 2px;
}
.swd {
	font: 12px var(--rv-mono);
	color: var(--rv-muted);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.sws {
	grid-row: 1 / 3;
	grid-column: 2;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 3px;
	font: 11px var(--rv-mono);
}
.sws .cdots {
	margin-top: 0;
}
.csw-foot {
	border-top: 1px solid var(--rv-hair);
	padding: 8px 14px;
	font-size: 12px;
	color: var(--rv-muted);
	display: flex;
	gap: 14px;
	flex-wrap: wrap;
}
.cscrim {
	display: none;
}

/* ---------- narrower: the file drawer, then the navigator, slide over the chat ---------- */
/* A tab beside the host's own menu is narrower than a page, so the navigator stays down to 860px. */
@container (max-width: 1100px) {
	.chatapp.drawer-open .clayout {
		grid-template-columns: var(--navw) minmax(0, 1fr) 0;
	}
	.cdrawer {
		position: fixed;
		top: 0;
		bottom: 0;
		right: 0;
		width: min(620px, 100cqw);
		z-index: 45;
		transform: translateX(102%);
		transition: transform 0.22s ease;
		box-shadow: var(--rv-shadow);
	}
	.chatapp.drawer-open .cdrawer {
		transform: none;
	}
	.chatapp.drawer-open .cscrim {
		display: block;
		position: fixed;
		inset: 0;
		background: rgb(15 22 30 / 30%);
		z-index: 35;
	}
}
@container (max-width: 860px) {
	.clayout,
	.chatapp.drawer-open .clayout {
		grid-template-columns: minmax(0, 1fr);
	}
	.only-narrow {
		display: inline-flex !important;
	}
	.cnav {
		position: fixed;
		top: 0;
		bottom: 0;
		left: 0;
		width: min(330px, 88cqw);
		z-index: 40;
		transform: translateX(-102%);
		transition: transform 0.22s ease;
		box-shadow: var(--rv-shadow);
	}
	.chatapp.nav-open .cnav {
		transform: none;
	}
	.chatapp.nav-open .cscrim {
		display: block;
		position: fixed;
		inset: 0;
		background: rgb(15 22 30 / 30%);
		z-index: 35;
	}
}
@container (max-width: 640px) {
	.hide-phone {
		display: none !important;
	}
	.cbar {
		gap: 8px;
	}
	.ctrack {
		width: 44px;
	}
	.cstream {
		padding: 16px 12px 8px;
	}
	.ccompose {
		padding: 6px 12px calc(10px + env(safe-area-inset-bottom));
	}
	.cav {
		width: 26px;
		height: 26px;
		border-radius: 8px;
	}
	.cmsg {
		gap: 8px;
	}
	.ccard {
		padding: 13px;
		border-radius: 12px;
	}
	.change h3 {
		font-size: 20px;
	}
	.cov h2 {
		font-size: 22px;
	}
	.cverdicts {
		grid-template-columns: minmax(0, 1fr);
	}
	.cchecks li {
		grid-template-columns: 22px minmax(0, 1fr);
	}
	.cchecks .crefs {
		grid-column: 2;
		justify-content: flex-start;
		max-width: none;
	}
	.cdrawer-cards {
		flex-wrap: nowrap;
		overflow-x: auto;
	}
	.cdrawer-cards .cref {
		flex: none;
	}
}
`;
