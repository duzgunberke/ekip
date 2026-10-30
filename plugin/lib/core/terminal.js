// Terminal back ends: where ekip opens its panes (worker logs in a column right of the lead, the live
// task pane under it) and how it finds them again. One small interface per terminal:
//   detect()  listPanes()  openPane(command, { below, title })  paneAlive(id)  focus(id)  setTitle(id, title)
// iTerm2 is driven with AppleScript (the code that used to live in core.js, unchanged). WezTerm is
// driven with `wezterm cli` (JSON, no osascript, answers in milliseconds even on a busy machine), and
// kitty with `kitty @` remote control as a second choice. Anything else gets a new window.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME, ROOT, SETTINGS } from "./core.js";

// The task pane's title: every back end finds the pane by it, so one lead never gets two.
export const TASK_TITLE = "ekip · görevler";
const run0 = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

/** Which terminal ekip runs in: "wezterm", "kitty", "iterm" or "none". Reads only the environment. */
export function detect(env = process.env) {
  if (env.WEZTERM_PANE != null && env.WEZTERM_PANE !== "") return "wezterm";
  if (env.KITTY_WINDOW_ID) return "kitty";
  if (env.TERM_PROGRAM === "iTerm.app" && env.ITERM_SESSION_ID) return "iterm";
  return "none";
}

// The lead's own id, recorded on its tasks so each lead sees its own; for iTerm2 the same value as
// before (the session UUID), so tasks made before this change still match.
export function leadId(env = process.env) {
  const kind = detect(env);
  if (kind === "wezterm") return `wezterm-${env.WEZTERM_PANE}`;
  if (kind === "kitty") return `kitty-${env.KITTY_WINDOW_ID}`;
  return env.ITERM_SESSION_ID?.split(":")[1] ?? env.TERM_SESSION_ID ?? null;
}

// The pane's command: a login zsh that first sets the pane title (and, for WezTerm's config, a user
// variable naming the pane's role), then runs the command.
export function paneShell(command, { title = "", role = "" } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const pre = [
    ...(title ? [`printf '\\033]2;%s\\007' ${q(title)}`] : []),
    ...(role ? [`printf '\\033]1337;SetUserVar=%s=%s\\007' ekip_role ${q(Buffer.from(role).toString("base64"))}`] : []),
  ];
  return ["/bin/zsh", "-lc", pre.length ? `${pre.join("; ")}; ${command}` : command];
}

// ---- WezTerm ------------------------------------------------------------------------------------

