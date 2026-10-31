# Collaboration

How several people run their own Claude lead against one shared hub without overwriting each other's work, tokens, or memory.

Today ekip is built for one person. A hub has one password, one passkey identity, one machine token, and one hub-wide snapshot for limits and savings; `ekip hub push` replaces the project list. This document describes the smallest changes that make a hub usable by a small team, in an order where each phase works on its own. It is a design, not a description of shipped behaviour; command and endpoint names below are proposals unless the current behaviour is quoted.

Examples use `hub.example.com`, `ada`, `ben`, and the project `storefront-web`. Nothing here requires names, hosts, or credentials to be committed.

## What exists today

| Area | Current behaviour | Consequence for a team |
|---|---|---|
| Hub auth | One hub password, one WebAuthn user handle, one `EKIP_HUB_TOKEN` bearer token for every machine (`hub/src/auth.js`, `hub/src/server.js`) | Everyone shares one identity; revoking one laptop revokes the team |
| Sessions | Session key is derived from the hub password; changing it signs everyone out | No per-person session control |
| Projects | `ekip hub push` sends `{projects, replace: true}`; projects are stored by name | A member's push can replace the owner's project list, including cards and TDAI ids |
| Tasks | `PUT /api/tasks` upserts by id; ids are `g<base36 time><random>` per machine; unknown fields are dropped by `cleanTask` | No owner, no assignee, no filter by person, no conflict detection |
| Runs | Jobs carry no member; runs are stored without an owner | Quotas and audit cannot be attributed |
| Limits | `limits` and `savings` are single hub-wide snapshots | One member's usage overwrites another's on the panel |
| Memory | One TDAI admin identity; one agent, wiki, and code graph per project on the hub | Knowledge is shared, but no one can tell who added a fact or restrict personal notes |
| Committed context | `.ekip/` holds `rules.md`, `lessons.md`, `acceptance.md`, `review.md`, `checks/`, `dev.json` | Works for a team already; needs conventions for shared edits |
| Phone | Panel over Tailscale with a passkey; notifications are local macOS notifications | No per-person messaging integration yet |

## 1. Identities and joining

### Model

A hub has **members**. A member is a person, not a machine. One member can have several machine tokens, passkeys, and paired phones.

```
member  { id, name, role, status, createdAt, disabledAt }
        id:       random short id, e.g. "m_7f3k" - the only identity that matters
        name:     display name, editable, not unique
        role:     "owner" | "member"
        status:   "active" | "suspended" | "removed"
token   { id, memberId, label, hash, prefix, createdAt, lastUsedAt, revokedAt }
passkey { credentialId, memberId, name, publicKey, signCount, transports, createdAt, lastUsedAt }
invite  { id, codeHash, role, createdBy, expiresAt, usedBy, usedAt }
```

The hub remains the only authority. A local `settings.json` gets `memberId` and a display name, but the hub derives the member from the credential on every request. A client cannot claim to be someone else by putting `owner` or `member` in a JSON body.

### Accounts and passkeys

- Replace the single `auth.userId` with a per-member WebAuthn user handle: 16 random bytes stored on the member. Handles must not be derived from the password, so changing a password does not orphan passkeys.
- Credentials are stored with `memberId`. Login returns a session payload `{ memberId, role, passkeyId, epoch }`; the role is read again from the member record on each request, so a role change takes effect without waiting for the session to expire.
- Password is optional per member. The default is passkey-first: an invite creates the account, the join flow registers a passkey, and a password is offered only as a fallback. Passwords are hashed with scrypt or Argon2id; the hub never stores or displays them.
- Owner-issued recovery uses a one-time enrolment code, exactly like the current 10-minute code (`ENROL_TTL`), not a password reset link. Using a recovery code bumps the member's session epoch, which invalidates old sessions, and requires a new passkey or password at the next login.
- Existing installs migrate on first start: the current password, passkeys, and bearer token become the `owner` member. The owner's existing passkeys keep their current handle; every new member and every newly registered passkey gets a random per-member handle.

### Machine tokens

