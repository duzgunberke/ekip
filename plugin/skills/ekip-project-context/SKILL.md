---
name: ekip-project-context
description: Use when planning, answering questions about, or delegating work in a registered project so decisions reflect its own procedures and history.
---

# Load registered project context

1. Identify the project and confirm it is registered: run `ekip project ls`,
   then `ekip project show NAME` for its card.
2. Read the project's `CLAUDE.md` and the relevant `.claude/skills/*/SKILL.md`
   process procedures before proposing implementation steps.
3. Match skill triggers to the user's task. Read the whole relevant skill,
   including its traps and definition of done.
4. Search project memory with `memory_search` using the task wording, important
   subsystem names, and known error text.
5. If memory is slow or times out, retry once. Then narrow the query to a
   distinctive file, symbol, error, or decision instead of repeating a broad
   query.
6. Search the project wiki with `wiki_search` for architecture, conventions,
   and domain concepts that code alone may not explain.
7. Use `wiki_read` on the relevant page when search results point to a useful
   article; do not infer its full content from a title.
8. Explore the code index with `codegraph_explore` for a feature or path, or
   `code_graph` if that is the available project MCP tool.
9. Use `codegraph callers SYMBOL` or `codegraph impact SYMBOL` when tracing
   callers or blast radius is more useful than broad exploration.
10. If codegraph reports no index, fall back to targeted `rg` searches and
   inspect the files those matches identify.
11. Review the project card's stack, commands, common tasks, and gotchas.
   Confirm commands against the repository's package scripts or docs when
   needed.
12. Keep project context distinct from personal runtime values. Never include
   private hostnames, URLs, tokens, or IDs in public briefs or committed docs.
13. Before dispatch, pass only the findings that matter: project conventions,
   relevant memory, wiki references, skill names, affected files, and checks.
14. If an insight is durable and likely to help another session, save one
   concise fact with `memory_remember`.
15. “Done” means the plan or answer is grounded in project-specific process and
   history, not generic assumptions. Note when a source was unavailable or
   stale.
