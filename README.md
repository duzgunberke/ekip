# ekip

**One terminal, one Claude, a whole team.**

You talk to a single Claude Code session, the *lead*. It spends your Claude limit on judgment:
understanding the request, design, splitting the work and reviewing the results. The work itself
goes to agents on **other quotas**: Antigravity, Codex, Copilot, Qwen, OpenCode, Grok, pooled
free-tier models, or a headless Claude when a task really needs it.

Every project you work on is indexed:

- a **card**: what it is, the stack, commands, frequent tasks, gotchas
- an **LLM wiki** built from its docs and notes
- **code graphs**: a local one, plus one built from its GitHub repo
- a **memory** in a vector DB, fed by your sessions

Agents get exactly the context they need instead of re-reading the repo, so far fewer tokens go
into reading.

An always-on **hub** on your VPS keeps queued jobs running when your Mac is off. It also serves a web
panel with your projects, jobs, runs, pools and links to your other dashboards.

```
 Mac                                                       VPS hub (https://ai.sazora.io)
 ┌──────────────────────────────────────────┐   SSH       ┌───────────────────────────────────────────┐
 │ ekip ─ lead Claude (your plan)           │   tunnel    │ panel + API + job queue (ekip-hub)        │
 │  ├ ekip run --via agy|codex|copilot|…    │ ──────────► │ freellmapi: free tiers of 30+ providers   │
 │  ├ ekip run --via agy,codex,free  (race) │  same       │ TencentDB Agent Memory:                   │
 │  ├ ekip job "…" --project X  (VPS queue) │  localhost  │   memory (vector DB), LLM wiki,           │
 │  ├ ekip team up --open  (hoptell peers)  │  ports      │   code graph from GitHub, memory proxy    │
 │  └ MCP: ekip (memory/wiki/graph),        │             │ workers: clone → branch → claude → push   │
 │         codegraph (local index)          │             └───────────────────────────────────────────┘
 │ hooks: project card + memories at        │
 │        session start; sessions → memory  │
 └──────────────────────────────────────────┘
```

ekip connects these open-source projects. It clones them; it does not fork them:

