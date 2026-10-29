# ekip

ekip turns one Claude Code session into a team lead: Claude plans and reviews, and the work runs on
worker agents with their own quotas (Antigravity, Codex, Copilot, Qwen, OpenCode, grok, free
models). Every registered project has its own memory, wiki, code graph and skills.

Most people clone this repo and tell Claude "set it up". They have not read the docs. This file
is for you, Claude, so you can do the setup well and explain ekip in a few sentences.

## When the user asks to install or set up ekip

1. **Check prerequisites** and say plainly what is missing: macOS, Node 22+ (`node -v`), Docker
   running (`docker info`), Claude Code, git. iTerm2 is recommended (live task pane next to the
   lead); `brew install terminal-notifier` gives notifications with the ekip logo.
2. **Run the setup:** `node plugin/bin/ekip.js init`. It installs the services (free model pool,
   memory), the plugin, the MCP servers and the worker CLIs, and links `ekip` on the PATH.
3. **Steps only the user can do** (interactive, so ask them to run these with `!` in front):
   - `ekip keys` opens each free model provider's key page; they paste the keys.
   - `ekip agents login` signs in to the worker CLIs they have accounts for. Two or more pools make
     ekip useful.
4. **Register their projects:** `ekip project add <folder>` for each project they work on (or
   `ekip project scan <parent folder>`). This builds the project card, code graph, wiki and memory,
   and imports their past Claude sessions for that project.
5. **Check:** `ekip doctor`, then show the setup gaps it prints and fix what you can.
6. **Explain in five lines,** not more:
   - From now on they start `ekip` instead of `claude`; they talk to it exactly as before.
   - The lead splits the work and hands it to workers on other quotas; Claude's limit goes to
     planning and review.
   - Progress shows in a pane under the session and on the web panel (if a hub is linked).
   - Every worker starts from the project's memory, wiki, code graph and skills.
   - `ekip help` lists everything; `ekip update` brings new releases.

Optional, offer once: a VPS hub (`docs/install.md`) keeps memory, the free pool and a job queue
running while the Mac is off, and serves the web panel.

## When the user works on ekip's own code

- Read `CONTRIBUTING.md`. This repository is public: never write personal project names, hosts,
  domains, ids or tokens into code, docs or examples; personal values go into `data/config.json`
  at runtime. Run `bash scripts/privacy-check.sh` before committing.
- `node --check` every touched file. User-facing CLI strings are Turkish source strings passed
  through `t()` with an English entry in `plugin/lib/core/i18n.js`.
- ekip may be running from this checkout: give workers that edit it `ekip run --worktree`, so a
  half-finished edit cannot break the running lead, panes or hooks.
- Update `README.md`, `README.tr.md` and `docs/` when behaviour changes; keep the README's
  structure.
- Work on a branch (`feat/…`, `fix/…`), merge into `main` when checks pass; a passing merge is
  released automatically (see `CONTRIBUTING.md`). Never tag or bump versions by hand.
