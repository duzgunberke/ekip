#!/usr/bin/env node
// ekip: one command for a lead Claude Code session that hands work to agents on other quotas.
//
//   ekip [claude args]            lead session on your Claude subscription, told how to delegate
//   ekip --free [claude args]     lead session on pooled free-tier models (when Claude's limit is out)
//   ekip run [--via auto|agy|free] [--cwd DIR] [--model M] "task"
//                                 headless worker; prints its final report (the lead calls this)
//   ekip key add <platform> <key> add a free-tier provider key to freellmapi (restarts it)
//   ekip key list                 configured provider keys
//   ekip setup                    install freellmapi, link ekip on PATH, enable the keyless pool
//   ekip team up|down|ls          long-lived workers (agy, free) as hoptell peers in tmux
//   ekip status | up | down | logs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything ekip keeps (keys, run transcripts, logs, cloned dependencies) lives inside the repo it
// runs from, so the whole setup sits on one disk and moves with the folder. EKIP_HOME overrides it.
const REPO = path.resolve(path.dirname(fs.realpathSync(process.argv[1])), "../..");
const HOME = process.env.EKIP_HOME ?? path.join(REPO, "data");
const VENDOR = path.join(REPO, "vendor");
const SETTINGS_FILE = path.join(HOME, "config.json");
const SETTINGS = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) : {};
const FREE_DIR = process.env.EKIP_FREELLMAPI_DIR ?? SETTINGS.freellmapiDir ?? path.join(VENDOR, "freellmapi");
const FREE_NODE = process.env.EKIP_FREELLMAPI_NODE ?? SETTINGS.freellmapiNode ?? "/opt/homebrew/opt/node@24/bin/node";
const PORT = Number(process.env.EKIP_FREELLMAPI_PORT ?? SETTINGS.port ?? 3001);
const FREELLMAPI_REPO = "https://github.com/tashfeenahmed/freellmapi.git";
const KEYLESS = ["ovh"];
const URL_ROOT = `http://127.0.0.1:${PORT}`;
const DB = path.join(FREE_DIR, "server/data/freeapi.db");
const CONFIG = path.join(HOME, "freellmapi.config.json");
const PID = path.join(HOME, "freellmapi.pid");
const LOG = path.join(HOME, "logs/freellmapi.log");
const RUNS = path.join(HOME, "runs");
const FREE_CLAUDE_HOME = path.join(HOME, "claude-free");

