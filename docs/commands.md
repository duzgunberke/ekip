<h1><img src="brand/logo-mark.svg" width="40" height="40" alt="" style="vertical-align: middle"> Commands and pools</h1>

Use the CLI reference below to launch the lead, manage workers and projects, and control the optional hub.

[README](../README.md) · [How it works](architecture.md) · [Memory](memory.md) · [Install](install.md) · **Commands** · [Operations](operations.md)

## CLI help

The command groups below match `EKIP_LANG=en node plugin/bin/ekip.js help`. Options are included where they materially change behavior.

```text
Everyday
  ekip
  ekip --free
  ekip --safe
  ekip status
  ekip limits
  ekip doctor [--fix]

Workers
  ekip run [--via POOL|a,b,c] [--project NAME] [--model ID] [--plugin P] [--skill S] [--worktree] "task"
  ekip review [--project NAME] [--base REF] [--checks-only] [--via a,b] [--dry-run]
  ekip review profile NAME [--refresh]
  ekip clean <id>
  ekip agents ls|install|login|test
  ekip team up|down|ls|open [--open]

Development environment
  ekip dev init --postgres <uuid> [--superuser NAME] [--secrets FILE] [--redis <uuid>]
  ekip dev ls|add|up|env|down|reset|sql|psql

Projects and memory
  ekip project add|remove|move|scan|ls|show|sync|card
  ekip memory search|remember|ingest|import-history|reindex|up|down|status|open
  ekip skill ls|search|show|learn|prune|candidates|accept|reject
  ekip tasks [--watch|--all]
  ekip task new|step|add|note|done|fail|cancel
  ekip tasks sync

VPS hub
  ekip job "task" --project NAME [--via auto|copilot|free] | ls | show ID
  ekip hub link|push|status|open
  ekip remote <ssh-host>
  ekip tunnel install|status
  ekip vps add|token|status|sh|apps|deploy|logs|restart

Setup
  ekip init
  ekip keys [--all|apply]
  ekip key add|list
  ekip up|down|logs
```

### Worker runs and review

`ekip run` sends a worker brief; use `-` to read it from standard input. `--via auto` chooses among tested, eligible pools. A comma-separated list such as `--via agy,codex` races workers in separate Git worktrees and branches. `--worktree` gives one worker its own worktree. Child runs are capped; `--allow-nested` is an internal override for bounded nested work, not a general way to remove the cap.

`ekip review` reviews the current changes with project profile lenses and configured checks. `--dry-run` prints the plan without running checks or reviewers; `--checks-only` skips reviewer runs. `--via` selects review pools. `ekip review profile NAME [--refresh]` creates or refreshes a registered project's profile. Review check commands pass through a safety filter.

### Tasks and liveness

`ekip tasks` lists live tasks; `--watch` follows updates and `--all` includes closed tasks. The lead creates and updates tasks with `ekip task new`, `step`, `add`, `note`, `done`, `fail`, and `cancel`. A step can be marked `running`, `done`, `failed`, or `skipped`; `--pct`, `--note`, `--detail`, `--parallel`, and `--alive` provide progress context. `--alive` refreshes liveness during a long step. `ekip tasks sync` resends task state to the hub if the panel is stale. `ekip reconcile` closes runs whose processes disappeared without reporting.

### Development databases

`ekip dev init --postgres UUID [--superuser NAME] [--secrets FILE] [--redis UUID]` configures shared development resources. Per-project operations are `ls`, `add`, `up`, `env`, `down`, `reset`, `sql`, and `psql`. `up` creates a project `.env.ekip-dev` and opens a tunnel. `reset` requires `--yes`. Production database targets are refused.

### Skills and projects

`ekip skill learn [PROJECT|--all] [--dry-run]` proposes reusable project procedures. `candidates` lists them; `accept PROJECT NAME` and `reject PROJECT NAME` record an explicit decision. `prune [PROJECT|--all] [--apply]` checks stale generated skills. `ls`, `search`, and `show` inspect skills.

`ekip project add PATH`, `remove NAME`, and `move NAME OLD_PATH NEW_PATH [--dry-run]` manage registration. `scan`, `ls`, `show`, `sync`, and `card` discover or inspect projects and refresh their context.

<img src="screenshots/terminal-help.png" alt="Terminal help showing ekip's command groups and options" width="100%">

## Worker pools

| Pool | Worker | Quota or route |
|---|---|---|
| `auto` | First eligible worker in the learned order, then `free` | Tested and available workers; limited pools are skipped |
| `agy` | Antigravity | Google account quota |
| `codex` | OpenAI Codex CLI | ChatGPT plan |
| `gemini` | Gemini CLI | `GEMINI_API_KEY`; hidden unless configured |
| `copilot` | GitHub Copilot CLI | Copilot free tier or plan |
| `qwen` | Qwen Code | Qwen OAuth, or freellmapi until signed in |
| `opencode` | OpenCode | Its free models or configured providers |
| `grok` | grok-cli | freellmapi, or xAI with `GROK_API_KEY` |
| `free` | Free-pool route | freellmapi free-tier models |
| `claude` | Headless Claude | Claude subscription; reserve for work that needs it |

`auto` is based on configured order, recent pool success rates, and a 15-minute cooldown after failures. `ekip limits` shows the next worker, quota resets, provider availability, and model routes.

<img src="screenshots/terminal-limits.png" alt="Terminal limits report with worker pools, provider availability, and current route" width="100%">

## Development databases

Run `ekip dev init --postgres <uuid> [--superuser NAME] [--secrets FILE] [--redis <uuid>]` once to record the shared development Postgres container. These values stay in `data/config.json`. Use `ekip dev add PROJECT [--db NAME]` to map a project to an isolated `_dev` database; `ekip dev up [PROJECT]` opens the local SSH tunnel and writes `.env.ekip-dev` at the registered project root. Workers should source that file and never use production URLs from project `.env` files for tests or migrations. Use `ekip dev reset PROJECT --yes` for a development reset and `ekip dev down` when finished. `ekip dev env PROJECT --shell` prints shell exports; passwords are masked by default. For quick queries, run `ekip dev sql PROJECT "..."`.

Hub jobs currently run in the VPS worker without the Mac settings bridge. To supply dev credentials there, persist the dev project map and Redis/Postgres UUIDs in hub configuration, then call `devEnv(PROJECT, { onVps: true })` before spawning the worker so URLs use the Coolify container IPs directly. Do not pass production resource UUIDs or URLs.

## Shared tools

ekip's own services live outside project repositories: freellmapi (free pool), TencentDB Agent Memory (memory) and hoptell (team peers). `ekip init` clones each one once; their locations are stored in `data/config.json` (`freellmapiDir`, `tdaiDir`, `hoptellDir`), and every project uses the same installation.

---

[← Back to README](../README.md) · Next: [Operations](operations.md)
