# pr-review-wheelhouse

A [Wheelhouse](https://github.com/chrisjowen/wheelhouse) plugin that adds a **PR review** tab to each project. Point it at a pull request and it walks you through the review in stages instead of handing you the whole list of changed files at once:

1. **Walkthrough**: what the PR does and why, the screenshots and evidence from its description, its checks, where the changed files went, and the reading plan.
2. **Quality pass**: readability and structure only (nesting, long functions, duplication, names). Keep a finding to send it as a suggestion, or dismiss it.
3. **Stops**: the important changes, one to three files at a time, with the reviewer's notes pinned above the lines they discuss, a complexity rating, alternative approaches and its pick.
4. **Skim pile**: everything else, one line and a risk level each. Generated files (build output, lockfiles, snapshots) stay hidden.

A chat sits beside the code at every stage. It opens each stage with the reviewer's take and a few questions you might ask. You can click line numbers to attach lines to a question, or switch it to **Request change** to pin a change request under a line. **Finish review** suggests a verdict from your notes and drafts the review. From there you can post it to GitHub, or send the change requests to Firstmate. Nothing is posted or sent until you click.

The reviewer is Claude by default, run through Claude Code's headless mode. A local model through [Ollama](https://ollama.com) is the other choice (see [Settings](#settings)).

## Install

```sh
wheelhouse plugin install chrisjowen/pr-review-wheelhouse
```

Or use **Settings → Plugins → Install plugin** with `chrisjowen/pr-review-wheelhouse`. The plugin is off until you turn it on in **Settings → Plugins → PR review**, for every project or only some. Each project then gets a **PR review** tab at `/projects/<project>/pr-review/review`.

You need:

- `gh`, signed in (`gh auth login`), to read pull requests and to post reviews;
- [Claude Code](https://claude.com/claude-code) (`claude`), signed in, for the default reviewer; or Ollama with a model pulled (`ollama pull qwen2.5:7b`) if you choose Ollama.

## Using it

The tab lists the project's open pull requests and takes any GitHub PR URL. Nothing is read or reviewed until you click Review. The tab reopens the review you had open last, as the engine kept it, without reading the PR again; **Check for new commits** reads it again with `gh`. `?pr=<number or URL>` on the tab's address does the same for a PR the engine already keeps; any other PR waits in the URL box for your click.

The first time, the tab asks you to **Start the engine**. The engine is the plugin's companion service, a small server on `127.0.0.1` that does the slow work: reading the PR, the reviewer's passes, the chat, and posting. Wheelhouse starts it only on that click. It keeps running after Wheelhouse stops, and it opens a tab that closes itself.

Opening a PR reads it with `gh` (description, commits, checks and diff), sorts the changed files, and runs the walkthrough. The walkthrough proposes the stops. The plugin holds that proposal to the real file list, so the reviewer can't hide a source file as "generated", put a test or doc in a stop, or leave the biggest change out. The other stages then run one at a time behind the walkthrough, and the stage you are looking at goes first. A review is kept per PR head, so reopening a PR costs nothing, and a new push starts a fresh review.

Move between stages with the passage on the left, **Mark reviewed, next stop**, or the `[` and `]` keys. Each stage has **Read again**, which runs it again with the prompts as they are now.

### Finishing

**Finish review** shows what you asked for and suggests a verdict: _Request changes_ once you have asked for any change, _Comment_ when you have kept only suggestions, _Approve_ otherwise. The draft is editable.

- **Post to GitHub** asks you to confirm. It then posts a pull request review on the head you reviewed. Change requests and kept suggestions that sit inside one hunk of the diff become inline comments; the rest go in the summary with their file and lines. GitHub doesn't let you approve or request changes on your own PR, and the tab says so; post it as a comment instead.
- **Send to Firstmate** shows the message: the PR's URL, then each change with its file and lines. **Open in Firstmate's chat** puts it in Wheelhouse's chat box, the same handoff the GitHub issues plugin uses. Nothing is sent until you send it there.
- **Copy review** copies the summary and comments.

### Prompts

**Prompts** opens the overall review prompt and the four stage prompts (walkthrough, quality pass, stops, skim pile). They are saved for every review as you type. Each pass gets the overall prompt first, then its stage's prompt, then only that stage's context, then a fixed description of the JSON to answer with. That last part isn't editable, so a reworded prompt can't break how the answer is read.

## Settings

Change these in **Settings → Plugins → PR review**, or under `plugins["pr-review"].settings` in Wheelhouse's `plugins.json`. The tab hands them to the engine as it connects, so they apply without restarting the engine.

| Setting                 | Key             | Default                  | What it does                                                                                          |
| ----------------------- | --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Reviewer                | `backend`       | `claude`                 | `claude`: Claude through Claude Code. `ollama`: a local model through Ollama.                         |
| Claude model            | `claudeModel`   | `sonnet`                 | The model Claude Code reviews with, such as `sonnet`, `opus` or a full model id.                      |
| Ollama model            | `ollamaModel`   | `qwen2.5:7b`             | The Ollama model each stage runs on, when the reviewer is Ollama.                                     |
| Ollama address          | `ollamaUrl`     | `http://127.0.0.1:11434` | Where Ollama answers.                                                                                 |
| Context window (tokens) | `contextTokens` | `16384`                  | How much an Ollama model reads at once (Ollama's own default, 2048, is too small for a stage's diff). |

### How Claude runs

The default reviewer is `claude -p`, Claude Code's non-interactive mode. It runs once per stage and once per chat answer, and loads none of your own setup:

- `--setting-sources ""`, so none of your user, project or local settings load;
- `--settings` with this plugin's own [`claude-settings.json`](wheelhouse/engine/claude-settings.json), which turns every hook off;
- `--tools ""`, `--strict-mcp-config` and `--disable-slash-commands`, so it has no tools, no MCP servers and no skills, and can only answer;
- `--no-session-persistence`, so no session is saved;
- it runs from the engine's own empty directory, with `FM_NO_LOCK=1`, so it never picks up Firstmate's hooks or lock.

It uses the sign-in Claude Code already has. A Wheelhouse that runs with its own `CLAUDE_CONFIG_DIR` can point the reviewer at another one with `PR_REVIEW_CLAUDE_CONFIG_DIR`; `default` means Claude Code's default.

### A local model instead

With `backend` set to `ollama`, each stage is one Ollama `/api/chat` call. A 7B model such as `qwen2.5:7b` is usable but generic: it takes 20 to 45 seconds a stage on an Apple-silicon Mac, and it is weak at grouping files from a raw diff. That is why the walkthrough reads a manifest of the files (names, kinds and sizes) rather than the diff, and why the plugin checks its grouping.

## What it reads and writes

The Wheelhouse side is read-only. Its provider runs one `gh pr list` in the project's clone to list the open pull requests.

The engine:

- reads with `gh pr view` and `gh pr diff`;
- posts with `gh api -X POST repos/<owner>/<repo>/pulls/<n>/reviews`, only from **Post to GitHub** after you confirm;
- keeps your prompts and one file per review in its state directory: `$PR_REVIEW_STATE_DIR`, else `$XDG_STATE_HOME/pr-review-wheelhouse`, else `~/.local/state/pr-review-wheelhouse`.

It answers only on `127.0.0.1`, and only requests that name this computer as their host. A request from a page must come from a page on this computer, and a request that changes anything must carry a header that a plain form from another site can't send.

## Development

```sh
npm install
npm run lint   # eslint and prettier
npm test       # node --test
npm run engine -- --port 4791   # the engine on its own
```

The plugin has no runtime dependencies and no build step. Wheelhouse imports `wheelhouse/server/index.js` and serves `wheelhouse/ui/` to the page as is.

- `.wheelhouse-plugin/plugin.json`: the manifest.
- `wheelhouse/server/index.js`: the open-PRs provider, the tab and the engine service.
- `wheelhouse/engine/`: the engine.
  - `main.js` and `http.js`: the server.
  - `review.js`: the review sessions and the one-at-a-time queue.
  - `stages.js` and `classify.js`: grouping the files into stages.
  - `prompts.js`: assembling the prompts and reading the answers.
  - `model.js`: the reviewer, Claude Code or Ollama, behind one interface.
  - `github.js`: `gh`.
  - `diff.js`: reading the diff.
- `wheelhouse/ui/`: the `pr-review-tab` element.
  - `draft.js`: drafting the GitHub review and the Firstmate message, shared with the engine.

The tests use a fake `gh`, a fake model and a fake `claude`, so they need none of the three installed.

## Licence

MIT
