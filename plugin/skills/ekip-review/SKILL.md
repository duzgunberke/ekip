---
name: ekip-review
description: Use when reviewing code changes with ekip, previewing checks, interpreting reviewer findings, or deciding whether a project needs a check script.
---

# Run a project review

1. Confirm the project and changed files. For registered project changes, run
   `ekip review --project NAME` before reporting.
2. Preview the plan with `ekip review --project NAME --dry-run` when you need
   to inspect selected checks and review setup before execution.
3. Use `--checks-only` to execute configured checks without launching
   reviewers. Use `--via a,b` to select available reviewer pools when
   appropriate.
4. Generate or refresh the project's review lenses with `ekip review profile
   NAME --refresh` when none exists or its conventions have changed.
5. Review output in two parts: check results and the two read-only reviewer
   reports. Each reviewer assesses the diff through the project profile.
6. Treat failed checks as must-fix. Treat HIGH findings confirmed by both
   reviewers as must-fix; investigate disagreements and verify the claim
   against source.
7. The safety filter skips checks whose command appears to write to live
   services or destructive targets. A skipped check is not a pass; inspect the
   reason and arrange a safe equivalent if needed.
8. Never weaken the safety filter to make a review green. Do not use production
   URLs or destructive targets for verification.
9. If a check times out, inspect its log and configured timeout. Slow is not
   automatically down; determine whether it failed, timed out, or is still
   working.
10. Fix confirmed findings, re-run the focused checks, then re-run `ekip review
   --project NAME` for the complete review.
11. Consider proposing a new project check script when the same regression class
   recurs and the condition can be tested deterministically.
12. A useful check is scoped, fast, safe for local/dev data, and exits nonzero
   on a clear failure. Document any setup it requires.
13. Do not add a check that reaches production or mutates shared live systems.
   The safety filter exists to avoid that class of side effect.
14. “Done” means checks are accounted for, must-fix findings are resolved, and
   the two reviewer results have been considered and summarized.
