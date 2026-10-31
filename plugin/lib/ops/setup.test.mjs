// The setup model and its reminders: an empty machine counts its missing steps right, a check that
// passes moves the counter, the list runs without a terminal, snooze silences a step, the pane line
// never cuts a word, and the wizard runs what "now" asks for (mocked: no key page, no login).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-setup-"));
process.env.EKIP_HOME = tmp;
process.env.EKIP_LANG = "en";
fs.writeFileSync(path.join(tmp, "config.json"), "{}");
const setup = await import("./setup.js");
const { snoozed } = await import("./snooze.js");
const { cols, renderPane } = await import("../tasks/pane.js");

// a bare machine: nothing installed beyond node, no services, no keys, no projects
const bare = {
  platform: "darwin", node: 22, git: true, claude: false, docker: { installed: true, ok: false }, env: { gitIdentity: false, ghInstalled: false, ghAuth: false },
  onPath: false, freeUp: false, memUp: false, keys: [], embeddings: false, logged: [], projects: [], projectGaps: [], vectors: null,
  wezterm: false, terminal: null, notifier: false, hub: false, cwd: tmp,
};

// counts: 9 counted steps on macOS (hub is optional), none done
let steps = setup.evaluate(bare, { env: {} });
let s = setup.summary(steps);
assert.equal(s.total, 9);
assert.equal(s.done, 0);
assert.deepEqual(s.required.map((x) => x.id), ["prereqs", "services", "keys", "embeddings", "agents", "project", "index"]);
assert.deepEqual(s.recommended.map((x) => x.id), ["terminal", "notify"]);
assert.match(steps.find((x) => x.id === "prereqs").detail, /Claude Code/);
assert.equal(steps.find((x) => x.id === "embeddings").command, "ekip key add nvidia <key>");
// Linux has no WezTerm / notifier steps
assert.equal(setup.summary(setup.evaluate({ ...bare, platform: "linux" }, { env: {} })).total, 7);

// a step completed (here by a fake check) moves the counter, by override and by EKIP_SETUP_FAKE
steps = setup.evaluate(bare, { env: {}, overrides: { keys: () => ({ done: true }) } });
assert.equal(setup.summary(steps).done, 1);
steps = setup.evaluate(bare, { env: { EKIP_SETUP_FAKE: "keys=done,agents=done,notify=done" } });
assert.equal(setup.summary(steps).done, 3);
// the facts themselves: two connected pools finish the worker step, a key for nvidia the embeddings
steps = setup.evaluate({ ...bare, keys: [["nvidia", "1"]], embeddings: true, logged: ["codex"] }, { env: {} });
for (const id of ["keys", "embeddings", "agents"]) assert.ok(steps.find((x) => x.id === id).done, id);
assert.match(steps.find((x) => x.id === "agents").detail, /2/);
// a registered project with gaps keeps the index step open, with the project and the command
steps = setup.evaluate({ ...bare, projects: [{ name: "shop" }], projectGaps: [{ name: "shop", gaps: [{ id: "wiki", title: "Project wiki is missing", command: "ekip project sync shop" }] }], vectors: { missing: 12 } }, { env: {} });
const index = steps.find((x) => x.id === "index");
assert.ok(!index.done);
assert.match(index.detail, /shop: Project wiki is missing/);
assert.match(index.detail, /12/);
assert.equal(index.command, "ekip project sync shop");

// snooze: a silenced required step is still missing but no longer in the reminders
const until = setup.summary(setup.evaluate(bare, { env: {} }));
assert.ok(until.remind.some((x) => x.id === "keys"));
const r = spawnSync(process.execPath, [path.resolve("plugin/bin/ekip.js"), "setup", "snooze", "keys"], { encoding: "utf8", env: { ...process.env } });
assert.equal(r.status, 0, r.stderr);
assert.ok(snoozed("keys"));
const after = setup.summary(setup.evaluate(bare, { env: {} }));
assert.ok(after.required.some((x) => x.id === "keys") && !after.remind.some((x) => x.id === "keys"));
spawnSync(process.execPath, [path.resolve("plugin/bin/ekip.js"), "setup", "unsnooze", "keys"], { env: { ...process.env } });
assert.ok(!snoozed("keys"));

