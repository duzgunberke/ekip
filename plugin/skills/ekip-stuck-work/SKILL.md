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
