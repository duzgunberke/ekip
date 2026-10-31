// `ekip terminal install|open|status`: ekip's own terminal, optional. WezTerm (MIT, Homebrew cask)
// is driven with `wezterm cli` instead of AppleScript and gets an ekip config: the brand's dark
// theme, a readable font size, task state in the tab bar, keys for the lead / column / task pane
// layout. The user's wezterm.lua is never overwritten; iTerm2 keeps working as before.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, ROOT, SETTINGS, ask, die, has, saveSettings } from "../core/core.js";
import { TASK_TITLE, detect, paneShell, parseWeztermList, weztermBin } from "../core/terminal.js";
import { c } from "../core/ui.js";
import { writeTerminalStatus } from "../tasks/tasks.js";
import { t } from "../core/i18n.js";
import { appLine, appState, appWezterm, ensureApp, launchMode, runningGuiApp, spawnArgv } from "./terminal-app.js";

export const configDir = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "wezterm");
// WezTerm reads the first of these that exists
const userConfigs = (env = process.env) => [...(env.WEZTERM_CONFIG_FILE ? [env.WEZTERM_CONFIG_FILE] : []), path.join(os.homedir(), ".wezterm.lua"), path.join(configDir(env), "wezterm.lua")];
const FONT_DIRS = [path.join(os.homedir(), "Library/Fonts"), "/Library/Fonts"];
export function jetbrainsInstalled(dirs = FONT_DIRS) {
  return dirs.some((d) => { try { return fs.readdirSync(d).some((f) => /^JetBrainsMono/i.test(f)); } catch { return false; } });
}
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

/**
 * ekip.lua: a module with apply(config). Colours from docs/brand.md (dark). The tab bar shows the
 * ekip mark on the left, one tab per project (the registered ekip project's name, else the folder,
 * "~" for home) and the open tasks on the right (? waiting for you, ■ stuck, ● running), read from
 * data/terminal-status.json, which ekip rewrites when a task changes: no ekip process per second.
 */