const die = (msg, code = 1) => { process.stderr.write(`ekip: ${msg}\n`); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(RUNS, { recursive: true });

// ---- freellmapi server ------------------------------------------------------------------------

async function healthy() {
  try { return (await fetch(`${URL_ROOT}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

async function up({ quiet = false } = {}) {
  if (await healthy()) return;
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

async function down() {
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

function sql(query) {
  const r = spawnSync("sqlite3", ["-separator", "\t", DB, query], { encoding: "utf8" });
  if (r.status !== 0) die(`sqlite3 failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const unifiedKey = () => sql("select value from settings where key='unified_api_key'");
const keyCounts = () => sql("select platform, count(*) from api_keys where enabled=1 group by platform")
  .split("\n").filter(Boolean).map((l) => l.split("\t"));

// ---- provider keys (declarative config, applied by freellmapi on every boot) ------------------

const readConfig = () => (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : { keys: [] });
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);
}

async function key(args) {
  const [sub, platform, value] = args;
  if (sub === "add") {
    if (!platform || (!value && !KEYLESS.includes(platform))) die(`usage: ekip key add <platform> <key>   (platforms: google, groq, cerebras, openrouter, mistral, nvidia, cohere, cloudflare, zhipu, ...; keyless: ${KEYLESS.join(", ")})`);
    const cfg = readConfig();
    const n = cfg.keys.filter((k) => k.platform === platform).length;
    if (value) cfg.keys.push({ platform, key: value, label: `ekip-${n + 1}` });
    else if (!n) cfg.keys.push({ platform, label: "ekip-1" });
    writeConfig(cfg);
    await down();
    await up();
    const counts = Object.fromEntries(keyCounts());
    if (!counts[platform]) die(`freellmapi did not accept the ${platform} key; see ${LOG}`);
    console.log(`${platform}: ${counts[platform]} key(s) active`);
  } else if (sub === "list" || !sub) {
    await up({ quiet: true });
    const rows = keyCounts();
    console.log(rows.length ? rows.map(([p, c]) => `${p}\t${c}`).join("\n") : "no provider keys yet — ekip key add <platform> <key>");
  } else die(`unknown: ekip key ${sub}`);
}

// ---- key wizard: opens each provider's key page, you paste the key -----------------------------

// Free tiers worth having for agent work (tool calling, long context), best first. URLs as in
// freellmapi's dashboard (client/src/components/keys/shared.tsx).
const PROVIDERS = [
  { platform: "groq", label: "Groq", url: "https://console.groq.com/keys", note: "very fast; ~14k requests/day" },
  { platform: "google", label: "Google AI Studio", url: "https://aistudio.google.com/apikey", note: "Gemini Flash; ~1k requests/day" },
  { platform: "cerebras", label: "Cerebras", url: "https://cloud.cerebras.ai", note: "very fast (API Keys in the left menu)" },
  { platform: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/keys", note: ":free models" },
  { platform: "nvidia", label: "NVIDIA NIM", url: "https://build.nvidia.com/settings/api-keys", note: "large models (Nemotron Ultra)" },
  { platform: "mistral", label: "Mistral", url: "https://console.mistral.ai/api-keys/", note: "pick the free Experiment plan" },
  { platform: "cloudflare", label: "Cloudflare Workers AI", url: "https://dash.cloudflare.com/profile/api-tokens", note: "paste as ACCOUNT_ID:API_TOKEN (token with Workers AI permission)" },
  { platform: "cohere", label: "Cohere", url: "https://dashboard.cohere.com/api-keys", note: "trial key" },
  { platform: "zhipu", label: "Z.ai (Zhipu)", url: "https://z.ai/manage-apikey/apikey-list", note: "GLM Flash" },
  { platform: "huggingface", label: "HuggingFace", url: "https://huggingface.co/settings/tokens", note: "token with Inference Providers permission" },
];

async function ask(question) {
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

const openUrl = (url) => spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });

async function keyWizard({ all = false } = {}) {
  if (!process.stdin.isTTY) die("ekip keys is interactive; run it in a terminal");
  const cfg = readConfig();
  const have = new Set(cfg.keys.map((k) => k.platform));
  const todo = PROVIDERS.filter((p) => all || !have.has(p.platform));
  if (!todo.length) { console.log("Every provider already has a key (ekip keys --all to add more)."); return; }
  console.log("For each provider, its key page opens in your browser: sign in with your own account, create a key, paste it here.");
  console.log("Enter = skip this provider, q = stop. Use one account per provider; extra accounts to dodge limits break their terms.\n");
  let added = 0;
  for (const p of todo) {
    console.log(`── ${p.label}: ${p.note}\n   ${p.url}`);
    openUrl(p.url);
    const v = await ask("   key: ");
    if (v === "q") break;
    if (!v) continue;
    if (p.platform === "cloudflare" && !v.includes(":")) { console.log("   skipped: Cloudflare needs ACCOUNT_ID:API_TOKEN"); continue; }
    const n = cfg.keys.filter((k) => k.platform === p.platform).length;
    cfg.keys.push({ platform: p.platform, key: v, label: `ekip-${n + 1}` });
    writeConfig(cfg);
    added++;
  }
  if (!added) return;
  await down();
  await up();
  const counts = Object.fromEntries(keyCounts());
  for (const p of PROVIDERS) if (cfg.keys.some((k) => k.platform === p.platform)) console.log(`${p.label}: ${counts[p.platform] ? "active" : "NOT accepted, see ekip logs"}`);
}

// ---- environments of the two non-subscription pools --------------------------------------------

async function freeEnv() {
  await up({ quiet: true });
  if (!keyCounts().length) die("no free provider keys yet — add one with: ekip key add <platform> <key>");
  const env = { ...process.env };
  // Interactive sessions use AUTH_TOKEN (an API_KEY there triggers a "use this key?" dialog);
  // runWorker swaps it for API_KEY, the only credential --bare reads.
  delete env.ANTHROPIC_API_KEY;
  fs.mkdirSync(FREE_CLAUDE_HOME, { recursive: true });
  const state = path.join(FREE_CLAUDE_HOME, ".claude.json");
  if (!fs.existsSync(state)) fs.writeFileSync(state, JSON.stringify({ hasCompletedOnboarding: true }));
  const model = process.env.EKIP_FREE_MODEL ?? "auto";
  return Object.assign(env, {
    ANTHROPIC_BASE_URL: URL_ROOT,
    ANTHROPIC_AUTH_TOKEN: unifiedKey(),
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CONFIG_DIR: FREE_CLAUDE_HOME,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // "auto" is no model Claude Code knows; give it a window every routed free model can hold.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.EKIP_FREE_WINDOW ?? "100000",
  });
}

// ---- workers ----------------------------------------------------------------------------------

function parseRun(args) {
  const o = { via: "auto", cwd: process.cwd(), model: null, task: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--via") o.via = args[++i];
    else if (a === "--cwd") o.cwd = path.resolve(args[++i]);
    else if (a === "--model") o.model = args[++i];
    else if (a === "-") o.task = fs.readFileSync(0, "utf8");
    else if (o.task == null) o.task = a;
    else o.task += ` ${a}`;
  }
  if (!o.task?.trim()) die('usage: ekip run [--via auto|agy|free] [--cwd DIR] [--model M] "task"   (or - to read the task from stdin)');
  if (!["auto", "agy", "free"].includes(o.via)) die(`--via must be auto, agy or free`);
  if (!fs.existsSync(o.cwd)) die(`no such directory: ${o.cwd}`);
  return o;
}

const WORKER_BRIEF = [
  "You are a worker agent dispatched by a lead agent. Do the task below completely and autonomously in the current directory; do not ask questions, make reasonable assumptions and state them.",
  "Finish with a short report: what you changed (files), what you verified and how, and anything left open.",
  "",
  "TASK:",
].join("\n");

function runChild(cmd, argv, opts, logFile) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`$ ${cmd} ${argv.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)).join(" ")}\n`);
    const child = spawn(cmd, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; log.write(d); });
    child.stderr.on("data", (d) => { out += d; log.write(d); });
    child.on("close", (code) => { log.end(`\n[exit ${code}]\n`); resolve({ code, out }); });
  });
}