- Format `ekip_<tokenId>_<secret>`, shown once at creation. The hub stores only `sha256(secret)` and the lookup prefix. Comparison is constant-time.
- One token per machine, with a label such as `ada-macbook` or `ada-vps`. A laptop and a desktop do not share a token.
- Tokens are scoped. `member` tokens can read shared projects, write their own tasks, claims, and runs. `owner` tokens additionally manage members, invites, projects, and pools. A future `runner` scope can let a worker report a run without acting as a person; workers should not receive a member token at all.
- Revoking a token ends only that machine. Revoking a member ends every session and token for that person.

Commands:

```bash
ekip hub token add "ada-macbook"          # prints the token once
ekip hub token ls                         # labels, prefix, last used - never the secret
ekip hub token revoke <prefix>
```

### Join flow

The network and the account are separate gates. Both are needed.

1. **Network.** The owner either invites the person to the Tailscale tailnet or shares the hub node with them. Tailnet invites give access to the whole tailnet unless ACLs restrict it. Node sharing gives access to the hub device only. The recommended setup is a `tag:ekip-hub` node whose ACL accepts only the hub ports from member devices; members then reach `https://hub.<tailnet>.ts.net` and nothing else on the owner's network. A public hub works without Tailscale but should not be the default.
2. **Account.** The owner creates a single-use invite:

   ```bash
   ekip hub invite --name ada --role member --ttl 24h
   ```

   The printed code is short, unambiguous, and shown once. The hub stores only its hash. Invites default to `member`; creating an owner requires an explicit `--role owner` and is audited.
3. **Join.** On their own machine, after installing ekip:

   ```bash
   ekip hub join https://hub.example.com
   ```

   The command asks for the invite code and a display name, registers a passkey on that device, receives a machine token, and writes `hubUrl`, `hubToken`, `memberId`, and the name to `data/config.json`. It never writes them into a repository. It refuses plain HTTP except for `localhost` and verifies that the URL answers as a hub before creating anything.
4. **Finish.** The new member sees the shared projects on the board and can create tasks. The owner sees the join in the audit log and can suspend the member immediately.

Invite codes must not be sent through a channel that stores them longer than necessary. A code is a one-time credential, not a password.

### Leaving, suspension, and removal

- `ekip hub member suspend <member>` blocks new sessions and token use without deleting anything. Existing claims stay until released or expired; open tasks are marked `orphaned` and shown to the owner.
- `ekip hub member remove <member>` revokes sessions, tokens, passkeys, and invites; releases claims; reassigns or freezes open tasks; unsubscribes notifications; removes project access. Memory and code contributions stay, attributed to the member, because deleting them would change the shared history. A separate owner-only purge is described in section 7.
- The last active owner cannot leave or be removed. Ownership transfer is explicit: `ekip hub member promote <member>`.

## 2. Shared project knowledge

### Project identity

The hub owns the canonical project record. A project is identified by its name on the hub, with one memory agent, one wiki, and one code graph per project. Members do not create their own copies of those ids.

- `GET /api/projects` returns the canonical list. `ekip project add` on a member's machine looks up the project on the hub and reuses its `tdai` ids instead of creating new ones.
- `ekip hub push` stops sending `replace: true` unless the caller is an owner explicitly running `ekip hub push --replace`. A normal push merges fields for projects the member can write and never deletes another member's project.
- The project record gains `createdBy`, `members[]` (or `visibility`), and `updatedAt` per field. The default is hub-wide read for members and write access for the project's `members[]`; the owner can mark a project `private` to restrict reads.
- Dev credentials stay in the hub-only `devenv` store, as today, and are never returned by `GET /api/projects`. They are owner-managed and not shared with members by default.

### One memory per project, with provenance

Memory on the hub is already scoped per project; the missing parts are attribution and member access.

- Each record written by ekip carries the hub member and source: `lead`, `worker`, `import`, or `manual`. The hub stores a small side index `{ recordId, memberId, runId, kind, at }` next to the TDAI write so search results and the panel can say who contributed. Where the memory API accepts a per-user conversation identity, ekip uses a member-scoped user under the same team; where it does not, the side index is the source of truth.
- A member's personal memory lives in a separate agent (`personal-<member>`) and is not searched by project queries. The lead's own `genel` lessons stay personal.
- Imports (`ekip memory import-history`) are tagged with the member who ran them. Importing someone else's local sessions requires that person's machine or an export they provide; the hub never reaches into a member's home directory.
- Deleting a memory record requires the author or an owner, and is audited. Bulk deletion is a separate owner-only operation with a preview count.

