// `ekip terminal install|open|status`: ekip's own terminal, optional. WezTerm (MIT, Homebrew cask)
// is driven with `wezterm cli` instead of AppleScript and gets an ekip config: the brand's dark
// theme, a readable font size, task state in the tab bar, keys for the lead / column / task pane
// layout. The user's wezterm.lua is never overwritten; iTerm2 keeps working as before.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, ROOT, die, has, saveSettings } from "../core/core.js";
import { TASK_TITLE, detect, paneShell, weztermBin } from "../core/terminal.js";
import { c } from "../core/ui.js";
import { t } from "../core/i18n.js";

export const configDir = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "wezterm");
// WezTerm reads the first of these that exists
const userConfigs = (env = process.env) => [...(env.WEZTERM_CONFIG_FILE ? [env.WEZTERM_CONFIG_FILE] : []), path.join(os.homedir(), ".wezterm.lua"), path.join(configDir(env), "wezterm.lua")];
export function weztermInstalled(env = process.env) {
  if (env.EKIP_WEZTERM) return fs.existsSync(env.EKIP_WEZTERM);
  return has("wezterm") || fs.existsSync("/Applications/WezTerm.app");
}

const lua = (v) => (Array.isArray(v) ? `{ ${v.map(lua).join(", ")} }` : JSON.stringify(String(v)));
// ekip.js through a login zsh (its PATH has node), as the panes run it: a fixed node path breaks
// on the next node upgrade.
const ekipCmd = (extra = []) => [path.join(ROOT, "plugin/bin/ekip.js"), ...extra].map((a) => JSON.stringify(a)).join(" ");

// The few lines that load ekip's settings; also the whole wezterm.lua when the user has none.
export const loaderLua = (dir) => `-- Loads ekip's WezTerm settings (ekip terminal install). Add your own settings after the require.
local wezterm = require("wezterm")
package.path = ${lua(dir)} .. "/?.lua;" .. package.path
local config = wezterm.config_builder and wezterm.config_builder() or {}
require("ekip").apply(config)
return config
`;