// A run that "succeeded" but only reports a quota or auth failure counts as failed, so auto moves on.
const LIMIT_RE = /quota|rate.?limit|resource.?exhausted|usage limit|limit reached|too many requests|\b429\b|not logged in|unauthori[sz]ed|overloaded_error|no_providers_configured/i;
const failed = (r) => r.code !== 0 || !r.out.trim() || (r.out.length < 600 && LIMIT_RE.test(r.out));

async function runVia(via, o, logFile) {
  const prompt = `${WORKER_BRIEF}\n${o.task}`;
  if (via === "agy") {
    if (!has("agy")) return { code: 127, out: "agy is not installed" };
    const argv = ["-p", prompt, "--dangerously-skip-permissions", "--print-timeout", process.env.EKIP_AGY_TIMEOUT ?? "0s"];
    if (o.model ?? process.env.EKIP_AGY_MODEL) argv.push("--model", o.model ?? process.env.EKIP_AGY_MODEL);
    return runChild("agy", argv, { cwd: o.cwd }, logFile);
  }
  const env = await freeEnv();
  env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (o.model) Object.assign(env, { ANTHROPIC_MODEL: o.model, ANTHROPIC_DEFAULT_SONNET_MODEL: o.model, ANTHROPIC_DEFAULT_OPUS_MODEL: o.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: o.model });
  // --bare: no user hooks, plugins or memory, so the free models get a small, plain context.
  const argv = ["--bare", "-p", prompt, "--permission-mode", "bypassPermissions"];
  return runChild("claude", argv, { cwd: o.cwd, env }, logFile);
}

