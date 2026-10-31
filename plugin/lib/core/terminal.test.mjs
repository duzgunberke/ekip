// Terminal back ends with a fake `wezterm cli` / `kitty @` / osascript: no terminal is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

{ // the pane command sets its title and role first, then runs the command
  const f = fakeWez([pane(1, 0, "claude")]);
  term.wezterm({ run: f.run, env, home: tmp }).openPane("tail -F a.log", { title: "ekip · codex" });
  const shell = f.calls.find((a) => a[1] === "split-pane").slice(-3);
  assert.equal(shell[0], "/bin/zsh");
  assert.match(shell[2], /\\033\]2;%s\\007' 'ekip · codex'; .*SetUserVar=%s=%s.*ekip_role 'cGFuZQ=='; .*; tail -F a\.log$/);
}

let ptyChecked = false; // set when the pty check below could run
{ // a worker pane: its own tint (reset when the command ends) and a header naming the worker
  const [, , cmd] = term.paneShell("tail -F a.log", { title: "ekip · codex", role: "pane" });
  assert.ok(cmd.includes(`printf '\\033]11;%s\\007' '${term.WORKER_BG}'`), cmd);
  assert.ok(cmd.includes(`trap 'printf "\\033]111\\007\\033]110\\007"' EXIT`), cmd);
  assert.ok(cmd.indexOf("trap ") < cmd.indexOf("]11;"), "the reset is armed before the tint");
  assert.match(cmd, /\\033\[48;2;[\d;]+m\\033\[38;2;[\d;]+m\\033\[1m %s \\033\[K\\033\[0m\\n' '(işçi|worker) · codex'; tail -F a\.log$/);
  // a quote in the label stays quoted
  assert.match(term.paneShell("x", { title: "ekip · o'neil", role: "pane" })[2], /'(işçi|worker) · o'\\''neil'; x$/);
  // the task pane, a plain pane and the lead's own commands get no tint and no header
  for (const opts of [{ title: term.TASK_TITLE, role: "tasks" }, { title: "ekip · x" }, {}]) {
    const c = term.paneShell("x", opts)[2];
    assert.ok(!/\]11;|\]111|\[48;2|trap /.test(c), c);
  }
  // in a pty: tint, header, the command, then the reset; the exit status is the command's
  // a pty of its own (forkpty), never reading stdin: copy the pane's output, exit with its status
  const ptyRun = [
    "import os, sys",
    "pid, fd = os.forkpty()",
    "if pid == 0: os.execv(sys.argv[1], sys.argv[1:])",
    "while True:",
    "    try: b = os.read(fd, 4096)",
    "    except OSError: b = b''",
    "    if not b: break",
    "    sys.stdout.buffer.write(b)",
    "sys.stdout.flush()",
    "sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))",
  ].join("\n");
  const r = spawnSync("python3", ["-I", "-c", ptyRun, ...term.paneShell("echo body; exit 3", { title: "ekip · t", role: "pane" })], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  if (fs.existsSync("/bin/zsh") && r.status !== null && !r.error && !/No module|Error/.test(r.stderr)) {
    ptyChecked = true;
    assert.equal(r.status, 3);
    const out = r.stdout;
    assert.ok(out.indexOf(`\x1b]11;${term.WORKER_BG}\x07`) < out.indexOf("body") && out.indexOf("body") < out.indexOf("\x1b]111\x07"), JSON.stringify(out));
  }
}

// A fake WezTerm with geometry: split-pane shares the anchor's cells like WezTerm does (one cell for
// the divider), close() gives a pane's rows back to its neighbour in the stack, rename() is what
// claude / agy do to the title once they run. No user variables in the list (WezTerm 20240203 prints
// none), so only ekip's record and the geometry can find the column.
function wezGeo({ task = false } = {}) {
  const W = 200, H = 50;
  const panes = [{ id: 1, tab: 0, title: "claude", left: 0, top: 0, cols: W, rows: H, tabTitle: "", zoomed: false }];
  if (task) { panes[0].rows = 34; panes.push({ id: 2, tab: 0, title: "ekip · görevler", left: 0, top: 35, cols: W, rows: 15, tabTitle: "", zoomed: false }); }
  const calls = [];
  let next = 10, nextTab = 1;
  const json = () => JSON.stringify(panes.map((p) => ({ window_id: 0, tab_id: p.tab, pane_id: p.id, title: p.title, tab_title: p.tabTitle,
    size: { cols: p.cols, rows: p.rows }, left_col: p.left, top_row: p.top, is_zoomed: p.zoomed, is_active: p.id === 1, cwd: "file:///tmp/" })));
  const run = (bin, args) => {
    args = [args[0], ...args.slice(2)];
    calls.push(args);
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (args[1] === "list") return { status: 0, stdout: json() };
    if (args[1] === "split-pane") {
      const a = panes.find((p) => String(p.id) === at("--pane-id"));
      const pct = Number(at("--percent")) / 100;
      const n = { id: next++, tab: a.tab, title: "zsh", tabTitle: a.tabTitle, zoomed: false };
      if (args.includes("--right")) { n.cols = Math.round(a.cols * pct); a.cols -= n.cols + 1; Object.assign(n, { left: a.left + a.cols + 1, top: a.top, rows: a.rows }); }
      else { n.rows = Math.round(a.rows * pct); a.rows -= n.rows + 1; Object.assign(n, { top: a.top + a.rows + 1, left: a.left, cols: a.cols }); }
      for (const p of panes) p.zoomed = false; // a split unzooms the tab
      panes.push(n);
      return { status: 0, stdout: `${n.id}\n` };
    }
    if (args[1] === "spawn") { const n = { id: next++, tab: 100 + nextTab++, title: "zsh", left: 0, top: 0, cols: W, rows: H, tabTitle: "", zoomed: false }; panes.push(n); return { status: 0, stdout: `${n.id}\n` }; }
    if (args[1] === "set-tab-title") { const t = panes.find((p) => String(p.id) === at("--pane-id")).tab; for (const p of panes) if (p.tab === t) p.tabTitle = args.at(-1); }
    if (args[1] === "zoom-pane") panes.find((p) => String(p.id) === at("--pane-id")).zoomed = true;
    return { status: 0, stdout: "" };
  };
  const close = (id) => {
    const i = panes.findIndex((p) => p.id === id), c = panes[i];
    panes.splice(i, 1);
    const above = panes.filter((p) => p.tab === c.tab && p.left === c.left && p.top + p.rows + 1 === c.top)[0];
    const below = panes.filter((p) => p.tab === c.tab && p.left === c.left && c.top + c.rows + 1 === p.top)[0];
    if (above) above.rows += c.rows + 1; else if (below) { below.top = c.top; below.rows += c.rows + 1; }
  };
  const rename = () => { for (const p of panes) if (p.id >= 10) p.title = `✳ worker ${p.id}`; };
  const share = () => { const tab = panes.filter((p) => p.tab === 0); return panes[0].cols / Math.max(...tab.map((p) => p.left + p.cols)); };
  const splits = () => calls.filter((a) => a[1] === "split-pane" || a[1] === "spawn").map((a) => (a[1] === "spawn" ? "spawn" : `${a[3]} ${a[4]}`));
  return { run, calls, panes, close, rename, share, splits };
}
const fresh = () => { fs.rmSync(path.join(tmp, "panes"), { recursive: true, force: true }); };

{ // 1..6 panes, each renamed by its program: one column right of the lead, then a workers tab
  fresh();
  const g = wezGeo();
  const w = term.wezterm({ run: g.run, env, home: tmp });
  for (let i = 1; i <= 6; i++) {
    assert.ok(w.openPane(`agent ${i}`, { title: `ekip · w${i}` }));
    g.rename();
    assert.ok(g.share() >= 0.62, `lead keeps ${g.share()} of the width after ${i} panes`);
  }
  const s = g.splits();
  assert.equal(s[0], "1 --right");
  assert.deepEqual(g.calls.find((a) => a[1] === "split-pane").slice(5, 7), ["--percent", "37"]);
  assert.ok(s.slice(1, 4).every((x) => x.endsWith("--bottom") && !x.startsWith("1 ")), `column splits: ${s}`);
  assert.equal(s[4], "spawn", "the fifth pane opens the workers tab");
  assert.ok(g.panes.filter((p) => p.tab !== 0).every((p) => p.tabTitle === term.WORKERS_TAB));
  assert.ok(s[5].endsWith("--bottom") && !s[5].startsWith("1 "), "the sixth goes into the workers tab");
  assert.equal(g.panes.filter((p) => p.tab !== 0).length, 2);
  // the column is one stack, its panes equally tall
  const col = g.panes.filter((p) => p.tab === 0 && p.id !== 1);
  assert.equal(new Set(col.map((p) => p.left)).size, 1);
  assert.ok(Math.max(...col.map((p) => p.rows)) - Math.min(...col.map((p) => p.rows)) <= 2, col.map((p) => p.rows).join(","));
  assert.equal(w.layout().column.length, 4);
  // panes 7-8 fill the workers tab, the ninth opens a second one, the tenth splits that
  for (let i = 7; i <= 10; i++) { assert.ok(w.openPane(`agent ${i}`, { title: `ekip · w${i}` })); g.rename(); }
  const s2 = g.splits();
  assert.ok(s2.slice(6, 8).every((x) => x.endsWith("--bottom") && !x.startsWith("1 ")));
  assert.equal(s2[8], "spawn", "a full workers tab opens another one");
  assert.ok(s2[9].endsWith("--bottom") && s2[9].startsWith(`${g.panes.at(-2).id} `), `the tenth splits the newest workers tab: ${s2[9]}`);
  const byTab = {};
  for (const p of g.panes.filter((x) => x.tab !== 0)) byTab[p.tab] = (byTab[p.tab] ?? 0) + 1;
  assert.deepEqual(Object.values(byTab), [4, 2]);
  assert.ok(g.share() >= 0.62);
}

{ // with the task pane under the lead: it stays the task pane, never a column pane, never split
  fresh();
  const g = wezGeo({ task: true });
  const w = term.wezterm({ run: g.run, env, home: tmp });
  assert.equal(w.findTaskPane(), "2");
  for (let i = 1; i <= 3; i++) { w.openPane("x", { title: `ekip · w${i}` }); g.rename(); }
  const lay = w.layout();
  assert.equal(lay.task.id, "2");
  assert.deepEqual(lay.column.map((p) => p.id).sort(), ["10", "11", "12"]);
  assert.ok(g.splits().every((x) => !x.startsWith("2 ")));
  assert.ok(g.splits().slice(1).every((x) => !x.startsWith("1 ")));
  assert.ok(g.share() >= 0.62);
}

{ // a pane closed in the middle: the next one fills the column again, the lead does not move
  fresh();
  const g = wezGeo();
  const w = term.wezterm({ run: g.run, env, home: tmp });
  for (let i = 1; i <= 3; i++) { w.openPane("x", { title: `ekip · w${i}` }); g.rename(); }
  const width = g.panes[0].cols;
  const mid = w.layout().column[1].id;
  g.close(Number(mid));
  assert.equal(w.layout().column.length, 2);
  w.openPane("x", { title: "ekip · w4" }); g.rename();
  assert.ok(!g.splits().at(-1).startsWith("1 "), "split the column, not the lead");
  assert.equal(g.panes[0].cols, width);
  assert.equal(w.layout().column.length, 3);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(tmp, "panes", "wezterm-1.json"), "utf8")).includes(mid), "closed pane pruned from the record");
}

{ // the record lost: the geometry alone still finds the column
  fresh();
  const g = wezGeo();
  const w = term.wezterm({ run: g.run, env, home: tmp });
  w.openPane("x"); w.openPane("x"); g.rename();
  fresh();
  w.openPane("x");
  assert.ok(!g.splits().at(-1).startsWith("1 "));
  assert.ok(g.share() >= 0.62);
}

{ // a zoomed lead (Cmd+Alt+Z): the list shows it full width, the record still knows the column; the
  // split unzooms the tab, so ekip zooms the lead again
  fresh();
  const g = wezGeo();
  const w = term.wezterm({ run: g.run, env, home: tmp });
  w.openPane("x"); g.rename();
  const saved = { ...g.panes[0] };
  Object.assign(g.panes[0], { zoomed: true, cols: 200 });
  w.openPane("x");
  assert.ok(!g.splits().at(-1).startsWith("1 "), "a zoomed lead is not split");
  assert.deepEqual(g.calls.at(-2), ["cli", "zoom-pane", "--pane-id", "1", "--zoom"]);
  // the focus goes back to the pane the user was in, never to the new worker pane
  assert.equal(g.calls.at(-1)[1], "activate-pane");
  assert.equal(g.panes[0].zoomed, true);
  Object.assign(g.panes[0], { cols: saved.cols });
}

{ // one task pane per lead, found in the pane list (no flag file needed)
  const f = fakeWez([pane(1, 0, "claude")]);
  const w = term.wezterm({ run: f.run, env, home: tmp });
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
  term.ensureTaskPane({ term: term.wezterm({ run: g.run, env, home: tmp }), env, home: tmp });
  assert.equal(g.calls.filter((a) => a[1] === "split-pane").length, 1);
}

{ // wezterm cli failing (mux busy, socket gone) = unknown: nothing opens, panes count as alive
  const f = fakeWez([], { fail: true });
  const w = term.wezterm({ run: f.run, env, home: tmp });
  assert.equal(w.listPanes(), null);
  assert.equal(w.findTaskPane(), null);
  assert.equal(w.paneAlive("4"), true);
  term.ensureTaskPane({ term: w, env, home: tmp });
  assert.equal(f.calls.filter((a) => a[1] === "split-pane").length, 0);
  const ok = fakeWez([pane(1, 0, "claude")]);
  const w2 = term.wezterm({ run: ok.run, env, home: tmp });
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

{ // kitty: the column is what ekip recorded, whatever the windows are titled now; past four, a
  // workers tab whose last window the next ones split, a new workers tab every four
  fresh();
  const tabs = [{ id: 2, title: "t", windows: [{ id: 3, title: "claude" }] }];
  const calls = [];
  let next = 10, nextTab = 50;
  const run = (cmd, args) => {
    calls.push(args);
    if (args[1] === "ls") return { status: 0, stdout: JSON.stringify([{ id: 1, tabs }, { id: 7, tabs: [{ id: 8, title: term.WORKERS_TAB, windows: [{ id: 9, title: "other" }] }] }]) };
    if (args[1] === "launch") {
      const id = next++;
      const opt = (name) => args.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
      if (args.includes("--type=tab")) tabs.push({ id: nextTab++, title: opt("tab-title"), windows: [{ id, title: "zsh" }] });
      else tabs.find((t) => t.windows.some((w) => `id:${w.id}` === opt("next-to"))).windows.push({ id, title: "zsh" });
      for (const t of tabs) for (const w of t.windows) if (w.id >= 10) w.title = `✳ worker ${w.id}`;
      return { status: 0, stdout: `${id}\n` };
    }
    return { status: 0, stdout: "" };
  };
  const k = term.kitty({ run, env: { KITTY_WINDOW_ID: "3" }, home: tmp });
  for (let i = 1; i <= 10; i++) assert.ok(k.openPane("x", { title: `ekip · w${i}` }));
  const launches = calls.filter((a) => a[1] === "launch");
  assert.ok(launches[0].includes("--location=vsplit") && launches[0].includes("--next-to=id:3") && launches[0].includes("--bias=37"));
  assert.ok(launches.slice(1, 4).every((a, i) => a.includes("--location=hsplit") && a.includes(`--next-to=id:${10 + i}`)), "column splits follow the last column window");
  assert.ok(launches.slice(1).every((a) => !a.includes("--next-to=id:3")), "the lead is split only once");
  assert.ok(launches[4].includes("--type=tab") && launches[4].includes(`--tab-title=${term.WORKERS_TAB}`) && launches[4].includes("--match=window_id:3"));
  assert.ok(launches.slice(5, 8).every((a, i) => a.includes("--type=window") && a.includes("--location=hsplit") && a.includes(`--next-to=id:${14 + i}`)), "panes 6-8 split the workers tab");
  assert.ok(launches[8].includes("--type=tab"), "a full workers tab opens another one");
  assert.ok(launches[9].includes(`--next-to=id:18`), "the tenth splits the newest workers tab");
  assert.deepEqual(tabs.map((t) => t.windows.length), [5, 4, 2]);
  assert.ok(tabs.slice(1).every((t) => t.title === term.WORKERS_TAB));
  const lay = k.layout();
  assert.equal(lay.column.length, 4);
  assert.equal(lay.workers.length, 6, "another OS window's workers tab is not this lead's");
  // a window closed in the column: the next pane goes back into the column, under its last window
  tabs[0].windows.splice(2, 1);
  k.openPane("x");
  assert.ok(calls.at(-1).includes("--next-to=id:13") && calls.at(-1).includes("--location=hsplit"));
  assert.equal(k.layout().column.length, 4);
  // the task pane splits the lead downwards and is never counted in the column
  tabs[0].windows.push({ id: 99, title: term.TASK_TITLE });
  assert.equal(k.findTaskPane(), "99");
  assert.equal(k.layout().column.length, 4);
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

// workers never get the lead's terminal identity; a test home never opens panes in the user's window
{
  const env = term.headlessEnv({ WEZTERM_PANE: "0", WEZTERM_UNIX_SOCKET: "/s", KITTY_WINDOW_ID: "1", ITERM_SESSION_ID: "w0:X", PATH: "/bin" });
  assert.deepEqual(env, { PATH: "/bin" });
  assert.equal(term.detect(env), "none");
  let opened = 0;
  const fake = { name: "wezterm", findTaskPane: () => "", openPane: () => { opened++; return "9"; }, layout: () => ({ me: { id: "0" } }) };
  term.ensureTaskPane({ term: fake, env: { WEZTERM_PANE: "0", EKIP_HOME: "/tmp/some-test-home" }, home: "/tmp/some-test-home" });
  assert.equal(opened, 0, "a test home opens nothing");
  console.log("terminal: workers are headless");
}