export function ekipLua({ statusFile = path.join(HOME, "terminal-status.json") } = {}) {
  const tasksPane = paneShell(ekipCmd(["tasks", "--watch"]), { title: TASK_TITLE, role: "tasks" });
  return `-- ekip's WezTerm settings, written by \`ekip terminal install\` and rewritten by every install:
-- keep your own settings in wezterm.lua, after require("ekip").apply(config).
local wezterm = require("wezterm")
local act = wezterm.action
local M = {}

local STATUS = ${lua(statusFile)}
local EKIP = ${lua(["/bin/zsh", "-lc", ekipCmd()])}
local TASK_PANE = ${lua(tasksPane)}
local TASK_TITLE = ${lua(TASK_TITLE)}
local L = { waiting = ${lua(t("bekleyen"))}, blocked = ${lua(t("takılan"))}, running = ${lua(t("çalışan"))}, setup = ${lua(t("kurulum"))} }
local C = {
  bg = "#0E1014", card = "#15181E", text = "#ECEEF2", muted = "#98A1B0", border = "#252A33", faint = "#5B6472",
  lead = "#FFA95E", team = "#2DD4BF", done = "#3FCF7A", failed = "#F2555A", blocked = "#F5A524",
  waiting = "#FACC15", queued = "#60A5FA",
}

local function decode(s)
  if wezterm.serde and wezterm.serde.json_decode then return wezterm.serde.json_decode(s) end
  return wezterm.json_parse(s)
end

-- data/terminal-status.json, read at most once a second; missing or broken: nothing to show.
local cache = { at = -1, v = { waiting = 0, blocked = 0, running = 0, projects = {} } }
local function status()
  local now = os.time()
  if now == cache.at then return cache.v end
  local v = { waiting = 0, blocked = 0, running = 0, projects = {} }
  local f = io.open(STATUS, "r")
  if f then
    local ok, d = pcall(decode, f:read("*a"))
    f:close()
    if ok and type(d) == "table" then
      for _, k in ipairs({ "waiting", "blocked", "running" }) do v[k] = tonumber(d[k]) or 0 end
      if type(d.projects) == "table" then v.projects = d.projects end
      -- missing required setup steps (ekip setup): a small "kurulum 5/9" counter
      if type(d.setup) == "table" and (tonumber(d.setup.missing) or 0) > 0 then v.setup = d.setup end
    end
  end
  cache = { at = now, v = v }
  return v
end

local function width(s)
  if wezterm.column_width then return wezterm.column_width(s) end
  return utf8.len(s) or #s
end
-- A long name keeps its start and its end: "northwind-…-checkout".
local function middle(s, n)
  if width(s) <= n then return s end
  if n <= 1 then return "…" end
  local chars = {}
  for _, cp in utf8.codes(s) do table.insert(chars, utf8.char(cp)) end
  local head, tail = math.ceil((n - 1) / 2), math.floor((n - 1) / 2)
  return table.concat(chars, "", 1, head) .. "…" .. (tail > 0 and table.concat(chars, "", #chars - tail + 1, #chars) or "")
end

-- A pane's folder: a Url object (newer WezTerm) or a file:// string (older).
local function folder(cwd)
  if not cwd then return nil end
  if type(cwd) ~= "string" then
    local ok, p = pcall(function() return cwd.file_path end)
    if ok and p then return p end
    cwd = tostring(cwd)
  end
  local p = cwd:gsub("^file://[^/]*", "")
  return (p:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))
end

-- The tab's name: the registered ekip project the folder is in, else the folder's last name; "~" at home.
local function project(dir, title)
  if dir and dir ~= "" then
    dir = dir:gsub("/+$", "")
    local best
    for _, p in ipairs(status().projects) do
      if type(p) == "table" and type(p.path) == "string" and type(p.name) == "string"
        and (dir == p.path or dir:sub(1, #p.path + 1) == p.path .. "/") and (not best or #p.path > #best.path) then best = p end
    end
    if best then return best.name end
    if dir == "" or dir == wezterm.home_dir then return "~" end
    return dir:match("([^/]+)$") or dir
  end
  title = (title or ""):gsub("^ekip · ", "")
  return title ~= "" and title or "ekip"
end

-- the active tab's name keeps up to 28 columns, the others 16, so the counts on the right still fit
local MAX_TAB, MAX_OTHER = 28, 16
local function tab_name(tab)
  local pane = tab.active_pane
  local dir = folder(pane.current_working_dir)
  -- a title set by hand wins; "ekip · " from older ekip versions is dropped
  local title = (tab.tab_title or ""):gsub("^ekip · ", "")
  if #title > 0 then return middle(title, MAX_TAB) end
  return middle(project(dir, pane.title), MAX_TAB)
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
    scrollbar_thumb = C.border,
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
  -- JetBrains Mono ships with WezTerm; a newer copy from Homebrew (font-jetbrains-mono) wins when installed
  config.font = wezterm.font_with_fallback({ "JetBrains Mono", "Menlo", "Apple Color Emoji" })
  config.font_size = 14
  config.line_height = 1.12
  config.scrollback_lines = 20000
  config.use_fancy_tab_bar = false
  config.tab_max_width = MAX_TAB + 6
  config.show_new_tab_button_in_tab_bar = false
  config.hide_tab_bar_if_only_one_tab = false
  config.window_padding = { left = "10pt", right = "10pt", top = "6pt", bottom = "5pt" }
  -- the pane you type in stands out; the others dim a little
  config.inactive_pane_hsb = { saturation = 0.85, brightness = 0.72 }
  config.status_update_interval = 1000
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
  local function bind(k, m, action) table.insert(keys, { key = k, mods = m, action = action }) end
  -- Shift+Enter: a new line in Claude Code instead of sending the prompt
  bind("Enter", "SHIFT", act.SendString("\\x1b\\r"))

  -- Paths are links too ("/x/y.js", "/x/y.js:12"); the line number stays out of the file:// URL.
  local rules = wezterm.default_hyperlink_rules()
  table.insert(rules, { regex = [[(?:^|[\\s"'(\\[<=])((?:/[\\w.@~+-]*[\\w@~+-]){2,})(?::\\d+){0,2}]], format = "file://$1", highlight = 1 })
  config.hyperlink_rules = rules
  config.quote_dropped_files = "Posix"
  config.audible_bell = "Disabled"
  config.visual_bell = { fade_in_duration_ms = 60, fade_out_duration_ms = 120 }
  config.colors.visual_bell = C.border
  -- OSC 9 / OSC 777 notifications (Claude Code, CLIs) show as desktop notifications, as in iTerm2
  config.notification_handling = "AlwaysShow"

  if wezterm.target_triple:find("darwin") then
    -- Option types @ | [ ] { } on Turkish and German keyboards: both Option keys stay composed
    config.send_composed_key_when_left_alt_is_pressed = true
    config.send_composed_key_when_right_alt_is_pressed = true
    config.native_macos_fullscreen_mode = true

    -- Cmd+V: an image on the clipboard goes to the program as Ctrl+V (Claude Code reads images
    -- there); anything else, a copied file and any failed check are a plain text paste. Only the
    -- pasteboard's type names are read (~0.1 s); "clipboard info" converts the image (~1 s).
    bind("v", "CMD", wezterm.action_callback(function(window, pane)
      local ok, success, out = pcall(wezterm.run_child_process, { "/usr/bin/osascript", "-l", "JavaScript", "-e",
        [[ObjC.import("AppKit"); ObjC.deepUnwrap($.NSPasteboard.generalPasteboard.types).join(" ")]] })
      local image = ok and success and type(out) == "string" and not out:find("public.file-url", 1, true)
        and (out:find("public.png", 1, true) or out:find("public.tiff", 1, true) or out:find("public.jpeg", 1, true) or out:find("com.compuserve.gif", 1, true))
      window:perform_action(image and act.SendKey({ key = "v", mods = "CTRL" }) or act.PasteFrom("Clipboard"), pane)
    end))

    -- iTerm2's "natural text editing": Option moves by word, Cmd to the line's ends
    bind("LeftArrow", "OPT", act.SendString("\\x1bb"))
    bind("RightArrow", "OPT", act.SendString("\\x1bf"))
    bind("Backspace", "OPT", act.SendString("\\x17"))
    bind("LeftArrow", "CMD", act.SendString("\\x01"))
    bind("RightArrow", "CMD", act.SendString("\\x05"))
    bind("Backspace", "CMD", act.SendString("\\x15"))
    -- Cmd+K clears the scrollback and the screen; the program redraws its prompt
    bind("k", "CMD", act.Multiple({ act.ClearScrollback("ScrollbackAndViewport"), act.SendKey({ key = "L", mods = "CTRL" }) }))

    -- iTerm2's panes: Cmd+D right, Cmd+Shift+D down, Cmd+[ ] move, Cmd+W closes the pane,
    -- Cmd+Shift+Enter maximizes it, Cmd+Enter is full screen
    bind("d", "CMD", act.SplitPane({ direction = "Right" }))
    bind("d", "CMD|SHIFT", act.SplitPane({ direction = "Down" }))
    bind("[", "CMD", act.ActivatePaneDirection("Prev"))
    bind("]", "CMD", act.ActivatePaneDirection("Next"))
    bind("w", "CMD", act.CloseCurrentPane({ confirm = true }))
    bind("Enter", "CMD", act.ToggleFullScreen)
    bind("Enter", "CMD|SHIFT", act.TogglePaneZoomState)

    -- A selection is copied when the mouse comes up (WezTerm's own default); a plain click no longer
    -- opens a link, Cmd+click does, as in iTerm2. Other mouse defaults stay: only these are replaced.
    local mouse = config.mouse_bindings or {}
    local function click(dir, streak, m, action) table.insert(mouse, { event = { [dir] = { streak = streak, button = "Left" } }, mods = m, action = action }) end
    for streak = 1, 3 do click("Up", streak, "NONE", act.CompleteSelection("ClipboardAndPrimarySelection")) end
    click("Up", 1, "CMD", act.OpenLinkAtMouseCursor)
    click("Down", 1, "CMD", act.Nop)
    config.mouse_bindings = mouse
  end
  config.keys = keys
  return config
end

-- Tabs: the project's name with room around it; the active tab sits on the card colour.
wezterm.on("format-tab-title", function(tab, tabs, panes, cfg, hover, max_width)
  local active = tab.is_active
  local name = middle(tab_name(tab), math.max(4, math.min(active and MAX_TAB or MAX_OTHER, max_width - 4)))
  return {
    { Background = { Color = active and C.card or C.bg } },
    { Foreground = { Color = active and C.lead or C.bg } }, { Text = active and "▎" or " " },
    { Foreground = { Color = (active or hover) and C.text or C.muted } },
    { Attribute = { Intensity = active and "Bold" or "Normal" } },
    { Text = " " .. name .. "  " },
  }
end)

-- The window title: ekip and the project.
wezterm.on("format-window-title", function(tab)
  return "ekip · " .. tab_name(tab)
end)

-- The counts on the right, longest form that fits: every label, labels on the non-zero ones, the
-- bare counts, the non-zero counts. Labels drop first; a word is never cut.
local function counts_variants(n)
  local defs = { { "waiting", "?", C.waiting }, { "blocked", "■", C.blocked }, { "running", "●", C.team } }
  local function build(labels, skip_zero)
    local items, w = {}, 0
    for _, d in ipairs(defs) do
      local k, sym, color = d[1], d[2], d[3]
      local v = n[k] or 0
      if not (skip_zero and v == 0) then
        local text = sym .. " " .. v .. ((labels == "all" or (labels == "some" and v > 0)) and (" " .. L[k]) or "")
        if #items > 0 then push(items, C.muted, "   "); w = w + 3 end
        push(items, v > 0 and color or C.faint, text)
        w = w + width(text)
      end
    end
    return items, w
  end
  return { { build("all") }, { build("some") }, { build("none") }, { build("none", true) } }
end

wezterm.on("update-status", function(window, pane)
  local n = status()
  window:set_left_status(wezterm.format({
    { Background = { Color = C.bg } }, { Text = "  " },
    { Foreground = { Color = C.lead } }, { Text = "❯ " },
    { Foreground = { Color = C.team } }, { Attribute = { Intensity = "Bold" } }, { Text = "ekip" },
    { Attribute = { Intensity = "Normal" } }, { Text = "   " },
  }))
  -- room left of the tabs: the window's columns minus the mark and every tab
  local cols = 0
  local ok, size = pcall(function() return window:active_tab():get_size() end)
  if ok and size then cols = size.cols end
  local used = 9
  local mw = window:mux_window()
  local active = window:active_tab():tab_id()
  for _, t in ipairs(mw and mw:tabs() or {}) do
    local p = t:active_pane()
    local name = (t:get_title() or ""):gsub("^ekip · ", "")
    if name == "" then name = project(folder(p:get_current_working_dir()), p:get_title()) end
    used = used + width(middle(name, t:tab_id() == active and MAX_TAB or MAX_OTHER)) + 4
  end
  local room = cols - used - 2
  -- the setup counter goes first and is the first to drop when the counts do not fit
  local setup = n.setup and (L.setup .. " " .. (tonumber(n.setup.done) or 0) .. "/" .. (tonumber(n.setup.total) or 0)) or nil
  for _, v in ipairs(counts_variants(n)) do
    local items, w = v[1], v[2]
    if setup and w > 0 and w + width(setup) + 5 <= room then
      local all = {}
      push(all, C.waiting, setup)
      push(all, C.muted, "   ")
      for _, it in ipairs(items) do table.insert(all, it) end
      table.insert(all, { Text = "  " })
      window:set_right_status(wezterm.format(all))
      return
    end
  end
  for _, v in ipairs(counts_variants(n)) do
    local items, w = v[1], v[2]
    if w > 0 and w + 2 <= room then
      table.insert(items, { Text = "  " })
      window:set_right_status(wezterm.format(items))
      return
    end
  end
  window:set_right_status("")
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

export function install(args, env = process.env, { run = spawnSync, brew = has("brew"), platform = process.platform } = {}) {
  const dry = args.includes("--dry-run");
  const step = (s) => console.log(`  ${dry ? c.gray(t("(deneme)")) : c.cyan("›")} ${s}`);
  console.log(`${c.bold(t("ekip terminali: WezTerm"))}${dry ? c.gray(` · ${t("deneme: hiçbir şey kurulmaz, dosya yazılmaz")}`) : ""}`);
  if (weztermInstalled(env)) step(t("WezTerm kurulu"));
  else if (platform !== "darwin") step(t("WezTerm kurulu değil: https://wezterm.org/install/linux.html adresindeki paketi kurun"));
  else if (!brew) step(t("WezTerm kurulu değil ve Homebrew yok. Önce Homebrew'u kurun (https://brew.sh), sonra: {cmd}", { cmd: "brew install --cask wezterm" }));
  else if (dry) step(t("kurulacak: {cmd}", { cmd: "brew install --cask wezterm" }));
  else {
    step("brew install --cask wezterm");
    if (run("brew", ["install", "--cask", "wezterm"], { stdio: "inherit" }).status !== 0) { console.log(`  ${c.red("✗")} brew install --cask wezterm failed`); return 1; }
  }
  // JetBrains Mono: WezTerm carries a copy; the Homebrew font is newer and used by other apps too
  if (platform === "darwin" && !jetbrainsInstalled()) {
    const cmd = "brew install --cask font-jetbrains-mono";
    if (!brew) step(t("JetBrains Mono yazı tipi kurulu değil; WezTerm kendi kopyasını kullanır (yoksa Menlo). Kurmak için: {cmd}", { cmd }));
    else if (dry) step(t("önerilir: {cmd}", { cmd }));
    else if (args.includes("--yes") || args.includes("-y") || args.includes("--font")) {
      step(cmd);
      if (run("brew", ["install", "--cask", "font-jetbrains-mono"], { stdio: "inherit" }).status !== 0) step(c.yellow(t("yazı tipi kurulamadı; WezTerm kendi kopyasını kullanır")));
    } else step(t("JetBrains Mono yazı tipi kurulu değil; WezTerm kendi kopyasını kullanır (yoksa Menlo). Kurmak için: {cmd}", { cmd: "ekip terminal install --font" }));
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
  if (platform === "darwin" && (dry || weztermInstalled(env))) ensureApp(env, { run, dry, step, platform, force: args.includes("--rebuild-app") });
  if (!dry) {
    saveSettings({ terminal: "wezterm" });
    // the tab bar reads its counts and project names from this file: write it once now
    writeTerminalStatus();
  }
  console.log(`\n  ${t("Başlatmak için: {cmd}  (lead solda, işçi bölmeleri sağda, görev bölmesi altta; Cmd+Alt+T görev bölmesi)", { cmd: c.cyan("ekip terminal open") })}`);
  return 0;
}

// `wezterm start` for a new window running `ekip <args>` in cwd. A running WezTerm opens the window
// from its own process, so ekip's own variables (EKIP_HOME, …) go on the command line.
export function startArgv(args, { env = process.env, cwd = process.cwd() } = {}) {
  const user = userConfigState(env);
  const start = path.join(configDir(env), "ekip-start.lua");
  // a user config without ekip.lua: this window still gets ekip's settings
  const cfg = user.state === "own" && fs.existsSync(start) ? ["--config-file", start] : [];
  return [...cfg, "start", "--cwd", cwd, "--", ...leadShell(args, env)];
}
export function leadShell(args, env = process.env) {
  const keep = Object.entries(env).filter(([k]) => (k.startsWith("EKIP_") && k !== "EKIP_TERMINAL") || k === "CLAUDE_CONFIG_DIR");
  const prefix = keep.map(([k, v]) => `${k}=${JSON.stringify(v)} `).join("");
  return ["/bin/zsh", "-lc", `${prefix}${ekipCmd(args)}`];
}
const childEnvOf = (env) => {
  const out = { ...env };
  for (const k of ["ITERM_SESSION_ID", "TERM_SESSION_ID", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "WEZTERM_PANE", "KITTY_WINDOW_ID"]) delete out[k];
  return out;
};

const detached = (env) => (bin, argv) => spawn(bin, argv, { detached: true, stdio: "ignore", env: childEnvOf(env) }).unref();

/**
 * Opens a lead window with ekip.app's WezTerm (WezTerm's own without it): a new window in the GUI
 * that is already running, so the Dock keeps one icon; a new GUI only when none runs.
 */
export function launchLead(args, { env = process.env, cwd = process.cwd(), run = spawnSync, launch = detached(env), panes = paneIds(run, env), platform = process.platform } = {}) {
  const bin = appWezterm(env) ?? weztermBin(env);
  if (launchMode(panes) === "spawn") {
    const r = run(bin, spawnArgv(leadShell(args, env), cwd), { encoding: "utf8", timeout: 5000, env: childEnvOf(env) });
    if (r.status === 0 && !r.error) {
      // bring the running WezTerm forward (`open -a` on a running app only activates it)
      const app = platform === "darwin" ? runningGuiApp(run("ps", ["-axo", "comm="], { encoding: "utf8" }).stdout) : null;
      if (app) launch("open", ["-a", app]);
      return "spawn";
    }
  }
  launch(bin, startArgv(args, { env, cwd }));
  return "start";
}

function open(args, env = process.env) {
  const dry = args.includes("--dry-run");
  if (!weztermInstalled(env)) die(t("WezTerm kurulu değil: ekip terminal install"));
  const rest = args.filter((a) => a !== "--dry-run");
  if (dry) {
    const bin = appWezterm(env) ?? weztermBin(env);
    const panes = paneIds(spawnSync, env);
    const argv = launchMode(panes) === "spawn" ? spawnArgv(leadShell(rest, env), process.cwd()) : startArgv(rest, { env });
    console.log(`${bin} ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    return 0;
  }
  launchLead(rest, { env });
  console.log(t("ekip WezTerm'de açılıyor"));
  return 0;
}