/** `wezterm cli list --format json` → [{ id, tab, window, title, tabTitle, cwd, top, left, active, vars }]. */
export function parseWeztermList(text) {
  let rows;
  try { rows = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows.map((p) => ({
    id: String(p.pane_id), tab: String(p.tab_id), window: String(p.window_id), title: p.title ?? "", tabTitle: p.tab_title ?? "",
    cwd: p.cwd ?? "", top: p.top_row ?? 0, left: p.left_col ?? 0, active: !!p.is_active, vars: p.user_vars ?? {},
  }));
}

export function weztermBin(env = process.env) {
  if (env.EKIP_WEZTERM) return env.EKIP_WEZTERM;
  for (const p of ["/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm", "/Applications/WezTerm.app/Contents/MacOS/wezterm"]) if (fs.existsSync(p)) return p;
  return "wezterm";
}

export function wezterm({ run = run0, env = process.env } = {}) {
  const bin = weztermBin(env);
  const cli = (args) => run(bin, ["cli", ...args], { timeout: 5000, env });
  const lead = env.WEZTERM_PANE != null ? String(env.WEZTERM_PANE) : null;
  const self = {
    name: "wezterm",
    // null means "could not ask": callers then assume the panes are still open (never a duplicate)
    listPanes() {
      const r = cli(["list", "--format", "json"]);
      if (r.status !== 0 || r.error) return null;
      return parseWeztermList(r.stdout ?? "");
    },
    // Panes of the lead's tab: the lead, its column (ekip-titled panes), the task pane.
    layout(panes = self.listPanes()) {
      if (!panes) return null;
      const me = panes.find((p) => p.id === lead);
      const tab = me ? panes.filter((p) => p.tab === me.tab) : [];
      const task = tab.find((p) => p.title === TASK_TITLE || p.vars.ekip_role === "tasks") ?? null;
      const column = tab.filter((p) => p !== me && p !== task && (p.vars.ekip_role === "pane" || p.title.startsWith("ekip · "))).sort((a, b) => a.top - b.top);
      return { me, task, column };
    },
    openPane(command, { below = false, title = "" } = {}) {
      const shell = paneShell(command, { title, role: below ? "tasks" : "pane" });
      const lay = self.layout();
      if (!lay?.me) return null;
      const split = (anchor, side, pct) => cli(["split-pane", "--pane-id", anchor, side, "--percent", String(pct), "--", ...shell]);
      const r = below ? split(lay.me.id, "--bottom", 30)
        : lay.column.length >= 5 ? cli(["spawn", "--pane-id", lay.me.id, "--", ...shell])
          : lay.column.length ? split(lay.column.at(-1).id, "--bottom", 50) : split(lay.me.id, "--right", 40);
      const id = r.status === 0 ? (r.stdout ?? "").trim() : "";
      return /^\d+$/.test(id) ? id : null;
    },
    paneAlive(id) {
      if (id == null || id === "") return false;
      const panes = self.listPanes();
      return panes ? panes.some((p) => p.id === String(id)) : true;
    },
    focus(id) { return cli(["activate-pane", "--pane-id", String(id)]).status === 0; },
    setTitle(id, title) { return cli(["set-tab-title", ...(id != null ? ["--pane-id", String(id)] : []), title]).status === 0; },
    // The task pane is found in the pane list by its title / role, not through a flag file: a slow or
    // failed answer means "unknown" and opens nothing.
    findTaskPane() { const lay = self.layout(); return lay ? (lay.task?.id ?? "") : null; },
  };
  return self;
}

// ---- kitty (second choice; needs allow_remote_control and the splits layout) --------------------

export function parseKittyLs(text) {
  let os;
  try { os = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(os)) return null;
  return os.flatMap((w) => (w.tabs ?? []).flatMap((t) => (t.windows ?? []).map((p) => ({
    id: String(p.id), tab: String(t.id), window: String(w.id), title: p.title ?? "", tabTitle: t.title ?? "", cwd: p.cwd ?? "", top: 0, left: 0,
    active: !!p.is_focused, vars: p.user_vars ?? {},
  }))));
}

export function kitty({ run = run0, env = process.env } = {}) {
  const k = (args) => run("kitty", ["@", ...args], { timeout: 5000, env });
  const lead = env.KITTY_WINDOW_ID ? String(env.KITTY_WINDOW_ID) : null;
  const self = {
    name: "kitty",
    listPanes() { const r = k(["ls"]); return r.status !== 0 || r.error ? null : parseKittyLs(r.stdout ?? ""); },
    layout(panes = self.listPanes()) {
      if (!panes) return null;
      const me = panes.find((p) => p.id === lead);
      const tab = me ? panes.filter((p) => p.tab === me.tab) : [];
      const task = tab.find((p) => p.title === TASK_TITLE) ?? null;
      return { me, task, column: tab.filter((p) => p !== me && p !== task && p.title.startsWith("ekip · ")) };
    },
    openPane(command, { below = false, title = "" } = {}) {
      const lay = self.layout();
      if (!lay?.me) return null;
      const anchor = below || !lay.column.length ? lay.me.id : lay.column.at(-1).id;
      const where = below || lay.column.length ? "hsplit" : "vsplit";
      const type = !below && lay.column.length >= 5 ? ["--type=tab"] : ["--type=window", `--location=${where}`, `--match=id:${anchor}`];
      const r = k(["launch", ...type, ...(title ? ["--title", title] : []), "--cwd=current", ...paneShell(command)]);
      const id = r.status === 0 ? (r.stdout ?? "").trim() : "";
      return /^\d+$/.test(id) ? id : null;
    },
    paneAlive(id) { if (!id) return false; const panes = self.listPanes(); return panes ? panes.some((p) => p.id === String(id)) : true; },
    focus(id) { return k(["focus-window", `--match=id:${id}`]).status === 0; },
    setTitle(id, title) { return k(["set-tab-title", ...(id ? [`--match=id:${id}`] : []), title]).status === 0; },
    findTaskPane() { const lay = self.layout(); return lay ? (lay.task?.id ?? "") : null; },
  };
  return self;
}

// ---- iTerm2 (AppleScript; moved from core.js, behaviour unchanged) ------------------------------

export function iterm({ run = run0, env = process.env, home = HOME } = {}) {
  // iTerm2 session ids that are open right now (one osascript call). The list of sessions can change
  // while the script walks it (a pane closing), which made the old per-index loop fail and every check
  // report "closed"; each window and tab is read in its own try block.
  function openSessions() {
    const r = run("osascript", ["-e", `tell application "iTerm2"
  set out to ""
  repeat with w in (every window)
    try
      repeat with t in (every tab of w)
        try
          repeat with s in (every session of t)
            try
              set out to out & (id of s) & linefeed
            end try
          end repeat
        end try
      end repeat
    end try
  end repeat
  return out
end tell`], { encoding: "utf8", timeout: 15_000 });
    // A busy iTerm2 (or a slow machine) can make osascript fail or time out. That is "unknown", not
    // "no sessions": callers treat null as "assume the panes are still open", so a slow answer never
    // opens a duplicate task pane (30 Oct: one lead collected four identical task panes this way).
    if (r.status !== 0 || r.error || !(r.stdout ?? "").trim()) return null;
    return new Set(r.stdout.split("\n").map((x) => x.trim()).filter(Boolean));
  }

  // Worker and log panes open in one column to the right of the lead: the first one splits the lead
  // vertically, every later one goes under any pane of that column that is still open, so the lead
  // keeps its width when earlier panes close. Past five panes in the column, a pane opens as a tab
  // instead. `below` (the task pane) splits the lead horizontally, full width. Each pane gets a title
  // saying what it shows. Elsewhere it falls back to a new window. Returns the new session id.
  function openPane(command, { below = false, title = "" } = {}) {
    const lead = env.ITERM_SESSION_ID?.split(":")[1];
    if (process.platform !== "darwin" || env.TERM_PROGRAM !== "iTerm.app" || !lead) return openTerminal(command, { run, env });
    const stateFile = path.join(home, "panes", `${lead}.json`);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    let column = [];
    try { column = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* first pane */ }
    const open = openSessions();
    if (open) column = column.filter((id) => open.has(id));
    const shellCmd = `/bin/zsh -lc ${JSON.stringify(command)}`;
    const name = title ? `\n    tell n to set name to ${JSON.stringify(title)}` : "";
    const split = (anchor, how) => `tell application "iTerm2"
  set target to missing value
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${anchor}" then set target to s
      end repeat
    end repeat
  end repeat
  if target is missing value then return ""
  tell target
    set n to (split ${how} with default profile command ${JSON.stringify(shellCmd)})${name}
  end tell
  return id of n
end tell`;
    const tab = `tell application "iTerm2"
  tell current window
    set nt to (create tab with default profile command ${JSON.stringify(shellCmd)})
    set n to current session of nt${name}
  end tell
  return id of n
end tell`;
    const osa = (script) => (run("osascript", ["-e", script], { encoding: "utf8" }).stdout ?? "").trim();
    if (below) { const id = osa(split(lead, "horizontally")); if (!id) openTerminal(command, { run, env }); return id || null; }
    const id = column.length >= 5 ? osa(tab) : column.length ? osa(split(column.at(-1), "horizontally")) : osa(split(lead, "vertically"));
    if (id) { if (column.length < 5) column.push(id); fs.writeFileSync(stateFile, JSON.stringify(column)); } else openTerminal(command, { run, env });
    return id || null;
  }

  // Whether an iTerm2 session with this id is still open (the user may have closed the pane).
  function paneAlive(id) {
    if (!id || process.platform !== "darwin") return false;
    const open = openSessions();
    return open ? open.has(id) : true;
  }

  const sessionScript = (id, body) => `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${String(id).replace(/"/g, "")}" then
          ${body}
        end if
      end repeat
    end repeat
  end repeat
end tell`;
  return {
    name: "iterm", openSessions, openPane, paneAlive,
    listPanes() { const open = openSessions(); return open ? [...open].map((id) => ({ id, tab: "", window: "", title: "", vars: {} })) : null; },
    focus(id) { return run("osascript", ["-e", sessionScript(id, "tell t to select\n          tell s to select\n          tell w to select")], { timeout: 5000 }).status === 0; },
    setTitle(id, title) { return run("osascript", ["-e", sessionScript(id ?? env.ITERM_SESSION_ID?.split(":")[1], `tell s to set name to ${JSON.stringify(title)}`)], { timeout: 5000 }).status === 0; },
  };
}

// A new window in the terminal ekip runs in (Terminal.app when there is none to split).
export function openTerminal(command, { run = run0, env = process.env } = {}) {
  if (detect(env) === "wezterm") { run(weztermBin(env), ["cli", "spawn", "--new-window", "--", ...paneShell(command)], { stdio: "ignore", timeout: 5000 }); return; }
  if (process.platform !== "darwin") { console.log(`run in a new terminal: ${command}`); return; }
  const app = env.TERM_PROGRAM === "iTerm.app" ? "iTerm" : "Terminal";
  const script = app === "iTerm"
    ? `tell application "iTerm" to create window with default profile command ${JSON.stringify(command)}`
    : `tell application "Terminal" to do script ${JSON.stringify(command)}`;
  run("osascript", ["-e", script, "-e", `tell application "${app}" to activate`], { stdio: "ignore" });
}

// ---- the current back end -----------------------------------------------------------------------

const FACTORY = { wezterm, kitty, iterm };
let current;
/** The back end for this process's terminal (null outside WezTerm, kitty and iTerm2). */
export function backend(opts) {
  if (opts) { const kind = detect(opts.env ?? process.env); return FACTORY[kind]?.(opts) ?? null; }
  if (current === undefined) current = FACTORY[detect()]?.() ?? null;
  return current;
}

export const listPanes = () => backend()?.listPanes() ?? null;
export const focus = (id) => backend()?.focus(id) ?? false;
export const setTitle = (id, title) => backend()?.setTitle(id, title) ?? false;
export function openPane(command, opts = {}) {
  const b = backend();
  if (!b) { openTerminal(command); return null; }
  const id = b.openPane(command, opts);
  if (!id && b.name !== "iterm") openTerminal(command);
  return id;
}
export function paneAlive(id) {
  const b = backend();
  // a session id stored by an iTerm2 lead is still checked in iTerm2
  return (b ?? iterm()).paneAlive(id);
}
export const openSessions = () => iterm().openSessions();

// The live task pane under the lead: opened when the lead starts, and again on a new task if the
// user closed it; one lead gets one pane. In WezTerm and kitty the pane list (found by title) is the
// truth; in iTerm2 a flag file keeps the pane's session id.
export function ensureTaskPane({ term = backend(), env = process.env, home = HOME } = {}) {
  if (!term || SETTINGS.taskPane === false) return;
  const lead = term.name === "iterm" ? env.ITERM_SESSION_ID?.split(":")[1] : leadId(env);
  if (!lead) return;
  const flag = path.join(home, "panes", `${lead}-tasks`);
  const listed = term.findTaskPane ? () => term.findTaskPane() : null;
  let prev = "";
  if (listed) { const found = listed(); if (found !== "") return; /* open, or unknown (null) */ }
  else { prev = fs.existsSync(flag) ? fs.readFileSync(flag, "utf8").trim() : ""; if (prev && term.paneAlive(prev)) return; }
  // Several ekip commands can start at once (a burst of `ekip task new`); only one may open the pane.
  const lock = `${flag}.lock`;
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* no lock */ }
  try { fs.mkdirSync(path.dirname(flag), { recursive: true }); fs.mkdirSync(lock); } catch { return; }
  try {
    if (listed) { if (listed() !== "") return; }
    else { const again = fs.existsSync(flag) ? fs.readFileSync(flag, "utf8").trim() : ""; if (again && again !== prev && term.paneAlive(again)) return; }
    const id = term.openPane(`${JSON.stringify(path.join(ROOT, "plugin/bin/ekip.js"))} tasks --watch`, { below: true, title: TASK_TITLE });
    if (id) fs.writeFileSync(flag, id);
    // the title lands when the pane's shell starts: hold the lock until the list shows it, so a
    // second caller right behind this one finds the pane instead of opening another
    if (id && listed) for (let i = 0; i < 15 && listed() === ""; i++) spawnSync("sleep", ["0.2"]);
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
