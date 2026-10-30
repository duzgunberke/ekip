#!/usr/bin/env node
// Screenshots of ekip's real WezTerm (macOS): a new WezTerm process with ekip.lua and a throw-away
// EKIP_HOME full of demo tasks (hub/demo/terminal-state.mjs), laid out as ekip lays it out (lead,
// worker column, task pane). Only that window is captured (screencapture -l <window id>), never the
// rest of the screen, and the process is stopped by its own pid afterwards.
//
//   node hub/demo/wezterm-shots.mjs [--keep] [--check] [OUT_DIR]   (default OUT_DIR: docs/screenshots)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeDemoState } from "./terminal-state.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const OUT = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(root, "docs/screenshots"));
const GUI = ["/Applications/WezTerm.app/Contents/MacOS/wezterm-gui", "/opt/homebrew/bin/wezterm-gui"].find((p) => fs.existsSync(p));
if (process.platform !== "darwin" || !GUI) { console.error("needs macOS and WezTerm.app"); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-wez-shot-"));
const HOME = path.join(tmp, "home"), XDG = path.join(tmp, "xdg"), WEZ = path.join(XDG, "wezterm");
fs.mkdirSync(HOME, { recursive: true }); fs.mkdirSync(WEZ, { recursive: true });
// the demo workers and the tracked job belong to this process while the shots run
const holder = spawn("sleep", ["900"], { stdio: "ignore" });
const env = { ...process.env, EKIP_HOME: HOME, EKIP_LANG: "en", XDG_CONFIG_HOME: XDG, PATH: `${path.join(HOME, "bin")}:${process.env.PATH}` };
for (const k of ["NO_COLOR", "WEZTERM_PANE", "WEZTERM_UNIX_SOCKET", "TMUX", "ITERM_SESSION_ID", "TERM_PROGRAM"]) delete env[k];

const q = (s) => JSON.stringify(String(s));
const ekipJs = path.join(root, "plugin/bin/ekip.js");
fs.writeFileSync(path.join(WEZ, "ekip.lua"), spawnSync(process.execPath, [ekipJs, "terminal", "config"], { env, encoding: "utf8" }).stdout);

// what the lead and the workers show: demo text, the way Claude Code and `ekip run` logs look
const E = (code) => `\\033[${code}m`;
const leadText = [
  `${E("90")}ekip lead · payments-api · Claude Code${E("0")}`,
  "",
  `${E("90")}❯${E("0")} add rate limits to the public API, document them, and ship the iOS build`,
  "",
  `${E("38;2;45;212;191")}⏺${E("0")} I split this into four tasks and handed them out:`,
  `  ${E("90")}⎿${E("0")}  codex   ${E("90")}token bucket per API key, 429 answers${E("0")}`,
  `  ${E("90")}⎿${E("0")}  copilot ${E("90")}the rate limit page with examples${E("0")}`,
  `  ${E("90")}⎿${E("0")}  track   ${E("90")}upload of the release build${E("0")}`,
  "",
  `${E("38;2;45;212;191")}⏺${E("0")} ${E("38;2;250;204;21")}One decision is yours${E("0")} (ios-app): submit v2.4 now, or after the paywall test?`,
  `  ${E("38;2;45;212;191")}A)${E("0")} Submit now   ${E("38;2;45;212;191")}B)${E("0")} Wait for the test`,
  "",
  `${E("38;2;45;212;191")}⏺${E("0")} The docs page is done: three examples, preview deployed.`,
  "",
  `${E("90")}❯${E("0")} `,
].join("\\n");
const workerText = (via, project, label, lines) => [`${E("90")}cwd: ~/code/${project}${E("0")}`, `${E("90")}label: ${label}${E("0")}`, `${E("90")}[ekip pool ${via}]${E("0")}`, ...lines].join("\\n");
const codex = workerText("codex", "payments-api", "Token bucket per API key", [
  `${E("1")}codex${E("0")} ${E("90")}· reading the project card, memory and code graph${E("0")}`,
  `${E("90")}›${E("0")} rg -n "func .*Handler" src/http`, `${E("90")}  src/http/routes.go:41  src/http/middleware.go:12${E("0")}`,
  `${E("32")}✎${E("0")} src/ratelimit/bucket.go ${E("32")}+86${E("0")}`, `${E("32")}✎${E("0")} src/http/middleware.go ${E("32")}+14${E("0")} ${E("90")}-2${E("0")}`,
  `${E("90")}›${E("0")} go test ./src/ratelimit/...`, `${E("32")}  ok   ratelimit  0.41s${E("0")}`,
]);
const copilot = workerText("copilot", "docs-site", "Rate limit page with examples", [
  `${E("1")}copilot${E("0")} ${E("90")}· docs-site · Astro 5, MDX${E("0")}`,
  `${E("90")}›${E("0")} reading src/content/docs/api/authentication.mdx`,
  `${E("32")}✎${E("0")} src/content/docs/api/rate-limits.mdx ${E("32")}+72${E("0")}`,
  `${E("90")}›${E("0")} pnpm astro check`, `${E("32")}  0 errors, 0 warnings${E("0")}`,
  `${E("1")}report${E("0")} rate limit page with three examples`, "[exit 0]",
]);
const show = (title, text) => ["/bin/zsh", "-c", `printf '\\033]2;%s\\007\\033[?25l' ${q(title).replace(/"/g, "'")}; printf "${text.replace(/"/g, '\\"')}"; sleep 900`];

// two more tabs: home ("~") and a long folder name; the folder is announced with OSC 7, as shells do
// (spawn_tab's cwd is not used at gui-startup)
const extraTabs = () => [os.homedir(), path.join(HOME, "code", "northwind-storefront-checkout-experience")].map((d) => {
  const cmd = `cd ${q(d)}; printf '\\033]7;file://localhost%s\\007\\033[?25l' ${q(d)}; sleep 900`;
  return `window:spawn_tab({ cwd = ${q(d)}, args = { "/bin/zsh", "-c", ${q(cmd)} } })`;
}).join("\n  ");

function shotConfig(scene, w, h) {
  const project = path.join(HOME, "code", "payments-api");
  const tasks = ["/bin/zsh", "-c", `printf '\\033]2;%s\\007' 'ekip · görevler'; exec ${q(process.execPath)} ${q(ekipJs)} tasks --watch`];
  return `local wezterm = require("wezterm")
package.path = ${q(WEZ)} .. "/?.lua;" .. package.path
local config = wezterm.config_builder()
require("ekip").apply(config)
config.set_environment_variables.EKIP_HOME = ${q(HOME)}
config.set_environment_variables.EKIP_LANG = "en"
config.set_environment_variables.PATH = ${q(env.PATH)}
config.window_close_confirmation = "NeverPrompt"
config.check_for_updates = false
wezterm.on("gui-startup", function()
  local tab, lead, window = wezterm.mux.spawn_window({ cwd = ${q(project)}, args = { "/bin/zsh", "-c", ${q(`printf "\\033[?25l${leadText.replace(/"/g, '\\"')}"; sleep 900`)} } })
  window:gui_window():set_inner_size(${w}, ${h})
  local tasks = lead:split({ direction = "Bottom", size = ${scene === "empty" ? 0.42 : 0.5}, cwd = ${q(project)}, args = { ${tasks.map(q).join(", ")} } })
  ${scene === "empty" ? "" : `local col = lead:split({ direction = "Right", size = 0.4, cwd = ${q(project)}, args = { ${show("ekip · codex", codex).map(q).join(", ")} } })
  col:split({ direction = "Bottom", size = 0.5, cwd = ${q(project)}, args = { ${show("ekip · copilot", copilot).map(q).join(", ")} } })`}
  ${scene === "tabs" ? `${extraTabs()}
  tab:activate()` : ""}
  lead:activate()