// ---- WezTerm as the default terminal (`ekip` in another terminal moves to WezTerm) --------------

const preference = (env, settings) => env.EKIP_TERMINAL || settings.terminal || "current";

/** Should a lead start move to WezTerm? { move: true } or { move: false, why } (why null: say nothing). */
export function handoffPlan(args, { env = process.env, settings = SETTINGS, tty = !!(process.stdin.isTTY && process.stdout.isTTY), installed = () => weztermInstalled(env) } = {}) {
  if (args.includes("--here")) return { move: false, why: null };
  if (preference(env, settings) !== "wezterm") return { move: false, why: null };
  if (detect(env) === "wezterm") return { move: false, why: null };
  // a print run, a team member, a pipe or an SSH login stays where it is
  if (!tty || args.some((a) => a === "-p" || a === "--print" || a === "--member")) return { move: false, why: null };
  if (env.SSH_CONNECTION || env.SSH_TTY) return { move: false, why: null };
  if (!installed()) return { move: false, why: t("WezTerm bulunamadı") };
  return { move: true };
}

/** Which terminal ekip was started from, for closing it: "iterm", "apple" or "other". */
export function hostTerminal(env = process.env) {
  if (env.TMUX) return "other";
  if (env.TERM_PROGRAM === "iTerm.app" && env.ITERM_SESSION_ID) return "iterm";
  if (env.TERM_PROGRAM === "Apple_Terminal") return "apple";
  return "other";
}

