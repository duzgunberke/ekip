# TencentDB memory-core patches

`memory-core-l0-fts-scan.patch`: `upsertL0` ran `DELETE FROM l0_fts WHERE record_id = ?` on every
message, but `record_id` is an UNINDEXED FTS5 column, so each write scanned the whole FTS table
(CPU pinned at 100%+, ~1 message/s at 66k messages, getting slower as the table grows). The patch
skips the delete for new records and skips the FTS rewrite when a re-sent record's text is unchanged.

On the VPS the patched file is `/data/ekip/memory-store.patched.ts`; `start-memory-core.sh` bind-mounts
it over `/app/src/core/store/sqlite/memory-store.ts` when it exists. After a memory-core image update,
re-apply the patch to the new file (`patch -p1` in a copy of `/app`) before restarting.
