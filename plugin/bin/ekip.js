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

const HOME = path.join(os.homedir(), ".ekip");
const SETTINGS_FILE = path.join(HOME, "config.json");
const SETTINGS = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) : {};
const FREE_DIR = process.env.EKIP_FREELLMAPI_DIR ?? SETTINGS.freellmapiDir ?? path.join(HOME, "freellmapi");
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

// ---- environments of the two non-subscription pools --------------------------------------------

async function freeEnv() {
  await up({ quiet: true });
  if (!keyCounts().length) die("no free provider keys yet — add one with: ekip key add <platform> <key>");
  const env = { ...process.env };
  delete env.ANTHROPIC_AUTH_TOKEN;
  fs.mkdirSync(FREE_CLAUDE_HOME, { recursive: true });
  const state = path.join(FREE_CLAUDE_HOME, ".claude.json");
  if (!fs.existsSync(state)) fs.writeFileSync(state, JSON.stringify({ hasCompletedOnboarding: true }));
  const model = process.env.EKIP_FREE_MODEL ?? "auto";
  return Object.assign(env, {
    ANTHROPIC_BASE_URL: URL_ROOT,
    ANTHROPIC_API_KEY: unifiedKey(),
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

async function setup() {
  const self = fs.realpathSync(process.argv[1]);
  // 1. freellmapi: needs Node >=20.18 <25.
  if (!fs.existsSync(FREE_NODE)) die(`no Node 20-24 at ${FREE_NODE}. Install one (brew install node@24) or set EKIP_FREELLMAPI_NODE`);
  if (!fs.existsSync(path.join(FREE_DIR, "package.json"))) sh("git", ["clone", FREELLMAPI_REPO, FREE_DIR]);
  const nodeEnv = { ...process.env, PATH: `${path.dirname(FREE_NODE)}:${process.env.PATH}` };
  if (!fs.existsSync(path.join(FREE_DIR, "server/dist/index.js"))) {
    sh("./scripts/dev-bootstrap.sh", [], { cwd: FREE_DIR, env: nodeEnv });
    sh("npm", ["run", "build"], { cwd: FREE_DIR, env: nodeEnv });
  }
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify({ ...SETTINGS, freellmapiDir: FREE_DIR, freellmapiNode: FREE_NODE }, null, 2)}\n`);
  await up();
  if (!readConfig().keys.length) await key(["add", "ovh"]);
  // 2. the ekip command on PATH.
  const link = path.join(os.homedir(), ".local/bin/ekip");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(self, link);
  console.error(`ekip: linked ${link} -> ${self}`);
  // 3. what else is there.
  console.log(`\nagy:     ${has("agy") ? "ok" : "missing — install Antigravity CLI for the agy pool"}`);
  console.log(`hoptell: ${has("hoptell") ? "ok (ekip team up)" : "missing — optional, only for ekip team (github.com/EminUZUN/hoptell)"}`);
  console.log(`plugin:  claude plugin marketplace add ${path.resolve(path.dirname(self), "../..")} && claude plugin install ekip@ekip`);
  console.log(`keys:    ekip key add <platform> <key>   (google, groq, cerebras, openrouter, mistral, nvidia, ...)`);
}

// ---- team (hoptell peers in tmux) -------------------------------------------------------------

const TEAM = {
  "ekip-agy": { roles: "worker,agy", cmd: ["agy", "--dangerously-skip-permissions"], needs: "agy" },
  "ekip-free": { roles: "worker,free", cmd: ["ekip", "--free", "--member", "--permission-mode", "bypassPermissions"], needs: null },
};
const tmuxHas = (name) => spawnSync("tmux", ["has-session", "-t", `=hoptell-${name}`], { stdio: "ignore" }).status === 0;

async function team([sub = "ls", ...names]) {
  if (!has("hoptell") || !has("tmux")) die("ekip team needs hoptell and tmux");
  const pick = names.length ? names.map((n) => (n.startsWith("ekip-") ? n : `ekip-${n}`)) : Object.keys(TEAM);
  for (const n of pick) if (!TEAM[n]) die(`unknown member ${n} (${Object.keys(TEAM).join(", ")})`);
  if (sub === "up") {
    for (const n of pick) {
      const m = TEAM[n];
      if (tmuxHas(n)) { console.log(`${n}: already running`); continue; }
      if (m.needs && !has(m.needs)) { console.log(`${n}: skipped, ${m.needs} not installed`); continue; }
      if (n === "ekip-free") await freeEnv();
      const r = spawnSync("hoptell", ["tmux", n, "--roles", m.roles, "--detach", "--", ...m.cmd], { stdio: "inherit" });
      console.log(`${n}: ${r.status === 0 ? `started (tmux attach -t hoptell-${n})` : "failed"}`);
    }
  } else if (sub === "down") {
    for (const n of pick) if (tmuxHas(n)) { spawnSync("tmux", ["kill-session", "-t", `=hoptell-${n}`]); console.log(`${n}: stopped`); }
  } else if (sub === "ls") {
    for (const n of Object.keys(TEAM)) console.log(`${n}: ${tmuxHas(n) ? "running" : "stopped"}`);
  } else die("usage: ekip team up|down|ls [agy|free]");
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
  ekip setup                      install freellmapi, link ekip, enable the keyless pool
  ekip team up|down|ls [agy|free] long-lived workers as hoptell peers in tmux
  ekip key add <platform> <key>   add a free provider key (google, groq, cerebras, openrouter, ...)
  ekip key list                   show provider keys
  ekip status                     pools and recent runs
  ekip up | down | logs           freellmapi server control
`;

const [cmd, ...rest] = process.argv.slice(2);
let code = 0;
switch (cmd) {
  case "run": code = await run(rest); break;
  case "key": case "keys": await key(rest); break;
  case "status": await status(); break;
  case "setup": await setup(); break;
  case "team": await team(rest); break;
  case "up": await up(); break;
  case "down": await down(); console.error("ekip: freellmapi stopped"); break;
  case "logs": spawnSync("tail", ["-n", "60", LOG], { stdio: "inherit" }); break;
  case "help": case "-h": case "--help": process.stdout.write(HELP); break;
  default: code = await lead(cmd ? [cmd, ...rest] : []);
}
process.exit(code);
