# ekip hub

Always-on service for the VPS: runs ekip worker jobs while the Mac is off and serves the control
panel at https://ai.sazora.io. Node 22, built-ins only; state in JSON files under `/data`.

## What it does

- **Jobs**: `POST /api/jobs {project, task, push?, model?}` → clones the project's GitHub repo into
  `/data/work/<project>`, creates worktree branch `ekip/job-<id>` from the default branch, runs
  `claude --bare -p` there (through the TDAI memory proxy with the project's `x-team-id`/`x-agent-id`,
  or straight to freellmapi when TDAI is down or the project has no TDAI ids), commits the changes as
  `ekip-hub <ekip@sazora.io>` and pushes the branch when `push` is true. Log: `/data/jobs/<id>.log`.
- **Registry and reports from the Mac**: `PUT /api/projects`, `POST /api/runs`, `POST /api/heartbeat`.
- **Panel** (`/`): Durum, Projeler, İşler, Çalıştırmalar. Password login → session cookie.

All `/api/*` calls need `Authorization: Bearer $EKIP_HUB_TOKEN` (or the panel's session cookie plus
the `X-Ekip-Csrf: 1` header for writes).

## API

| method | path | body / notes |
|---|---|---|
| GET | `/api/status` | freellmapi readiness + providers, TDAI health, queue counts, workers, Mac clients |
| GET / PUT | `/api/projects` | PUT: `[{name, repo, repos?, summary, card, tdai:{teamId,agentId,wikiId,codeGraphId}}]` (upsert by name) or `{projects, replace:true}` |
| DELETE | `/api/projects/:name` | |
| POST | `/api/jobs` | `{project, task, via?:"free", model?, push?:true}` |
| GET | `/api/jobs`, `/api/jobs/:id` | `:id` includes `log` (tail), `report`, `branch`, `diffstat` |
| POST | `/api/jobs/:id/cancel` | queued or running |
| POST / GET | `/api/runs` | `{id, via, project, task, status, report, startedAt, finishedAt}` (upsert by id) |
| POST | `/api/heartbeat` | `{client, host, agents:[...]}` |

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
5. Traefik dynamic file: route `Host(\`ai.sazora.io\`)` to `http://ekip-hub:7777` on the `coolify`
   network, TLS via your resolver.

Local test without compose:

```sh
docker build -t ekip-hub .
docker run -d --name ekip-hub-test --env-file test.env -v "$PWD/tmpdata:/data" -p 127.0.0.1:7777:7777 ekip-hub
```
