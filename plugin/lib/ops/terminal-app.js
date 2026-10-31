// ~/Applications/ekip.app: WezTerm under ekip's name and icon, so the Dock shows one "ekip" icon.
// A wrapper app that execs WezTerm's binary does not work: macOS takes the Dock icon and name from
// the bundle the running executable lives in, so it shows WezTerm's "$W" again. ekip.app is an APFS
// clone of WezTerm.app (`cp -c`: no extra disk until a file changes) with ekip's Info.plist and icon;
// only the main executable is re-signed ad hoc (the helpers keep WezTerm's own signature, ~half the
// disk of `--deep`). It is rebuilt when WezTerm's version changes (ekip terminal install, ekip update).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOTIFIER_APP, TERMINAL_APP_ID } from "../core/core.js";
import { c } from "../core/ui.js";
import { t } from "../core/i18n.js";

export const APP_ID = TERMINAL_APP_ID;
export const ICON = "ekip.icns";
// next to this file, so a plugin cache copy finds it too (rendered from docs/brand/app-icon.svg)
const ICON_PNG = fileURLToPath(new URL("../../assets/ekip-app-icon.png", import.meta.url));
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export const appPath = (env = process.env) => env.EKIP_APP || NOTIFIER_APP;
export function sourceApp(env = process.env) {
  if (env.EKIP_WEZTERM_APP) return env.EKIP_WEZTERM_APP;
  // a WezTerm given by path (tests, a custom build) has no .app to copy
  if (env.EKIP_WEZTERM) return null;
  return ["/Applications/WezTerm.app", path.join(os.homedir(), "Applications/WezTerm.app")].find((p) => fs.existsSync(p)) ?? null;
}
/** ekip.app holds ekip's terminal (not the older notifications-only applet). */
export const isTerminalApp = (app) => fs.existsSync(path.join(app, "Contents/Resources", ICON)) && fs.existsSync(path.join(app, "Contents/MacOS/wezterm-gui"));

/** The iconset macOS wants: 16-512 pt at 1x and 2x, so 16 to 1024 px. */
export function iconsetEntries() {
  return [16, 32, 128, 256, 512].flatMap((n) => [{ name: `icon_${n}x${n}.png`, px: n }, { name: `icon_${n}x${n}@2x.png`, px: n * 2 }]);
}

/**
 * Info.plist changes as plutil arguments. The document types go: ekip.app must not become the
 * handler for .sh / .command files.
 */
export function plistEdits({ version = "" } = {}) {
  return [
    ["-replace", "CFBundleName", "-string", "ekip"],
    ["-replace", "CFBundleDisplayName", "-string", "ekip"],
    ["-replace", "CFBundleIdentifier", "-string", APP_ID],
    ["-replace", "CFBundleIconFile", "-string", ICON],
    ["-remove", "CFBundleIconName"],
    ["-remove", "CFBundleDocumentTypes"],
    ["-replace", "EkipWeztermVersion", "-string", version],
  ];
}

const read = (run, bin, args) => { const r = run(bin, args, { encoding: "utf8", timeout: 10_000 }); return r.status === 0 ? (r.stdout ?? "").trim() : ""; };
export const weztermVersion = (app, run = spawnSync) => (app ? read(run, path.join(app, "Contents/MacOS/wezterm"), ["--version"]).replace(/^wezterm\s+/, "") : "");
const builtFrom = (app, run) => read(run, "plutil", ["-extract", "EkipWeztermVersion", "raw", path.join(app, "Contents/Info.plist")]);

/** { app, source, built, current, state: "ok" | "stale" | "missing" | "no-wezterm" | "other-os" } */
export function appState(env = process.env, { run = spawnSync, platform = process.platform } = {}) {
  const app = appPath(env), source = sourceApp(env);
  if (platform !== "darwin") return { app, source, state: "other-os" };
  if (!source) return { app, source, state: "no-wezterm" };
  if (!isTerminalApp(app)) return { app, source, state: "missing" };
  const built = builtFrom(app, run), current = weztermVersion(source, run);
  return { app, source, built, current, state: built && current && built !== current ? "stale" : "ok" };
}

/** The `wezterm` to launch with: ekip.app's copy (its GUI shows the ekip icon) or null. */
export function appWezterm(env = process.env) {
  const bin = path.join(appPath(env), "Contents/MacOS/wezterm");
  return !env.EKIP_WEZTERM && isTerminalApp(appPath(env)) && fs.existsSync(bin) ? bin : null;
}

/**
 * Builds ekip.app from WezTerm.app next to the target and swaps it in. The old ekip.app (the
 * notifications applet or an older build) is replaced only when it is ekip's own.
 */
