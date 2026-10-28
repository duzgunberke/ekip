// Shared paths, settings and helpers of every ekip module.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything ekip keeps (keys, run transcripts, logs, cloned dependencies) lives inside the repo it
// runs from, so the whole setup sits on one disk and moves with the folder. EKIP_HOME overrides it.
export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
// Claude Code runs plugins from a cached copy, so the real repo is recorded in a pointer file.
export const POINTER = path.join(os.homedir(), ".config/ekip/root");
const pointed = (() => { try { return fs.readFileSync(POINTER, "utf8").trim(); } catch { return null; } })();
export const ROOT = pointed && fs.existsSync(path.join(pointed, "plugin/bin/ekip.js")) ? pointed : REPO;
export const HOME = process.env.EKIP_HOME ?? path.join(ROOT, "data");
export const VENDOR = path.join(ROOT, "vendor");
export const SETTINGS_FILE = path.join(HOME, "config.json");
export const SETTINGS = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) : {};
export const FREE_DIR = process.env.EKIP_FREELLMAPI_DIR ?? SETTINGS.freellmapiDir ?? path.join(VENDOR, "freellmapi");
export const FREE_NODE = process.env.EKIP_FREELLMAPI_NODE ?? SETTINGS.freellmapiNode ?? "/opt/homebrew/opt/node@24/bin/node";
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

export const die = (msg, code = 1) => { process.stderr.write(`ekip: ${msg}\n`); process.exit(code); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(RUNS, { recursive: true });

// ---- freellmapi server ------------------------------------------------------------------------

export async function healthy() {
  try { return (await fetch(`${URL_ROOT}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

// Remote mode: the services (freellmapi, TencentDB memory) run on the VPS hub, and a launchd SSH
// tunnel maps them to the same 127.0.0.1 ports here, so every other part of ekip is unchanged.
export const REMOTE = SETTINGS.remote ?? null;
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
  const child = spawn(FREE_NODE, ["server/dist/index.js"], { cwd: FREE_DIR, env, detached: true, stdio: ["ignore", out, out] });
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

export function sql(query) {
  const r = spawnSync("sqlite3", ["-separator", "\t", DB, query], { encoding: "utf8" });
  if (r.status !== 0) die(`sqlite3 failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export const unifiedKey = () => SETTINGS.freellmapiKey ?? sql("select value from settings where key='unified_api_key'");
// Remote mode counts the declared keys (the VPS applies the same file on boot).
export const keyCounts = () => (REMOTE
  ? Object.entries(readConfig().keys.reduce((m, k) => ({ ...m, [k.platform]: (m[k.platform] ?? 0) + 1 }), {})).map(([p, c]) => [p, String(c)])
  : sql("select platform, count(*) from api_keys where enabled=1 group by platform").split("\n").filter(Boolean).map((l) => l.split("\t")));

// Applies data/freellmapi.config.json: restarts the local server, or ships it to the VPS hub.
export async function restartFree() {
  if (!REMOTE) { await down(); await up(); return; }
  const scp = spawnSync("scp", ["-q", CONFIG, `${REMOTE.ssh}:${REMOTE.dir}/hub/freellmapi.config.json`], { stdio: "inherit" });
  if (scp.status !== 0) die("could not copy the key file to the VPS");
  ssh(`chmod 644 ${REMOTE.dir}/hub/freellmapi.config.json && docker restart freellmapi >/dev/null`);
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
  } else if (sub === "list" || !sub) {
    await up({ quiet: true });
    const rows = keyCounts();
    console.log(rows.length ? rows.map(([p, c]) => `${p}\t${c}`).join("\n") : "no provider keys yet — ekip key add <platform> <key>");
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
  tdai: { repo: "https://github.com/TencentCloud/TencentDB-Agent-Memory.git", key: "tdaiDir" },
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
  }
  saveSettings({ [DEPS[name].key]: dir });
  return dir;
}

export const TDAI_PORTS = { core: 8420, panel: 8125, knowledge: 8424, proxy: 8096 };
export const tdaiDeploy = () => path.join(depDir("tdai"), "deploy/global-images");
export const tdaiUp = async () => {
  try { return (await fetch(`http://127.0.0.1:${TDAI_PORTS.proxy}/health`, { signal: AbortSignal.timeout(1500) })).status < 500; } catch { return false; }
};
export const containerRunning = (n) => spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", n], { encoding: "utf8" }).stdout.trim() === "true";

export const adminKey = () => {
  if (SETTINGS.tdaiKey) return SETTINGS.tdaiKey;
  const f = path.join(tdaiDeploy(), ".admin-key");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
};

export function openTerminal(command) {
  if (process.platform !== "darwin") { console.log(`run in a new terminal: ${command}`); return; }
  const app = process.env.TERM_PROGRAM === "iTerm.app" ? "iTerm" : "Terminal";
  const script = app === "iTerm"
    ? `tell application "iTerm" to create window with default profile command ${JSON.stringify(command)}`
    : `tell application "Terminal" to do script ${JSON.stringify(command)}`;
  spawnSync("osascript", ["-e", script, "-e", `tell application "${app}" to activate`], { stdio: "ignore" });
}

