# ekip

**One terminal, one Claude, a whole team.** You talk to a single Claude Code session. It hands parts of
the work to agents running on *other* quotas (Antigravity, pooled free-tier models), remembers each
project across sessions, and keeps a searchable wiki of your notes and docs. Your Claude limit lasts
much longer.

```
you ──► ekip (lead Claude Code session, your subscription)
          │  plans, splits, reviews
          ├─► ekip run --via agy   ──► Antigravity CLI (Google quota)
          ├─► ekip run --via free  ──► Claude Code ─► memory proxy ─► freellmapi ─► Groq, Gemini, Cerebras, OpenRouter, ...
          └─► ekip team (hoptell)  ──► long-lived agy / free peers in their own terminal windows
                         memory + LLM wiki + code graph: TencentDB Agent Memory
```

ekip glues together four open-source projects. It does not fork them; `ekip init` clones them into `vendor/`:

| project | role in ekip |
|---|---|
| [freellmapi](https://github.com/tashfeenahmed/freellmapi) | one local endpoint (OpenAI + Anthropic format) over many providers' free tiers, with failover |
| [hoptell](https://github.com/EminUZUN/hoptell) | agent-to-agent messages; long-lived team members in tmux |
| [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | chat memory, skills, LLM wiki and code graph, with a panel |
| [Antigravity CLI](https://antigravity.google) (`agy`, optional) | a strong worker on a separate Google quota |

## Quick start

> **Türkçe:** Yeni bir terminal aç, aşağıdaki 3 satırı çalıştır. `ekip init` her şeyi klonlar, kurar ve
> başlatır. Sonra her ücretsiz sağlayıcının anahtar sayfasını tarayıcıda açar; anahtarı oluşturup
> terminale yapıştırırsın. Bittiğinde sadece `ekip` yaz.

```bash
git clone https://github.com/duzgunberke/ekip.git
cd ekip
node plugin/bin/ekip.js init
```

Then, in any project:

```bash
cd ~/code/my-project
ekip                 # lead Claude Code session; just ask: "build X, fix Y, write the docs"
```

### Requirements

- macOS or Linux, with `git`, `tmux` and `sqlite3`. On macOS: `brew install tmux sqlite`.
- **Node.js 22 or later** for ekip itself, plus **Node 22-24** for freellmapi: `brew install node@24`. ekip finds it by itself.
- **Docker** (Docker Desktop or OrbStack), running, for the memory stack.
- **Claude Code** (`claude`), logged in to your subscription.
- Optional: the **Antigravity CLI** (`agy`), logged in. It is the strongest worker pool.

### What `ekip init` does

Every step is idempotent, so it is safe to run again.

1. Checks the prerequisites and links `~/.local/bin/ekip`.
2. Clones and builds **freellmapi** (`vendor/freellmapi`), starts it on `127.0.0.1:3001`, and enables the keyless OVH pool.
3. Installs **hoptell** if it is missing, starts its local relay (`ws://127.0.0.1:7788`), and registers its MCP server in Claude Code.
4. Clones **TencentDB Agent Memory** (`vendor/tdai`) and starts memory-core, memory-hub and proxy in Docker.
   - Its LLM work (memory extraction, wiki ingest) runs on freellmapi, so it costs no paid quota.
   - Its data is bind-mounted to `data/tdai/`.
5. Installs the **ekip Claude Code plugin**, so every `claude` session knows how to delegate.
6. Runs the **key wizard**. It opens each provider's key page in your browser, you paste the key, and Enter skips a provider.

To put everything on another disk, clone the repo there. Keys, logs, run transcripts, memory data
and the cloned dependencies all stay inside the repo folder (`data/`, `vendor/`, both git-ignored).

## Commands

```bash
ekip [claude args]                  # lead session (Claude subscription) that delegates by itself
ekip --free [claude args]           # lead session on free-tier models, for when the Claude limit is out
ekip run [--via auto|agy|free] [--cwd DIR] [--model ID] "task"   # one headless worker
ekip team up|down|ls|open [agy|free] [--open]   # long-lived peers; --open shows each in a terminal window
ekip keys [--all]                   # key wizard (opens each provider's key page)
ekip key add <platform> <key> | key list
ekip memory up|down|status|open     # memory stack; open = panel at http://127.0.0.1:8125
ekip status | up | down | logs      # pools, recent runs; freellmapi server control
```

The `auto` pool tries `agy` first and falls back to `free` when agy fails or is out of quota.
Worker transcripts are saved to `data/runs/`.

## Free providers the key wizard covers

The wizard asks for these in this order, best for agent work first:

| provider | free tier |
|---|---|
| Groq | very fast, about 14k requests per day |
| Google AI Studio | Gemini Flash |
| Cerebras | very fast |
| OpenRouter | `:free` models |
| NVIDIA NIM | large models |
| Mistral | free Experiment plan |
| Cloudflare Workers AI | key format `ACCOUNT_ID:TOKEN` |
| Cohere | trial key |
| Z.ai | GLM Flash |
| HuggingFace | Inference Providers |

Use **one account per provider**. Opening extra accounts to get around free-tier limits breaks the
providers' terms. Some catalog entries in freellmapi are third-party resellers. ekip does not add
them, because your code would go to them.

## How the pieces fit

- **Lead session.** `ekip` starts `claude` with a short system prompt that explains `ekip run` and `ekip team`. The plugin's `ekip:ekip` skill teaches the same thing to any plain `claude` session.
- **Free worker.** It runs `claude --bare -p` with `ANTHROPIC_BASE_URL` pointing at freellmapi, and with its own config dir (`data/claude-free`). Your normal `claude` and its settings are never touched.
- **Team member.** `hoptell tmux ekip-free -- ekip --free --member` runs a member that receives tasks by hoptell message and replies when it is done.
- **Memory.** TencentDB Agent Memory runs locally in Docker. Its panel at http://127.0.0.1:8125 manages teams, agents, the wiki (upload your notes and docs) and code graphs.

## Configuration

`data/config.json` holds the paths of the cloned dependencies and the Node binary for freellmapi.
Point those paths at existing checkouts to reuse them.

Environment overrides:

- `EKIP_HOME`
- `EKIP_FREELLMAPI_DIR`, `EKIP_FREELLMAPI_NODE`, `EKIP_FREELLMAPI_PORT`
- `EKIP_FREE_MODEL` (default `auto`), `EKIP_FREE_WINDOW`
- `EKIP_AGY_MODEL`, `EKIP_AGY_TIMEOUT`

## Troubleshooting

- **`ekip status` shows `provider keys: ovh×1` only.** Keyless OVH allows about 2 requests per minute. Run `ekip keys`.
- **A free worker fails with `429 All models exhausted`.** Add more providers, or wait for the limits to reset.
- **The memory stack does not start.** Check that Docker is running, then check `docker logs tdai-memory-core`, `docker logs tdai-memory-hub` and `docker logs tdai-proxy`.
- **The agy team member asks for approval on hoptell tools.** Allow `mcp(hoptell/*)` in `~/.gemini/antigravity-cli/settings.json` under `permissions.allow`.

## License

MIT. The cloned projects keep their own licenses.
