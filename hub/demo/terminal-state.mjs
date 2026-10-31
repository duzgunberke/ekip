// Demo state for ekip's terminal screenshots: a throw-away EKIP_HOME with tasks (one running, one
// waiting for you, one stuck, one finished), a tracked upload, worker logs and two "ready" pools.
// Nothing is read from the user's own data.
//
//   node hub/demo/terminal-state.mjs DIR [busy|empty|pools] [pid]   (pid: a live process the demo workers belong to)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function writeDemoState(home, { scene = "busy", pid = process.pid } = {}) {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const min = (m) => m * 60_000;
  for (const d of ["tracks", "runs", "bin"]) { fs.rmSync(path.join(home, d), { recursive: true, force: true }); fs.mkdirSync(path.join(home, d), { recursive: true }); }
  for (const b of ["codex", "copilot"]) { fs.writeFileSync(path.join(home, "bin", b), "#!/bin/sh\nexit 0\n"); fs.chmodSync(path.join(home, "bin", b), 0o755); }
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ agents: { codex: { ok: true }, copilot: { ok: true } }, autoOrder: ["codex", "copilot"], terminal: "wezterm", lang: "en" }));
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify(["payments-api", "ios-app", "docs-site", "data-pipeline", "storefront-web"].map((name) => ({ name, path: path.join(home, "code", name) }))));
  for (const name of ["payments-api", "ios-app", "docs-site", "data-pipeline", "storefront-web", "northwind-storefront-checkout-experience"]) fs.mkdirSync(path.join(home, "code", name), { recursive: true });
  fs.writeFileSync(path.join(home, "release-status.json"), JSON.stringify({ at: iso(0), version: "1.5.0", latest: "1.5.0", behind: false }));
  const runName = (agoMin, via) => `${iso(-min(agoMin)).slice(0, 19).replace(/:/g, "-")}.000Z-${via}.log`;
  const run = (name, via, project, label, taskId, lines) => {
    fs.writeFileSync(path.join(home, "runs", name), `cwd: ~/code/${project}\nproject: ${project}\nlabel: ${label}\ntaskId: ${taskId}\npid: ${pid}\ntask:\n${label}\n\n[ekip pool ${via}]\n${lines.join("\n")}\n`);
    return path.join(home, "runs", name);
  };
  const step = (title, status, extra = {}) => ({ title, status, ...(["running", "blocked", "waiting-user"].includes(status) ? { startedAt: iso(-min(4)), progressAt: iso(-20_000) } : {}), ...extra });
  const task = (id, title, project, agoMin, steps, more = {}) => ({ id, title, project, status: "running", createdAt: iso(-min(agoMin)), updatedAt: iso(-15_000), p0: 0, p0At: iso(-min(agoMin)), steps, workers: [], notes: [], ...more });
  const done = (id, title, project, agoMin, result) => ({ ...task(id, title, project, agoMin + 20, [step("Do it", "done")]), status: "done", endedAt: iso(-min(agoMin)), updatedAt: iso(-min(agoMin)), result: { text: result, links: [] } });

  let tasks;
  if (scene === "empty") {
    tasks = [
      done("g7k1aa", "Add rate limits to the public API", "payments-api", 12, "token bucket per API key, 429 with Retry-After; 14 tests pass"),
      done("g7k1ab", "Upload the release build", "storefront-web", 40, "1.4 GB on the CDN, checksum verified"),
      done("g7k1ac", "Document the rate limits", "docs-site", 95, "rate limit page with three examples, preview deployed"),
    ];
  } else {
    const codexLog = run(runName(7, "codex"), "codex", "payments-api", "Token bucket per API key", "g7k2xa", ["reading src/http/middleware.go", "edited src/ratelimit/bucket.go"]);
    const trackId = `${iso(-min(2)).replace(/[:.]/g, "-")}-track`;
    const trackLog = path.join(home, "runs", `${trackId}.log`);
    fs.writeFileSync(trackLog, "$ ./scripts/upload.sh\nupload 52%\n");
    fs.writeFileSync(path.join(home, "tracks", `${trackId}.json`), JSON.stringify({ id: trackId, label: "Upload release build", cmd: "./scripts/upload.sh", taskId: null, pid, status: "running", startedAt: iso(-min(2)), createdAt: iso(-min(2)), log: trackLog, lastLine: "upload 52%", pct: 52, rate: "11.2 MB/s", etaAt: iso(min(1.2)), detail: "745 MB / 1.4 GB · 11.2 MB/s" }));
    tasks = [
      task("g7k2xa", "Add rate limits to the public API", "payments-api", 11, [
        step("Read the API routes", "done"),
        step("Token bucket per API key", "running", { pct: 70, detail: "go test ./src/ratelimit/... ok" }),
        step("Tests for 429 answers", "pending"),
        step("Review and merge", "pending"),
      ], { workers: [{ runId: path.basename(codexLog), via: "codex", label: "Token bucket per API key", pid, status: "running", startedAt: iso(-min(7)), log: codexLog }] }),
      task("g7k4ma", "Submit iOS v2.4 for review", "ios-app", 9, [step("Build and sign v2.4", "done"), step("Submit for review", "waiting-user", { reason: "Submit now, or after the paywall test?" })], {
        ask: { question: "Submit v2.4 for review now, or after the paywall test ends?", options: ["Submit now", "Wait for the test"], at: iso(-30_000) },
        hold: { kind: "waiting-user", reason: "Submit v2.4 now, or after the paywall test?", at: iso(-30_000), step: 2 },
      }),
      task("g7k6qd", "Backfill the demand forecast", "data-pipeline", 6, [step("Backfill 90 days", "blocked", { reason: "BigQuery quota resets at 18:00" })], { hold: { kind: "blocked", reason: "BigQuery quota resets at 18:00", at: iso(-min(1)), step: 1 } }),
      { ...done("g7k3pb", "Document the rate limits", "docs-site", 0.2, "rate limit page with three examples, preview deployed"), endedAt: iso(-10_000), updatedAt: iso(-10_000) },
      done("g7k1ab", "Migrate auth to passkeys", "payments-api", 90, "passkey sign-in and recovery merged"),
    ];
  }
  if (scene === "pools") pools(home, { iso, min, pid, run, runName });
  fs.writeFileSync(path.join(home, "tasks.json"), JSON.stringify(tasks, null, 2));
  return home;
}