### Reaching the shared memory

Today a lead's memory calls go to `127.0.0.1` ports fed by an SSH tunnel to the owner's hub. A joined member must not get SSH access to the owner's server. The hub therefore needs a small authenticated memory gateway:

- `POST /api/memory/*` accepts the member's machine token and forwards to the TDAI services with the hub's service key. The hub, not the client, sets the member and run headers; a client cannot claim another member in the body.
- The gateway checks that the member can read the project before any wiki, graph, or memory call, and that only the owner can create or delete a project's agents, wikis, and code graphs.
- `ekip hub join` writes a `memoryUrl` next to the hub URL. A member's memory module uses it instead of an SSH tunnel. If the gateway is not deployed, a member's memory is read-only through the panel; the owner can still run a local stack, but then it is not shared.
- Worker runs on the hub already pass `x-team-id`/`x-agent-id` to the proxy. Extend that with the member and run id, and use the same project access check as the gateway.

### What is committed under `.ekip/`

These files travel with the repository through normal review, so every member gets the same rules after a pull:

| File | Contents | Who edits |
|---|---|---|
| `.ekip/rules.md` | Non-negotiable project rules | Owner or member, through a pull request |
| `.ekip/lessons.md` | Corrections from real mistakes, one dated line each | Any member via `ekip project lesson`; conflicts keep both lines |
| `.ekip/acceptance.md` | Criteria every delivery is reviewed against | Any member; review-added criteria are marked |
| `.ekip/review.md` | Review profile: checks, gotchas, what the project cares about | Owner or member, regenerated deliberately |
| `.ekip/checks/` | Project check scripts that are safe to run | Owner or member; no live-service writes |
| `.ekip/dev.json` | Non-secret dev defaults shared by the team | Owner |

Agents must not rewrite these files silently during a review. A lesson added on a member's machine is committed on that member's branch and merged like any other change, so the lesson carries the author in git history.

### What stays personal

- Provider keys, CLI logins, passkeys, machine tokens, `data/config.json`.
- Local run logs, worktrees, `.codegraph/` indexes, capture queues.
- Draft skills in `data/skill-candidates/` and private lessons in `data/projects/<name>.lessons.md` when the project has no `.ekip/` folder.
- Notes kept outside the board. The shared board is visible to members; whether a task can be private is an open question in section 8.

Accepted project skills are shared by committing them to `.claude/skills/` in the repository, not by copying files between machines. Memory skills are shared because they live in the project agent.

## 3. Shared task board

### Task and run ownership

Add the member to both records. The hub derives it from the credential; the body's value is ignored or checked for equality.

```
task { id, project, title, status, owner, assignee?, lead, claims[], rev,
       createdAt, updatedAt, ... }
run  { id, taskId, project, owner, pool, status, startedAt, endedAt, ... }
```

- Task ids are namespaced at the source: `ada:g1x7...`. The existing id format `g<time><random>` stays the suffix. The `:` separator is already accepted by the hub's id regex, so old clients keep working; an unqualified id is assigned to the owner member during migration.
- `lead` remains the terminal identity from `leadId()` and is scoped under the member for display only. It is not an authorization boundary.
- `owner` is the member who created the task. `assignee` is the member currently expected to act on it; it defaults to the owner. Reassignment is explicit and audited.
- `rev` is an optimistic concurrency counter. A client sends the `rev` it last saw; the hub returns `409` with the current record instead of overwriting a newer change. Without this, two panel tabs or two members can silently clobber a task.

### Board and filters

- `GET /api/tasks?project=&owner=&assignee=&status=&since=` returns only what the caller may see. Default views: mine, project, everyone.
- Each person's lead shows their own tasks first. The project view groups by member and marks a task with whoever holds its claims.
- The panel gets a "People" view built from `POST /api/heartbeat`: member, device label, project, current task, pool, last seen. Hostnames are owner-visible detail and are shown to other members only as device labels.
- Presence is advisory. A member who closes a laptop does not lose a task; it goes stale after the configured interval and is labelled "no recent heartbeat", not reassigned.

