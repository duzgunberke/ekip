---
name: ekip-stuck-work
description: Use when a worker, task, panel item, hub job, or health check looks stuck, stale, or wrong.
---

# Diagnose and prevent stuck work

1. Find the run or task details first: inspect the panel/task step and the
   corresponding log. For a long-running local job, use `ekip show LOG`.
2. Check whether the process is alive with `ps`; compare the log's modification
   time with the last reported output. A stale timestamp alone does not prove
   the process is dead.
3. Check server load and memory pressure with `uptime`, `free -h` on Linux, or
   the appropriate local system monitor. For containerized services, inspect
   `docker stats`.
4. Check quota and routing with `ekip agents` and `ekip limits`. A provider may
   be healthy while its quota or model access is exhausted.
5. Check whether the issue is only display state. If a finished run remains
   active on the panel, run `ekip tasks sync`; the stale task pane restarts
   itself after its code changes.
6. Check dependency names when a command references a missing container or
   service. Under a PaaS, list containers and identify them by a stable name
   pattern; do not assume generated container names stayed fixed.
7. Treat a slow check as slow until evidence says it is down. Inspect its
   timeout, logs, process, and resource usage before restarting it.
8. Use `ekip doctor` to inspect local tunnel, pools, graph, wiki, and memory.
   Use `ekip doctor --fix` only for the repairs it reports.
9. On the hub, inspect `ekip hub status`, then use `ekip vps sh "..."` for
   host-level checks and `ekip vps logs APP` or `ekip vps restart APP` for the
   relevant Coolify app.
10. Check whether duplicate jobs are competing for one quota or resource. Stop
   or serialize redundant work before retrying.
11. Make the current instance healthy: repair the confirmed cause,
   resume/re-dispatch work with an appropriate pool, then verify the log and
   panel state.
12. Add the mechanism that prevents the class of failure, following the lead
   rule: save a durable fix in project memory with `memory_remember`; recurring
   procedures can become a skill with `ekip skill learn`.
13. For a recurring project bug with check scripts, propose a project check
   script so the next review catches it automatically.
14. Do not report “stuck” solely because an estimate expired or a check is slow.
   Report what evidence showed and what changed.
15. “Done” means both the particular instance is fixed and a repeat-prevention
   mechanism or documented reason it is not applicable is in place.

## Failure classes seen in real use

Each of these looked like "stuck" or "broken" and was something else. Check for them first.

- **A failed read shown as zero.** A status reader timed out under load and the panel showed healthy
  providers as having no models. A read that fails must keep the last good value, not report zero.
- **A reporter that does not report.** Work was progressing on the server, but the progress script's
  update line was disabled, so the panel froze at one percent for hours. Measure the work itself
  (records written, files done) and pass `--alive`.
- **A blocked event loop.** A request sent right before `spawnSync` never left, so the hub never got
  the Mac's heartbeat. Await network calls before blocking calls.
- **Too much parallelism.** Six parallel imports pinned the memory server; its own health checks and
  searches timed out and three import groups died on a 504. Keep parallel load below what the shared
  service can absorb, and retry transient 5xx instead of aborting.
- **A renamed dependency.** Moving a service under a PaaS renamed its container; every caller that used
  the fixed name silently got nothing. Resolve names at run time.
- **Slow is not down.** A health probe with a short timeout called a busy but working service
  offline. Give probes a realistic timeout and show "slow" on timeout.
- **A step nobody advanced.** A step stayed "running" because the command that should have marked it
  failed earlier in the same shell line. Check that each `ekip task step` actually ran.
- **A pane running old code.** A long-lived pane kept old logic after an update; the task pane now
  restarts itself, other long-lived processes may not.
- **A short PATH.** Hooks, panes and launchd jobs start with a PATH without `~/.local/bin`, so an
  installed worker CLI looked "not installed" on the panel. ekip adds the usual install folders itself.
- **Quota found only after a failure.** A pool showed "ready" until a run failed on its quota; a pool
  named with `--via` then failed the task. A quota failure now hands the task to the next pool, and the
  reset time is read from the message ("Resets in …", "try again at …").
- **A search that scans everything.** Memory search went from instant to 4-16 s as the store grew to
  287k conversation rows (half duplicates, tool noise) in one unpartitioned vector table, and the hook
  that adds knowledge to each message gave up silently. Lookups that time out are now logged as
  timeouts and doctor warns; vector tables are partitioned per project; `ekip memory compact` cleans.
- **A plain word as a project name.** "ekip" is also an everyday Turkish word; matching it in free text
  filed unrelated research under the ekip project. Common-word names need a path or `--project` mention.
- **A hook timeout from an older cached copy.** Claude Code runs the plugin from a cached copy with the
  old hook timeout; a budget longer than that timeout printed an error under every message. Hooks end
  themselves well inside the shortest timeout any copy might have.
- **Scripts replaced while they run.** bash reads a script as it executes it; copying a new CI script
  over a running one corrupted the run. CI now runs from a per-run copy.
