# ekip hub

Always-on service for the VPS: runs ekip worker jobs while the Mac is off and serves the control
panel at your own domain (e.g. https://ai.example.com). Node 22, built-ins only; state in JSON files under `/data`.

## What it does

- **Jobs**: `POST /api/jobs {project, task, push?, model?}` → clones the project's GitHub repo into
  `/data/work/<project>`, creates worktree branch `ekip/job-<id>` from the default branch, runs
  `claude --bare -p` there (through the TDAI memory proxy with the project's `x-team-id`/`x-agent-id`,
  or straight to freellmapi when TDAI is down or the project has no TDAI ids), commits the changes as
  `ekip-hub` (set `EKIP_GIT_EMAIL` for the commit email) and pushes the branch when `push` is true. Log: `/data/jobs/<id>.log`.
- **Registry and reports from the Mac**: `PUT /api/projects`, `POST /api/runs`, `POST /api/heartbeat`.
- **Panel** (`/`): React SPA in `web/` (based on shadcn-admin, see `web/UPSTREAM.md`), built into
  `public/` by the Docker image: Görevler (live task progress, default page), Genel bakış, Projeler,
  Kod haritası, İşler, Çalıştırmalar, Havuzlar, Paneller. Password + passkey login → session
  cookie (see [Panel sign-in](#panel-sign-in-password--passkey)).
  Local dev: `cd web && pnpm install && pnpm dev` (proxies the API to `EKIP_HUB_DEV_URL`,
  default http://127.0.0.1:7799); `pnpm build` writes `../public`.

All `/api/*` calls need `Authorization: Bearer $EKIP_HUB_TOKEN` (or the panel's session cookie plus
the `X-Ekip-Csrf: 1` header for writes). Without either, every path answers a bare `404 not found`
(no `401`, no panel, no branding); only `/login`, `/sign-in`, `/assets/*` and `/healthz` exist for a
stranger.

## Panel sign-in: password + passkey

A stolen password alone does not open the panel. Sign-in is two steps:

1. `POST /login {password}`. Before any passkey exists (and without `EKIP_HUB_REQUIRE_PASSKEY=1`)
   this still opens a session, as before. Otherwise it only sets a 5-minute `ekip_login` ticket and
   answers `{ok, next: "passkey" | "enrol"}`.
2. The passkey (Touch ID, iCloud Keychain, a security key): `POST /login/passkey/options` and
   `/login/passkey/verify`. The session cookie names the passkey that opened it: removing that
   passkey ends its sessions, and password-only sessions end when the first passkey is registered.
   Session lifetime is still `EKIP_SESSION_HOURS`.

**Enrolment.** The first passkey needs a one-time code from a machine that holds the hub token:

```sh
ekip hub passkey add      # prints a code (single use, 10 minutes) and https://ai.example.com/sign-in?enrol=CODE
```

Open the address on the device that should hold the passkey, enter the password, and save the
passkey (`/login/enrol/options`, `/login/enrol/verify`: password + code + the passkey ceremony; the
code is spent on the first attempt). The same command adds a passkey for a new device later. A
session opened with a passkey can also add one directly (command palette → "Add a passkey on this
device"); a password alone never can. Codes live in the hub's memory, so a restart voids them.

`ekip hub passkey list` shows them, `ekip hub passkey remove <id>` (an id prefix is enough) deletes
one. Removing the last passkey turns the requirement off again unless `EKIP_HUB_REQUIRE_PASSKEY=1`.
Lost every device? `ekip hub passkey add` on the Mac and register a new one.

Passkeys are stored as public keys in `/data/passkeys.json`. WebAuthn checks run on `node:crypto`
alone (ES256, EdDSA, RS256; "none" attestation), keeping the hub free of npm dependencies. The
relying party is the request's host unless `EKIP_HUB_ORIGIN` / `EKIP_HUB_RP_ID` pin it (recommended
behind a proxy); a passkey only works on the host name it was registered on, and on `localhost`
for `ekip hub local`, not on a bare IP address. Failed passwords, codes and passkeys count toward
the same per-IP and global login throttle.

## API

| method | path | body / notes |
|---|---|---|
| GET | `/api/passkeys` | `{required, passkeys:[{id, name, createdAt, lastUsedAt, transports, via}]}` (no key material) |
| POST | `/api/passkeys/code` | token only: a one-time enrolment code `{code, expiresAt, path}` (`ekip hub passkey add`) |
| DELETE | `/api/passkeys/:id` | token or a passkey session; an unambiguous id prefix works |
| POST | `/api/passkeys/register/options`, `/register/verify` | a passkey session adds another passkey |
| GET | `/api/status` | freellmapi readiness + providers, TDAI health, queue counts, workers, Mac clients |
| GET / PUT | `/api/projects` | PUT: `[{name, repo, repos?, summary, card, tdai:{teamId,agentId,wikiId,codeGraphId,codeGraphs:[{repo,id,branch,private,status}]}}]` (upsert by name) or `{projects, replace:true}` |
| DELETE | `/api/projects/:name` | |
| POST | `/api/jobs` | `{project, task, via?:"free", model?, push?:true}` |
| GET | `/api/jobs`, `/api/jobs/:id` | `:id` includes `log` (tail), `report`, `branch`, `diffstat` |
| POST | `/api/jobs/:id/cancel` | queued or running |
| POST / GET | `/api/runs` | `{id, via, project, task, status, report, host?, startedAt, finishedAt}` (upsert by id) |
| POST | `/api/heartbeat` | `{client, host, agents:[...]}` |
| PUT | `/api/tasks` | live task from the Mac: `{id, title, project, status, createdAt, updatedAt, endedAt?, steps[], workers[], notes[], pct, eta, host, result?, ask?, answers?}` (upsert by id; last 500 kept) |
| GET | `/api/tasks`, `/api/tasks/:id` | newest first; a task may carry `result {text, links[], at, auto}` (what it produced), `ask {question, options[], at}` (the decision it waits for) and `answers[]` |
| GET | `/api/ci` | the last fresh-install result of ekip's own CI (`result.json` in `EKIP_CI_DIR`, default `$EKIP_DATA/ci`) |
| GET | `/api/release` | `{version, main {sha, at}, ci {status, step, sha, startedAt, finishedAt}, testing, hub {commit, version, startedAt}}`: main's last commit as the CI poller saw it, whether it is under test, the newest release tag and the commit this hub runs (`EKIP_HUB_COMMIT` or build arg `SOURCE_COMMIT`) |
| PUT / GET | `/api/usage` | PUT: knowledge usage summary from `ekip stats` / `ekip doctor` (`{days, totals, daily[], projects[]}`, max 500 KB, stored in `usage.json`); GET returns it or `null` |
| PUT / GET | `/api/limits` | PUT: latest Mac worker/provider/routing snapshot (JSON object, max 500 KB); GET returns the snapshot or `null` |
| GET | `/api/projects/:name/repos` | GitHub metadata per repo (branches, languages, open PRs); server-side `GITHUB_TOKEN`, cached 10 min |
| GET | `/api/projects/:name/graph?repo=` | file tree: TencentDB code graph (`tdai.codeGraphs`, via `KNOWLEDGE_URL`) merged with GitHub's git tree |
| GET | `/api/projects/:name/symbols?repo=&file=` | top symbols of one file from the code graph |

`repo` is `owner/name`, `github.com/owner/name`, `https://github.com/owner/name(.git)` or
`git@github.com:owner/name.git`.

## Deploy (VPS)

1. TDAI stack running via its own scripts (network `tdai-memory-stack`, container `tdai-proxy`).
   Point its `.env` LLM settings at `http://freellmapi:3001` (`MEMORY_LLM_BASE_URL=http://freellmapi:3001/v1`,
   `PROXY_UPSTREAM_URL=http://freellmapi:3001`, keys = freellmapi's unified key).
2. Coolify installed (network `coolify` exists).
3. In this folder:
   ```sh
   cp .env.example .env                     # fill in; chmod 600 .env
   cp freellmapi.config.example.json freellmapi.config.json
   chmod 644 freellmapi.config.json         # read by uid 1000 inside the container
   docker compose up -d --build
   ```
4. First run of freellmapi: open its dashboard through an SSH tunnel
   (`ssh -L 3001:127.0.0.1:3001 vps`, http://127.0.0.1:3001), create the account, copy the unified
   API key into `FREELLMAPI_KEY`, then `docker compose up -d ekip-hub`.
5. Traefik dynamic file: route `Host(\`ai.example.com\`)` to `http://ekip-hub:7777` on the `coolify`
   network, TLS via your resolver.

Local test without compose:

```sh
docker build -t ekip-hub .
docker run -d --name ekip-hub-test --env-file test.env -v "$PWD/tmpdata:/data" -p 127.0.0.1:7777:7777 ekip-hub
```