| project | role |
|---|---|
| [freellmapi](https://github.com/tashfeenahmed/freellmapi) | one local endpoint over many providers' free tiers, with failover |
| [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | memory, skills, LLM wiki (after [Karpathy's idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)), code graph, memory proxy |
| [codegraph](https://github.com/colbymchenry/codegraph) | local code index with an MCP server |
| [hoptell](https://github.com/EminUZUN/hoptell) | agent-to-agent messages; long-lived peers in tmux |
| agent CLIs | [Antigravity](https://antigravity.google), [Codex](https://github.com/openai/codex), [Copilot CLI](https://github.com/github/copilot-cli), [Qwen Code](https://github.com/QwenLM/qwen-code), [OpenCode](https://opencode.ai), [grok-cli](https://github.com/superagent-ai/grok-cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli) |

## Quick start (your Mac)

```bash
git clone https://github.com/duzgunberke/ekip.git && cd ekip
node plugin/bin/ekip.js init      # clones, builds and starts everything; then keys, logins, projects
```

`init` is interactive and safe to run again. It does the following:

1. Links `~/.local/bin/ekip`.
2. Builds and starts freellmapi.
3. Starts the hoptell relay.
4. Starts TencentDB Agent Memory in Docker.
5. Installs the Claude Code plugin (the skill and hooks).
6. Registers the `ekip` and `codegraph` MCP servers.
7. Installs the agent CLIs.
8. Opens each free provider's key page so you can paste a key.
9. Walks you through the agent logins.
10. Registers every project you committed to in the last 30 days.

Then, in a new terminal:

```bash
ekip
```

Then ask for anything, for example: "make two promo videos for X; fix what's left in lumareef; fix Y
in the sports-center app; add feature Z to the Unity game". The lead splits the work, sends each part
to the right pool with the project's context, reviews the results and reports back.

### Requirements

- macOS with `git`, `tmux`, `sqlite3` and Node.js 22 or later. freellmapi also needs Node 22-24: `brew install node@24`.
- Docker: Docker Desktop or OrbStack.
- Claude Code (`claude`), logged in.
- `agy` (Antigravity) is optional, and the strongest worker pool.

## The VPS hub (optional, recommended)

The hub runs the services that should never sleep: freellmapi, TencentDB memory, and the panel with
its job queue. The Mac reaches them through a launchd SSH tunnel on the same localhost ports.

1. On the server:
   - Copy `hub/` to `/data/ekip/hub`.
   - Clone TencentDB Agent Memory to `/data/ekip/tdai`.
   - Fill in `hub/.env` (see `hub/.env.example`), then run `docker compose up -d --build`.
   - Start the TDAI scripts with `CODE_SOURCE_ENABLED=gongfeng`.
   - Route your domain to `http://ekip-hub:7777`. With Coolify, use a Traefik dynamic file; see `hub/README.md`.
   - Keep the TDAI ports closed to the internet. The scripts publish on 0.0.0.0, so add DOCKER-USER drop rules.
2. On the Mac:

   ```bash
   ekip remote <ssh-host>                     # stop the local services and use the hub instead
   ekip tunnel install                        # launchd keeps the tunnel up
   ekip hub link https://ai.example.com <EKIP_HUB_TOKEN>
   ekip hub push                              # projects, cards and memory ids to the hub
   ```

## Commands

```bash
ekip [claude args]          # lead session (subscription); ekip --free: lead on free models
ekip run [--via POOL|a,b,c] [--project NAME|--cwd DIR] [--model ID] [--plugin NAME] [--skill NAME] "task"
ekip clean <id>             # remove the worktrees of a multi-pool run
ekip job "task" --project NAME | job ls | job show ID      # queue on the VPS hub
ekip agents [ls|install|login|test]                        # worker CLIs and their quotas
ekip project add|scan|ls|show|sync|card                    # registry, cards, wiki, code graphs
ekip memory search|remember|ingest|up|down|status|open
ekip keys | key add <platform> <key> | key list            # free-tier provider keys
ekip team up|down|ls|open [--open]                          # hoptell peers in terminal windows
ekip vps add|token|status|sh|apps|deploy|logs|restart       # SSH + Coolify API
ekip hub link|push|status|open   ·   ekip remote <host>   ·   ekip tunnel install|status
ekip status | up | down | logs | init
```

### Pools

| `--via` | what | quota |
|---|---|---|
| `agy` | Antigravity CLI | Google account |
| `codex` | OpenAI Codex CLI | ChatGPT plan |
| `copilot` | GitHub Copilot CLI | Copilot free tier or plan |
| `qwen` | Qwen Code | Qwen account |
| `opencode` | OpenCode | its free models, or your providers |
| `grok` | grok-cli on freellmapi (or xAI with `GROK_API_KEY`) | free pool |
| `gemini` | Gemini CLI | `GEMINI_API_KEY` |
| `free` | Claude Code `--bare` on freellmapi, through the memory proxy for registered projects | free pool |
| `claude` | headless Claude with your skills and plugins | your subscription |
| `auto` | the first agent that passed `ekip agents test`, then `free` | |

- `--via a,b,c` runs the same task on several pools, each in its own git worktree and branch. You compare the branches and merge the best one.
- `--plugin` / `--skill` load a Claude plugin or skill into a `free` or `claude` worker. For example, `--plugin lemo-opuscar` makes films.

## Data

Everything ekip keeps lives in `data/` (git-ignored) inside this folder. That includes keys, the
project registry and cards, run transcripts, worktrees, logs and the local memory volumes. Cloned
dependencies go to `vendor/`. Claude Code runs the plugin from its own cache; `~/.config/ekip/root`
points it back to this folder.

## Notes

- **Provider terms.** Use one account per provider. Extra accounts made to get around free-tier limits break the providers' terms.
- **Where your text goes.** Memory extraction and wiki building use the free pool's models. Session text and docs are sent to those providers.
- **Hub security.** The hub's API needs a bearer token. The panel uses a password, an HttpOnly session cookie and a CSRF header. The TencentDB and freellmapi ports are not public.

## License

MIT. The cloned projects keep their own licenses.