export function buildApp(env = process.env, { run = spawnSync, dry = false, step = () => {}, icon = ICON_PNG } = {}) {
  const app = appPath(env), source = sourceApp(env);
  if (!source) return { ok: false, why: t("WezTerm.app bulunamadı") };
  if (fs.existsSync(app) && !isOurs(app, run)) return { ok: false, why: t("{app} ekip'in değil; dokunulmadı", { app }) };
  const version = weztermVersion(source, run);
  step(t("{app}: WezTerm {v} kopyası, ekip adı ve simgesiyle", { app, v: version || "?" }));
  if (dry) return { ok: true, app, version };
  const tmp = path.join(path.dirname(app), `.ekip-${process.pid}.app`);
  const set = path.join(os.tmpdir(), `ekip-${process.pid}.iconset`);
  const must = (bin, args) => { const r = run(bin, args, { encoding: "utf8", timeout: 120_000 }); if (r.status !== 0 || r.error) throw new Error(`${bin} ${args[0]}: ${(r.stderr || r.error?.message || "").trim()}`); };
  try {
    fs.mkdirSync(path.dirname(app), { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    // APFS clone; another file system gets a plain copy
    if (run("cp", ["-Rc", source, tmp], { stdio: "ignore" }).status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); must("cp", ["-R", source, tmp]); }
    const plist = path.join(tmp, "Contents/Info.plist");
    for (const edit of plistEdits({ version })) {
      if (edit[0] === "-remove") run("plutil", [...edit, plist], { stdio: "ignore" }); // absent keys are fine
      else must("plutil", [...edit, plist]);
    }
    fs.rmSync(set, { recursive: true, force: true });
    fs.mkdirSync(set, { recursive: true });
    // sips exits 0 on a file it cannot read: check what it wrote
    for (const { name, px } of iconsetEntries()) { must("sips", ["-z", String(px), String(px), icon, "--out", path.join(set, name)]); if (!fs.existsSync(path.join(set, name))) throw new Error(`sips: ${icon}`); }
    must("iconutil", ["-c", "icns", set, "-o", path.join(tmp, "Contents/Resources", ICON)]);
    run("xattr", ["-cr", tmp], { stdio: "ignore" });
    // helpers that are not signed (a self-built WezTerm) are signed too
    if (run("codesign", ["--force", "-s", "-", tmp], { stdio: "ignore", timeout: 120_000 }).status !== 0) must("codesign", ["--force", "--deep", "-s", "-", tmp]);
    must("codesign", ["--verify", "--deep", "--strict", tmp]);
    if (fs.existsSync(app)) { run(LSREGISTER, ["-u", app], { stdio: "ignore" }); fs.rmSync(app, { recursive: true, force: true }); }
    fs.renameSync(tmp, app);
    run(LSREGISTER, ["-f", app], { stdio: "ignore" });
    return { ok: true, app, version };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { ok: false, why: e.message };
  } finally {
    fs.rmSync(set, { recursive: true, force: true });
  }
}
function isOurs(app, run) {
  const id = read(run, "plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(app, "Contents/Info.plist")]);
  return /^io\.ekip\./.test(id);
}

/** `ekip terminal install` / `ekip update`: builds ekip.app when it is missing or WezTerm changed. */
export function ensureApp(env = process.env, { run = spawnSync, dry = false, step = () => {}, platform = process.platform, force = false } = {}) {
  const s = appState(env, { run, platform });
  if (s.state === "other-os" || s.state === "no-wezterm") return s;
  if (s.state === "ok" && !force) { step(t("{app} güncel (WezTerm {v})", { app: s.app, v: s.built || "?" })); return s; }
  const r = buildApp(env, { run, dry, step });
  if (!r.ok) step(c.yellow(t("ekip.app üretilemedi ({why}); WezTerm.app kullanılır", { why: r.why })));
  return { ...s, state: r.ok ? "ok" : s.state, built: r.version };
}

/** One status line: [level, text] or null where it does not apply. */
export function appLine(s) {
  if (s.state === "ok") return ["ok", t("kurulu (WezTerm {v})", { v: s.built || "?" })];
  if (s.state === "stale") return ["warn", t("WezTerm {a} için üretilmiş, kurulu WezTerm {b} → ekip terminal install", { a: s.built, b: s.current })];
  if (s.state === "missing") return ["warn", t("yok; Dock'ta WezTerm simgesi görünür → ekip terminal install")];
  return null;
}

// ---- one WezTerm GUI: a new window in the running one instead of a second process ---------------

/**
 * How to open a lead window. `panes` is `wezterm cli --no-auto-start list` (null: no GUI answers).
 * A running GUI gets a new window over `wezterm cli spawn`; `wezterm start` would start a second
 * GUI process (a second Dock icon) whenever it gets `--config-file`.
 */
export const launchMode = (panes) => (Array.isArray(panes) ? "spawn" : "start");

/** `wezterm cli spawn` for a new window in the running GUI; `shell` is the lead's command. */
export const spawnArgv = (shell, cwd) => ["cli", "--no-auto-start", "spawn", "--new-window", "--cwd", cwd, "--", ...shell];

/** The .app whose wezterm-gui is running, from `ps -axo comm=` (null when none). */
export function runningGuiApp(psOut) {
  for (const line of String(psOut ?? "").split("\n")) {
    const m = /^\s*(\/.+?\.app)\/Contents\/MacOS\/wezterm-gui\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}
