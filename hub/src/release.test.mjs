// node hub/src/release.test.mjs: the release state read from the CI directory, and GET /api/release
// (plus the task result/ask fields) on a hub started in a temporary data directory.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { releaseInfo } from "./release.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ekip-release-"));
const MAIN = "abc1234def5678abc1234def5678abc1234def56";

test("no CI data: nothing under test, no main", () => {
  assert.deepEqual(releaseInfo(tmp(), { commit: "abc1234" }), { version: null, main: null, ci: null, testing: false, hub: { commit: "abc1234", version: null, startedAt: null } });
});

test("main taken by the poller, no result yet: under test", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "last-sha"), `${MAIN}\n`);
  const r = releaseInfo(dir);
  assert.equal(r.main.sha, MAIN);
  assert.ok(r.main.at);
  assert.equal(r.testing, true);
});

test("result for an older commit: main is still under test", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "last-sha"), MAIN);
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ status: "pass", step: "all", sha: "0000000", log: "x".repeat(100) }));
  const r = releaseInfo(dir);
  assert.equal(r.testing, true);
  assert.equal(r.ci.sha, "0000000");
  assert.equal(r.ci.log, undefined, "the log tail is not part of the release state");
});

test("result for main: tested, with its status", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "last-sha"), MAIN);
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ status: "fail", step: "smoke test", sha: MAIN.slice(0, 7), finishedAt: "2026-10-30T10:00:00Z" }));
  const r = releaseInfo(dir);
  assert.equal(r.testing, false);
  assert.deepEqual([r.ci.status, r.ci.step], ["fail", "smoke test"]);
});

test("garbage in the CI files is ignored", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "last-sha"), "not a sha");
  fs.writeFileSync(path.join(dir, "result.json"), "{");
  assert.deepEqual(releaseInfo(dir), { version: null, main: null, ci: null, testing: false, hub: { commit: null, version: null, startedAt: null } });
});

test("release tags come from the poller's mirror", () => {
  const dir = tmp(), src = path.join(dir, "src");
  const git = (...a) => { const r = spawnSync("git", a, { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "main", src);
  const commit = (msg) => { git("-C", src, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", msg); return git("-C", src, "rev-parse", "HEAD"); };
  const first = commit("a");
  git("-C", src, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "tag", "-a", "v1.9.0", "-m", "v1.9.0");
  commit("b");
  git("-C", src, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "tag", "-a", "v1.10.0", "-m", "v1.10.0");
  git("clone", "-q", "--bare", src, path.join(dir, "mirror.git"));
  const r = releaseInfo(dir, { commit: first.slice(0, 7) });
  assert.equal(r.version, "v1.10.0", "sorted as versions, not as text");
  assert.equal(r.hub.version, "v1.9.0");
});

test("hub serves GET /api/release and keeps task result/ask", async (t) => {
  const data = tmp(), ci = path.join(data, "ci-state");
  fs.mkdirSync(ci);
  fs.writeFileSync(path.join(ci, "last-sha"), MAIN);
  const token = "test-token-0123456789abcdef";
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", EKIP_DATA: data, EKIP_CI_DIR: ci, EKIP_HUB_TOKEN: token, EKIP_HUB_PASSWORD: "test-password-123", EKIP_HUB_COMMIT: MAIN.slice(0, 7), EKIP_WORKERS: "1", FREELLMAPI_URL: "", TDAI_PROXY_URL: "", KNOWLEDGE_URL: "http://127.0.0.1:9" },
    stdio: "ignore",
  });
  t.after(() => server.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`, auth = { authorization: `Bearer ${token}` };
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }

  assert.equal((await fetch(`${base}/api/release`)).status, 401, "the release state needs the token");
  const r = await (await fetch(`${base}/api/release`, { headers: auth })).json();
  assert.equal(r.main.sha, MAIN);
  assert.equal(r.testing, true);
  assert.equal(r.hub.commit, MAIN.slice(0, 7));
  assert.ok(r.hub.startedAt);

  const task = { id: "g1", title: "x", status: "running", steps: [{ title: "a", status: "waiting-user", rate: "1 MB/s" }], notes: [],
    ask: { question: "Yeniden üretelim mi?", options: ["Evet", "Hayır"], at: "2026-10-30T10:00:00Z" },
    result: { text: "Rapor hazır", links: ["docs/r.md", "https://example.com/r"], at: "2026-10-30T10:00:00Z", auto: true },
    answers: [{ question: "q", answer: "a", at: null }] };
  assert.equal((await fetch(`${base}/api/tasks`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(task) })).status, 201);
  const back = await (await fetch(`${base}/api/tasks/g1`, { headers: auth })).json();
  assert.deepEqual(back.ask.options, ["Evet", "Hayır"]);
  assert.deepEqual(back.result, task.result);
  assert.equal(back.steps[0].rate, "1 MB/s");
  assert.equal(back.answers[0].answer, "a");
  const badAnswers = await fetch(`${base}/api/tasks`, { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ...task, answers: { no: 1 } }) });
  assert.equal(badAnswers.status, 200, "answers that are not a list are dropped, not a crash");
});