/** ekip.lua: a module with apply(config). Colours from docs/brand.md (dark). */
export function ekipLua({ tasksFile = path.join(HOME, "tasks.json") } = {}) {
  const tasksPane = paneShell(ekipCmd(["tasks", "--watch"]), { title: TASK_TITLE, role: "tasks" });
  return `-- ekip's WezTerm settings, written by \`ekip terminal install\` and rewritten by every install:
-- keep your own settings in wezterm.lua, after require("ekip").apply(config).
local wezterm = require("wezterm")
local act = wezterm.action
local M = {}

local TASKS = ${lua(tasksFile)}
local EKIP = ${lua(["/bin/zsh", "-lc", ekipCmd()])}
local TASK_PANE = ${lua(tasksPane)}
local TASK_TITLE = ${lua(TASK_TITLE)}
local L = { running = ${lua(t("çalışıyor"))}, waiting = ${lua(t("seni bekliyor"))}, blocked = ${lua(t("engelli"))} }
local C = {
  bg = "#0E1014", card = "#15181E", text = "#ECEEF2", muted = "#98A1B0", border = "#252A33",
  lead = "#FFA95E", team = "#2DD4BF", done = "#3FCF7A", failed = "#F2555A", blocked = "#F5A524",
  waiting = "#FACC15", queued = "#60A5FA",
}

local function decode(s)
  if wezterm.serde and wezterm.serde.json_decode then return wezterm.serde.json_decode(s) end
  return wezterm.json_parse(s)
end

-- Open tasks from ekip's tasks.json: running, waiting for the user, blocked (read at most every 2 s).
local cache = { at = -1, n = { running = 0, waiting = 0, blocked = 0 } }
local function counts()
  local now = os.time()
  if now - cache.at < 2 then return cache.n end
  local n = { running = 0, waiting = 0, blocked = 0 }
  local f = io.open(TASKS, "r")
  if f then
    local ok, list = pcall(decode, f:read("*a"))
    f:close()
    if ok and type(list) == "table" then
      for _, task in ipairs(list) do
        if task.status == "running" then
          local hold = task.hold
          if type(hold) == "table" and hold.kind == "waiting-user" then n.waiting = n.waiting + 1
          elseif type(hold) == "table" then n.blocked = n.blocked + 1
          else n.running = n.running + 1 end
        end
      end
    end
  end
  cache = { at = now, n = n }
  return n
end

local function push(items, color, text)
  table.insert(items, { Foreground = { Color = color } })
  table.insert(items, { Text = text })
end

function M.apply(config)
  config.colors = {
    foreground = C.text, background = C.bg,
    cursor_bg = C.lead, cursor_fg = C.bg, cursor_border = C.lead,
    selection_bg = C.border, selection_fg = C.text, split = C.border,
    ansi = { C.card, C.failed, C.done, C.blocked, C.queued, "#C084FC", C.team, C.text },
    brights = { C.muted, "#FF7A7F", "#6EE7A0", C.waiting, "#93C5FD", "#D8B4FE", "#5EEAD4", "#FFFFFF" },
    tab_bar = {
      background = C.bg,
      active_tab = { bg_color = C.card, fg_color = C.text },
      inactive_tab = { bg_color = C.bg, fg_color = C.muted },
      inactive_tab_hover = { bg_color = C.card, fg_color = C.text },
      new_tab = { bg_color = C.bg, fg_color = C.muted },
      new_tab_hover = { bg_color = C.card, fg_color = C.text },
    },
  }
  config.font = wezterm.font_with_fallback({ "JetBrains Mono", "Menlo" })
  config.font_size = 14
  config.line_height = 1.1
  config.scrollback_lines = 20000
  config.use_fancy_tab_bar = false
  config.tab_max_width = 48
  config.window_padding = { left = 8, right = 8, top = 6, bottom = 4 }
  -- the pane you type in stands out; the others dim a little
  config.inactive_pane_hsb = { saturation = 0.85, brightness = 0.7 }
  config.status_update_interval = 2000
  local envs = config.set_environment_variables or {}
  envs.COLORTERM = "truecolor"
  config.set_environment_variables = envs

  -- Cmd+Alt (Ctrl+Alt off macOS): T task pane under the lead (focuses it when it is open), D a pane
  -- in the column on the right, S one more under it, E a new ekip lead in a tab, Z zoom, arrows move.
  local mods = wezterm.target_triple:find("darwin") and "CMD|ALT" or "CTRL|ALT"
  local keys = config.keys or {}
  local function key(k, action) table.insert(keys, { key = k, mods = mods, action = action }) end
  key("t", wezterm.action_callback(function(window, pane)
    for _, p in ipairs(pane:tab():panes()) do
      if p:get_title() == TASK_TITLE then p:activate() return end
    end
    window:perform_action(act.SplitPane({ direction = "Down", size = { Percent = 30 }, command = { args = TASK_PANE } }), pane)
  end))
  key("d", act.SplitPane({ direction = "Right", size = { Percent = 40 } }))
  key("s", act.SplitPane({ direction = "Down" }))
  key("e", act.SpawnCommandInNewTab({ args = EKIP }))
  key("z", act.TogglePaneZoomState)
  for _, dir in ipairs({ "Left", "Right", "Up", "Down" }) do key(dir .. "Arrow", act.ActivatePaneDirection(dir)) end
  config.keys = keys
  return config
end

-- Tab titles: the pane's title; an ekip tab also shows its open tasks (? waiting, ■ blocked, ● running).
wezterm.on("format-tab-title", function(tab, tabs, panes, cfg, hover, max_width)
  local title = tab.tab_title
  if not title or #title == 0 then title = tab.active_pane.title end
  local items = { { Background = { Color = tab.is_active and C.card or C.bg } } }
  if title:find("^ekip") then
    local n = counts()
    if n.waiting > 0 then push(items, C.waiting, " ?" .. n.waiting) end
    if n.blocked > 0 then push(items, C.blocked, " ■" .. n.blocked) end
    if n.running > 0 then push(items, C.team, " ●" .. n.running) end
  end
  push(items, tab.is_active and C.text or C.muted, " " .. wezterm.truncate_right(title, math.max(8, max_width - 10)) .. " ")
  return items
end)

-- Right of the tab bar: the ekip mark and what needs you.
wezterm.on("update-status", function(window, pane)
  local n = counts()
  local items = {}
  push(items, C.lead, "❯ ")
  push(items, C.team, "ekip  ")
  if n.waiting > 0 then push(items, C.waiting, "? " .. n.waiting .. " " .. L.waiting .. "  ") end
  if n.blocked > 0 then push(items, C.blocked, "■ " .. n.blocked .. " " .. L.blocked .. "  ") end
  push(items, n.running > 0 and C.team or C.muted, "● " .. n.running .. " " .. L.running .. " ")
  window:set_right_status(wezterm.format(items))
end)

return M
`;
}

