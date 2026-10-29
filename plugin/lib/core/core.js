// Shared paths, settings and helpers of every ekip module.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t } from "./i18n.js";

// Hooks, panes, launchd jobs and Claude Code start ekip with a short PATH that misses where worker
// CLIs install (~/.local/bin, npm's prefix, Homebrew), so an installed agy looked "not installed".
// The usual install folders are added once here, for every module and every worker ekip spawns.
{
  const home = os.homedir();
  const extra = [path.join(home, ".local/bin"), path.join(home, ".npm-global/bin"), path.join(home, ".bun/bin"), path.join(home, ".cargo/bin"),
    "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".orbstack/bin")];
  // npm's global prefix as ekip init set it (no `npm prefix` call: this runs on every hook)
  try { const rc = fs.readFileSync(path.join(home, ".npmrc"), "utf8").match(/^prefix\s*=\s*(.+)$/m)?.[1]?.trim(); if (rc) extra.push(path.join(rc.replace(/^~/, home), "bin")); } catch { /* none */ }
  const have = new Set((process.env.PATH ?? "").split(path.delimiter));
  const add = extra.filter((d) => !have.has(d) && fs.existsSync(d));
  if (add.length) process.env.PATH = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...add].join(path.delimiter);
}

// Everything ekip keeps (keys, run transcripts, logs, cloned dependencies) lives inside the repo it
// runs from, so the whole setup sits on one disk and moves with the folder. EKIP_HOME overrides it.
export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
// Claude Code runs plugins from a cached copy, so the real repo is recorded in a pointer file.
export const POINTER = path.join(os.homedir(), ".config/ekip/root");
const pointed = (() => { try { return fs.readFileSync(POINTER, "utf8").trim(); } catch { return null; } })();
export const ROOT = pointed && fs.existsSync(path.join(pointed, "plugin/bin/ekip.js")) ? pointed : REPO;
export const HOME = process.env.EKIP_HOME ?? path.join(ROOT, "data");
export const VENDOR = path.join(ROOT, "vendor");
export const SETTINGS_FILE = path.join(HOME, "config.json");
export const SETTINGS = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) : {};
export const FREE_DIR = process.env.EKIP_FREELLMAPI_DIR ?? SETTINGS.freellmapiDir ?? path.join(VENDOR, "freellmapi");
// Read at call time: `ekip init` finds a suitable Node and saves it after this module loaded, and a
// fixed fallback path (a Homebrew one) only exists on some Macs. Without a setting, the running node.
export const freeNode = () => process.env.EKIP_FREELLMAPI_NODE ?? SETTINGS.freellmapiNode ?? process.execPath;
export const FREE_NODE = freeNode(); // kept for older importers; use freeNode()
export const PORT = Number(process.env.EKIP_FREELLMAPI_PORT ?? SETTINGS.port ?? 3001);
export const FREELLMAPI_REPO = "https://github.com/tashfeenahmed/freellmapi.git";
export const KEYLESS = ["ovh"];
export const URL_ROOT = `http://127.0.0.1:${PORT}`;
export const DB = path.join(FREE_DIR, "server/data/freeapi.db");
export const CONFIG = path.join(HOME, "freellmapi.config.json");
export const PID = path.join(HOME, "freellmapi.pid");
export const LOG = path.join(HOME, "logs/freellmapi.log");
export const RUNS = path.join(HOME, "runs");
export const FREE_CLAUDE_HOME = path.join(HOME, "claude-free");

