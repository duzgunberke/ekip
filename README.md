# ekip

You talk to one Claude Code session, and it hands work to agents that run on other quotas, so your
Claude limit lasts longer.

| pool | what runs | how |
|------|-----------|-----|
| your Claude | the lead session: planning, splitting the work, reviewing results | `ekip` or plain `claude` with the plugin |
| `agy` | Antigravity CLI, headless (Google quota) | `ekip run --via agy` |
| `free` | Claude Code `--bare` on [freellmapi](https://github.com/tashfeenahmed/freellmapi) (pooled free tiers) | `ekip run --via free` |
| team | long-lived `ekip-agy` / `ekip-free` peers over [hoptell](https://github.com/EminUZUN/hoptell) | `ekip team up` |

## Install

```bash
git clone <this repo> ekip && cd ekip
node plugin/bin/ekip.js setup           # clones and builds freellmapi (Node 20-24), links ~/.local/bin/ekip, enables keyless OVH
claude plugin marketplace add "$PWD" && claude plugin install ekip@ekip   # the skill, in every Claude session
ekip key add groq <key>                 # add free-tier keys: google, groq, cerebras, openrouter, mistral, nvidia, ...
```

Optional pools:

- `agy`: install the Antigravity CLI.
- team: install hoptell and tmux, then register the hoptell MCP server in Claude and agy.

## Use

```bash
ekip                       # lead session on your Claude subscription; it delegates by itself
ekip --free                # lead session on free-tier models, for when the Claude limit is out
ekip run [--via auto|agy|free] [--cwd DIR] "task"    # one headless worker; auto = agy, then free
ekip team up|down|ls [agy|free]                      # hoptell peers in tmux (tmux attach -t hoptell-ekip-free)
ekip status | key add | key list | up | down | logs
```

With the plugin installed, a plain `claude` session also knows about ekip, through the `ekip:ekip`
skill. Ask it to "ekibe dağıt" or to save your limit, and it delegates.

## Layout

- `plugin/bin/ekip.js` is the whole CLI: one file, Node built-ins only.
- `plugin/skills/ekip/SKILL.md` is the skill every Claude session sees.
- `~/.ekip/` holds `config.json` (paths), `freellmapi.config.json` (provider keys, mode 600, applied by freellmapi on boot), `runs/` (worker transcripts), `logs/`, and `claude-free/` (the Claude config dir the free pool uses).

You can override the paths and ports with `EKIP_FREELLMAPI_DIR`, `EKIP_FREELLMAPI_NODE` and `EKIP_FREELLMAPI_PORT`.
You can override the models with `EKIP_FREE_MODEL` (default `auto`), `EKIP_AGY_MODEL` and `EKIP_FREE_WINDOW`.

## Notes

- Keyless OVH allows only about 2 requests per minute per model. That is enough to see the free pool work, but it is too slow for real agent work. Add keys.
- Use one account of your own per provider. Opening extra accounts to get around free-tier limits breaks the providers' terms.
- A team member starts unattended, so `ekip team up` marks the current folder as trusted in the free pool's own Claude config. It skips the bypass-mode prompt only if your own Claude settings already do.
