---
name: ekip-hub-ops
description: Use when linking, checking, operating, or updating the optional ekip VPS hub and its panel, workers, memory, or free pool.
---

# Operate the VPS hub

1. The hub can host the web panel, free model pool, memory services, and queued
   jobs so they remain available when the Mac is off.
2. Link a deployed hub with `ekip hub link URL TOKEN`; use `ekip hub status` to
   inspect the link and `ekip hub open` to open its panel.
3. Push registered project metadata with `ekip hub push` after project
   registration changes.
4. Queue background work with `ekip job "task" --project NAME`; inspect queued
   jobs with `ekip job ls` and `ekip job show ID`.
5. Check local and linked service state with `ekip status` and run `ekip
   doctor` for diagnosed setup gaps.
6. For the live panel, inspect its health and logs in the PaaS. Health probes
   should allow slow first responses; a slow answer is not automatically a dead
   service.
7. When operating under a PaaS such as Coolify, keep persistent data
   directories mounted across rebuilds and attach services to the required
   external Docker networks.
8. Container names can be regenerated. Find relevant containers by a stable
   name pattern and inspect labels rather than hardcoding generated suffixes.
9. For host access use the configured SSH command: `ekip vps sh "COMMAND"`.
   `ekip vps status` reports host reachability and Coolify token state.
10. Use `ekip vps apps` to find the target application. Then inspect `ekip vps
   logs APP`, `ekip vps deploy APP`, or restart it with `ekip vps restart APP`
   when appropriate.
11. To deploy an update, rebuild the hub application image from the updated
   source and restart/redeploy that application through the PaaS. Preserve its
   persistent data and network configuration.
12. Confirm the deployed image contains the intended revision. Then check
   health, panel access, memory, free-pool service, and a harmless job/status
   path.
13. If jobs fail, inspect job status, worker logs, pool quota, resource usage,
   and repository access. Do not assume the panel itself caused a worker
   failure.
14. Keep hub tokens in local runtime settings; never paste them into briefs,
   logs, public docs, or source control.
15. “Done” means the expected services are healthy after the operation,
   persistent state remains mounted, and the panel/job path reflects the
   current state.
