---
name: ekip-skills
description: Use when repeated project work should become a reusable Claude Code skill, or when reviewing generated skill candidates.
---

# Create and curate project skills

1. Project skills live in the registered project's
   `.claude/skills/<name>/SKILL.md` and should be committed in that project.
2. Learn from real registered-project run history with `ekip skill learn
   PROJECT`. Use `ekip skill learn PROJECT --dry-run` to inspect clusters
   without generating candidates.
3. The learner needs at least three runs in a repeated work cluster before it
   generates a candidate. Existing local skills and rejected candidates are
   excluded from regeneration.
4. Internal ekip housekeeping runs are excluded. Unregistered folders are not
   learned as projects.
5. Review available proposals with `ekip skill candidates`; inspect a skill
   with `ekip skill show NAME` or `ekip skill search QUERY`.
6. Accept a candidate only after checking that its triggers, procedure,
   commands, and checks match real project practice: `ekip skill accept PROJECT
   NAME`.
7. Reject a bad or duplicate proposal explicitly with `ekip skill reject
   PROJECT NAME`; this records the decision so it is not proposed repeatedly.
8. `ekip skill prune PROJECT` reports stale generated TencentDB skills. It does
   not remove local skill files; `--apply` applies the supported remote
   cleanup.
9. You can write a skill by hand when a procedure just worked and is likely to
   recur. Capture the actual successful sequence, not speculative advice.
10. Use Claude Code skill frontmatter with `name:` and `description:`. The
   description must say WHEN to use it in the user's likely words, in English.
11. Order the body as a concrete procedure: prerequisites, commands, decision
   points, traps, verification, and what “done” means.
12. Include safe, project-specific commands and paths. Do not invent commands or
   embed personal hosts, tokens, IDs, or production values.
13. Keep one skill focused on one repeatable job. Use numbered steps and
   explicit failure handling; remove generic filler.
14. Test the procedure once where practical and correct any command or path that
   differs from the project.
15. “Done” means the file is under `.claude/skills`, frontmatter is valid, a
   user can recognize when to invoke it, and each step can be followed without
   hidden context.
