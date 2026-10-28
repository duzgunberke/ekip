---
name: ekip
description: Hand work to worker agents that run on other quotas (Antigravity/agy, pooled free-tier models through freellmapi, or long-lived hoptell peers), so your own Claude limit lasts. Use when a task splits into well-scoped parts (mechanical edits, tests, docs, research, isolated fixes), when the user asks to delegate, parallelize, "ekibe dağıt", save Claude limits, or when the Claude limit is running out; also to set up or check the ekip pools (ekip setup, ekip status, ekip key add).
---

# ekip: workers on other quotas

`ekip` is a CLI on PATH (`~/.local/bin/ekip`, or run `${CLAUDE_PLUGIN_ROOT}/bin/ekip.js`). It runs
worker agents on quotas other than yours:

| pool | what runs | strength | use for |
|------|-----------|----------|---------|
| `agy` | Antigravity CLI headless (Gemini and others), Google quota | strong | most delegated work |
| `free` | Claude Code `--bare` on freellmapi (pooled free tiers) | weaker, varies | small, precise, mechanical tasks |
| `auto` (default) | agy, then free when agy fails or is out of quota | | |

First check what is usable: `ekip status`. If `ekip` is missing, or `freellmapi` shows down with no
keys, run `ekip setup` once (clones and builds freellmapi, links `ekip`, enables the keyless OVH pool).

## One-shot workers: `ekip run`

```bash
ekip run [--via auto|agy|free] [--cwd DIR] [--model ID] "brief"
ekip run --via agy --cwd /path/to/repo - <<'EOF'
long brief...
EOF
```

A worker runs headless with full file and shell access in its cwd. It cannot ask questions. It prints
its final report to stdout, and the full transcript goes to `~/.ekip/runs/`. Exit code 1 means
every pool failed.

- Run independent workers in parallel: call Bash with `run_in_background: true`, one call per worker.
  You are notified when each one exits.
- Never let two concurrent workers edit the same files. If they must work heavily in the same repo,
  give each one its own `git worktree add` directory as `--cwd`.
- Write each brief as for a capable colleague with no context. Include the goal, the files and paths,
  the constraints, how to verify, and what to report back.
- Keep these for yourself: understanding the request, design decisions, splitting the work,
  integration, and review. Check every result (`git diff`, run the tests) before you report it.
  When a result is wrong, fix it or send it again with a sharper brief.
- Prefer these workers over your own subagents for well-scoped work. Subagents spend your Claude limit.

## Long-lived team members: `ekip team` (hoptell)

`ekip team up [agy|free]` starts `ekip-agy` and `ekip-free` as hoptell peers in tmux, with the
`worker` role. They keep their context between tasks:

- Send work with the hoptell `send_message` tool, addressed `to: "@worker"` or to a peer name from `list_peers`.
- Wait with `wait_for_message`.

Use them for multi-step work that benefits from a conversation. Use `ekip run` for everything else.
`ekip team ls` shows which members are running. `ekip team down` stops them.
To watch a member: `tmux attach -t hoptell-ekip-agy`.

## When the Claude limit is out

The user can start `ekip --free`. That session is Claude Code with freellmapi as its model, and the
same delegation applies.

## Pool management (when the user asks)

- `ekip key add <platform> <key>` adds a free-tier key and restarts freellmapi. Platforms: google,
  groq, cerebras, openrouter, mistral, nvidia, cohere, cloudflare, zhipu. `ekip key add ovh` needs no key.
- `ekip key list`, `ekip up`, `ekip down`, `ekip logs`.
- freellmapi dashboard: http://127.0.0.1:3001