const asString = (s) => `"${String(s).replace(/[\\"]/g, "\\$&")}"`;
// Waits a moment so ekip has exited (no "a process is running" prompt), then closes only this one
// session / tab; a window with no other tab closes with it.
export function itermCloseScript(sessionId) {
  const id = String(sessionId ?? "").split(":").pop();
  if (!/^[0-9A-Fa-f-]{8,}$/.test(id)) return null;
  return `delay 1
tell application "iTerm2"
  repeat with w in windows
    repeat with tb in tabs of w
      repeat with s in sessions of tb
        if unique id of s is ${asString(id)} then
          close s
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`;
}

export function terminalAppCloseScript(tty) {
  if (!/^\/dev\/ttys?\d+$/.test(String(tty ?? ""))) return null;
  return `delay 1
tell application "Terminal"
  repeat with w in windows
    repeat with tb in tabs of w
      if tty of tb is ${asString(tty)} then
        if (count of tabs of w) is 1 then
          close w saving no
        else
          try
            close tb saving no
          end try
        end if
        return
      end if
    end repeat
  end repeat
end tell`;
}

const ttyName = (run) => { const r = run("tty", [], { encoding: "utf8", stdio: ["inherit", "pipe", "ignore"] }); return r.status === 0 ? (r.stdout ?? "").trim() : ""; };
const paneIds = (run, env) => {
  const r = run(weztermBin(env), ["cli", "--no-auto-start", "list", "--format", "json"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0 || r.error) return null;
  return parseWeztermList(r.stdout ?? "")?.map((p) => p.id) ?? null;
};

/**
 * Starts the lead in a new WezTerm window and, once its pane shows up in `wezterm cli list`, closes
 * the session ekip was started from. Returns true when the lead now runs in WezTerm (the caller
 * exits); false when WezTerm did not open (nothing is closed, the lead starts here).
 */
export async function handoff(args, { env = process.env, cwd = process.cwd(), run = spawnSync, launch, wait = 10_000, step = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), platform = process.platform } = {}) {
  const panes = paneIds(run, env);
  const before = new Set(panes ?? []);
  try {
    launchLead(args, { env, cwd, run, launch: launch ?? detached(env), panes, platform });
  } catch (e) {
    console.log(c.yellow(t("WezTerm açılamadı ({why}); lead bu terminalde açılıyor", { why: e.message })));
    return false;
  }
  let opened = false;
  for (let waited = 0; waited <= wait && !opened; waited += step) {
    opened = (paneIds(run, env) ?? []).some((id) => !before.has(id));
    if (!opened) await sleep(step);
  }
  if (!opened) {
    console.log(c.yellow(t("WezTerm açılamadı ({why}); lead bu terminalde açılıyor", { why: t("{n} sn içinde yeni pencere görünmedi", { n: Math.round(wait / 1000) }) })));
    return false;
  }
  const host = platform === "darwin" ? hostTerminal(env) : "other";
  const script = host === "iterm" ? itermCloseScript(env.ITERM_SESSION_ID) : host === "apple" ? terminalAppCloseScript(ttyName(run)) : null;
  if (script) {
    console.log(t("ekip WezTerm'de açıldı; bu sekme kapanıyor"));
    // detached: it outlives ekip and the session it closes
    if (launch) launch("osascript", ["-e", script]);
    else spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
  } else console.log(t("ekip WezTerm'de açıldı; artık WezTerm penceresini kullanın (bu terminal açık kalır)"));
  return true;
}

