<h1><img src="brand/logo-mark.svg" width="40" height="40" alt="" style="vertical-align: middle"> Operations</h1>

Review the upstream patches ekip applies, diagnose common failures, and understand data flow and privacy.

[README](../README.md) · [How it works](architecture.md) · [Memory](memory.md) · [Skills](skills.md) · [Reliability](reliability.md) · [Install](install.md) · [Commands](commands.md) · **Operations**

## Upstream patches

ekip keeps patches alongside its deployment tools and applies them to its local TencentDB clone or service configuration, without modifying upstream repositories. See [the patch deployment notes](../hub/tools/tdai-patches/README.md).

| Component | Issue | Patch or mitigation |
|---|---|---|
| TencentDB memory-core, L0 FTS | Deleting by an unindexed FTS5 column scanned the full table on every message. | Skip the delete for new records and avoid rewriting unchanged records. |
| TencentDB prompts | Chinese prompt instructions could make smaller models write memories in Chinese or copy an older memory's language. | Add a strict rule to write in the user's language for extraction, deduplication, scenes, persona, and skill prompts. |
| TencentDB session importer | Sessions over 256 MB could exceed V8 string limits; large batches timed out; a failed batch could lose a session; checkpoints were only per folder. | Stream large files without inline images, support lean conversation-only imports, use 20-message batches with in-place retry, and checkpoint after each session. Filter with `TDAI_IMPORT_SINCE_DAYS` and `TDAI_IMPORT_MAX_MB`. |
| freellmapi | Its default 120 RPM per-IP cap throttled internal services sharing one Docker IP. | Set `FREELLMAPI_RPM` to configure the cap; the hub defaults it to 1000 RPM. Provider-specific limits remain separate. |

`ekip memory import-history` defaults to the last 30 days and sessions up to 200 MB. Use `--days`, `--max-mb`, or `--all` to change the import window and size cap.

## Troubleshooting

| Symptom | Check | Likely cause or next step |
|---|---|---|
| A task step is stalled | Open the step detail and run `ekip limits`. | The worker may be waiting on a provider, model, or quota. Stall status means progress has not changed for 15 minutes. |
| `auto` skips a pool | Run `ekip limits` and check its reset time. | A quota error was found in the pool's recent run logs. It is skipped until available. |
| Memory is slow or history import times out | Run `ekip doctor`; inspect hub container resources and logs. | Memory-core may be busy. Confirm the FTS patch is applied and the patched file is mounted. |
| A wiki remains in processing | Run `ekip doctor`, then `ekip doctor --fix` if needed. | Free models may be slow; failed sources can be retried after wiki processing completes. |
| A provider is healthy but has no usable models | Run `ekip limits`. | The key may be valid but have no model access or remaining credits. |
| A worker pane does not close | Check the process, then run `ekip reconcile`. | A worker killed outside ekip may have left an unreported run; reconcile closes vanished runs. |
| Hub pages or jobs are unreachable | Check `ekip hub status`, the SSH tunnel, and hub health. | Confirm the hub URL and credentials, tunnel, and service status. |

## Data, privacy, and terms

- **Local state:** `data/` contains configuration, provider keys, project registry and cards, task state, run logs, and worktrees. It is ignored by Git.
- **External processing:** Memory extraction, wiki generation, embeddings, and translation use configured model providers. Session messages, worker reports, and project documentation can be sent to those providers. Do not register material that must stay on your machines; choose providers you trust.
- **Import scope:** Lean history import excludes tool output by default. See [Memory](memory.md#what-is-stored-and-what-is-not) for stored and excluded content.
- **Provider terms:** Use one account per provider. Creating extra accounts to evade free-tier limits can violate provider terms.
- **Hub access:** The API uses a bearer token. The panel uses a password and session cookie; cookie-authenticated writes require a CSRF header. Keep TencentDB and freellmapi ports private behind the hub.

---

[← Back to README](../README.md) · Next: [README](../README.md)

### Memories in the wrong language

The memory extractor is told to write in the source language, but free models sometimes answer in
Chinese. `hub/tools/translate-cron.sh` rewrites those records (text, search index and vector together)
and is safe to run often: it is resumable and refuses a second copy. On the hub it runs nightly:

```cron
30 3 * * * /data/ekip/hub/tools/translate-cron.sh >> /data/ekip/translate-cron.log 2>&1
```
