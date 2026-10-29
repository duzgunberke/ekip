// Pool capacity: with fake run logs and fake worker CLIs on PATH, --via auto skips a pool that is
// already running as many workers as its capacity, and takes it back once its run has exited.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-agents-test-"));
const home = path.join(tmp, "home"), bin = path.join(tmp, "bin"), runs = path.join(home, "runs");
fs.mkdirSync(runs, { recursive: true });
fs.mkdirSync(bin);
for (const b of ["codex", "copilot"]) { fs.writeFileSync(path.join(bin, b), "#!/bin/sh\n"); fs.chmodSync(path.join(bin, b), 0o755); }
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
  autoOrder: ["codex", "copilot"], agents: { codex: { ok: true }, copilot: { ok: true } }, poolConcurrency: { codex: 1, copilot: 2 },
}));
process.env.EKIP_HOME = home;
process.env.PATH = `${bin}:/usr/bin:/bin`;
const { autoOrder, runningByPool, poolCapacity, freePools } = await import("./agents.js");

const log = (name, body) => fs.writeFileSync(path.join(runs, name), `cwd: /tmp\nproject: -\nlabel: -\npid: ${process.pid}\ntask:\nx\n\n${body}`);
try {
  assert.deepEqual(autoOrder(), ["codex", "copilot", "free"]);
  assert.equal(poolCapacity("claude"), 0);

  // an auto run that is on codex right now (its mark, no [exit], this process is alive)
  log("2026-01-01T10-00-00-000Z-auto.log", "[ekip pool codex]\n$ codex exec ...\nworking\n");
  assert.deepEqual(runningByPool(runs), { codex: 1 });
  assert.deepEqual(autoOrder(), ["copilot", "free"], "codex is at capacity 1/1");
  assert.ok(!freePools().includes("codex"));

  // a dead pid does not count
  fs.writeFileSync(path.join(runs, "2026-01-01T10-00-01-000Z-copilot.log"), "pid: 999999\ntask:\nx\n\n[ekip pool copilot]\n");
  assert.equal(runningByPool(runs).copilot, undefined);

  // two copilot races fill copilot (2/2): every pool is full, so the least busy come first
  log("2026-01-01T10-00-02-000Z-copilot+codex-copilot.log", "$ copilot -p ...\n");
  log("2026-01-01T10-00-03-000Z-copilot.log", "[ekip pool copilot]\n");
  log("2026-01-01T10-00-04-000Z-free.log", "[ekip pool free]\n[ekip pool free]\n");
  for (const i of [5, 6]) log(`2026-01-01T10-00-0${i}-000Z-free.log`, "[ekip pool free]\n");
  assert.deepEqual(runningByPool(runs), { codex: 1, copilot: 2, free: 3 });
  assert.deepEqual(autoOrder(), ["codex", "copilot", "free"]);

  // the codex run exits: codex is open again
  fs.appendFileSync(path.join(runs, "2026-01-01T10-00-00-000Z-auto.log"), "done\n[exit 0]\n");
  assert.deepEqual(autoOrder(), ["codex", "free"]);
  console.log("agents capacity tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
