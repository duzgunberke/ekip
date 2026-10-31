// WezTerm as the default terminal, with a fake `wezterm cli`, osascript and brew: no terminal is
// opened or closed, nothing is installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-wezdefault-"));
process.env.EKIP_HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.EKIP_HOME, { recursive: true });
const term = await import("./terminal.js");
const core = await import("../core/core.js");
const quiet = (fn) => async (...a) => { const log = console.log; console.log = () => {}; try { return await fn(...a); } finally { console.log = log; } };

// ---- when a lead start moves to WezTerm --------------------------------------------------------
const iterm = { TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0t1p0:6B0C2D1E-1111-2222-3333-444455556666" };
const yes = () => true;
const plan = (args, env, settings = { terminal: "wezterm" }, extra = {}) => term.handoffPlan(args, { env, settings, tty: true, installed: yes, ...extra });
assert.deepEqual(plan([], iterm), { move: true });
assert.equal(plan(["--here"], iterm).move, false, "--here stays");
assert.equal(plan([], { ...iterm, EKIP_TERMINAL: "current" }).move, false, "EKIP_TERMINAL=current stays");
assert.equal(plan([], iterm, { terminal: "current" }).move, false);
assert.equal(plan([], iterm, {}).move, false, "no setting: stays");
assert.equal(plan([], iterm, {}, {}).move, false);
assert.equal(plan([], { ...iterm, EKIP_TERMINAL: "wezterm" }, {}).move, true, "EKIP_TERMINAL=wezterm moves");
assert.equal(plan([], { WEZTERM_PANE: "3" }).move, false, "already in WezTerm");
assert.equal(plan(["-p", "hi"], iterm).move, false);
assert.equal(plan(["--member"], iterm).move, false);
assert.equal(plan([], { ...iterm, SSH_CONNECTION: "1 2 3 4" }).move, false);
assert.equal(plan([], iterm, undefined, { tty: false }).move, false);
assert.deepEqual(plan([], iterm, undefined, { installed: () => false }), { move: false, why: "WezTerm bulunamadı" });

assert.equal(term.hostTerminal(iterm), "iterm");
assert.equal(term.hostTerminal({ TERM_PROGRAM: "Apple_Terminal" }), "apple");
assert.equal(term.hostTerminal({ TERM_PROGRAM: "vscode" }), "other");
assert.equal(term.hostTerminal({ ...iterm, TMUX: "/tmp/tmux" }), "other");

// ---- the close scripts name only the given session / tty ---------------------------------------
const s = term.itermCloseScript(iterm.ITERM_SESSION_ID);
assert.match(s, /^delay 1/);
assert.equal(s.match(/unique id of s is "([^"]*)"/g).length, 1);
assert.ok(s.includes('unique id of s is "6B0C2D1E-1111-2222-3333-444455556666"'));
assert.ok(/\bclose s\b/.test(s) && !/close (w|tb|every|window)/.test(s), "closes only the matching session");
assert.equal(term.itermCloseScript(""), null);
assert.equal(term.itermCloseScript('w0t0p0:x" then close every window'), null, "no injection");
const a = term.terminalAppCloseScript("/dev/ttys004");
assert.equal(a.match(/tty of tb is "([^"]*)"/g).length, 1);
assert.ok(a.includes('tty of tb is "/dev/ttys004"'));
assert.equal(term.terminalAppCloseScript("not a tty"), null);

// ---- the new window keeps the folder and ekip's variables --------------------------------------
const argv = term.startArgv(["--free"], { env: { EKIP_HOME: "/x/home", EKIP_TERMINAL: "wezterm", XDG_CONFIG_HOME: path.join(tmp, "xdg") }, cwd: "/some/project" });
assert.deepEqual(argv.slice(0, 3), ["start", "--cwd", "/some/project"]);
assert.ok(argv.at(-1).startsWith('EKIP_HOME="/x/home" ') && argv.at(-1).includes('"--free"') && !argv.at(-1).includes("EKIP_TERMINAL"));

// ---- handoff: verifies the window before closing anything --------------------------------------
const pane = (id) => ({ window_id: 0, tab_id: 0, pane_id: id, title: "zsh", cwd: "", top_row: 0, left_col: 0, is_active: true });
function fake({ appearAfter = 0, panes = [pane(1)], tty = "/dev/ttys004", spawnStatus = 0, ps = "" } = {}) {
  const launched = [];
  let lists = 0;
  const run = (bin, args) => {
    if (bin === "tty") return { status: 0, stdout: `${tty}\n` };
    if (bin === "ps") return { status: 0, stdout: ps };
    assert.deepEqual(args.slice(0, 2), ["cli", "--no-auto-start"], "wezterm cli never auto-starts a server");
    // a running GUI gets the new window over `wezterm cli spawn`
    if (args[2] === "spawn") { launched.push([bin, args]); return { status: spawnStatus, stdout: "99\n" }; }
    assert.equal(args[2], "list");
    lists++;
    const open = launched.some(([b]) => b !== "osascript") && appearAfter >= 0 && lists > appearAfter + 1;
    return { status: 0, stdout: JSON.stringify(open ? [...panes, pane(99)] : panes) };
  };
  const launch = (bin, args) => launched.push([bin, args]);
  return { run, launch, launched };
}
const sleep = async () => {};
const ho = quiet(term.handoff);
const wezEnv = { ...iterm, EKIP_WEZTERM: path.join(tmp, "wezterm"), XDG_CONFIG_HOME: path.join(tmp, "xdg") };

{ // iTerm2: WezTerm opens, then only this session is closed
  const f = fake({ appearAfter: 2 });
  assert.equal(await ho([], { env: wezEnv, cwd: "/p", run: f.run, launch: f.launch, sleep, platform: "darwin" }), true);
  assert.equal(f.launched.length, 2);
  assert.equal(f.launched[0][0], wezEnv.EKIP_WEZTERM);
  assert.deepEqual(f.launched[0][1].slice(0, 6), ["cli", "--no-auto-start", "spawn", "--new-window", "--cwd", "/p"], "WezTerm runs: a window in it, no second GUI");
  assert.deepEqual(f.launched[1][0], "osascript");
  assert.equal(f.launched[1][1].at(-1), term.itermCloseScript(iterm.ITERM_SESSION_ID));
}
{ // WezTerm never shows a new pane: nothing is closed, the lead stays
  const f = fake({ appearAfter: -1 });
  assert.equal(await ho([], { env: wezEnv, run: f.run, launch: f.launch, sleep, wait: 1000, step: 250, platform: "darwin" }), false);
  assert.ok(f.launched.every(([b]) => b !== "osascript"), "no osascript when WezTerm did not open");
}
{ // `wezterm start` throws: nothing is closed
  const f = fake();
  const run = (bin, args) => (args?.[2] === "list" ? { status: 1, stdout: "" } : f.run(bin, args));
  assert.equal(await ho([], { env: wezEnv, run, launch: () => { throw new Error("ENOENT"); }, sleep, platform: "darwin" }), false);
}
{ // `cli spawn` fails: falls back to `wezterm start`
  const f = fake({ spawnStatus: 1 });
  assert.equal(await ho([], { env: wezEnv, cwd: "/p", run: f.run, launch: f.launch, sleep, platform: "darwin" }), true);
  assert.equal(f.launched[0][1][0], "cli");
  assert.deepEqual(f.launched[1][1].slice(0, 3), ["start", "--cwd", "/p"]);
}
{ // the running GUI is brought forward by its own .app
  const f = fake({ ps: "/sbin/launchd\n/Users/x/Applications/ekip.app/Contents/MacOS/wezterm-gui\n" });
  assert.equal(term.launchLead(["--free"], { env: wezEnv, cwd: "/p", run: f.run, launch: f.launch, panes: ["1"], platform: "darwin" }), "spawn");
  assert.deepEqual(f.launched.at(-1), ["open", ["-a", "/Users/x/Applications/ekip.app"]]);
  assert.ok(f.launched[0][1].at(-1).includes('"--free"'));
  const g = fake();
  assert.equal(term.launchLead([], { env: wezEnv, cwd: "/p", run: g.run, launch: g.launch, panes: null, platform: "darwin" }), "start", "no GUI: start one");
  assert.deepEqual(g.launched[0][1].slice(0, 3), ["start", "--cwd", "/p"]);
}
{ // a WezTerm that was not running (list fails before) still counts once its pane shows up
  const f = fake({ appearAfter: 0 });
  const run = (bin, args) => (f.launched.length ? f.run(bin, args) : { status: 1, stdout: "" });
  assert.equal(await ho([], { env: wezEnv, run, launch: f.launch, sleep, platform: "darwin" }), true);
}
{ // Terminal.app: the tab with this tty
  const f = fake({ tty: "/dev/ttys007" });
  assert.equal(await ho([], { env: { TERM_PROGRAM: "Apple_Terminal", EKIP_WEZTERM: wezEnv.EKIP_WEZTERM }, run: f.run, launch: f.launch, sleep, platform: "darwin" }), true);
  assert.equal(f.launched[1][1].at(-1), term.terminalAppCloseScript("/dev/ttys007"));
}
{ // another terminal (and anything off macOS): WezTerm opens, nothing is closed
  for (const [env, platform] of [[{ TERM_PROGRAM: "vscode" }, "darwin"], [iterm, "linux"]]) {
    const f = fake();
    assert.equal(await ho([], { env: { ...env, EKIP_WEZTERM: wezEnv.EKIP_WEZTERM }, run: f.run, launch: f.launch, sleep, platform }), true);
    assert.equal(f.launched.length, 1);
  }
}

// ---- ekip init: the WezTerm step -----------------------------------------------------------------
const init = quiet(term.initTerminal);
const xdg = path.join(tmp, "xdg-init");
const initEnv = { EKIP_WEZTERM: path.join(tmp, "bin", "wezterm"), XDG_CONFIG_HOME: xdg };
const brewRun = (calls) => (bin, args) => { calls.push([bin, ...args]); fs.mkdirSync(path.dirname(initEnv.EKIP_WEZTERM), { recursive: true }); fs.writeFileSync(initEnv.EKIP_WEZTERM, ""); return { status: 0 }; };
const noAsk = () => { throw new Error("must not ask"); };
assert.equal(await init([], { env: initEnv, platform: "linux", ask: noAsk }), "skipped");
assert.equal(await init(["--no-terminal"], { env: initEnv, platform: "darwin", ask: noAsk }), "skipped");
{ const calls = []; assert.equal(await init([], { env: initEnv, platform: "darwin", interactive: false, ask: noAsk, run: brewRun(calls), brew: true }), "skipped"); assert.equal(calls.length, 0, "CI: no question, no install"); }
{ const calls = []; assert.equal(await init([], { env: initEnv, platform: "darwin", interactive: true, ask: async () => "h", run: brewRun(calls), brew: true }), "skipped"); assert.equal(calls.length, 0); }
assert.equal(await init(["--yes"], { env: initEnv, platform: "darwin", run: () => assert.fail("no brew"), brew: false }), "no-brew");
assert.equal(core.SETTINGS.terminal, undefined);
{
  let asked = 0;
  const calls = [];
  assert.equal(await init([], { env: initEnv, platform: "darwin", interactive: true, ask: async () => { asked++; return ""; }, run: brewRun(calls), brew: true }), "installed");
  assert.equal(asked, 1);
  assert.deepEqual(calls, [["brew", "install", "--cask", "wezterm"]]);
  assert.ok(fs.existsSync(path.join(xdg, "wezterm", "ekip.lua")));
  assert.equal(JSON.parse(fs.readFileSync(core.SETTINGS_FILE, "utf8")).terminal, "wezterm");
}
{ // already installed: no question, no brew, only config + setting
  const calls = [];
  assert.equal(await init([], { env: initEnv, platform: "darwin", interactive: true, ask: noAsk, run: brewRun(calls), brew: true }), "installed");
  assert.equal(calls.length, 0);
}

// ---- subcommands never change the terminal ------------------------------------------------------
{
  const home = path.join(tmp, "cli-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ terminal: "wezterm" }));
  const marker = path.join(tmp, "wezterm-called");
  const fakeBin = path.join(tmp, "fake-wezterm");
  fs.writeFileSync(fakeBin, `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  const ekip = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../bin/ekip.js");
  const env = { ...process.env, ...iterm, EKIP_HOME: home, EKIP_WEZTERM: fakeBin, EKIP_TERMINAL: "wezterm", WEZTERM_PANE: "" };
  for (const args of [["tasks"], ["help"], ["terminal", "status"], ["status", "--offline"]]) {
    const r = spawnSync(process.execPath, [ekip, ...args], { env, encoding: "utf8", timeout: 20_000 });
    assert.ok(!/Cannot find module|SyntaxError/.test(r.stderr), r.stderr);
  }
  assert.ok(!fs.existsSync(marker), "a subcommand called wezterm");
  // `ekip terminal default` and status show the setting
  const r = spawnSync(process.execPath, [ekip, "terminal", "default", "current"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).terminal, "current");
  assert.notEqual(spawnSync(process.execPath, [ekip, "terminal", "default", "kitty"], { env, encoding: "utf8" }).status, 0);
}

// ---- ekip.lua: the tab bar reads the status file, names tabs by project, pads the window -------------
{
  const luaText = term.ekipLua({ statusFile: "/x/data/terminal-status.json" });
  assert.ok(luaText.includes('local STATUS = "/x/data/terminal-status.json"'));
  assert.ok(!/tasks\.json/.test(luaText), "the tab bar never parses tasks.json");
  for (const part of ["window_padding", 'font_with_fallback({ "JetBrains Mono", "Menlo"', "show_new_tab_button_in_tab_bar = false", "format-window-title", "set_left_status", "inactive_pane_hsb", "split = C.border", "local function middle", "wezterm.home_dir"]) assert.ok(luaText.includes(part), part);
  // what an iTerm2 user relies on
  for (const part of [
    'bind("Enter", "SHIFT", act.SendString("\\x1b\\r"))',
    "generalPasteboard.types", '"public.png"', '"public.file-url"', 'act.SendKey({ key = "v", mods = "CTRL" })', 'act.PasteFrom("Clipboard")',
    'bind("LeftArrow", "OPT", act.SendString("\\x1bb"))', 'bind("RightArrow", "OPT", act.SendString("\\x1bf"))', 'bind("Backspace", "OPT", act.SendString("\\x17"))',
    'bind("LeftArrow", "CMD", act.SendString("\\x01"))', 'bind("RightArrow", "CMD", act.SendString("\\x05"))', 'bind("Backspace", "CMD", act.SendString("\\x15"))',
    "send_composed_key_when_left_alt_is_pressed = true",
    'act.ClearScrollback("ScrollbackAndViewport"), act.SendKey({ key = "L", mods = "CTRL" })',
    'bind("d", "CMD", act.SplitPane({ direction = "Right" }))', 'bind("d", "CMD|SHIFT", act.SplitPane({ direction = "Down" }))',
    'act.ActivatePaneDirection("Prev")', 'act.ActivatePaneDirection("Next")', 'bind("w", "CMD", act.CloseCurrentPane({ confirm = true }))',
    'bind("Enter", "CMD", act.ToggleFullScreen)', "native_macos_fullscreen_mode = true", 'bind("Enter", "CMD|SHIFT", act.TogglePaneZoomState)',
    'act.CompleteSelection("ClipboardAndPrimarySelection")', 'click("Up", 1, "CMD", act.OpenLinkAtMouseCursor, reporting)', 'mouse_reporting = reporting or false', "config.mouse_bindings or {}",
    "wezterm.default_hyperlink_rules()", 'format = "file://$1"',
    'quote_dropped_files = "Posix"', 'audible_bell = "Disabled"', "config.visual_bell", 'notification_handling = "AlwaysShow"',
  ]) assert.ok(luaText.includes(part), part);
  assert.ok(Number(luaText.match(/scrollback_lines = (\d+)/)[1]) >= 20000);
  assert.ok(!/send_composed_key_when_\w+_alt_is_pressed = false/.test(luaText), "Option keeps typing @ | [ ] { }");
  assert.ok(!/disable_default_(mouse|key)_bindings/.test(luaText), "WezTerm's defaults stay");
  // the path rule: absolute paths with an optional :line, never relative ones or URLs
  const rule = new RegExp(luaText.match(/regex = \[\[(.*?)\]\]/)[1]);
  assert.equal("see /Users/a/b.js:12:3.".match(rule)?.[1], "/Users/a/b.js");
  assert.equal("--f=/tmp/x".match(rule)?.[1], "/tmp/x");
  for (const s of ["./rel/path", "src/x/y", "https://x.com/a/b", "/a"]) assert.equal(s.match(rule), null, s);
  assert.ok(!luaText.includes("—"), "no em dash");
  assert.ok(!/truncate_right/.test(luaText), "names are shortened in the middle, never cut at the end");
  // a real WezTerm loads it (when one is installed here)
  const bin = ["/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm", "/Applications/WezTerm.app/Contents/MacOS/wezterm"].find((p) => fs.existsSync(p));
  if (bin) {
    const dir = path.join(tmp, "lua-check");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ekip.lua"), luaText);
    fs.writeFileSync(path.join(dir, "check.lua"), term.loaderLua(dir));
    const r = spawnSync(bin, ["--config-file", path.join(dir, "check.lua"), "ls-fonts", "--text", "a"], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/error|stack traceback/i.test(r.stderr ?? ""), r.stderr);
    // the keys and clicks WezTerm actually registers
    const k = spawnSync(bin, ["--config-file", path.join(dir, "check.lua"), "show-keys"], { encoding: "utf8", timeout: 20_000 });
    assert.equal(k.status, 0, k.stderr);
    assert.ok(!/error|stack traceback/i.test(k.stderr ?? ""), k.stderr);
    if (process.platform === "darwin") {
      for (const re of [/SHIFT\s+Enter\s+->\s+SendString/, /SUPER\s+v\s+->\s+EmitEvent/, /SUPER\s+k\s+->\s+Multiple\(\[ClearScrollback\(ScrollbackAndViewport\)/,
        /\bALT\s+LeftArrow\s+->\s+SendString/, /SUPER\s+LeftArrow\s+->\s+SendString/, /SUPER\s+Backspace\s+->\s+SendString/,
        /SUPER\s+d\s+->\s+SplitPane\(SplitPane \{ direction: Right/, /SUPER\s+D\s+->\s+SplitPane\(SplitPane \{ direction: Down/,
        /SUPER\s+\[\s+->\s+ActivatePaneDirection\(Prev\)/, /SUPER\s+w\s+->\s+CloseCurrentPane/, /SUPER\s+Enter\s+->\s+ToggleFullScreen/,
        /SHIFT \| SUPER\s+Enter\s+->\s+TogglePaneZoomState/, /ALT \| SUPER\s+t\s+->\s+EmitEvent/, /ALT \| SUPER\s+d\s+->\s+SplitPane/,
        /SUPER\s+Up \{ streak: 1, button: Left \}\s+->\s+OpenLinkAtMouseCursor/, /\n\s+Up \{ streak: 1, button: Left \}\s+->\s+CompleteSelection\(ClipboardAndPrimarySelection\)/,
        /\n\s+Down \{ streak: 1, button: Middle \}/]) assert.match(k.stdout, re);
    }
  }
}
assert.equal(term.jetbrainsInstalled([path.join(tmp, "no-fonts")]), false);
{ const d = path.join(tmp, "fonts"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "JetBrainsMono-Regular.ttf"), ""); assert.equal(term.jetbrainsInstalled([d]), true); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok: WezTerm default terminal (plan, close scripts, handoff, init, subcommands)");
