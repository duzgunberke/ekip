// ekip.app (WezTerm under ekip's name and icon) and the one-GUI launch decision. On macOS it builds
// an app from a tiny fake WezTerm.app in a temp folder; ~/Applications and LaunchServices are not touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-app-"));
process.env.EKIP_HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.EKIP_HOME, { recursive: true });
const app = await import("./terminal-app.js");
const { parseWeztermList } = await import("../core/terminal.js");

// ---- icon sizes: 16 to 1024 px, the names iconutil wants -----------------------------------------
const icons = app.iconsetEntries();
assert.equal(icons.length, 10);
assert.deepEqual([...new Set(icons.map((i) => i.px))].sort((a, b) => a - b), [16, 32, 64, 128, 256, 512, 1024]);
assert.ok(icons.some((i) => i.name === "icon_512x512@2x.png" && i.px === 1024));
assert.ok(icons.some((i) => i.name === "icon_16x16.png" && i.px === 16));

// ---- Info.plist: ekip's name, id and icon; no file types ----------------------------------------
const edits = app.plistEdits({ version: "20240203-110809-5046fc22" });
const set = Object.fromEntries(edits.filter((e) => e[0] === "-replace").map((e) => [e[1], e[3]]));
assert.deepEqual(set, { CFBundleName: "ekip", CFBundleDisplayName: "ekip", CFBundleIdentifier: "io.ekip.terminal", CFBundleIconFile: "ekip.icns", EkipWeztermVersion: "20240203-110809-5046fc22" });
assert.ok(edits.some((e) => e[0] === "-remove" && e[1] === "CFBundleDocumentTypes"), "ekip.app must not open .sh files");
assert.ok(/^io\.ekip\./.test(app.APP_ID) && !/[A-Z]/.test(app.APP_ID));

// ---- one GUI: a running WezTerm (cli list answers) gets a window, otherwise one starts ----------
const list = JSON.stringify([{ window_id: 0, tab_id: 0, pane_id: 3, title: "zsh" }]);
assert.equal(app.launchMode(parseWeztermList(list)), "spawn");
assert.equal(app.launchMode(parseWeztermList("[]")), "spawn", "a GUI with no window still answers");
assert.equal(app.launchMode(null), "start", "no GUI: `wezterm cli list` failed");
assert.equal(app.launchMode(parseWeztermList("not json")), "start");
assert.deepEqual(app.spawnArgv(["/bin/zsh", "-lc", "ekip"], "/p"), ["cli", "--no-auto-start", "spawn", "--new-window", "--cwd", "/p", "--", "/bin/zsh", "-lc", "ekip"]);
assert.equal(app.runningGuiApp("/sbin/launchd\n/Applications/WezTerm.app/Contents/MacOS/wezterm-gui\n"), "/Applications/WezTerm.app");
assert.equal(app.runningGuiApp("/Users/x/Applications/ekip.app/Contents/MacOS/wezterm-gui"), "/Users/x/Applications/ekip.app");
assert.equal(app.runningGuiApp("/opt/homebrew/bin/wezterm\n/Applications/WezTerm.app/Contents/MacOS/wezterm-mux-server"), null);
assert.equal(app.runningGuiApp(undefined), null);

// ---- state lines ----------------------------------------------------------------------------------
assert.equal(app.appState({ EKIP_APP: path.join(tmp, "x.app"), EKIP_WEZTERM_APP: tmp }, { platform: "linux" }).state, "other-os");
assert.equal(app.appState({ EKIP_APP: path.join(tmp, "x.app"), EKIP_WEZTERM: "/x/wezterm" }, { platform: "darwin" }).state, "no-wezterm", "a WezTerm by path: no app is built");
assert.equal(app.appLine({ state: "stale", built: "a", current: "b" })[0], "warn");
assert.match(app.appLine({ state: "stale", built: "a", current: "b" })[1], /ekip terminal install/);
assert.equal(app.appLine({ state: "no-wezterm" }), null);