async function run(args) {
  const o = parseRun(args);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${o.via}`;
  const logFile = path.join(RUNS, `${id}.log`);
  fs.writeFileSync(logFile, `cwd: ${o.cwd}\ntask:\n${o.task}\n\n`);
  const order = o.via === "auto" ? ["agy", "free"] : [o.via];
  let last = null;
  for (const via of order) {
    process.stderr.write(`ekip: worker via ${via} in ${o.cwd} (log: ${logFile})\n`);
    try {
      last = await runVia(via, o, logFile);
    } catch (e) {
      last = { code: 1, out: String(e?.message ?? e) };
    }
    if (!failed(last)) {
      process.stdout.write(`[ekip worker: ${via}]\n${last.out.trim()}\n`);
      return 0;
    }
    process.stderr.write(`ekip: ${via} failed (exit ${last.code}): ${last.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}\n`);
  }
  process.stdout.write(`[ekip worker: all pools failed]\n${last?.out.trim() ?? ""}\n`);
  return 1;
}

// ---- the lead session -------------------------------------------------------------------------

const LEAD_PROMPT = `# ekip: workers on other quotas
You lead a team. Besides your own subagents (which spend YOUR Claude limit), you can hand work to
external worker agents that run on separate quotas, through the shell command \`ekip run\`:

- \`ekip run --via agy "<brief>"\`: Antigravity CLI (Gemini and other strong models), Google quota.
- \`ekip run --via free "<brief>"\`: Claude Code harness driven by pooled free-tier models (freellmapi). Weaker: give it small, precise, mechanical tasks.
- \`ekip run "<brief>"\` (auto): tries agy, falls back to free when agy is out of quota.
- Options: \`--cwd DIR\` (default: current dir), \`--model ID\`. Long briefs: \`ekip run - <<'EOF' ... EOF\`.

A worker runs headless with full file and shell access in its cwd, cannot ask you questions, and prints
its final report to stdout (full transcript under ~/.ekip/runs/).

How to use them:
- Prefer workers over your own subagents for well-scoped work: mechanical edits across files, writing
  tests, docs, research/reading a codebase, isolated bug fixes, boilerplate. This saves your limit.
- Keep for yourself: understanding the request, design decisions, splitting the work, integration,
  and reviewing every worker's result (read the diff with git diff, run the tests) before you report.
- Run independent workers in parallel with the Bash tool's run_in_background; you are notified when
  each one exits. Never let two concurrent workers edit the same files; use separate git worktrees
  (\`git worktree add\`) when parallel workers must touch the same repo heavily.
- Write each brief as for a capable colleague with no context: goal, relevant files/paths, constraints,
  how to verify, and what to report back.
- If a worker's result is wrong, fix it yourself or re-dispatch with a sharper brief; don't trust it blindly.
- \`ekip status\` shows which pools are usable.

Long-lived team members (optional, via hoptell): \`ekip team up\` starts \`ekip-agy\` and \`ekip-free\` as
hoptell peers in tmux. They keep their context between tasks: send them work with the hoptell
send_message tool (to their name, or \`@worker\`) and wait for the reply. Use them for multi-step work
that benefits from a conversation; use \`ekip run\` for one-shot tasks.
`;

const MEMBER_PROMPT = `# ekip team member
You are a long-running worker in an ekip team. Other agents send you tasks over hoptell. When the
inbox notice appears, read your inbox, do each task completely and autonomously, and reply to the
sender with send_message (reply_to the message id): what you changed, how you verified it, what is open.`;

const HOPTELL_MCP = JSON.stringify({ mcpServers: { hoptell: { command: "hoptell", args: ["mcp"] } } });

async function lead(args) {
  let free = false, member = false;
  while (args[0] === "--free" || args[0] === "--member") {
    if (args[0] === "--free") free = true; else member = true;
    args = args.slice(1);
  }
  const env = free ? await freeEnv() : process.env;
  const argv = ["--append-system-prompt", member ? MEMBER_PROMPT : LEAD_PROMPT, ...args];
  // The free config dir has none of the user's MCP servers; hand it hoptell when it is installed.
  if (free && has("hoptell")) argv.unshift("--mcp-config", HOPTELL_MCP);
  if (free && !member) console.error("ekip: lead session on free-tier models (freellmapi)");
  const r = spawnSync("claude", argv, { stdio: "inherit", env });
  return r.status ?? 1;
}

// ---- setup -----------------------------------------------------------------------------------

function sh(cmd, argv, opts = {}) {
  console.error(`$ ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.status !== 0) die(`${cmd} failed (exit ${r.status})`);
}

// Dependencies ekip clones when this machine has none configured (config.json can point elsewhere).
const DEPS = {
  freellmapi: { repo: "https://github.com/tashfeenahmed/freellmapi.git", key: "freellmapiDir" },
  hoptell: { repo: "https://github.com/EminUZUN/hoptell.git", key: "hoptellDir" },
  tdai: { repo: "https://github.com/TencentCloud/TencentDB-Agent-Memory.git", key: "tdaiDir" },
};
const depDir = (name) => SETTINGS[DEPS[name].key] ?? path.join(VENDOR, name);
const saveSettings = (patch) => {
  Object.assign(SETTINGS, patch);
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(SETTINGS, null, 2)}\n`);
};

function clone(name) {
  const dir = depDir(name);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    sh("git", ["clone", "--depth", "50", DEPS[name].repo, dir]);
  }
  saveSettings({ [DEPS[name].key]: dir });
  return dir;
}