function setDefault([value] = []) {
  if (!["wezterm", "current"].includes(value)) die("usage: ekip terminal default wezterm|current");
  saveSettings({ terminal: value });
  console.log(value === "wezterm" ? t("ekip artık WezTerm'de açılır (bu terminalde açmak için: ekip --here)") : t("ekip artık çalıştırıldığı terminalde açılır"));
  return 0;
}

/** `ekip init`, macOS: offer WezTerm once (default yes), then the config and the setting. */
export async function initTerminal(args, { env = process.env, platform = process.platform, interactive = !!(process.stdin.isTTY && process.stdout.isTTY) && !env.CI, ask: prompt = ask, run = spawnSync, brew = has("brew"), installed = () => weztermInstalled(env) } = {}) {
  if (platform !== "darwin" || args.includes("--no-terminal")) return "skipped";
  if (!installed()) {
    let yes = args.includes("--yes") || args.includes("-y");
    if (!yes && interactive) yes = !/^(h|hayır|n|no)$/i.test((await prompt(`${t("ekip'in kendi terminalini (WezTerm) kurayım mı? [E/h]")} `)).trim());
    if (!yes) { console.log(c.gray(t("WezTerm atlandı; sonra: ekip terminal install"))); return "skipped"; }
    if (!brew) { console.log(t("WezTerm kurulu değil ve Homebrew yok. Önce Homebrew'u kurun (https://brew.sh), sonra: {cmd}", { cmd: "ekip terminal install" })); return "no-brew"; }
  }
  return install([], env, { run, brew, platform }) === 0 ? "installed" : "failed";
}