### Notifications are per person

- A task event notifies its `owner`, its `assignee`, and members who currently hold a claim or added themselves as watchers. It does not notify the whole hub.
- Each member configures their own channels (local macOS notification, panel, later Telegram). Quiet hours, mute, and per-event choices are per member.
- Hub job failures notify the member whose task or job failed, not the owner of the hub.
- Message payloads carry the task title, project, status, and a panel link. They do not carry prompts, diffs, memory text, tokens, or dev credentials.

### Hand-off

`ekip task assign <id> <member>` moves the assignee and notifies both people. Claims stay with their holder until released, so the new assignee sees a warning and asks the holder to release. A lead can hand a task to a teammate without losing the task history.

## 4. Avoiding collisions

Two people editing the same files is the failure mode that costs the most. The hub becomes the place where a lead declares an area before dispatching work.

### Claims

```
claim { id, project, repo, branch, paths[], taskId, member,
        note, createdAt, renewedAt, expiresAt, state }
```

A lead declares the paths a task will touch before a worker starts:

```bash
ekip claim src/checkout/** src/cart/** --task ada:g1x7 --ttl 2h
ekip claim ls --project storefront-web
ekip claim release <id>
```

- Paths are repository-relative, support `*` and `**`, and are normalised before comparison. A claim is a lock on a set of paths, not on files that happen to be open.
- Claims can also be directory-level (`migrations/`, `package-lock.json`, generated clients) where a task changes many generated files.
- The claim records the branch, so the panel can show "ada is changing checkout on `ekip/ada/g1x7`".
- Claims are per member, not per machine. A member holding a claim on one machine may renew it from another.

### Overlap rules

| Situation | Result |
|---|---|
| No overlap | Claim granted, both claims recorded |
| Overlap with the same member's active claim | Idempotent; renew instead of a duplicate |
| Overlap with another member's active claim | `409` with holder, task, start time, and expiry; work does not start |
| Overlap with an expired claim | New claim granted; the old holder is notified |
| Owner overrides with `--force` | Claim granted, both members notified, audit entry records the override |
| Holder releases | Waiting members are notified; first to claim gets it |

A member who needs a path held by someone else must ask the holder to release it or wait for expiry. There is no silent steal, including for owners; `--force` is visible to everyone affected.

In phase 1 the hub only warns: the claim is shown on the board and in the lead's brief, but the command exits successfully. In phase 2 the same endpoint returns `409` and the client refuses to dispatch. This lets a team adopt claims before the workflow is fully enforced.

### Stale claims

- Default TTL is 2 hours, renewed by task updates or `ekip claim renew`.
- Fifteen minutes before expiry the holder is notified once. Members waiting on the claim are told it is about to expire.
- Expiry releases the claim. It does not delete the branch or the worktree.
- A claim whose task has been `done` or `failed` for more than 30 minutes is released even if its TTL has not passed.
- A claim is not released because a laptop is asleep. A running worker may be doing the work; the task heartbeat, not the claim renewal, is the signal.
- The owner can release a claim with `--force` after a notification to the holder; the action is audited.

### One branch per task, merge through review

- Every task gets its own branch, `ekip/<member>/<task-suffix>`, and its own worktree. Hub jobs switch from `ekip/job-<id>` to the same naming so local and hub runs look alike.
- Nobody works in someone else's worktree and nobody pushes to another member's branch. The shared branches are `main` and release branches.
- Integration goes through a pull request. The repository's protected branch rules do the merge; ekip does not need its own git server for this. `ekip ship` and the existing review flow stay the last gate.
- A CI check can ask the hub whether a pull request's changed files are covered by the author's claims:

  ```bash
  ekip claim check --base origin/main
  ```

  It fails on files outside the author's claims unless the author is an owner or the files changed only through a merge. This catches work that started before a claim was taken.
- Generated files and lockfiles are claimed broadly. A reviewer still checks that regeneration did not change unrelated output.

### Hub as the source of truth