// freellmapi needs Node >=20.18 <25; the default node may be newer.
function findOldNode() {
  const candidates = [SETTINGS.freellmapiNode, "/opt/homebrew/opt/node@24/bin/node", "/opt/homebrew/opt/node@22/bin/node",
    "/usr/local/opt/node@24/bin/node", "/usr/local/opt/node@22/bin/node", "node"].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ["-p", "process.versions.node"], { encoding: "utf8" });
    const major = Number(r.stdout?.split(".")[0]);
    if (r.status === 0 && major >= 21 && major < 25) return c === "node" ? spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim() : c;
  }
  return null;
}

const step = (n, title) => console.log(`\n━━ ${n}. ${title}`);

async function init({ skipKeys = false } = {}) {
  const self = fs.realpathSync(process.argv[1]);
  step(1, "prerequisites");
  const need = ["git", "claude", "sqlite3", "tmux", "docker"];
  const missing = need.filter((b) => !has(b));
  if (missing.length) die(`missing: ${missing.join(", ")}. On macOS: brew install ${missing.filter((b) => b !== "claude" && b !== "docker").join(" ")}; Claude Code from claude.com/claude-code; Docker Desktop or OrbStack`);
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) die("docker is installed but not running; start Docker Desktop / OrbStack and run ekip init again");
  const oldNode = findOldNode();
  if (!oldNode) die("freellmapi needs Node 22-24 next to your default node: brew install node@24");
  saveSettings({ freellmapiNode: oldNode });
  console.log(`ok (freellmapi node: ${oldNode}; agy: ${has("agy") ? "found" : "not found, optional"})`);

  step(2, "ekip on PATH");
  const link = path.join(os.homedir(), ".local/bin/ekip");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(self, link);
  console.log(`${link} -> ${self}${(process.env.PATH ?? "").split(":").includes(path.dirname(link)) ? "" : "  (add ~/.local/bin to PATH)"}`);

  step(3, "freellmapi (free-tier router)");
  const fdir = clone("freellmapi");
  const nodeEnv = { ...process.env, PATH: `${path.dirname(oldNode)}:${process.env.PATH}` };
  if (!fs.existsSync(path.join(fdir, "server/dist/index.js"))) {
    sh("./scripts/dev-bootstrap.sh", [], { cwd: fdir, env: nodeEnv });
    sh("npm", ["run", "build"], { cwd: fdir, env: nodeEnv });
  }
  if (!readConfig().keys.length) { const c = readConfig(); c.keys.push({ platform: "ovh", label: "ekip-1" }); writeConfig(c); }
  await up();

  step(4, "hoptell (agent-to-agent relay)");
  if (!has("hoptell")) {
    const hdir = clone("hoptell");
    sh("npm", ["install"], { cwd: hdir });
    sh("npm", ["link"], { cwd: hdir });
  }
  spawnSync("hoptell", ["local-relay", "install"], { stdio: "inherit" });
  if (spawnSync("claude", ["mcp", "get", "hoptell"], { stdio: "ignore" }).status !== 0) sh("claude", ["mcp", "add", "-s", "user", "hoptell", "--", "hoptell", "mcp"]);

  step(5, "TencentDB Agent Memory (memory, LLM wiki, code graph)");
  clone("tdai");
  await memoryUp();

  step(6, "Claude Code plugin (the ekip skill in every session)");
  spawnSync("claude", ["plugin", "marketplace", "add", REPO], { stdio: "inherit" });
  spawnSync("claude", ["plugin", "install", "ekip@ekip"], { stdio: "inherit" });
  await memoryMcp();

  if (!skipKeys && process.stdin.isTTY) {
    step(7, "free-tier keys");
    await keyWizard();
  }
  console.log("\nDone. Start with: ekip    (status: ekip status, more keys: ekip keys)");
}

