# Operations


Upstream patches, troubleshooting, data and privacy.



[← back to the README](../README.md)


## Patches to upstream projects

ekip clones these projects and does not fork them. Where they needed fixing, the patch is kept here
with an explanation, and applied without touching their repos:

| Where | Problem | Fix |
|---|---|---|
| TDAI memory-core, `upsertL0` | `DELETE FROM l0_fts WHERE record_id = ?` on an UNINDEXED FTS5 column scanned the whole table on every message; at 66k messages the core sat at 100%+ CPU and writes crawled | skip the delete for new records and for re-sent unchanged ones: CPU 130% → 30%, writes 3-7× faster ([patch](../hub/tools/tdai-patches/memory-core-l0-fts-scan.patch)) |
| TDAI prompts (extraction, dedup, scenes, persona, skills) | small models answered in Chinese because the prompts are Chinese; dedup copied the language of old memories | one strict language rule at the end of each prompt |
| TDAI importer (`agents/asset-import.ts`) | a 1.2 GB session crashed it (V8 string limit) and skipped the whole folder; 100-message batches outran the gateway timeout; one failed batch dropped the whole session; progress was saved only per folder | streamed reading without inline images, `TDAI_IMPORT_LEAN`, 20-message batches, per-batch retry, per-session checkpoint |
| freellmapi deploy | a per-IP limit of 120 requests/min throttled every internal client against each other (they share one Docker IP) | `PROXY_RATE_LIMIT_RPM=1000`; provider limits are tracked separately |

## Troubleshooting

| Symptom | Look at | Usual cause |
|---|---|---|
| a step shows ⚠ stalled | its detail line, `ekip limits` | the free pool is saturated, or a pool hit its quota |
| a pool is skipped by `auto` | `ekip limits` | its last run hit a quota; the reopen time is shown |
| memory feels slow, imports time out | `ekip doctor`, `docker stats` on the hub | memory-core busy; is the FTS patch mounted? |
| a wiki stays "processing" | `ekip doctor` | slow free models; failed sources are retried after it is ready |
| a provider says healthy but nothing answers | `ekip limits` (shows "no models") | the key is valid but has no models or credits (HuggingFace) |
| a worker pane never closes | `ekip reconcile` | the worker was killed before it could report |

## Data, privacy and terms

- **Where things live.** Everything ekip keeps is in `data/` (git-ignored): keys, the project registry
  and cards, run logs, worktrees, task state, background job scripts. Claude Code runs the plugin from
  its cache; `~/.config/ekip/root` points it back here.
- **Where your text goes.** Memory extraction, wiki building and translation use the free pool, so
  session text and docs are sent to those providers. Don't register a project whose text must not leave
  your machines, or point `auto:memory` at a provider you trust.
- **Provider terms.** One account per provider. Extra accounts made to get around free-tier limits
  break the providers' terms, and ekip will not help you make them.
- **Hub security.** The API needs a bearer token; the panel uses a password, an HttpOnly session
  cookie and a CSRF header. TencentDB and freellmapi are never exposed publicly.
