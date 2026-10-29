---
name: ekip-dev-env
description: Use when tests, migrations, or workers need a project's development database, Redis, or other safe dev/test/UAT services.
---

# Use a safe development environment

1. Prefer the user's existing development, test, or UAT environment when it is

   intentionally provided through MCP servers or project connection settings.
2. Confirm it is a non-production target before running tests or migrations. Do

   not infer safety from a variable name alone.
3. ekip can host development Postgres and Redis resources on the user's server.

   Initialize once with `ekip dev init --postgres UUID [--superuser NAME]
   [--secrets FILE] [--redis UUID]`.
4. Inspect configured projects with `ekip dev ls`.

5. Map a registered project to an isolated development database with `ekip dev

   add PROJECT [--db NAME]`.
6. Start the environment with `ekip dev up PROJECT`. This writes

   `.env.ekip-dev` in the project root and opens a local tunnel.
7. Load those settings in a worker shell with `set -a; source .env.ekip-dev;

   set +a`.
8. `ekip dev env PROJECT --shell` prints shell exports; credentials are masked

   by default.
9. For a quick query, use `ekip dev sql PROJECT "SELECT ..."`; use `ekip dev

   psql PROJECT` for an interactive session.
10. Use `ekip dev reset PROJECT --yes` only when the requested reset should

   discard that project's development data.
11. Run `ekip dev down` when work is finished to close the tunnel.

12. Never use production URLs from project `.env` files for tests or migrations.

   Never pass production resource IDs to dev setup.
13. If a project already has a safe external environment, do not overwrite it

   with an unrelated ekip dev target; use its approved connection method.
14. Hub workers need their dev credentials configured on the hub; local

   `.env.ekip-dev` is not automatically a remote secret store.
15. If the service is slow, inspect health and logs before treating it as down.

   Do not migrate or reset production to diagnose it.
16. “Done” means commands used a verified non-production endpoint, destructive
   resets were explicit, and any tunnel started for the task was closed.
