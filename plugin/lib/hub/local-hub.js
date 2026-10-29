// `ekip hub local`: the web panel on this computer, for people without a VPS. The same hub image the
// VPS runs, built from this checkout, bound to 127.0.0.1, wired to the local free pool and memory
// stack. ekip init starts it when no hub is linked; the token and panel password stay in data/.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DB, HOME, PORT, ROOT, SETTINGS, adminKey, containerRunning, saveSettings, sleep, unifiedKey } from "../core/core.js";

const NAME = "ekip-hub-local";
const IMAGE = "ekip-hub:local";
const HUB_PORT = Number(process.env.EKIP_LOCAL_HUB_PORT ?? 7777);
const URL_LOCAL = `http://localhost:${HUB_PORT}`;
const SECRETS = path.join(HOME, "hub-local.json");
const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", ...opts });

function secrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS, "utf8")); } catch { /* first run */ }
  const s = { token: crypto.randomBytes(32).toString("hex"), password: crypto.randomBytes(9).toString("base64url") };
  fs.writeFileSync(SECRETS, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

// rebuild only when the hub's code changed since the image was built
function sourceHash() {
  const h = crypto.createHash("sha256");
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", "public", "demo", ".data", "dist"].includes(e.name)) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else h.update(f).update(fs.readFileSync(f));
  } };
  for (const x of ["src", "web", "package.json", "Dockerfile"]) { const f = path.join(ROOT, "hub", x); if (fs.statSync(f).isDirectory()) walk(f); else h.update(fs.readFileSync(f)); }
  return h.digest("hex").slice(0, 16);
}

/** A hub somewhere else (the VPS) is linked: the local panel would only split the picture. */
export const remoteLinked = () => !!SETTINGS.hubUrl && !SETTINGS.hubLocal;

export async function up({ quiet = false } = {}) {
  const log = (m) => { if (!quiet) console.log(m); };
  if (remoteLinked()) { log(`a hub is already linked (${SETTINGS.hubUrl}); the local panel is not needed`); return { skipped: "remote" }; }
  const hash = sourceHash();
  const built = docker(["image", "inspect", "-f", "{{index .Config.Labels \"ekip.src\"}}", IMAGE]).stdout?.trim();
  if (built !== hash) {
    log("building the panel image (first time takes a few minutes)…");
    const b = docker(["build", "-q", "--label", `ekip.src=${hash}`, "-t", IMAGE, path.join(ROOT, "hub")], { stdio: quiet ? "ignore" : ["ignore", "ignore", "inherit"], timeout: 1_800_000 });
    if (b.status !== 0) throw new Error("panel image build failed (docker build hub/)");
    docker(["rm", "-f", NAME]);
  }
  const s = secrets();
  if (!containerRunning(NAME)) {
    docker(["rm", "-f", NAME]);
    const net = docker(["network", "inspect", "tdai-memory-stack"]).status === 0 ? ["--network", "tdai-memory-stack"] : [];
    const env = {
      EKIP_HUB_TOKEN: s.token, EKIP_HUB_PASSWORD: s.password, EKIP_LOCAL_PANEL: "1", EKIP_WORKERS: "1",
      FREELLMAPI_URL: `http://host.docker.internal:${PORT}`, FREELLMAPI_KEY: (SETTINGS.freellmapiKey || fs.existsSync(DB) ? unifiedKey() : "") ?? "",
      TDAI_PROXY_URL: "http://tdai-proxy:8096", TDAI_USER_KEY: adminKey() ?? "", KNOWLEDGE_URL: "http://tdai-memory-hub:8424",
    };
    const r = docker(["run", "-d", "--name", NAME, "--restart", "unless-stopped", "-p", `127.0.0.1:${HUB_PORT}:7777`,
      "--add-host", "host.docker.internal:host-gateway", "-v", "ekip-hub-local-data:/data", ...net,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), IMAGE]);
    if (r.status !== 0) throw new Error(`panel container did not start: ${(r.stderr ?? "").trim().split("\n").pop()}`);
  }
  for (let i = 0; i < 30; i++) {
    const ok = await fetch(`${URL_LOCAL}/healthz`, { signal: AbortSignal.timeout(2000) }).then((x) => x.ok).catch(() => false);
    if (ok) break;
    await sleep(1000);
  }
  saveSettings({ hubUrl: URL_LOCAL, hubToken: s.token, hubLocal: true });
  log(`panel: ${URL_LOCAL}  password: ${s.password}  (saved in ${SECRETS})`);
  return { url: URL_LOCAL, password: s.password };
}

export function down() {
  docker(["rm", "-f", NAME]);
  if (SETTINGS.hubLocal) saveSettings({ hubUrl: null, hubToken: null, hubLocal: false });
  console.log("local panel stopped");
}

export async function main([sub = "up"]) {
  if (sub === "up") { await up(); return 0; }
  if (sub === "down") { down(); return 0; }
  if (sub === "status") {
    const s = fs.existsSync(SECRETS) ? JSON.parse(fs.readFileSync(SECRETS, "utf8")) : null;
    console.log(containerRunning(NAME) ? `running: ${URL_LOCAL}${s ? `  password: ${s.password}` : ""}` : "not running (ekip hub local)");
    return 0;
  }
  console.error("usage: ekip hub local [up|down|status]");
  return 2;
}
