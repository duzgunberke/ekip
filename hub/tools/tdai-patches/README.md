# TencentDB memory-core patches

`memory-core-l0-fts-scan.patch`: `upsertL0` ran `DELETE FROM l0_fts WHERE record_id = ?` on every
message, but `record_id` is an UNINDEXED FTS5 column, so each write scanned the whole FTS table
(CPU pinned at 100%+, ~1 message/s at 66k messages, getting slower as the table grows). The patch
skips the delete for new records and skips the FTS rewrite when a re-sent record's text is unchanged.

On the VPS the patched file is `/data/ekip/memory-store.patched.ts`; `start-memory-core.sh` bind-mounts
it over `/app/src/core/store/sqlite/memory-store.ts` when it exists. After a memory-core image update,
re-apply the patch to the new file (`patch -p1` in a copy of `/app`) before restarting.

## Language rule (prompts)
`core/prompts/{l1-extraction,l1-dedup,persona-generation,scene-extraction}.ts` and
`core/skill/prompts/skill-review-prompt{,-strict}.ts` get one strict line: write free text in the language the
user wrote in (Turkish for this user), never Chinese/Japanese because the prompt itself is Chinese. l1-dedup also
stops copying the language of old pool memories. Patched files live in `/data/ekip/tdai-patches/app/...` on the VPS;
`start-memory-core.sh` bind-mounts every file under that folder over the same path in the container.
Existing Chinese memories were rewritten with `hub/tools/tdai-translate-l1.mjs` (freellmapi profile `auto:translate`).