// ---- TencentDB Agent Memory ---------------------------------------------------------------------

const TDAI_PORTS = { core: 8420, panel: 8125, knowledge: 8424, proxy: 8096 };
const tdaiDeploy = () => path.join(depDir("tdai"), "deploy/global-images");
const tdaiUp = async () => {
  try { return (await fetch(`http://127.0.0.1:${TDAI_PORTS.proxy}/health`, { signal: AbortSignal.timeout(1500) })).status < 500; } catch { return false; }
};
const containerRunning = (n) => spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", n], { encoding: "utf8" }).stdout.trim() === "true";

function setEnvValues(file, values) {
  let text = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}\n${k}=${v}\n`;
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
}

// The stack's LLM (memory extraction, wiki ingest) and the proxy's upstream both go to freellmapi,
// so memory costs no paid quota. Data volumes are bind mounts under data/tdai.
async function memoryUp() {
  await up({ quiet: true });
  const dir = tdaiDeploy();
  if (!fs.existsSync(dir)) die(`TencentDB Agent Memory is not cloned (${depDir("tdai")}); run ekip init`);
  const env = path.join(dir, ".env");
  if (!fs.existsSync(env)) fs.copyFileSync(path.join(dir, ".env.example"), env);
  const key = unifiedKey();
  const coreData = path.join(HOME, "tdai/core"), panelData = path.join(HOME, "tdai/panel");
  fs.mkdirSync(coreData, { recursive: true });
  fs.mkdirSync(panelData, { recursive: true });
  setEnvValues(env, {
    MEMORY_LLM_BASE_URL: `http://host.docker.internal:${PORT}/v1`, MEMORY_LLM_API_KEY: key, MEMORY_LLM_MODEL: "auto", MEMORY_LLM_PROTOCOL: "openai",
    PROXY_UPSTREAM_URL: `http://host.docker.internal:${PORT}`, PROXY_UPSTREAM_API_KEY: key, PROXY_UPSTREAM_MODEL: "auto",
    MEMORY_CORE_VOLUME: coreData, PANEL_VOLUME: panelData,
  });
  if (["tdai-memory-core", "tdai-memory-hub", "tdai-proxy"].every(containerRunning)) { console.log("memory stack already running"); return; }
  // start-all.sh probes the LLM from the host, where host.docker.internal does not resolve; the
  // three service scripts it wraps need no probe.
  for (const script of ["start-memory-core.sh", "start-memory-hub.sh", "start-proxy.sh"]) {
    sh(`./${script}`, [], { cwd: dir, env: { ...process.env, PROXY_FULL_STACK: "1" } });
  }
}

function memoryDown() {
  sh("./stop-all.sh", [], { cwd: tdaiDeploy() });
}

const adminKey = () => {
  const f = path.join(tdaiDeploy(), ".admin-key");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
};

