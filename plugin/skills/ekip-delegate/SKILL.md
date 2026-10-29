---
name: ekip-delegate
description: Use when you want to split work across agents, save a quota, compare approaches, or hand a coding task to a worker.
---

# Delegate work

1. Identify parts with separate deliverables and minimal shared files. Keep
   design choices, integration, and final review with the lead.
2. Load project context first with the `ekip-project-context` skill when this
   is a registered project.
3. Choose a pool using `ekip agents` and `ekip limits`. Use `auto` for ordinary
   tasks; it selects an available tested pool.
4. Use `--via agy,codex,free` (or another comma list from `ekip agents`) to
   race independent approaches when quality or uncertainty justifies the cost.
   Each gets its own worktree and branch.
5. Use `--worktree` when one worker edits code that is currently running, such
   as ekip itself or a live dev server. Merge only after review.
6. Use `claude` only after another pool failed on that task or the user asked.
   For Claude pool, specify `--model sonnet` or `--model opus` when the task
   needs a chosen model.
7. Draft a standalone brief for a headless worker. It must state the goal,
   allowed files, constraints, verification commands, and requested report
   (files, checks, open issues).
8. Keep the task brief small enough to execute without follow-up. Include
   relevant decisions and project gotchas from memory/wiki, not personal
   environment values.
9. Dispatch using `ekip run --via auto --project PROJECT --task TASK_ID --label
   "short purpose" "brief"`.
10. Use `--project` for registered work so the worker receives project folder
   and automatic project context, including applicable skills and memory.
11. Use `--skill NAME` or `--plugin NAME` when a known procedure is especially
   relevant. Verify the skill exists before passing it.
12. For a long brief, pipe it on stdin: `ekip run --via auto --project PROJECT -
   <<'EOF'` followed by the brief and the closing marker.
13. Do not assign overlapping files to concurrent workers unless they each have
   separate worktrees. Separate investigation from implementation when file
   ownership cannot be divided.
14. Wait for the worker report and inspect its diff with `git diff` or the
   worker branch diff. Do not accept a report as proof that files or checks are
   correct.
15. Run the relevant project checks and inspect failure output yourself. For
   registered project code changes, use `ekip review --project PROJECT` before
   reporting.
16. If a worker fails, identify the missing context or mistaken assumption, then
   re-dispatch with a narrower, sharper brief and exact acceptance criteria.
17. When a failed attempt is solved, save the durable cause and fix with project
   memory (`memory_remember`) so later work does not repeat it.
18. Say what was delegated, what was reviewed, what passed, and what remains
   open. “Done” means the result is integrated and reviewed, not merely
   returned by a worker.
