---
name: ekip-tasks
description: Use when tracking work in the ekip task panel, starting a multi-step request, or keeping long-running progress visible.
---

# Keep task state true

1. For a request with multiple steps, create a task with 3–8 concrete outcomes:
   `ekip task new "short title" --project PROJECT --steps "inspect; implement;
   verify; report"`.
2. Keep each step observable and small enough to close as it happens. Avoid
   vague steps such as “work on feature”.
3. Mark step 1 running as soon as you begin it: `ekip task step ID 1 running`.
   Check that the command succeeded before continuing.
4. Mark every later step running at its actual start. Do not leave a step
   pending while you work on it.
5. Close a step as soon as its outcome is reached: `ekip task step ID N done`.

6. If a step fails or is no longer needed, mark it `failed` or `skipped`; do
   not pretend it completed.
7. For a long step, send progress with `--pct N` and keep liveness fresh using
   `--alive`, for example `ekip task step ID 2 running --pct 40 --alive`.
8. Add a brief `--note` when the panel needs context, and use `--detail` for
   fuller step information.
9. If the plan changes, add a concrete step with `ekip task add ID "new
   outcome"`.
10. Never leave an old task's remaining steps pending for later. Close or fail
   that task, then open a new task for newly discovered work.
11. Pass the task ID and a useful label to each relevant worker using `--task ID
   --label "purpose"` on `ekip run`.
12. If you start a long command yourself (import, render, loop, or similar),
   expose its log with `ekip show LOG`.
13. When a completed worker still appears active in the panel, run `ekip tasks
   sync` and confirm the view updates.
14. Before closing, check `ekip tasks` and make sure each step reflects reality.

15. Close the task the moment its result has been reviewed: `ekip task done ID
   "one-sentence result" --link <file or URL>`. The result and links show on the
   panel and in `ekip status`. Use `ekip task fail ID "why"` if the work cannot be
   completed.
   A decision you ask the user in chat also goes on the panel: `ekip task ask ID
   "question" --option "A" --option "B"`, then `ekip task answer ID "choice"`.
   When the user asks what is going on, answer from `ekip status`.
16. “Done” means no step is left pending or running and the panel shows the
   reviewed result.
