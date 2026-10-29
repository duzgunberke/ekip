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
const { autoOrder, runningByPool, poolCapacity, freePools, lastQuotaHit, parseResetIn } = await import("./agents.js");

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

  // quota attribution: every test starts from empty run logs
  const reset = () => { for (const f of fs.readdirSync(runs)) fs.rmSync(path.join(runs, f)); };
  const body = (pool, text, exit) => `[ekip pool ${pool}]\n$ ${pool} run\n${text}\n[exit ${exit}]\n`;
  const stamp = (n) => `2026-02-01T10-00-0${n}-000Z`;

  // reset-time parsing (item 14)
  assert.equal(parseResetIn("Resets in 140h45m18s"), (140 * 3600 + 45 * 60 + 18) * 1000);
  assert.equal(parseResetIn("Resets in 2h 45m"), (2 * 3600 + 45 * 60) * 1000);
  assert.equal(parseResetIn("Resets in 5 days"), 5 * 86400_000);
  assert.equal(parseResetIn("resets in 3d"), 3 * 86400_000);
  assert.equal(parseResetIn("Resets in soon"), null);
  assert.equal(parseResetIn("Resets in "), null);

  // multi-pool auto log (item 2): codex hit its quota, agy then succeeded
  reset();
  log(`${stamp(1)}-auto.log`, `${body("codex", "ERROR: You've hit your usage limit. Resets in 2h 45m", 1)}${body("agy", "all done", 0)}`);
  const hit = lastQuotaHit("codex");
  assert.ok(hit, "codex quota hit is attributed from the auto log");
  assert.match(hit.message, /hit your usage limit/);
  const left = new Date(hit.resetAt).getTime() - Date.now();
  assert.ok(left > 2.5 * 3600_000 && left < 3 * 3600_000, "reset parsed from '2h 45m'");
  assert.equal(lastQuotaHit("agy"), null, "agy's own segment succeeded");

  // the later success of the same pool clears it (own segment exit)
  log(`${stamp(2)}-auto.log`, body("codex", "fine", 0));
  assert.equal(lastQuotaHit("codex"), null);

  // race children are matched by their own pool, not by substring (item 3)
  reset();
  log(`${stamp(1)}-agy+codex-codex.log`, "$ codex exec\nRESOURCE_EXHAUSTED: out\n[exit 1]\n");
  assert.ok(lastQuotaHit("codex"), "the codex child counts for codex");
  assert.equal(lastQuotaHit("agy"), null, "the codex child does not count for agy");

  // no parseable reset time: a default cooldown from the failure, not forever (item 4)
  reset();
  log(`${stamp(1)}-copilot.log`, body("copilot", "Individual quota reached", 1));
  const cool = lastQuotaHit("copilot");
  assert.ok(cool?.resetAt, "an unknown reset gets a cooldown");
  const cd = new Date(cool.resetAt).getTime() - Date.now();
  assert.ok(cd > 5 * 3600_000 && cd <= 6 * 3600_000 + 1000, "about 6 h");
  const old = path.join(runs, `${stamp(1)}-copilot.log`);
  fs.utimesSync(old, new Date(Date.now() - 7 * 3600_000), new Date(Date.now() - 7 * 3600_000));
  assert.equal(lastQuotaHit("copilot"), null, "the cooldown ends");
  console.log("agents quota tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