async function memory([sub = "status"]) {
  if (sub === "up") await memoryUp();
  else if (sub === "down") memoryDown();
  else if (sub === "open") openUrl(`http://127.0.0.1:${TDAI_PORTS.panel}`);
  else if (sub === "status") {
    for (const n of ["tdai-memory-core", "tdai-memory-hub", "tdai-proxy"]) console.log(`${n}: ${containerRunning(n) ? "running" : "stopped"}`);
    console.log(`panel: http://127.0.0.1:${TDAI_PORTS.panel}   admin key: ${adminKey() ? path.join(tdaiDeploy(), ".admin-key") : "not created yet"}`);
  } else die("usage: ekip memory up|down|status|open");
}

async function memoryMcp() { /* filled in once the knowledge MCP wiring is verified */ }

// ---- open team members in terminal windows ---------------------------------------------------

function openTerminal(command) {
  if (process.platform !== "darwin") { console.log(`run in a new terminal: ${command}`); return; }
  const app = process.env.TERM_PROGRAM === "iTerm.app" ? "iTerm" : "Terminal";
  const script = app === "iTerm"
    ? `tell application "iTerm" to create window with default profile command ${JSON.stringify(command)}`
    : `tell application "Terminal" to do script ${JSON.stringify(command)}`;
  spawnSync("osascript", ["-e", script, "-e", `tell application "${app}" to activate`], { stdio: "ignore" });
}

// ---- team (hoptell peers in tmux) -------------------------------------------------------------

const TEAM = {
  "ekip-agy": { roles: "worker,agy", cmd: ["agy", "--dangerously-skip-permissions"], needs: "agy" },
  "ekip-free": { roles: "worker,free", cmd: ["ekip", "--free", "--member", "--permission-mode", "bypassPermissions"], needs: null },
};
// A team member starts unattended, so it cannot answer Claude Code's first-run dialogs. Starting it
// in a folder is the user's trust decision for that folder; the bypass-mode prompt follows the
// user's own Claude setting (skipDangerousModePermissionPrompt), never more.
function preTrustFree(cwd) {
  const state = path.join(FREE_CLAUDE_HOME, ".claude.json");
  const d = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : {};
  d.hasCompletedOnboarding = true;
  d.projects ??= {};
  d.projects[cwd] = { ...d.projects[cwd], hasTrustDialogAccepted: true };
  fs.writeFileSync(state, JSON.stringify(d, null, 2));
  const userSettings = path.join(os.homedir(), ".claude/settings.json");
  let skip = false;
  try { skip = JSON.parse(fs.readFileSync(userSettings, "utf8")).skipDangerousModePermissionPrompt === true; } catch { /* none */ }
  const freeSettings = path.join(FREE_CLAUDE_HOME, "settings.json");
  const fsd = fs.existsSync(freeSettings) ? JSON.parse(fs.readFileSync(freeSettings, "utf8")) : {};
  if (skip) fsd.skipDangerousModePermissionPrompt = true; else delete fsd.skipDangerousModePermissionPrompt;
  fs.writeFileSync(freeSettings, JSON.stringify(fsd, null, 2));
}

const tmuxHas = (name) => spawnSync("tmux", ["has-session", "-t", `=hoptell-${name}`], { stdio: "ignore" }).status === 0;