- A claim is valid only after the hub acknowledges it. The local cache exists for display, not for permission.
- If the hub is unreachable, the lead warns loudly and continues without a shared claim in phase 1. In phase 2 a project can set `claims.required`; then dispatch is refused with "hub unreachable, no claim" rather than risking a collision. The setting is per project, because a solo side project does not need the same guarantee.
- Claim state changes are append-only in the audit log: granted, denied, renewed, expired, released, forced.

## 5. Quotas

### Default: everyone brings their own

- Provider logins, API keys, free pools, and CLI sessions stay on the member's machine. A worker dispatched from Ada's Mac uses Ada's quotas; Ben's work never consumes them.
- `limits` and `savings` become per-member collections keyed by `memberId`. `GET /api/limits` returns the caller's snapshot; the owner's panel can show all members. A member's usage never overwrites another's.
- `POST /api/heartbeat` already receives `{ client, host }`; add `memberId`, project, current task, and pool names. Usage rows carry both member and pool, so the panel can answer "who used which quota".
- A member can see their own usage in full and others' usage only as coarse availability (for example "Ben has a pool available"), unless the hub owner enables a shared view.

### Optional: shared pools

Some teams want a hub-owned pool so a laptop that is off can still run work, or so a rarely used subscription is shared. That is opt-in per pool.

```
pool { id, name, kind, owner, credentialsRef,
       policy { maxConcurrent, perMember { perHour, concurrent, dailyMinutes }, reserveOwner }
       members[] }
```

- The pool runs on the hub, under the hub's credentials, and never copies provider keys to member machines.
- Admission is per member. A request over a member's cap is rejected with the reset time; it is not silently queued forever. Surplus capacity goes to other members; the owner can reserve a slot.
- Every job records `member`, `pool`, and policy decision. If a provider reports tokens or cost, those are stored; if it does not, the panel shows requests and wall-clock time and labels cost "unknown" rather than inventing a number.
- Per-member caps apply to hub jobs. ekip cannot police what a member does in their own terminal, so personal usage is advisory by nature; the panel must say so.
- Sharing a provider account may violate its terms, and prompts from every member may be processed under one account. The join flow discloses this before a member uses a shared pool; the owner decides whether to create one.

### Panel

- Pools are grouped by member and by shared pool, with per-member caps and current usage.
- A failed admission shows the member, pool, cap, and reset time.
- Usage is attributed to the task and project, so the cost of a feature can be read without exposing prompts.

## 6. Telegram and phone

The panel already works on a phone through Tailscale with a passkey. Desktop notifications are local to the Mac that runs the lead. A messaging integration is new work; the goal is per-person delivery, not a team group chat.

### Pairing

```bash
ekip notify pair telegram
```

- The command asks the hub for a six-digit code valid for five minutes, single use, bound to the member, and prints the bot username.
- The member sends `/pair <code>` to the bot. The hub checks the code, stores `{ memberId, chatId, label, createdAt }`, and confirms on the phone and in the terminal.
- Unpairing is `ekip notify unpair telegram` or `/unpair`; it removes only that chat. Removing a member removes all their chats.
- The hub either uses long polling (outbound only, works behind Tailscale) or a webhook with a random path and a secret header on a public host. Long polling is the default because it needs no inbound port.
- The bot token is a hub secret in the environment, never in the repository or a member's settings.

### What the bot may do

| Command | Effect |
|---|---|
| `/tasks` | The caller's open tasks, grouped by project |
| `/task <id>` | Status, owner, claims, last update - no diff or memory text |
| `/status` | Pool availability and active work for the caller |
| `/answer <id> <text>` | Answer a blocked question on the caller's own task |
| `/mute 2h` | Pause notifications for that chat |
| `/unpair` | Remove the chat |

Writes are limited to the caller's own tasks. `/answer` requires the task to be waiting on that member and never accepts a secret; the bot replies with a link to the panel for anything larger. Rate limiting and a maximum message size apply per chat.

### Delivery rules

- Own tasks: created, blocked, failed, done.
- Shared tasks: only if the member holds a claim or is watching; no broadcast of every worker event.
- Mentions and direct hand-offs notify immediately, subject to mute.
- Quiet hours are per member and stored on the hub.
- Messages contain task titles and links. They do not contain prompts, diffs, logs, tokens, or memory content.
- Chat ids are personal data: stored on the hub, never logged in plain text, never committed, and deleted when the member is removed.

