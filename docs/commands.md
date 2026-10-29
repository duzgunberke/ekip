<h1><img src="brand/logo-mark.svg" width="40" height="40" alt="" style="vertical-align: middle"> Commands and pools</h1>

Use the CLI reference below to launch the lead, manage workers and projects, and control the optional hub.

[README](../README.md) · [How it works](architecture.md) · [Memory](memory.md) · [Install](install.md) · **Commands** · [Operations](operations.md)

## CLI help

These command groups and usage forms match `EKIP_LANG=en node plugin/bin/ekip.js help`.

```text
Everyday
  ekip
  ekip --free
  ekip --safe
  ekip status
  ekip limits
  ekip doctor [--fix]

Workers
  ekip run [--via POOL|a,b,c] [--project NAME] [--model ID] [--plugin P] [--skill S] "task"
  ekip clean <id>
  ekip agents ls|install|login|test
  ekip team up|down|ls|open [--open]

Development environment
  ekip dev init --postgres <uuid> [--superuser NAME] [--secrets FILE] [--redis <uuid>] | ls|add|up|env|down|reset|sql|psql

Projects and memory
  ekip project add|remove|scan|ls|show|sync|card
  ekip memory search|remember|ingest|import-history|reindex|up|down|status|open
  ekip skill ls|search|show <project> [query|name]

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

`ekip run` sends a worker brief; the task can be read from standard input with `-`. Use a comma-separated `--via` list to run the same work in separate worktrees and branches. `ekip reconcile` closes runs whose process disappeared without reporting.

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
