---
name: ekip-projects
description: Use when adding, discovering, refreshing, relocating, or removing a project registered with ekip.
---

# Manage registered projects

1. List known projects with `ekip project ls`; inspect details and the card
   with `ekip project show NAME` or `ekip project card NAME`.
2. Add a repository by path with `ekip project add PATH`. Registration builds
   its project card, code graph, wiki, and memory context.
3. Discover repositories beneath a parent with `ekip project scan PATH`. Review
   the candidates before confirming registration.
4. Refresh project-derived context after meaningful changes with `ekip project
   sync NAME`. Check its output for card, graph, wiki, or memory errors.
5. Move a registered project through `ekip project move NAME OLD_PATH NEW_PATH
   --dry-run` first to inspect effects; then repeat without `--dry-run` to
   apply.
6. Do not manually edit registry paths or move a registered folder behind
   ekip's back. Use the supported move operation so history and metadata follow
   it.
7. Remove a project with `ekip project remove NAME` only when it should no
   longer be registered. Understand the cleanup summary before confirming.
8. Removal cleans the registration and associated generated project context,
   including card, code graph, wiki, and memory linkage; it may also clear
   project-specific Claude history paths.
9. Memory can import Claude session history with `ekip memory import-history`; new sessions arrive on their own (Stop hook, hourly catch-up), `ekip memory catch-up` sends the missing ones by hand.
   The default import window is 30 days and the default per-session cap is 200
   MB.
10. Change import sizing with `--days`, `--max-mb`, or `--all`; the `--max-mb`
   option changes the default cap. Avoid `--all` unless the full history is
   intended.
11. Rebuild missing vector embeddings with `ekip memory reindex`. It is
   resumable and only backfills records without vectors.
12. Treat memory, wiki, and graph indexing as potentially slow. Inspect
   status/logs and resource use before retrying a large import.
13. Do not place private project hosts, IDs, tokens, or personal paths into
   public repository examples; keep them in runtime configuration.
14. After an operation, run `ekip project show NAME` and verify the path/card
   and expected indexes. After removal, confirm it no longer appears in `ekip
   project ls`.
15. “Done” means registration and derived context match the project's current
   location and intended lifecycle.
