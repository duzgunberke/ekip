// `ekip statusline`: one line under the Claude Code prompt with what ekip is doing, so nobody has to
// look at another pane: the project of the session, active tasks and the step that runs, busy pools,
// the last CI result and a pending update. Local files only (no network), so it stays instant.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/core.js";
import { c } from "../core/ui.js";

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };

export async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
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
    parts.push(`${tasks.length} görev · ${t.title.slice(0, 32)}${step ? c.gray(` (${done}/${t.steps.length} · ${step.title.slice(0, 24)})`) : ""}`);
  }

  // busy pools (running/capacity), from the same data ekip mesai uses
  try {
    const { poolLoad } = await import("../workers/agents.js");
    const busy = Object.entries(poolLoad()).filter(([, l]) => l.running > 0).map(([n, l]) => `${n} ${l.running}/${l.capacity}`);
    if (busy.length) parts.push(c.yellow(busy.join(" ")));
  } catch { /* no pool data */ }

  // last CI result (saved by ekip doctor) and a pending update (from the update check cache)
  const ci = readJson(path.join(HOME, "ci-last.json"), null);
  if (ci?.status === "pass") parts.push(c.green("CI ✓"));
  else if (ci?.status === "fail") parts.push(c.red(`CI ✗ ${ci.step ?? ""}`));
  const up = readJson(path.join(HOME, "update-check.json"), {});
  const local = readJson(path.join(path.dirname(new URL(import.meta.url).pathname), "../../.claude-plugin/plugin.json"), {}).version;
  if (up.latest && local && up.latest !== local && up.latest.localeCompare(local, undefined, { numeric: true }) > 0) parts.push(c.yellow(`yeni sürüm ${up.latest}`));
  else if (local) parts.push(c.gray(`v${local}`));

  process.stdout.write(parts.join(c.gray(" · ")));
  return 0;
}

/** ekip init: point Claude Code's status line at ekip, unless the user already has one. */
export function install(root) {
  const file = path.join(process.env.HOME ?? "", ".claude/settings.json");
  const settings = readJson(file, {});
  if (settings.statusLine) return false;
  settings.statusLine = { type: "command", command: `node ${JSON.stringify(path.join(root, "plugin/bin/ekip.js"))} statusline` };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}
