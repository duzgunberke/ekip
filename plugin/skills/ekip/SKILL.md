---
name: ekip
description: Lead a team of worker agents on other quotas (Antigravity/agy, Codex, Copilot, Qwen, OpenCode, Grok, pooled free-tier models, or a headless Claude), with each registered project's card, memory, LLM wiki and code graph, and a VPS hub that keeps working when the Mac is off. Use when a task splits into well-scoped parts, when the user asks to delegate, parallelize, "ekibe dağıt", compare models, save Claude limits, queue work on the VPS, work in one of their registered projects, or manage the VPS/Coolify; also for ekip setup and status.
---

# ekip: lead a team on other quotas

The user has Claude Max and wants your effort spent on judgment: understanding the request, design,
splitting the work, integration and review. Everything well-scoped goes to workers through the CLI
`ekip`, which is on PATH. If it is not, use `${CLAUDE_PLUGIN_ROOT}/bin/ekip.js`.

## Pools: `ekip run --via ...`

| --via | what | use for |
|---|---|---|
| `auto` (default) | first usable of the tested agents, then `free` | most delegated work |
| `agy` | Antigravity (strong models, Google quota) | substantial coding, research |
| `codex`, `copilot`, `qwen`, `opencode` | other vendors' CLIs on their own accounts | same work, with a different model family |
| `grok`, `free` | harnesses on pooled free-tier models (freellmapi) | small, precise, mechanical tasks |
| `claude` | headless Claude on the subscription | last resort: only after another pool failed at the task, or when the user asks |

`ekip agents` shows which pools are installed and tested.

```bash
ekip run [--via POOL|a,b,c] [--project NAME | --cwd DIR] [--model ID] [--plugin NAME] [--skill NAME] "brief"
ekip run --via agy --project my-app - <<'EOF'
long brief...
EOF
```

**Options**

- `--project NAME` works in a registered project. It sets the folder, and free workers get that project's memory through the memory proxy.
- `--plugin NAME` or `--skill NAME` works with every pool. Claude workers load it; agy, copilot and the other agents are told to read and follow its SKILL.md. Examples: `--via agy --plugin lemo-opuscar` for films, `--skill blender-modeling` for Blender.
- Choosing a pool: the user's Claude limit is the scarce resource. Use agy or copilot for real work, and qwen, opencode, grok or free for light work. Skill-heavy work also goes to agy or copilot first.
- `--via agy,codex,free` puts several models on the same task. Each one works in its own git worktree and branch, and you get each diffstat and report. Compare them, `git merge` the best branch, then run `ekip clean <id>`. Use this when quality matters or the approach is uncertain.

**How to delegate**

- Workers are headless: they have full file and shell access, cannot ask questions, and print a final report.
- Brief each one like a capable colleague with no context: the goal, the files, the constraints, how to verify, and what to report back.
- Run independent workers in parallel with Bash `run_in_background`; you are notified when each one exits.
- Never put two concurrent workers on the same files unless they use worktrees.
- Review every result (`git diff`, the tests) before you report it to the user.

## Projects, memory, wiki, code graph

- `ekip project ls` and `ekip project show NAME` show the registered projects and their cards: stack, commands, frequent tasks and gotchas.
- The **ekip MCP** tools give per-project access:
  - `memory_search` and `memory_remember` for memory;
  - `wiki_search` and `wiki_read` for the LLM wiki built from the project's docs and notes;
  - `code_graph` for the TencentDB code graph.
- The **codegraph** MCP explores the local code index.
- Prefer these tools over reading many files: they cost far fewer tokens.
- When you learn a durable fact (a decision, a constraint, a "don't touch X"), save it with `memory_remember`.

## The VPS hub (keeps working when the Mac is off)

- `ekip job "<task>" --project NAME` queues a job on the hub. A free worker clones the repo, works on the branch `ekip/job-<id>`, pushes it, and the hub keeps the report.
- `ekip job ls` lists jobs and `ekip job show ID` shows one.
- The panel is at the hub URL set with `ekip hub link` (`ekip hub open` opens it). It shows projects, jobs, runs from the Mac and the pool status.
- `ekip vps sh "<cmd>"` runs a command on the server over SSH.
- `ekip vps apps|deploy|logs|restart <app>` uses the Coolify API.

## Long-lived peers (hoptell)

- `ekip team up --open` starts `ekip-agy` and `ekip-free` as hoptell peers, each in its own terminal window.
- Message them with the hoptell `send_message` tool and wait for the reply with `wait_for_message`.
- `ekip team ls` shows which members are running; `ekip team down` stops them.

## Setup and pool management (when the user asks)

- `ekip init` is the one-time setup. `ekip status` shows the overall state.
- Keys and logins:
  - `ekip keys` opens each free provider's key page so the user can paste a key.
  - `ekip agents login` signs in to codex, qwen and the other CLIs.
  - These are interactive, so the user runs them in their own terminal.
- When the Claude limit is out, the user can run `ekip --free`: the lead itself then runs on free models.


## Development databases

When a task needs a database or Redis in a registered project, run `ekip dev ls`, then `ekip dev up PROJECT`. This writes `PROJECT_ROOT/.env.ekip-dev` and opens the tunnel. Workers load it with:

```bash
set -a; source .env.ekip-dev; set +a
```

Never use production URLs from a project's `.env` for tests or migrations. Run `ekip dev add PROJECT` for a new project, `ekip dev reset PROJECT --yes` instead of hand-dropping data, and `ekip dev sql PROJECT "..."` for quick queries. Run `ekip dev down` when done. If `ekip dev` says it is not initialised, tell the user to run `ekip dev init`.

## Review

Run `ekip review --project NAME` to check and review project changes. Add `--dry-run` to preview checks, `--checks-only` to run checks without reviews, and use `ekip review profile NAME --refresh` to regenerate the project's review profile.

## Skills

- [ekip-delegate](../ekip-delegate/SKILL.md): split requests and dispatch reviewable worker briefs.
- [ekip-project-context](../ekip-project-context/SKILL.md): load a registered project's process, memory, wiki, graph, and card.
- [ekip-tasks](../ekip-tasks/SKILL.md): keep task steps and panel state current.
- [ekip-stuck-work](../ekip-stuck-work/SKILL.md): diagnose stalled work and prevent repeat failures.
- [ekip-review](../ekip-review/SKILL.md): run and interpret project checks and two reviews.
- [ekip-skills](../ekip-skills/SKILL.md): learn, curate, and write project procedures.
- [ekip-dev-env](../ekip-dev-env/SKILL.md): use safe development databases and environments.
- [ekip-projects](../ekip-projects/SKILL.md): register, refresh, relocate, and remove projects.
- [ekip-hub-ops](../ekip-hub-ops/SKILL.md): operate and diagnose the optional VPS hub.
- [ekip-setup](../ekip-setup/SKILL.md): set up ekip from a clone and close setup gaps.