end)
return config
`;
}

const SWIFT = `import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid && (w[kCGWindowLayer as String] as? Int) == 0 { print(w[kCGWindowNumber as String]!); break }`;
fs.writeFileSync(path.join(tmp, "winid.swift"), SWIFT);
const windowOf = (pid) => spawnSync("swift", [path.join(tmp, "winid.swift"), String(pid)], { encoding: "utf8" }).stdout.trim();

async function shot(name, scene, w, h) {
  writeDemoState(HOME, { scene, pid: holder.pid });
  const cfg = path.join(WEZ, `shot-${name}.lua`);
  fs.writeFileSync(cfg, shotConfig(scene, w, h));
  const gui = spawn(GUI, ["--config-file", cfg, "start", "--always-new-process", "--class", `org.ekip.shot.${name}`], { env, stdio: "ignore" });
  try {
    let id = "";
    for (let i = 0; i < 40 && !id; i++) { await sleep(500); id = windowOf(gui.pid); }
    if (!id) throw Error(`no WezTerm window for pid ${gui.pid}`);
    await sleep(4500); // the task pane draws its first frames
    const file = path.join(OUT, `${name}.png`);
    const r = spawnSync("screencapture", ["-x", "-o", "-l", id, file]);
    if (r.status !== 0) throw Error(`screencapture failed for window ${id}`);
    console.log(`${name}: ${file}`);
  } finally {
    gui.kill("SIGTERM");
  }
}

try {
  fs.mkdirSync(OUT, { recursive: true });
  // --check: extra windows to look at (several tabs, home, a long folder name, narrow widths), not for the docs
  const shots = args.includes("--check")
    ? [["check-narrow-1100", "busy", 1100, 900], ["check-tabs-wide", "tabs", 1600, 700], ["check-tabs-900", "tabs", 900, 700], ["check-tabs-640", "tabs", 640, 600]]
    : [["terminal-wezterm-layout", "busy", 1600, 1000], ["terminal-empty", "empty", 1600, 900]];
  for (const [name, scene, w, h] of shots) await shot(name, scene, w, h);
} finally {
  holder.kill("SIGTERM");
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`kept ${tmp}`);
}