The phone panel remains the full view. Telegram is a notification and quick-answer channel, not a second panel.

## 7. Security and privacy

### Roles

| Action | Member | Owner |
|---|---|---|
| Read shared projects, memory, wiki, tasks, claims | Yes | Yes |
| Create tasks, runs, claims in shared projects | Own records | All |
| Edit or close another member's task | No (ask or reassign) | Yes, audited |
| Invite, suspend, remove members | No | Yes |
| Add or revoke machine tokens | Own only | All |
| Register or remove own passkeys | Yes | Yes |
| Manage project membership, dev credentials | No | Yes |
| Create or change shared pools and caps | No | Yes |
| Read audit log and export it | Own actions | All |
| Delete project or bulk-delete memory | No | Yes, with preview and `--yes` |

A member cannot change their own role, create an owner invite, or promote themselves. Object-level checks are required on every route: a member can read the board but can write only records they own or hold a claim on.

### What members can and cannot see

- Shared: project cards, `.ekip/` files in the repository, project memory and wiki, task titles and status, claim holders, run summaries.
- Not shared by default: personal memory, personal tasks, provider keys, dev credentials, other members' run logs, hub environment, audit entries for other people's auth.
- The owner can widen read access per project. Narrowing below "member of this project" is the default for private projects.
- Device hostnames, IP addresses, and chat ids are personal data. Show labels, store details only where needed, and keep them out of logs.

### Audit log

An append-only log on the hub, separate from tasks and runs:

```
{ at, actor, action, target, result, detail? }
```

Covered actions: login success and failure, passkey add/remove, invite create/use/revoke, token add/revoke, member join/suspend/remove/promote, project create/update/delete, claim grant/deny/renew/expire/force, task reassign, pool and cap changes, memory bulk delete.

- No secrets, tokens, passwords, prompts, or full IP addresses. A truncated or hashed IP is enough for abuse investigation.
- Monthly files, owner-readable in the panel, exportable as JSONL. Default retention is 90 days; security-relevant removals should be exportable before pruning.
- Audit writes must not be able to break the operation they describe; a failed audit write is reported to the owner, not silently dropped.

### Removing a member, concretely

1. Disable the member and bump their session epoch.
2. Revoke all tokens and passkeys; delete pending invites created by them.
3. Release claims; notify waiting members.
4. Reassign or freeze open tasks; mark runs as historical.
5. Remove project access and notification pairings.
6. Rotate any shared pool credential the member could use, and any secret they could read.
7. Keep memory and git history, attributed to the member, unless a separate purge is requested.
8. Record every step in the audit log.

The member may still have local copies of code and memory from before removal. The hub cannot erase those; say so in the removal confirmation.

### Threats to keep in mind

| Threat | Mitigation |
|---|---|
| Stolen laptop | Revoke that machine token and its passkeys; other machines stay signed in |
| Shared token leaked to a worker | Per-machine tokens, scoped tokens, no token in worker environment, revocation |
| Invite code intercepted | Single use, short TTL, hashed at rest, audit, no reuse after join |
| Malicious member | Least privilege, object-level checks, audit, claims, owner removal |
| Shared memory as prompt injection | Treat memory and imported text as untrusted data; provenance labels; workers never execute instructions found in memory |
| Hub outage | Local work continues, claims are advisory, panel shows stale state |
| Data leaving the team | Memory and shared pools may process text externally; disclose at join; personal memory stays separate |

### Data retention

Tasks, runs, and audit have caps and retention; memory is long-lived by design. The owner sets retention per category. A member can export their own tasks and memory contributions and ask for removal; removal is audited and does not rewrite other people's history.

## 8. Phases

Effort is a rough estimate for one developer who knows the codebase, including tests and docs. The first phase is the smallest useful product: two people, one project, no shared token, visible ownership, and warnings before obvious collisions.

