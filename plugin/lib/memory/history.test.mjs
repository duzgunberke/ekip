// The Claude history gap on a fake ~/.claude/projects tree: imported, live-captured and worker sessions
// are not a gap, a day-old user session no one took is (counted), a fresh one waits; the catch-up sends
// the missing and the changed ones only, within its limits, one run at a time, once an hour.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-history-"));
const home = path.join(tmp, "home"), base = path.join(tmp, "claude-projects");
process.env.EKIP_HOME = home;
process.env.EKIP_CLAUDE_PROJECTS = base;
process.env.EKIP_LANG = "tr";
fs.mkdirSync(path.join(home, "memory-state/capture"), { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), "{}");
const history = await import("./history.js");
const { projectGaps } = await import("../projects/onboarding.js");

const now = Date.now(), H = 3600_000;
const user = (text) => `${JSON.stringify({ type: "user", entrypoint: "cli", cwd: "/nowhere/demo", message: { role: "user", content: text } })}\n`;
const brief = `${JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "You are a worker agent dispatched by a lead agent. Do the task below." })}\n`;
const sdk = `${JSON.stringify({ type: "user", entrypoint: "sdk-cli", cwd: "/nowhere/demo", message: { role: "user", content: "fix it" } })}\n`;
function session(dir, sid, body, ageH) {
  const f = path.join(base, dir, `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  const t = new Date(now - ageH * H);
  fs.utimesSync(f, t, t);
  return f;
}
const D = "-Volumes-X-Projects-demo";
const imported = session(D, "s-imported", user("old work"), 72);
session(D, "s-captured", user("live work"), 48);
session(D, "s-stale", user("captured, then resumed"), 30);
session(D, "s-worker", brief + user("worker task"), 72);
session(D, "s-sdk", sdk, 72);
session(D, "s-missing", user("never sent"), 72);
session(D, "s-fresh", user("ten minutes ago, still open"), 1 / 6);
session(`${D}-data-worktrees-1-claude`, "s-worktree", user("worktree lead"), 50);
session("-Volumes-X-Projects-demoapp", "s-other", user("another project"), 72);
// the importer's key, and live capture state (the stale one was captured before its last write)
fs.writeFileSync(path.join(home, "memory-state/asset-import.json"), JSON.stringify({ done: [`agt-x::session:claude-code:${imported}`, `agt-x::session:claude-code:${path.join(base, D, "s-other/subagents/agent-1.jsonl")}`] }));
const capState = (sid, atH) => fs.writeFileSync(path.join(home, "memory-state/capture", `${sid}.json`), JSON.stringify({ lines: 1, project: "demo", at: new Date(now - atH * H).toISOString() }));
capState("s-captured", 47);
capState("s-stale", 40);

const p = { name: "demo", path: "/nowhere/demo", tdai: { agentId: "agt-x" } };
const states = Object.fromEntries(history.projectSessions(p).map((s) => [s.sid, s.state]));
assert.deepEqual(states, { "s-imported": "imported", "s-captured": "captured", "s-stale": "stale", "s-worker": "worker", "s-sdk": "worker", "s-missing": "missing", "s-fresh": "missing", "s-worktree": "missing" });
assert.deepEqual(history.missingSessions(p).map((s) => s.sid).sort(), ["s-missing", "s-worktree"]);

// the setup gap names the count and the light command
const gap = projectGaps({ ...p, card: null }).find((g) => g.id === "history");
assert.equal(gap.title, "Claude geçmişi hafızaya aktarılmamış (2 oturum)");
assert.equal(gap.command, "ekip memory catch-up");
// everything in memory: no gap
const clean = { name: "nothing-here", path: "/nowhere/x", tdai: { agentId: "agt-x" } };
assert.equal(projectGaps(clean).some((g) => g.id === "history"), false);

// catch-up: the missing (idle) and the changed sessions, newest first; never the fresh, worker or done ones
const sent = [];
const send = async (target, file, sid) => { sent.push(`${target.name}:${sid}`); return { sent: 1 }; };
let r = await history.catchUp({ projects: [p], home, force: true, send });
assert.deepEqual(sent, ["demo:s-stale", "demo:s-worktree", "demo:s-missing"]);
assert.deepEqual(r, { sessions: 3, sent: 3, left: 0 });
// limits: one session per run leaves the rest for later
sent.length = 0;
r = await history.catchUp({ projects: [p], home, force: true, send, maxSessions: 1 });
assert.equal(r.sessions, 1); assert.equal(r.left, 2);
// a session larger than the size budget goes alone, as the first of its run
r = await history.catchUp({ projects: [p], home, force: true, send, maxMb: 1e-6 });
assert.equal(r.sessions, 1); assert.equal(r.left, 2);
// memory down: stops at the first error, the rest stays for the next run
r = await history.catchUp({ projects: [p], home, force: true, send: async () => { throw new Error("ECONNREFUSED"); } });
assert.equal(r.sessions, 0); assert.equal(r.left, 3); assert.match(r.error, /ECONNREFUSED/);
// one at a time: a running history import or another catch-up defers it
fs.writeFileSync(path.join(home, "import-history.lock"), String(process.pid));
assert.deepEqual(await history.catchUp({ projects: [p], home, force: true, send }), { deferred: "import-history" });
fs.rmSync(path.join(home, "import-history.lock"));
fs.mkdirSync(path.join(home, "memory-state/catch-up.lock"));
assert.deepEqual(await history.catchUp({ projects: [p], home, force: true, send }), { deferred: "locked" });
fs.rmSync(path.join(home, "memory-state/catch-up.lock"), { recursive: true });
// from the Stop hook: once an hour
sent.length = 0;
r = await history.catchUpIfDue({ projects: [p], home, force: true, send });
assert.equal(r.sessions, 3);
assert.deepEqual(await history.catchUpIfDue({ projects: [p], home, force: true, send }), { skipped: "recent" });

// the live capture reads a session line by line: complete lines only, a half-written last line waits
const { capture } = await import("./memory.js");
const meta = (i) => JSON.stringify({ type: "queue-operation", n: i });
const tf = path.join(tmp, "s-lines.jsonl");
fs.writeFileSync(tf, `${meta(1)}\n${meta(2)}\n{"type":"queue-op`);
assert.deepEqual(await capture(p, tf, "s-lines"), { sent: 0, lines: 2 });
fs.appendFileSync(tf, `eration"}\n${meta(4)}\n`);
assert.deepEqual(await capture(p, tf, "s-lines"), { sent: 0, lines: 4 });
assert.deepEqual(await capture(p, tf, "s-lines"), { sent: 0, lines: 4 });

fs.rmSync(tmp, { recursive: true, force: true });
console.log("history gap: ok");