// ---- a real build from a fake WezTerm.app (macOS only) -------------------------------------------
if (process.platform === "darwin") {
  const src = path.join(tmp, "WezTerm.app");
  const macos = path.join(src, "Contents/MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(path.join(src, "Contents/Resources"));
  let version = "20240203-110809-5046fc22";
  const writeWez = () => fs.writeFileSync(path.join(macos, "wezterm"), `#!/bin/sh\necho "wezterm ${version}"\n`, { mode: 0o755 });
  writeWez();
  fs.writeFileSync(path.join(macos, "wezterm-gui"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(src, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>wezterm-gui</string><key>CFBundleIdentifier</key><string>com.github.wez.wezterm</string>
<key>CFBundleName</key><string>WezTerm</string><key>CFBundleIconFile</key><string>terminal.icns</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeExtensions</key><array><string>sh</string></array></dict></array>
</dict></plist>
`);
  const target = path.join(tmp, "Applications", "ekip.app");
  const env = { EKIP_APP: target, EKIP_WEZTERM_APP: src };
  const lsCalls = [];
  const run = (bin, args, o) => (bin.endsWith("/lsregister") ? (lsCalls.push(args), { status: 0 }) : spawnSync(bin, args, o));
  assert.equal(app.appState(env, { run }).state, "missing");
  const r = app.buildApp(env, { run });
  assert.ok(r.ok, r.why);
  const plist = (key) => spawnSync("plutil", ["-extract", key, "raw", path.join(target, "Contents/Info.plist")], { encoding: "utf8" });
  assert.equal(plist("CFBundleName").stdout.trim(), "ekip");
  assert.equal(plist("CFBundleIdentifier").stdout.trim(), "io.ekip.terminal");
  assert.equal(plist("CFBundleIconFile").stdout.trim(), "ekip.icns");
  assert.notEqual(plist("CFBundleDocumentTypes").status, 0);
  assert.ok(fs.statSync(path.join(target, "Contents/Resources/ekip.icns")).size > 10_000);
  assert.equal(spawnSync("codesign", ["--verify", "--deep", "--strict", target]).status, 0, "signed");
  assert.equal(spawnSync("xattr", ["-p", "com.apple.quarantine", target]).status, 1, "no quarantine");
  assert.ok(lsCalls.some((a) => a[0] === "-f" && a[1] === target), "registered");
  assert.equal(app.appState(env, { run }).state, "ok");
  assert.equal(app.appWezterm(env), path.join(target, "Contents/MacOS/wezterm"));
  // brew upgrade: WezTerm changes, ekip.app is stale until it is rebuilt
  version = "20250101-000000-abcdef12";
  writeWez();
  const stale = app.appState(env, { run });
  assert.equal(stale.state, "stale");
  assert.equal(stale.built, "20240203-110809-5046fc22");
  assert.equal(app.ensureApp(env, { run }).state, "ok");
  assert.equal(app.appState(env, { run }).built, version);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["ekip.app"], "no temp copy left behind");
  // the old notifications applet's id written over it: stale, and the rebuild brings the id back
  spawnSync("plutil", ["-replace", "CFBundleIdentifier", "-string", "io.ekip.notifier", path.join(target, "Contents/Info.plist")]);
  assert.equal(app.appState(env, { run }).state, "stale");
  assert.equal(app.ensureApp(env, { run }).state, "ok");
  assert.equal(plist("CFBundleIdentifier").stdout.trim(), "io.ekip.terminal");
  // an ekip.app that is not ekip's is left alone
  const foreign = path.join(tmp, "foreign", "ekip.app");
  fs.mkdirSync(path.join(foreign, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(foreign, "Contents/Info.plist"), fs.readFileSync(path.join(src, "Contents/Info.plist")));
  assert.equal(app.buildApp({ EKIP_APP: foreign, EKIP_WEZTERM_APP: src }, { run }).ok, false);
  assert.ok(fs.existsSync(path.join(foreign, "Contents/Info.plist")));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok: ekip.app (icon sizes, Info.plist, build, stale check) and one WezTerm GUI");