async function team([sub = "ls", ...names]) {
  if (!has("hoptell") || !has("tmux")) die("ekip team needs hoptell and tmux");
  const open = names.includes("--open");
  names = names.filter((n) => n !== "--open");
  const pick = names.length ? names.map((n) => (n.startsWith("ekip-") ? n : `ekip-${n}`)) : Object.keys(TEAM);
  for (const n of pick) if (!TEAM[n]) die(`unknown member ${n} (${Object.keys(TEAM).join(", ")})`);
  if (sub === "up") {
    for (const n of pick) {
      const m = TEAM[n];
      if (tmuxHas(n)) { console.log(`${n}: already running`); continue; }
      if (m.needs && !has(m.needs)) { console.log(`${n}: skipped, ${m.needs} not installed`); continue; }
      if (n === "ekip-free") { await freeEnv(); preTrustFree(process.cwd()); }
      const r = spawnSync("hoptell", ["tmux", n, "--roles", m.roles, "--detach", "--", ...m.cmd], { stdio: "inherit" });
      console.log(`${n}: ${r.status === 0 ? `started (tmux attach -t hoptell-${n})` : "failed"}`);
    }
    if (open) for (const n of pick) if (tmuxHas(n)) openTerminal(`tmux attach -t '=hoptell-${n}'`);
  } else if (sub === "open") {
    for (const n of pick) if (tmuxHas(n)) openTerminal(`tmux attach -t '=hoptell-${n}'`); else console.log(`${n}: not running (ekip team up)`);
  } else if (sub === "down") {
    for (const n of pick) if (tmuxHas(n)) { spawnSync("tmux", ["kill-session", "-t", `=hoptell-${n}`]); console.log(`${n}: stopped`); }
  } else if (sub === "ls") {
    for (const n of Object.keys(TEAM)) console.log(`${n}: ${tmuxHas(n) ? "running" : "stopped"}`);
  } else die("usage: ekip team up|down|ls|open [agy|free] [--open]");
}

// ---- status -----------------------------------------------------------------------------------

async function status() {
  const ok = await healthy();
  console.log(`freellmapi: ${ok ? `up (${URL_ROOT}, dashboard ${URL_ROOT}/)` : "down (starts on demand; ekip up)"}`);
  if (ok) {
    const rows = keyCounts();
    console.log(`  provider keys: ${rows.length ? rows.map(([p, c]) => `${p}×${c}`).join(", ") : "none — ekip key add <platform> <key>"}`);
  }
  console.log(`agy: ${has("agy") ? "installed" : "not installed"}`);
  console.log(`claude: ${has("claude") ? "installed" : "not installed"}`);
  if (has("tmux")) console.log(`team: ${Object.keys(TEAM).map((n) => `${n} ${tmuxHas(n) ? "running" : "stopped"}`).join(", ")}`);
  const recent = fs.readdirSync(RUNS).sort().slice(-5);
  if (recent.length) console.log(`recent runs:\n${recent.map((f) => `  ${path.join(RUNS, f)}`).join("\n")}`);
}

const HELP = `ekip — lead Claude session + workers on other quotas

  ekip [claude args]              start the lead Claude Code session (your subscription)
  ekip --free [claude args]       same, but the lead runs on free-tier models
  ekip run [--via auto|agy|free] [--cwd DIR] [--model M] "task"
                                  run one headless worker and print its report
  ekip init                       one-time setup: clones and starts freellmapi, hoptell and TencentDB
                                  Agent Memory, installs the Claude plugin, runs the key wizard
  ekip memory up|down|status|open TencentDB Agent Memory stack (memory, LLM wiki, code graph)
  ekip team up|down|ls|open [agy|free] [--open]
                                  long-lived workers as hoptell peers in tmux; --open / open shows
                                  each one in its own terminal window
  ekip keys [--all]               key wizard: opens each provider's key page, you paste the key
  ekip key add <platform> <key>   add a free provider key (google, groq, cerebras, openrouter, ...)
  ekip key list                   show provider keys
  ekip status                     pools and recent runs
  ekip up | down | logs           freellmapi server control
`;

const [cmd, ...rest] = process.argv.slice(2);
let code = 0;
switch (cmd) {
  case "run": code = await run(rest); break;
  case "key": await key(rest); break;
  case "keys": if (rest[0] && rest[0] !== "--all") await key(rest); else await keyWizard({ all: rest[0] === "--all" }); break;
  case "status": await status(); break;
  case "init": case "setup": await init({ skipKeys: rest.includes("--no-keys") }); break;
  case "memory": await memory(rest); break;
  case "team": await team(rest); break;
  case "up": await up(); break;
  case "down": await down(); console.error("ekip: freellmapi stopped"); break;
  case "logs": spawnSync("tail", ["-n", "60", LOG], { stdio: "inherit" }); break;
  case "help": case "-h": case "--help": process.stdout.write(HELP); break;
  default: code = await lead(cmd ? [cmd, ...rest] : []);
}
process.exit(code);