function status(env = process.env) {
  const kind = detect(env);
  const user = userConfigState(env);
  const names = { wezterm: "WezTerm", kitty: "kitty", iterm: "iTerm2", none: t("bölme açamayan bir terminal") };
  console.log(`  ${t("şu anki terminal")}: ${c.bold(names[kind])}`);
  const pref = preference(env, SETTINGS);
  console.log(`  ${t("ekip açılınca")}: ${pref === "wezterm" ? c.bold(t("WezTerm'e geçer")) : c.bold(t("bu terminalde kalır"))}${env.EKIP_TERMINAL ? c.gray(" (EKIP_TERMINAL)") : ""}  ${c.gray("· ekip terminal default wezterm|current")}`);
  console.log(`  WezTerm: ${weztermInstalled(env) ? c.green(t("kurulu")) : c.gray(t("kurulu değil"))}`);
  const app = appLine(appState(env));
  if (app) console.log(`  ekip.app: ${app[0] === "ok" ? c.green(app[1]) : c.yellow(app[1])}`);
  console.log(`  ekip.lua: ${fs.existsSync(path.join(configDir(env), "ekip.lua")) ? c.green(t("yazılmış")) : c.gray(t("yok (ekip terminal install)"))}  ·  ${user.file}: ${user.state === "linked" ? c.green(t("ekip.lua'yı yüklüyor")) : user.state === "own" ? c.yellow(t("ekip.lua'yı yüklemiyor")) : c.gray(t("yok"))}`);
  return 0;
}

export async function main([sub = "status", ...args]) {
  if (sub === "install") { const code = install(args); if (code) die("brew install --cask wezterm failed"); return 0; }
  if (sub === "default") return setDefault(args);
  if (sub === "open") return open(args);
  if (sub === "status") return status();
  if (sub === "config") { process.stdout.write(ekipLua()); return 0; }
  die("usage: ekip terminal install [--dry-run] [--rebuild-app] | open [--dry-run] [ekip args] | default wezterm|current | status | config");
}