// The pools row: three connected worker pools (one running, one ready, one limited) and the free pool
// with the providers behind it (one resting), a running free worker on NVIDIA, the background
// embedding work, and one missing setup step. Keys are fake rows in a throw-away freellmapi database.
function pools(home, { iso, min, pid, run, runName }) {
  for (const b of ["agy", "codex", "copilot"]) { fs.writeFileSync(path.join(home, "bin", b), "#!/bin/sh\nexit 0\n"); fs.chmodSync(path.join(home, "bin", b), 0o755); }
  const free = path.join(home, "freellmapi");
  fs.mkdirSync(path.join(free, "server/data"), { recursive: true });
  spawnSync("sqlite3", [path.join(free, "server/data/freeapi.db"), "create table if not exists api_keys(platform text, enabled int); delete from api_keys; insert into api_keys values ('nvidia',1),('google',1),('groq',1),('openrouter',1);"]);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  cfg.agents = { agy: { ok: true }, codex: { ok: true }, copilot: { ok: true, limitUntil: iso(min(60 * 26)), limitMessage: "monthly limit reached", limitAt: iso(-min(30)) } };
  cfg.autoOrder = ["agy", "codex", "copilot"];
  cfg.freellmapiDir = free;
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
  run(runName(3, "free"), "free", "docs-site", "Changelog for v2.4", "g7k3pb", ["drafting CHANGELOG.md"]);
  const at = Date.now();
  fs.writeFileSync(path.join(home, "freellmapi-routing-last.json"), JSON.stringify({ at, rs: {
    platforms: {
      nvidia: { models: 17, cooling: 0, ok24: 1762, fail24: 40, lastError: null },
      google: { models: 15, cooling: 0, ok24: 84, fail24: 15, lastError: null },
      groq: { models: 7, cooling: 7, ok24: 31, fail24: 60, lastError: "429: rate limit", coolUntil: at + min(12) },
      openrouter: { models: 10, cooling: 0, ok24: 10, fail24: 8, lastError: null },
    },
    profiles: {}, recent: { platform: "nvidia", model: "nvidia/nemotron-3-super-120b-a12b", status: "success", at: iso(-20_000) },
    embeddings: { nvidia: { model: "nvidia/nemotron-3-embed-1b", ok24: 3343, fail24: 4, lastOkAt: iso(-40_000), lastAt: iso(-40_000), lastStatus: "success", lastError: null } },
  } }));
  fs.writeFileSync(path.join(home, "vectors-status.json"), JSON.stringify({ at, missing: 0, never: false, layer: "L1", done: 1240, total: 1600, running: true, queue: 360 }));
  const step = (id, level, short, done) => ({ id, level, title: short, short, why: "", command: "", done, detail: null });
  fs.writeFileSync(path.join(home, "setup-state.json"), JSON.stringify({ at, lang: "en", steps: [
    step("prereqs", "required", "prerequisites", true), step("services", "required", "services", true), step("keys", "required", "model keys", true),
    step("embeddings", "required", "embeddings", true), step("agents", "required", "worker logins", true), step("project", "required", "project", true),
    step("index", "required", "memory index", false), step("terminal", "recommended", "terminal", true), step("notify", "recommended", "notifications", false),
  ] }));
  void pid;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, scene = "busy", pid] = process.argv.slice(2);
  if (!dir) { console.error("usage: node hub/demo/terminal-state.mjs DIR [busy|empty] [pid]"); process.exit(2); }
  writeDemoState(path.resolve(dir), { scene, pid: pid ? Number(pid) : process.pid });
}
