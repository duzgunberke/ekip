# Commands and pools


Every command, every worker pool.



[← back to the README](../README.md)


## Commands

```bash
# daily
ekip                         # the lead session (your subscription); it dispatches by itself
ekip --free                  # the lead on free models, when your Claude limit is out
ekip status                  # pools, memory, panel, team, last runs
ekip limits                  # what is limited, where a new task would go
ekip doctor [--fix]          # check (and repair) everything
ekip tasks [--watch|--all]   # the task list the panes and panel show

# workers
ekip run [--via POOL|a,b,c] [--project NAME|--cwd DIR] [--model ID] [--plugin P] [--skill S] [--task ID --label L] "task"
ekip clean <id>              # worktrees of a multi-pool run
ekip reconcile               # close runs whose process vanished
ekip agents ls|install|login|test

# projects and memory
ekip project add|scan|ls|show|sync|card
ekip memory search|remember|ingest|import-history|reindex|up|down|status|open
ekip skill ls|search|show <project> [query|name]

# hub
ekip job "task" --project NAME [--via auto|copilot|free] | job ls | job show ID
ekip hub link|push|status|open   ·   ekip remote <host>   ·   ekip tunnel install|status
ekip vps add|token|status|sh|apps|deploy|logs|restart     # SSH + Coolify API

# setup
ekip init · ekip keys [--all|apply] · ekip key add|list · ekip up|down|logs
```

## Pools

| `--via` | what | quota |
|---|---|---|
| `agy` | Antigravity CLI | your Google account |
| `codex` | OpenAI Codex CLI | your ChatGPT plan (works on the free plan with lower limits) |
| `copilot` | GitHub Copilot CLI | Copilot free tier or plan |
| `qwen` | Qwen Code | the free pool, or your Qwen account |
| `opencode` | OpenCode | its free models, or your providers |
| `grok` | grok-cli | the free pool, or xAI with `GROK_API_KEY` |
| `gemini` | Gemini CLI | `GEMINI_API_KEY` (the personal free tier is Antigravity now) |
| `free` | Claude Code `--bare` on the free pool, through the memory proxy for registered projects | free pool |
| `claude` | headless Claude with your skills and plugins | your subscription; last resort |
| `auto` | the first ready, unlimited pool in the ranked order, then `free` | |

`--plugin` / `--skill` work with every pool: Claude workers load them, the others are told to read and
follow the skill's `SKILL.md`. Example: `--via copilot --plugin lemo-opuscar` directs a film.

Inside the lead, two Claude subagents keep its own context small: `scout` (Haiku, read-only) finds
code and facts, `implementer` (Sonnet) does a coding step that needs the session's tools.

## Shared tools

Third-party tools used by more than one project live in one shared `tools/` folder next to your projects, never inside a project: freellmapi, TencentDB Agent Memory, hoptell, earshot (sound for
code-made films, also an MCP server), ACE-Step (music), img2threejs. The paths are in
`data/config.json` (`freellmapiDir`, `tdaiDir`, `hoptellDir`).
