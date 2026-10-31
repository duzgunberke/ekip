// `ekip statusline`: one line under the Claude Code prompt with what ekip is doing, so nobody has to
// look at another pane: the project of the session, active tasks and the step that runs, busy pools,
// the last CI result and a pending update. Local files only (no network), so it stays instant.
import fs from "node:fs";
import path from "node:path";
import { HOME, ROOT, SETTINGS, saveSettings } from "../core/core.js";
import { c } from "../core/ui.js";

// cut on a word boundary with an ellipsis, never mid-word or leaving "( + )"
const short = (s, n) => { s = String(s).trim(); if (s.length <= n) return s; const cut = s.slice(0, n).replace(/[\s(+·,:-]+\S*$/, ""); return `${cut || s.slice(0, n)}…`; };
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };

export async function main([sub] = []) {
  // ekip statusline off|on: remove it from Claude Code or put it back
  if (sub === "off" || sub === "on") return toggle(sub === "on");
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
  // the task pane under the lead already shows all of this: no second copy under the prompt
  if (await taskPaneOpen()) return 0;
  const cwd = input.workspace?.current_dir ?? input.cwd ?? process.cwd();
  const parts = [c.cyan("ekip")];

  // the registered project this session is in
  const projects = readJson(path.join(HOME, "projects.json"), []);
  const here = projects.filter((p) => cwd === p.path || cwd.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (here) parts.push(c.bold(here.name));

  // active tasks: count, and the running step of the newest one
  const tasks = readJson(path.join(HOME, "tasks.json"), []).filter((t) => t.status === "running");
  if (tasks.length) {
    const t = tasks.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const step = t.steps.find((s) => s.status === "running");
    const done = t.steps.filter((s) => s.status === "done").length;
    parts.push(`${tasks.length} görev · ${short(t.title, 36)}${step ? c.gray(` (${done}/${t.steps.length} ${short(step.title, 28)}${step.pct != null ? ` %${step.pct}` : ""})`) : ""}`);
  }

  // busy pools (running/capacity), from the same data ekip mesai uses
  try {
    const { poolLoad } = await import("../workers/agents.js");
    const busy = Object.entries(poolLoad()).filter(([, l]) => l.running > 0).map(([n, l]) => `${n} ${l.running}/${l.capacity}`);
    if (busy.length) parts.push(c.yellow(busy.join(" ")));
  } catch { /* no pool data */ }

  // last CI result (saved by ekip doctor) and a pending update (from the update check cache)
  // an old answer misleads (31 Oct: a failure two releases back still showed): only a fresh one counts
  const ciFile = path.join(HOME, "ci-last.json");
  let ciAge = Infinity; try { ciAge = Date.now() - fs.statSync(ciFile).mtimeMs; } catch { /* none */ }
  const ci = ciAge < 3 * 3600_000 ? readJson(ciFile, null) : null;
  if (ci?.status === "pass") parts.push(c.green("CI ✓"));
  else if (ci?.status === "fail") parts.push(c.red(`CI ✗ ${ci.step ?? ""}`));
  const up = readJson(path.join(HOME, "update-check.json"), {});
  const { localVersion } = await import("./update.js");
  const local = localVersion();
  if (up.latest && local && up.latest !== local && up.latest.localeCompare(local, undefined, { numeric: true }) > 0) parts.push(c.yellow(`yeni sürüm ${up.latest}`));
  else if (local) parts.push(c.gray(`v${local}`));

  process.stdout.write(parts.join(c.gray(" · ")));
  return 0;
}

/** True when this lead's tab shows ekip's task pane; unknown (no terminal, slow answer) counts as no. */
export async function taskPaneOpen({ env = process.env, term = null } = {}) {
  try {
    const t = await import("../core/terminal.js");
    if (!term && t.detect(env) === "none") return false;
    return !!(term ?? t.backend({ env })).findTaskPane();
  } catch { return false; }
}

const settingsFile = () => path.join(process.env.HOME ?? "", ".claude/settings.json");

function toggle(on) {
  const file = settingsFile();
  const settings = readJson(file, {});
  const ours = String(settings.statusLine?.command ?? "").includes("statusline");
  if (on) {
    if (settings.statusLine && !ours) { console.log("Claude Code already has another status line; left as it is"); return 1; }
    settings.statusLine = { type: "command", command: `node ${JSON.stringify(path.join(ROOT, "plugin/bin/ekip.js"))} statusline` };
  } else if (ours) delete settings.statusLine;
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  // remembered, so ekip init and updates do not put it back
  saveSettings({ statusline: on });
  console.log(on ? "ekip status line on (new Claude Code sessions)" : "ekip status line off (ekip statusline on brings it back)");
  return 0;
}

/** ekip init: point Claude Code's status line at ekip, unless the user already has one or turned it off. */
export function install(root) {
  if (SETTINGS.statusline === false) return false;
  const file = settingsFile();
  const settings = readJson(file, {});
  if (settings.statusLine) return false;
  settings.statusLine = { type: "command", command: `node ${JSON.stringify(path.join(root, "plugin/bin/ekip.js"))} statusline` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}
