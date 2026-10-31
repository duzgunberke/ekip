# Roadmap

ekip grows in three steps. Each one keeps the same rule: Claude spends its limit on judgment, and the
work runs on other quotas.

## v1: one lead, many workers (today)

- A lead Claude session hands well-scoped work to workers on other quotas (`ekip run`), compares
  pools, and reviews every result.
- Every registered project has its own memory, wiki, code graph and skills.
- Project-aware review (`ekip review`), development databases (`ekip dev`), skills learned from
  repeated work (`ekip skill learn`), a live task pane and a web panel with logs.

## v2: shared memory and teamwork

<img src="assets/team-memory.svg" alt="Several people, each with their own ekip, feed and read one shared memory with personal, project and team layers" width="100%">

Today ekip is one person, one Claude and a whole team of agents. Next: a whole team of people on one
shared memory. Everyone keeps their own terminal and agents, connected to one hub. What one person
solves in a project, a teammate's agent knows the next day: the fix, the test that caught it and what
did not work. Personal notes stay personal; team-wide rules live in a team layer every agent reads.
The foundation is already here: memory is isolated per project and per agent inside one store.

The memory and the hub stop being one person's.

- **Shared project memory.** Teammates who work on the same project read and write the same
  memories, wiki and skills; what one person's session learned, the next person's workers start
  from. Memories carry their author and source session.
- **More than one machine.** Several Macs (and the hub) report to one panel; tasks show where they
  run, and a queued job can be picked up by whichever machine is free.
- **Roles.** Who may queue jobs, approve skill candidates, or deploy; read-only panel access for
  people who only watch.
- **Hand-off.** A task can move from one person's lead to another's with its steps, notes, worker
  logs and review profile.

## v3: integrations

Projects need more than code: error tracking, uptime checks, analytics, metrics, logs. Most users
either run these tools already (often on the same server as their apps) or would like to. In v3,
ekip finds them, sets them up when they are missing, and wires them into each project, so a project
gets an error tracker or a status check with one command instead of an afternoon.

### What it looks like

```bash
ekip integrations                      # what is available, what is running, which projects use what
ekip integrate my-app errors           # error tracking for my-app (self-hosted or a hosted account)
ekip integrate my-app uptime           # an uptime check for each of my-app's public URLs
ekip integrate --all errors --dry-run  # the plan for every project, nothing changed
```

### Categories and first integrations

| Category | Self-hosted | Hosted |
|---|---|---|
| Error tracking | GlitchTip | Sentry |
| Uptime and status pages | Uptime Kuma | Better Stack |
| Product analytics | Umami, PostHog | PostHog Cloud |
| Server metrics and logs | Beszel, Dozzle, Prometheus and Grafana | Grafana Cloud |
| Business intelligence | Metabase | |
| Object storage | Garage, MinIO | S3-compatible |

### How one integration works

Each integration is a small module with the same five steps. Adding a new tool means writing one
module.

1. **Detect.** Is the tool already running? ekip asks the user's server (through its PaaS API, for
   example Coolify, or over SSH) and the user's accounts. Does the project already use it? ekip
   reads its dependencies and config (`@sentry/*`, a DSN in the environment, a tracking script).
2. **Provision** (only when missing, and only with the user's yes). Install the self-hosted tool as
   a service on the user's server from a template, or use the hosted account the user connected.
   One shared instance serves every project.
3. **Connect.** Create the project inside the tool through its API (a GlitchTip project and DSN, an
   Uptime Kuma monitor, an Umami site) and store the secrets where the app's other settings live
   (the PaaS environment, never the repo).
4. **Wire.** A worker adds the SDK or snippet to the project's code for its stack (Expo/React
   Native, Next.js, Node, Python), behind the project's own conventions, and opens it for review
   like any other change.
5. **Verify.** Send a test event, hit the monitor, and confirm it arrived. The integration is added
   to the project's review profile, so `ekip review` notices when a later change removes it.

### Closing the loop

Integrations are not only installed, they feed the team:

- **Triage.** New errors and failed checks become ekip tasks with the stack trace, the release and
  the suspected files, ready to hand to a worker (`ekip triage my-app`).
- **Panel.** The web panel shows each project's error rate, uptime and key metrics next to its
  tasks and runs.
- **Memory.** Fixes for recurring errors are saved as lessons in the project's memory, and
  repeated fixes become skill candidates.

### Safety

- Nothing is installed, created or changed on a server without the user's confirmation; `--dry-run`
  shows the full plan.
- Development first: wiring is tested against the project's development environment before
  production.
- Production resources are never stopped or modified by an integration; it only adds its own
  service and the app's environment variables.
- Secrets live in the PaaS environment or the tool itself, are masked in logs and memory, and never
  enter the repository.