// non-interactive: `ekip setup` without a terminal prints the list and exits 0; --json counts
const list = spawnSync(process.execPath, [path.resolve("plugin/bin/ekip.js"), "setup"], { encoding: "utf8", env: { ...process.env, EKIP_SETUP_FAKE: "keys=done" }, timeout: 20000 });
assert.equal(list.status, 0, list.stderr);
assert.match(list.stdout, /Setup \d\/9/);
assert.match(list.stdout, /ekip agents login/);
const json = JSON.parse(spawnSync(process.execPath, [path.resolve("plugin/bin/ekip.js"), "setup", "--json"], { encoding: "utf8", env: { ...process.env, EKIP_SETUP_FAKE: "keys=done,agents=done" }, timeout: 20000 }).stdout);
assert.equal(json.total, 9);
assert.ok(json.steps.find((x) => x.id === "keys").done && json.steps.find((x) => x.id === "agents").done);
assert.ok(fs.existsSync(path.join(tmp, "setup-state.json")));

// the pane line: whole names only at every width, "→ ekip setup" kept as long as it fits
const badge = { done: 5, total: 9, missing: ["model keys", "embeddings", "memory index"] };
const names = new Set(["setup", "5/9", "·", "missing:", "model", "keys,", "keys", "embeddings,", "embeddings", "memory", "index", "→", "ekip", "+1", "+2"]);
for (let w = 8; w <= 100; w++) {
  const line = setup.stripText(badge, w, cols);
  assert.ok(cols(line) <= w, `${w}: ${line}`);
  for (const word of line.split(" ").filter(Boolean)) assert.ok(names.has(word), `${w}: cut word "${word}" in "${line}"`);
}
assert.equal(setup.stripText({ ...badge, missing: [] }, 80), "");
for (const width of [24, 40, 59, 80, 120]) {
  const lines = renderPane({ clock: "10:00", counts: {}, cards: [], pools: [], setup: badge }, { width, height: 14, stream: { isTTY: false }, env: {} });
  assert.match(lines[1], /setup 5\/9/, `pane ${width}`);
  for (const l of lines) assert.ok(cols(l) <= width);
}
// no line without a missing required step
assert.ok(!renderPane({ clock: "10:00", counts: {}, cards: [], pools: [], setup: null }, { width: 80, height: 10, stream: { isTTY: false }, env: {} }).join("\n").includes("setup"));

// the wizard: "now" runs the step's commands (mocked), "later" and "skip" do not; skip snoozes
const runs = [];
const answers = { keys: "", agents: "l", embeddings: "k" };
let current = null;
const io = {
  ask: async (q) => { const step = current; current = null; return q.includes("[tr/en]") ? "" : answers[step] ?? "l"; },
  facts: async () => bare, secret: async () => "", open: () => { throw new Error("must not open a page"); },
  exec: (x) => { runs.push(x[1].slice(1).join(" ")); return 0; },
};
// which step the prompt belongs to: the wizard prints its title just before asking
const log = console.log;
const titles = Object.fromEntries(setup.evaluate(bare, { env: {} }).map((x) => [x.title, x.id]));
console.log = (...a) => { const text = a.join(" "); for (const [title, id] of Object.entries(titles)) if (text.includes(title)) current = id; };
try { await setup.wizard({ io, askLang: false, env: { EKIP_SETUP_FAKE: "prereqs=done,services=done" } }); } finally { console.log = log; }
assert.ok(runs.includes("keys"), runs.join(" | "));
assert.ok(!runs.some((x) => x.startsWith("agents")), "later runs nothing");
assert.ok(snoozed("embeddings"), "skip silences the step");

console.log("setup: ok");