const errTTY = process.stderr.isTTY && !process.env.NO_COLOR;
export const die = (msg, code = 1) => { process.stderr.write(`${errTTY ? "\x1b[31mekip ✗\x1b[39m" : "ekip:"} ${t(msg)}\n`); process.exit(code); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
// macOS shows the sending app's icon and ignores terminal-notifier's -appIcon on recent versions, so
// notifications go out in the name of a tiny "ekip" app bundle that carries the logo (-sender).
export const NOTIFIER_APP = path.join(os.homedir(), "Applications/ekip.app");
const NOTIFIER_ID = "io.ekip.notifier";
export function ensureNotifierApp() {
  if (process.platform !== "darwin" || fs.existsSync(path.join(NOTIFIER_APP, "Contents/Resources/applet.icns"))) return fs.existsSync(NOTIFIER_APP);
  const png = path.join(ROOT, "plugin/assets/ekip-icon.png");
  if (!fs.existsSync(png)) return false;
  try {
    fs.mkdirSync(path.dirname(NOTIFIER_APP), { recursive: true });
    spawnSync("osacompile", ["-o", NOTIFIER_APP, "-e", 'display dialog "ekip sends its notifications through this app." buttons {"OK"} default button 1'], { stdio: "ignore" });
    const set = path.join(os.tmpdir(), `ekip-${process.pid}.iconset`);
    fs.mkdirSync(set, { recursive: true });
    for (const n of [16, 32, 128, 256, 512]) {
      spawnSync("sips", ["-z", String(n), String(n), png, "--out", path.join(set, `icon_${n}x${n}.png`)], { stdio: "ignore" });
      spawnSync("sips", ["-z", String(n * 2), String(n * 2), png, "--out", path.join(set, `icon_${n}x${n}@2x.png`)], { stdio: "ignore" });
    }
    spawnSync("iconutil", ["-c", "icns", set, "-o", path.join(NOTIFIER_APP, "Contents/Resources/applet.icns")], { stdio: "ignore" });
    fs.rmSync(set, { recursive: true, force: true });
    const plist = path.join(NOTIFIER_APP, "Contents/Info.plist");
    spawnSync("plutil", ["-replace", "CFBundleIdentifier", "-string", NOTIFIER_ID, plist], { stdio: "ignore" });
    spawnSync("plutil", ["-replace", "CFBundleName", "-string", "ekip", plist], { stdio: "ignore" });
    // newer osacompile also writes an asset catalog whose default icon wins over applet.icns
    fs.rmSync(path.join(NOTIFIER_APP, "Contents/Resources/Assets.car"), { force: true });
    spawnSync("plutil", ["-remove", "CFBundleIconName", plist], { stdio: "ignore" });
    spawnSync("plutil", ["-replace", "CFBundleIconFile", "-string", "applet", plist], { stdio: "ignore" });
    spawnSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", NOTIFIER_APP], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

/**
 * A macOS notification. The app name ("ekip") is shown by macOS itself, so title says what it is
 * about (a task's name), subtitle its state ("✓ Bitti · project"), message the short result.
 */
export function notify(title, message, { subtitle = "", group = "ekip", open = "" } = {}) {
  if (process.platform !== "darwin" || SETTINGS.notifications === false) return;
  // a separate data dir means a test or a throwaway instance: no notifications unless asked for
  if (process.env.EKIP_HOME && !process.env.EKIP_NOTIFY) return;
  const icon = path.join(ROOT, "plugin/assets/ekip-icon.png");
  const sender = ensureNotifierApp() ? ["-sender", NOTIFIER_ID] : ["-appIcon", icon];
  if (has("terminal-notifier")) spawnSync("terminal-notifier", ["-title", title, ...(subtitle ? ["-subtitle", subtitle] : []), "-message", message || title, ...sender, "-group", group, ...(open ? ["-open", open] : [])], { stdio: "ignore", timeout: 3000 });
  else spawnSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`], { stdio: "ignore", timeout: 1000 });
}
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(RUNS, { recursive: true });

// ---- freellmapi server ------------------------------------------------------------------------

// 4 s: through the SSH tunnel to a busy server a working pool can take over a second; late is not down
export async function healthy(timeoutMs = 4000) {
  try { return (await fetch(`${URL_ROOT}/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok; } catch { return false; }
}

// Remote mode: the services (freellmapi, TencentDB memory) run on the VPS hub, and a launchd SSH
// tunnel maps them to the same 127.0.0.1 ports here, so every other part of ekip is unchanged.
export const REMOTE = SETTINGS.remote ?? null;
// The free pool's container: "freellmapi" from ekip's own compose, "freellmapi-<id>" when a PaaS such
// as Coolify runs it. Resolved at call time (shell snippet), "freellmapiContainer" in config overrides.
export const FREE_CONTAINER_SH = SETTINGS.freellmapiContainer ? `echo ${SETTINGS.freellmapiContainer}` : "docker ps --format '{{.Names}}' | grep -m1 -E '^freellmapi(-|$)'";
// The memory stack's containers (tdai-memory-core, tdai-memory-hub, tdai-proxy) the same way: plain names
// from TencentDB's start scripts, "<name>-<id>" under Coolify. Network aliases (http://tdai-proxy:8096) keep the plain name.
export const TDAI_CONTAINER_SH = (name) => `docker ps --format '{{.Names}}' | grep -m1 -E '^${name}(-|$)'`;
export const tdaiContainer = (name) => spawnSync("sh", ["-c", TDAI_CONTAINER_SH(name)], { encoding: "utf8" }).stdout?.trim() || name;
export const TUNNEL_LABEL = "io.ekip.tunnel";
export const ssh = (cmd, opts = {}) => spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", REMOTE.ssh, cmd], { encoding: "utf8", ...opts });

export async function up({ quiet = false } = {}) {
  if (await healthy()) return;
  if (REMOTE) {
    spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${TUNNEL_LABEL}`], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) { if (await healthy()) return; await sleep(500); }
    die(`the VPS hub is not reachable through the tunnel (ekip tunnel status; ssh ${REMOTE.ssh})`);
  }
  if (!fs.existsSync(path.join(FREE_DIR, "server/dist/index.js"))) die(`freellmapi is not built in ${FREE_DIR} (npm run build)`);
  const env = { ...process.env, FREEAPI_ENV_PATH: path.join(FREE_DIR, ".env"), HOST: "127.0.0.1", PORT: String(PORT) };
  if (fs.existsSync(CONFIG)) env.FREEAPI_CONFIG_PATH = CONFIG;
  const out = fs.openSync(LOG, "a");
  const child = spawn(freeNode(), ["server/dist/index.js"], { cwd: FREE_DIR, env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  fs.writeFileSync(PID, String(child.pid));
  for (let i = 0; i < 60; i++) {
    if (await healthy()) { if (!quiet) console.error(`ekip: freellmapi up on ${URL_ROOT}`); return; }
    await sleep(500);
  }
  die(`freellmapi did not start; see ${LOG}`);
}

export async function down() {
  let pid = fs.existsSync(PID) ? Number(fs.readFileSync(PID, "utf8")) : null;
  if (!pid) {
    // Started some other way (by hand): find the listener on our port.
    const r = spawnSync("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    pid = Number(r.stdout.trim().split("\n")[0]) || null;
  }
  if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  fs.rmSync(PID, { force: true });
  for (let i = 0; i < 20 && (await healthy()); i++) await sleep(250);
}

export function sql(query, { timeout } = {}) {
  const r = spawnSync("sqlite3", ["-separator", "\t", DB, query], { encoding: "utf8", ...(timeout ? { timeout } : {}) });
  if (r.status !== 0) { if (timeout) return ""; die(`sqlite3 failed: ${r.stderr.trim()}`); }
  return r.stdout.trim();
}

export const unifiedKey = () => SETTINGS.freellmapiKey ?? sql("select value from settings where key='unified_api_key'");
// Remote mode counts the declared keys (the VPS applies the same file on boot).
export const keyCounts = ({ timeout } = {}) => (REMOTE
  ? Object.entries(readConfig().keys.reduce((m, k) => ({ ...m, [k.platform]: (m[k.platform] ?? 0) + 1 }), {})).map(([p, c]) => [p, String(c)])
  : sql("select platform, count(*) from api_keys where enabled=1 group by platform", { timeout }).split("\n").filter(Boolean).map((l) => l.split("\t")));

// Applies data/freellmapi.config.json: restarts the local server, or ships it to the VPS hub.
export async function restartFree() {
  if (!REMOTE) { await down(); await up(); return; }
  const scp = spawnSync("scp", ["-q", CONFIG, `${REMOTE.ssh}:${REMOTE.dir}/hub/freellmapi.config.json`], { stdio: "inherit" });
  if (scp.status !== 0) die("could not copy the key file to the VPS");
  ssh(`chmod 644 ${REMOTE.dir}/hub/freellmapi.config.json && docker restart $(${FREE_CONTAINER_SH}) >/dev/null`);
  for (let i = 0; i < 60; i++) { await sleep(1000); if (await healthy()) return; }
  die("freellmapi on the VPS did not come back; ekip vps sh 'docker logs --tail 50 freellmapi'");
}

// ---- provider keys (declarative config, applied by freellmapi on every boot) ------------------

export const readConfig = () => (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : { keys: [] });
export function writeConfig(cfg) {
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);
}

export async function key(args) {
  const [sub, platform, value] = args;
  if (sub === "add") {
    if (!platform || (!value && !KEYLESS.includes(platform))) die(`usage: ekip key add <platform> <key>   (platforms: google, groq, cerebras, openrouter, mistral, nvidia, cohere, cloudflare, zhipu, ...; keyless: ${KEYLESS.join(", ")})`);
    const cfg = readConfig();
    const n = cfg.keys.filter((k) => k.platform === platform).length;
    if (value) cfg.keys.push({ platform, key: value, label: `ekip-${n + 1}` });
    else if (!n) cfg.keys.push({ platform, label: "ekip-1" });
    writeConfig(cfg);
    await restartFree();
    const counts = Object.fromEntries(keyCounts());
    if (!counts[platform]) die(`freellmapi did not accept the ${platform} key; see ${LOG}`);
    console.log(`${platform}: ${counts[platform]} key(s) active`);
  } else if (sub === "rm" || sub === "remove") {
    // The key file only adds keys on boot, so a removal also deletes the row in freellmapi's DB.
    const label = value;
    if (!platform) die("usage: ekip key rm <platform> [label]   (labels: ekip key list)");
    const cfg = readConfig();
    const gone = cfg.keys.filter((k) => k.platform === platform && (!label || k.label === label));
    if (!gone.length) die(`no ${platform} key${label ? ` labelled ${label}` : ""}`);
    cfg.keys = cfg.keys.filter((k) => !gone.includes(k));
    writeConfig(cfg);
    const where = `platform='${platform.replace(/[^a-z0-9_-]/gi, "")}'${label ? ` and label='${label.replace(/[^a-z0-9_-]/gi, "")}'` : ""}`;
    if (REMOTE) ssh(`docker exec $(${FREE_CONTAINER_SH}) node -e "const D=require('/app/node_modules/better-sqlite3');new D('/app/server/data/freeapi.db').prepare(\\"delete from api_keys where ${where}\\").run()"`);
    else spawnSync("sqlite3", [DB, `delete from api_keys where ${where}`]);
    await restartFree();
    console.log(`removed ${gone.length} ${platform} key(s)`);
  } else if (sub === "list" || !sub) {
    await up({ quiet: true });
    const rows = keyCounts();
    console.log(rows.length ? readConfig().keys.map((k) => `${k.platform}\t${k.label}\t${k.key ? `${k.key.slice(0, 6)}…` : "(keyless)"}`).join("\n") : "no provider keys yet — ekip key add <platform> <key>");
  } else die(`unknown: ekip key ${sub}`);
}

// Like ask(), but the typed or pasted text is shown as dots, so keys stay off the screen.
export async function askSecret(question) {
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); else if (s !== "\r\n" && s !== "\n") process.stdout.write("•".repeat(s.length)); };
  try { const p = rl.question(question); muted = true; return (await p).trim(); } finally { rl.close(); process.stdout.write("\n"); }
}

export async function ask(question) {
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

export const openUrl = (url) => spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });

export function sh(cmd, argv, opts = {}) {
  console.error(`$ ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.status !== 0) die(`${cmd} failed (exit ${r.status})`);
}

// Dependencies ekip clones when this machine has none configured (config.json can point elsewhere).
export const DEPS = {
  freellmapi: { repo: "https://github.com/tashfeenahmed/freellmapi.git", key: "freellmapiDir" },
  hoptell: { repo: "https://github.com/EminUZUN/hoptell.git", key: "hoptellDir" },
  // pinned: ekip's patches (hub/tools/tdai-patches) were written against this commit
  tdai: { repo: "https://github.com/TencentCloud/TencentDB-Agent-Memory.git", key: "tdaiDir", ref: "ecc01a5" },
};
export const depDir = (name) => SETTINGS[DEPS[name].key] ?? path.join(VENDOR, name);
export const saveSettings = (patch) => {
  Object.assign(SETTINGS, patch);
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(SETTINGS, null, 2)}\n`);
};

export function clone(name) {
  const dir = depDir(name);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    sh("git", ["clone", "--depth", "50", DEPS[name].repo, dir]);
    if (DEPS[name].ref) {
      if (spawnSync("git", ["-C", dir, "checkout", "-q", DEPS[name].ref], { stdio: "ignore" }).status !== 0) {
        spawnSync("git", ["-C", dir, "fetch", "-q", "--depth", "200", "origin"], { stdio: "ignore" });
        spawnSync("git", ["-C", dir, "checkout", "-q", DEPS[name].ref], { stdio: "ignore" });
      }
    }
  }
  saveSettings({ [DEPS[name].key]: dir });
  return dir;
}

export const TDAI_PORTS = { core: 8420, panel: 8125, knowledge: 8424, proxy: 8096 };
export const tdaiDeploy = () => path.join(depDir("tdai"), "deploy/global-images");
export const tdaiUp = async (timeoutMs = 1500) => {
  try { return (await fetch(`http://127.0.0.1:${TDAI_PORTS.proxy}/health`, { signal: AbortSignal.timeout(timeoutMs) })).status < 500; } catch { return false; }
};
export const containerRunning = (n) => spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", n], { encoding: "utf8" }).stdout.trim() === "true";

export const adminKey = () => {
  if (SETTINGS.tdaiKey) return SETTINGS.tdaiKey;
  const f = path.join(tdaiDeploy(), ".admin-key");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
};

// iTerm2 session ids that are open right now (one osascript call). The list of sessions can change
// while the script walks it (a pane closing), which made the old per-index loop fail and every check
// report "closed"; each window and tab is read in its own try block.
export function openSessions() {
  const r = spawnSync("osascript", ["-e", `tell application "iTerm2"
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
end tell`], { encoding: "utf8" });
  return new Set((r.stdout ?? "").split("\n").map((x) => x.trim()).filter(Boolean));
}

// In iTerm2, worker and log panes open in one column to the right of the lead: the first one splits
// the lead vertically, every later one goes under any pane of that column that is still open, so the
// lead keeps its width when earlier panes close. Past five panes in the column, a pane opens as a
// tab instead. `below` (the task pane) splits the lead horizontally, full width. Each pane gets a
// title saying what it shows. Elsewhere it falls back to a new window. Returns the new session id.
export function openPane(command, { below = false, title = "" } = {}) {
  const lead = process.env.ITERM_SESSION_ID?.split(":")[1];
  if (process.platform !== "darwin" || process.env.TERM_PROGRAM !== "iTerm.app" || !lead) return openTerminal(command);
  const stateFile = path.join(HOME, "panes", `${lead}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  let column = [];
  try { column = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* first pane */ }
  const open = openSessions();
  column = column.filter((id) => open.has(id));
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
  const run = (script) => spawnSync("osascript", ["-e", script], { encoding: "utf8" }).stdout.trim();
  if (below) { const id = run(split(lead, "horizontally")); if (!id) openTerminal(command); return id || null; }
  const id = column.length >= 5 ? run(tab) : column.length ? run(split(column.at(-1), "horizontally")) : run(split(lead, "vertically"));
  if (id) { if (column.length < 5) column.push(id); fs.writeFileSync(stateFile, JSON.stringify(column)); } else openTerminal(command);
  return id || null;
}

// Whether an iTerm2 session with this id is still open (the user may have closed the pane).
export function paneAlive(id) {
  if (!id || process.platform !== "darwin") return false;
  return openSessions().has(id);
}

// The live task pane under the lead (iTerm2): opened when the lead starts, and again on a new task
// if the user closed it. The flag file keeps the pane's session id, so one lead gets one pane.
export function ensureTaskPane() {
  const lead = process.env.ITERM_SESSION_ID?.split(":")[1];
  if (!lead || process.env.TERM_PROGRAM !== "iTerm.app" || SETTINGS.taskPane === false) return;
  const flag = path.join(HOME, "panes", `${lead}-tasks`);
  const prev = fs.existsSync(flag) ? fs.readFileSync(flag, "utf8").trim() : "";
  if (prev && paneAlive(prev)) return;
  const id = openPane(`${JSON.stringify(path.join(ROOT, "plugin/bin/ekip.js"))} tasks --watch`, { below: true, title: "ekip · görevler" });
  fs.mkdirSync(path.dirname(flag), { recursive: true });
  fs.writeFileSync(flag, id ?? "");
}

export function openTerminal(command) {
  if (process.platform !== "darwin") { console.log(`run in a new terminal: ${command}`); return; }
  const app = process.env.TERM_PROGRAM === "iTerm.app" ? "iTerm" : "Terminal";
  const script = app === "iTerm"
    ? `tell application "iTerm" to create window with default profile command ${JSON.stringify(command)}`
    : `tell application "Terminal" to do script ${JSON.stringify(command)}`;
  spawnSync("osascript", ["-e", script, "-e", `tell application "${app}" to activate`], { stdio: "ignore" });
}