| Phase | Scope | Effort | Done when |
|---|---|---|---|
| 1. Accounts and board | Member records, per-member passkeys and hashed machine tokens, invites and `hub join`, task/run owner, board filters, per-person notifications, `ekip hub push` merge fix, advisory claims, basic audit | 2 weeks | Two members join with their own credentials; each sees their own tasks; a push by one does not replace the other's projects; an overlapping claim produces a warning and a visible holder |
| 2. Enforced claims and branches | Claim denial, `--force` with audit, TTL and stale handling, one branch/worktree per task, claim check in review, project-level `claims.required` | 1-2 weeks | A second member cannot start work on a claimed area; an expired claim is released; every task merges through its own branch and review |
| 3. Shared knowledge | Hub memory gateway and `memoryUrl`, member attribution on memory and runs, per-member personal memory, canonical TDAI ids from the hub, project membership and read policy, `.ekip/` shared-edit conventions, skill approval | 3 weeks | A search result says who contributed it; a member's personal notes never appear in project search; a new member gets the same project context after joining |
| 4. Quotas | Per-member limits and savings, heartbeat attribution, optional shared pools with per-member caps, panel grouping, admission errors | 2 weeks | One member's usage no longer overwrites another's; a shared pool enforces a per-member cap and records who used it |
| 5. Channels and lifecycle | Telegram pairing and per-person routing, hand-off UX, member removal automation, audit export, retention controls | 1-2 weeks | A member pairs one chat and receives only their own task events; removal completes every step in section 7 with an audit trail |

Dependencies: phase 2 needs phase 1's identity; phase 3 needs phase 1's canonical project record; phase 4 can start after phase 1 but its panel work is easier after phase 2; phase 5 needs phases 1 and 2 for ownership and claim events.

### Where the work lands

| Area | Files |
|---|---|
| Members, sessions, tokens, invites | `hub/src/auth.js`, `hub/src/server.js`, `hub/src/webauthn.js`, `hub/src/auth.test.mjs` |
| Storage for members, tokens, invites, claims, audit, per-member limits | `hub/src/store.js` (new collections next to `projects`, `tasks`, `runs`, `clients`) |
| Routes, authorization, task/run ownership, filters, claim endpoints, project merge | `hub/src/server.js` |
| Job attribution, branch naming, claim checks | `hub/src/worker.js` |
| Join, token, invite, member, claim commands | `plugin/bin/ekip.js`, `plugin/lib/hub/` |
| Task ids, owner, assignee, `rev`, conflict handling, pane labels | `plugin/lib/tasks/tasks.js`, `plugin/lib/tasks/pane.js` |
| Memory gateway, authorship, personal scope, canonical TDAI ids | `hub/src/server.js`, `plugin/lib/memory/memory.js`, `plugin/lib/projects/projects.js` |
| Shared `.ekip/` conventions | `plugin/lib/projects/project-config.js`, `plugin/lib/review/criteria.js` |
| Board, people, claims, members, audit, per-member pools | `hub/web/src/features/tasks/`, `projects/`, `pools/`, `overview/`, plus routes under `hub/web/src/routes/_authenticated/` |

### Open questions

- **Tenancy.** Is one hub one team, or should projects and members be scoped to organisations now? Adding a tenant field later is cheaper than adding it after claims and audit exist.
- **Recovery.** Can a member recover without the owner? Passkey-only is safer but assumes a second device or a synced passkey.
- **Claim granularity.** Are paths enough for a monorepo, or are symbol-level claims needed? Renames and generated files need an explicit policy.
- **Merge authority.** Does the hub need to host git, or is a protected branch on an external forge enough? The current worker clone model suggests the latter.
- **Shared pools and terms.** Does sharing one provider account violate its terms, and who accepts that risk? This must be answered before phase 4 ships.
- **Memory deletion.** What does "delete my contribution" mean when a fact was merged into a summary or wiki page that others rely on?
- **Offline work.** Should `claims.required` be default-on for shared projects, and how loudly should a hub outage block dispatch?
- **Private tasks.** Should a member be able to keep a task off the shared board while still using shared memory and quotas?
- **Notifications.** Telegram only, or a generic webhook and an ntfy-style push channel? A generic channel avoids tying the design to one service.
- **Effort estimates.** The numbers above are unvalidated; the first phase should be re-estimated after the auth and store changes are understood in code.

### Out of scope

Organisation-wide SSO, SCIM, public sign-up, multi-tenant billing, a browser IDE, and a replacement for GitHub or GitLab review. Those are separate products; this document only makes one hub safe for a small team.
