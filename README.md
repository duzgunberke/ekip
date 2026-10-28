# ekip

One command: a lead Claude Code session that hands work to worker agents on other quotas.

- `ekip`: lead session on the Claude subscription. Its system prompt tells it about `ekip run`.
- `ekip --free`: the lead session runs on free-tier models, for when the Claude limit is used up.
- `ekip run [--via auto|agy|free] [--cwd DIR] "task"`: one headless worker.
  - `agy` uses the Antigravity CLI quota.
  - `free` runs Claude Code `--bare` against freellmapi on 127.0.0.1:3001.
  - `auto` tries agy first, then free.
- `ekip key add <platform> <key>`: add a free provider key. Keys are kept in `~/.ekip/freellmapi.config.json` (mode 600), and freellmapi applies them on every boot.
- `ekip status | up | down | logs`

freellmapi checkout: `/Volumes/SSD/Projects/freellmapi`. It is built and runs on Homebrew `node@24`, because it needs Node below 25.
Override the paths with `EKIP_FREELLMAPI_DIR`, `EKIP_FREELLMAPI_NODE` and `EKIP_FREELLMAPI_PORT`.
Override the models with `EKIP_FREE_MODEL` (default `auto`) and `EKIP_AGY_MODEL`.
Worker transcripts are saved in `~/.ekip/runs/`.
