<h1><img src="brand/logo-mark.svg" width="40" height="40" alt="" style="vertical-align: middle"> Skills, lessons and reviews</h1>

How a project's repeated work becomes a skill, how corrections become lessons, and how both reach every worker.

[README](../README.md) · [How it works](architecture.md) · [Memory](memory.md) · **Skills** · [Reliability](reliability.md) · [Install](install.md) · [Commands](commands.md) · [Operations](operations.md)

<p align="center"><img src="assets/skill-loop.svg" alt="The skill loop: runs are logged, repeats are grouped, ekip skill learn drafts a SKILL.md, you accept it, it lives in .claude/skills, every later worker brief and the lead use it; corrected mistakes become lessons on top of every brief and the lead's context" width="100%"></p>

## Two kinds of project skill

| Kind | Where it lives | How it is found |
|---|---|---|
| Process skills | `<project>/.claude/skills/<name>/SKILL.md`, and one level down for sub-repos | `plugin/lib/projects/project-skills.js` ranks them by word overlap with the request (case, Turkish letters and accents folded). A project with three or fewer lists all of them. |
| Memory skills | TencentDB Agent Memory, extracted from imported Claude sessions when the project is registered | `skill_search` and `skill_get` MCP tools, `ekip skill ls\|search\|show` |

Both reach the work without anyone asking for them:

- **Every worker brief.** `ekip run --project NAME` appends the project's lessons, its `.ekip/rules.md`,
  up to four matching process skills (with the path of each `SKILL.md`) and up to three memory skills.
- **The lead.** The `UserPromptSubmit` hook adds the matching process skills of the project you mention
  to Claude's context with each message.
- **By name.** `ekip run --skill NAME` loads a project skill (then `~/.claude/skills`) into any pool;
  workers that cannot load Claude plugins get the file path to read.

## The learning loop

1. **Runs are logged.** Every worker run writes its brief and final report to `data/runs/`, and starts
   and finishes go to `data/skill-usage.jsonl`. A run in a git worktree counts for the repo it came
   from. ekip's own housekeeping (project cards, review profiles, the learner itself) is left out.
2. **Repeats are grouped.** `ekip skill learn PROJECT` normalises the briefs (paths, ids and numbers
   become placeholders) and joins runs with the same label stem or a word overlap of 0.35 or more.
   A group needs `skillMinRuns` runs (3 by default) to become a candidate.
3. **A draft is written.** One worker reads the groups, the project card, `CLAUDE.md`, the package
   scripts and any matching memory skill, and returns a `SKILL.md` per group: a description that says
   when to use it, the procedure, files, checks, traps and what "done" means. Every command in it must
   appear in that material. Groups that already match a local skill are skipped.
4. **You decide.** Drafts wait in `data/skill-candidates/`. `ekip skill candidates` lists them,
   `ekip skill accept PROJECT NAME` moves one into `.claude/skills/`, `ekip skill reject PROJECT NAME`
   deletes it and remembers the name, so the same idea is not proposed again.
5. **It is used.** From the next brief on, the skill is matched like any other process skill.

`ekip doctor` (every 30 minutes through launchd) runs the learner once a day for every project and
`ekip status` says when new candidates are waiting. `--dry-run` shows the groups without calling a
worker. `ekip skill prune PROJECT` lists memory skills that are near copies or unused for 30 days; it
never deletes anything.

### An example

A video-editing project kept getting briefs like "render the 9:16 cut of the launch clip, check the
loudness, upload it". After the third such run, the learner grouped them and drafted
`flow-production-unit`: which composition file to render, the loudness check the earlier workers ran,
where the export goes and the trap that broke one run. The user accepted it with one command. The
next render brief in that project listed the skill at the top, and the worker followed it instead of
working the steps out again.

### Is it used?

`ekip stats [project]` counts skill lookups by the lead's hook, worker briefs and MCP calls, lists the
skills workers actually opened (the run log mentions the `SKILL.md` more often than the brief line
does) and compares run success with and without knowledge. These are signals, not proof.

## Lessons

When you correct a mistake, the lead runs `ekip project lesson NAME "what went wrong and the rule"`.
The line goes to the project's lessons file (`.ekip/lessons.md` when the project has a `.ekip/` folder,
else a private file under `data/projects/`). Every worker brief in that project starts with the whole
list, whatever the brief is about; the lead gets the newest ones with every message. `genel` is the
lead's own list. When a worker fails and a later attempt works, the lead saves the difference into
the project's memory as well.

## Reviews that fit the project

`ekip review [--project NAME] [--base REF]` looks at what changed, picks the project's own check
scripts that touch those files (anything that writes to live services is skipped), runs them, and asks
two reviewers on different pools to read the diff through the project's review profile: the rules
from its `CLAUDE.md`, its known gotchas and the checks behind them. `--checks-only` runs the checks
alone; `ekip review profile NAME --refresh` regenerates the profile.

## Settings that travel with the project

`ekip project config NAME` creates a `.ekip/` folder that is committed with the code, so everyone who
works on the project with ekip shares it:

| File | Used for |
|---|---|
| `rules.md` | added to every worker brief and to the lead's context |
| `lessons.md` | corrected mistakes, on top of every worker brief |
| `review.md` | the profile `ekip review` reads changes through |
| `checks/` | the project's own check scripts, run by `ekip review` |
| `dev.json` | the development database mapping (never passwords) |

Process skills stay in `.claude/skills/`, where Claude Code reads them too.

---

[← Memory](memory.md) · Next: [Reliability](reliability.md)
