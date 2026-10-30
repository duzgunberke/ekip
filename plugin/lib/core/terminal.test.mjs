// Terminal back ends with a fake `wezterm cli` / `kitty @` / osascript: no terminal is touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-term-"));
process.env.EKIP_HOME = tmp;
const term = await import("./terminal.js");
const core = await import("./core.js");

// detect() and leadId() read only the environment
assert.equal(term.detect({ WEZTERM_PANE: "0", TERM_PROGRAM: "WezTerm" }), "wezterm");
assert.equal(term.detect({ KITTY_WINDOW_ID: "3" }), "kitty");
assert.equal(term.detect({ TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t0p0:ABC" }), "iterm");
assert.equal(term.detect({ TERM_PROGRAM: "Apple_Terminal" }), "none");
assert.equal(term.leadId({ TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t0p0:ABC" }), "ABC");
assert.equal(term.leadId({ WEZTERM_PANE: "7" }), "wezterm-7");
assert.equal(term.leadId({ TERM_SESSION_ID: "xyz" }), "xyz");
// the old core.js names still work
for (const n of ["openPane", "ensureTaskPane", "openSessions", "openTerminal", "paneAlive"]) assert.equal(typeof core[n], "function", n);

// `wezterm cli list --format json` as WezTerm prints it
const pane = (id, tab, title, extra = {}) => ({ window_id: 0, tab_id: tab, pane_id: id, workspace: "default", size: { rows: 40, cols: 120 }, title, cwd: "file:///tmp/", cursor_x: 0, cursor_y: 0, tab_title: "", window_title: title, is_active: id === 1, is_zoomed: false, tty_name: `/dev/ttys00${id}`, top_row: 0, left_col: 0, ...extra });
const parsed = term.parseWeztermList(JSON.stringify([pane(1, 0, "claude"), pane(4, 0, "ekip · görevler", { top_row: 30 })]));
assert.deepEqual(parsed.map((p) => [p.id, p.tab, p.title, p.top]), [["1", "0", "claude", 0], ["4", "0", "ekip · görevler", 30]]);
assert.equal(term.parseWeztermList("not json"), null);
assert.equal(term.parseWeztermList("{}"), null);

// a fake wezterm: keeps a pane list, records every call, answers split-pane with a new id
function fakeWez(panes, { fail = false } = {}) {
  const calls = [];
  let next = 10;
  const run = (bin, args) => {
    assert.equal(args[1], "--no-auto-start");
    args = [args[0], ...args.slice(2)];
    calls.push(args);
    if (fail) return { status: 1, stdout: "", stderr: "connection refused" };
    if (args[1] === "list") return { status: 0, stdout: JSON.stringify(panes) };
    if (args[1] === "split-pane" || args[1] === "spawn") {
      const id = next++;
      const cmd = args.slice(args.indexOf("--") + 1).join(" ");
      const title = cmd.match(/\\033\]2;%s\\007' '([^']*)'/)?.[1] ?? "zsh";
      const top = args.includes("--bottom") ? 30 + id : 0;
      panes.push(pane(id, 0, title, { top_row: top }));
      return { status: 0, stdout: `${id}\n` };
    }
    return { status: 0, stdout: "" };
  };
  return { run, calls };
}
const env = { WEZTERM_PANE: "1", TERM_PROGRAM: "WezTerm", EKIP_WEZTERM: "wezterm" };

{ // column: first pane splits the lead to the right, the next goes under it, past five a new tab
  const f = fakeWez([pane(1, 0, "claude")]);
  const w = term.wezterm({ run: f.run, env });
  assert.equal(w.openPane("tail -F a.log", { title: "ekip · codex" }), "10");
  assert.deepEqual(f.calls.at(-1).slice(0, 6), ["cli", "split-pane", "--pane-id", "1", "--right", "--percent"]);
  assert.equal(w.openPane("tail -F b.log", { title: "ekip · qwen" }), "11");
  assert.deepEqual(f.calls.at(-1).slice(0, 5), ["cli", "split-pane", "--pane-id", "10", "--bottom"]);
  for (let i = 0; i < 3; i++) w.openPane("x", { title: `ekip · w${i}` });
  w.openPane("x", { title: "ekip · sixth" });
  assert.equal(f.calls.at(-1)[1], "spawn");
  // the pane command sets its title and role first, then runs the command
  const shell = f.calls.find((a) => a[1] === "split-pane").slice(-3);
  assert.equal(shell[0], "/bin/zsh");
  assert.match(shell[2], /\\033\]2;%s\\007' 'ekip · codex'; .*SetUserVar=%s=%s.*ekip_role 'cGFuZQ=='; tail -F a\.log$/);
}

{ // one task pane per lead, found in the pane list (no flag file needed)
  const f = fakeWez([pane(1, 0, "claude")]);
  const w = term.wezterm({ run: f.run, env });
  assert.equal(w.findTaskPane(), "");
  term.ensureTaskPane({ term: w, env, home: tmp });
  term.ensureTaskPane({ term: w, env, home: tmp });
  fs.rmSync(path.join(tmp, "panes"), { recursive: true, force: true }); // a lost flag file changes nothing
  term.ensureTaskPane({ term: w, env, home: tmp });
  const splits = f.calls.filter((a) => a[1] === "split-pane");
  assert.equal(splits.length, 1, "exactly one task pane");
  assert.deepEqual(splits[0].slice(0, 5), ["cli", "split-pane", "--pane-id", "1", "--bottom"]);
  assert.equal(w.findTaskPane(), "10");
  // a task pane in another lead's tab does not count for this lead
  const g = fakeWez([pane(1, 0, "claude"), pane(2, 5, "ekip · görevler")]);
  term.ensureTaskPane({ term: term.wezterm({ run: g.run, env }), env, home: tmp });
  assert.equal(g.calls.filter((a) => a[1] === "split-pane").length, 1);
}

{ // wezterm cli failing (mux busy, socket gone) = unknown: nothing opens, panes count as alive
  const f = fakeWez([], { fail: true });
  const w = term.wezterm({ run: f.run, env });
  assert.equal(w.listPanes(), null);
  assert.equal(w.findTaskPane(), null);
  assert.equal(w.paneAlive("4"), true);
  term.ensureTaskPane({ term: w, env, home: tmp });
  assert.equal(f.calls.filter((a) => a[1] === "split-pane").length, 0);
  const ok = fakeWez([pane(1, 0, "claude")]);
  const w2 = term.wezterm({ run: ok.run, env });
  assert.equal(w2.paneAlive("1"), true);
  assert.equal(w2.paneAlive("99"), false);
  w2.setTitle("1", "ekip · demo");
  assert.deepEqual(ok.calls.at(-1), ["cli", "set-tab-title", "--pane-id", "1", "ekip · demo"]);
  w2.focus("1");
  assert.deepEqual(ok.calls.at(-1), ["cli", "activate-pane", "--pane-id", "1"]);
}

{ // kitty @ ls
  const ls = [{ id: 1, tabs: [{ id: 2, title: "t", windows: [{ id: 3, title: "claude", is_focused: true }, { id: 4, title: "ekip · görevler" }] }] }];
  const k = term.kitty({ run: () => ({ status: 0, stdout: JSON.stringify(ls) }), env: { KITTY_WINDOW_ID: "3" } });
  assert.equal(k.findTaskPane(), "4");
  assert.deepEqual(term.parseKittyLs(JSON.stringify(ls)).map((p) => p.id), ["3", "4"]);
}

if (process.platform === "darwin") { // iTerm2: the same AppleScript layout as before the move
  const ienv = { TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t0p0:LEAD" };
  const scripts = [];
  let n = 0;
  const open = new Set(["LEAD"]);
  const run = (cmd, args) => {
    const s = args[1];
    scripts.push(s);
    if (s.includes("set out to")) return { status: 0, stdout: [...open].join("\n") + "\n" };
    if (s.includes("split") || s.includes("create tab")) { const id = `S${++n}`; open.add(id); return { status: 0, stdout: `${id}\n` }; }
    return { status: 0, stdout: "" };
  };
  const it = term.iterm({ run, env: ienv, home: tmp });
  it.openPane("tail -F a", { title: "ekip · a" });
  assert.match(scripts.at(-1), /if id of s is "LEAD"[\s\S]*split vertically with default profile command "\/bin\/zsh -lc \\"tail -F a\\""\)\n {4}tell n to set name to "ekip · a"/);
  it.openPane("tail -F b");
  assert.match(scripts.at(-1), /if id of s is "S1"[\s\S]*split horizontally/);
  for (let i = 0; i < 4; i++) it.openPane("x");
  assert.match(scripts.at(-1), /create tab with default profile/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, "panes", "LEAD.json"), "utf8")), ["S1", "S2", "S3", "S4", "S5"]);
  it.openPane("tasks", { below: true });
  assert.match(scripts.at(-1), /if id of s is "LEAD"[\s\S]*split horizontally/);
  // the task pane: flag file + osascript check, opened once, again only after it closed
  const before = scripts.length;
  term.ensureTaskPane({ term: it, env: ienv, home: tmp });
  term.ensureTaskPane({ term: it, env: ienv, home: tmp });
  assert.equal(scripts.slice(before).filter((s) => s.includes("split horizontally")).length, 1);
  open.delete(fs.readFileSync(path.join(tmp, "panes", "LEAD-tasks"), "utf8").trim());
  term.ensureTaskPane({ term: it, env: ienv, home: tmp });
  assert.equal(scripts.slice(before).filter((s) => s.includes("split horizontally")).length, 2);
  // osascript timing out = unknown: the pane is assumed open, nothing is opened
  const slow = term.iterm({ run: (c, a) => (a[1].includes("set out to") ? { status: null, error: new Error("ETIMEDOUT"), stdout: "" } : run(c, a)), env: ienv, home: tmp });
  const mid = scripts.length;
  term.ensureTaskPane({ term: slow, env: ienv, home: tmp });
  assert.equal(scripts.slice(mid).filter((s) => s.includes("split")).length, 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("terminal back ends: ok");