// What the user's own config does with ekip.lua: "none" (no config: ekip writes a small one),
// "linked" (it already requires ekip) or "own" (ekip leaves it alone and says how to add it).
export function userConfigState(env = process.env) {
  const file = userConfigs(env).find((f) => fs.existsSync(f));
  if (!file) return { state: "none", file: path.join(configDir(env), "wezterm.lua") };
  const text = fs.readFileSync(file, "utf8");
  return { state: /require\s*\(?\s*["']ekip["']/.test(text) ? "linked" : "own", file };
}

function install(args, env = process.env) {
  const dry = args.includes("--dry-run");
  const step = (s) => console.log(`  ${dry ? c.gray(t("(deneme)")) : c.cyan("›")} ${s}`);
  console.log(`${c.bold(t("ekip terminali: WezTerm"))}${dry ? c.gray(` · ${t("deneme: hiçbir şey kurulmaz, dosya yazılmaz")}`) : ""}`);
  if (weztermInstalled(env)) step(t("WezTerm kurulu"));
  else if (process.platform !== "darwin") step(t("WezTerm kurulu değil: https://wezterm.org/install/linux.html adresindeki paketi kurun"));
  else if (!has("brew")) step(t("WezTerm kurulu değil ve Homebrew yok. Önce Homebrew'u kurun (https://brew.sh), sonra: {cmd}", { cmd: "brew install --cask wezterm" }));
  else if (dry) step(t("kurulacak: {cmd}", { cmd: "brew install --cask wezterm" }));
  else {
    step("brew install --cask wezterm");
    if (spawnSync("brew", ["install", "--cask", "wezterm"], { stdio: "inherit" }).status !== 0) die("brew install --cask wezterm failed");
  }
  const dir = configDir(env);
  const mine = path.join(dir, "ekip.lua"), start = path.join(dir, "ekip-start.lua");
  const write = (file, text) => { if (!dry) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); } };
  write(mine, ekipLua());
  write(start, loaderLua(dir));
  step(t("{file} yazılır (ekip'in ayarları: koyu tema, 14 pt yazı, sekmede görev durumu, kısayollar)", { file: mine }));
  const user = userConfigState(env);
  if (user.state === "none") { write(user.file, loaderLua(dir)); step(t("{file} yoktu: ekip.lua'yı yükleyen küçük bir dosya yazılır", { file: user.file })); }
  else if (user.state === "linked") step(t("{file} zaten ekip.lua'yı yüklüyor", { file: user.file }));
  else {
    step(t("{file} sizin; ekip ona dokunmaz. ekip'in ayarlarını istiyorsanız 'return config' satırından önce ekleyin:", { file: user.file }));
    console.log(c.gray(`      package.path = ${lua(dir)} .. "/?.lua;" .. package.path\n      require("ekip").apply(config)`));
  }
  if (!dry) saveSettings({ terminal: "wezterm" });
  console.log(`\n  ${t("Başlatmak için: {cmd}  (lead solda, işçi bölmeleri sağda, görev bölmesi altta; Cmd+Alt+T görev bölmesi)", { cmd: c.cyan("ekip terminal open") })}`);
  return 0;
}

function open(args, env = process.env) {
  const dry = args.includes("--dry-run");
  if (!weztermInstalled(env)) die(t("WezTerm kurulu değil: ekip terminal install"));
  const user = userConfigState(env);
  const start = path.join(configDir(env), "ekip-start.lua");
  // a user config without ekip.lua: this window still gets ekip's settings
  const cfg = user.state === "own" && fs.existsSync(start) ? ["--config-file", start] : [];
  const rest = args.filter((a) => a !== "--dry-run");
  const command = ekipCmd(rest);
  const argv = [...cfg, "start", "--cwd", process.cwd(), "--", "/bin/zsh", "-lc", command];
  if (dry) { console.log(`${weztermBin(env)} ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`); return 0; }
  const childEnv = { ...env };
  for (const k of ["ITERM_SESSION_ID", "TERM_SESSION_ID", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "WEZTERM_PANE", "KITTY_WINDOW_ID"]) delete childEnv[k];
  spawn(weztermBin(env), argv, { detached: true, stdio: "ignore", env: childEnv }).unref();
  console.log(t("ekip WezTerm'de açılıyor"));
  return 0;
}

function status(env = process.env) {
  const kind = detect(env);
  const user = userConfigState(env);
  const names = { wezterm: "WezTerm", kitty: "kitty", iterm: "iTerm2", none: t("bölme açamayan bir terminal") };
  console.log(`  ${t("şu anki terminal")}: ${c.bold(names[kind])}`);
  console.log(`  WezTerm: ${weztermInstalled(env) ? c.green(t("kurulu")) : c.gray(t("kurulu değil"))}`);
  console.log(`  ekip.lua: ${fs.existsSync(path.join(configDir(env), "ekip.lua")) ? c.green(t("yazılmış")) : c.gray(t("yok (ekip terminal install)"))}  ·  ${user.file}: ${user.state === "linked" ? c.green(t("ekip.lua'yı yüklüyor")) : user.state === "own" ? c.yellow(t("ekip.lua'yı yüklemiyor")) : c.gray(t("yok"))}`);
  return 0;
}

export async function main([sub = "status", ...args]) {
  if (sub === "install") return install(args);
  if (sub === "open") return open(args);
  if (sub === "status") return status();
  if (sub === "config") { process.stdout.write(ekipLua()); return 0; }
  die("usage: ekip terminal install [--dry-run] | open [--dry-run] [ekip args] | status | config");
}
