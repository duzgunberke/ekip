#!/usr/bin/env node
// ekip: one command for a lead Claude Code session that hands work to agents on other quotas.
//
//   ekip [claude args]            lead session on your Claude subscription, told how to delegate
//   ekip --free [claude args]     lead session on pooled free-tier models (when Claude's limit is out)
//   ekip run [--via auto|agy|free] [--cwd DIR] [--model M] "task"
//                                 headless worker; prints its final report (the lead calls this)
//   ekip key add <platform> <key> add a free-tier provider key to freellmapi (restarts it)
//   ekip key list                 configured provider keys
//   ekip status | up | down | logs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = path.join(os.homedir(), ".ekip");
const FREE_DIR = process.env.EKIP_FREELLMAPI_DIR ?? "/Volumes/SSD/Projects/freellmapi";
const FREE_NODE = process.env.EKIP_FREELLMAPI_NODE ?? "/opt/homebrew/opt/node@24/bin/node";
const PORT = Number(process.env.EKIP_FREELLMAPI_PORT ?? 3001);
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
    if (!platform || !value) die("usage: ekip key add <platform> <key>   (platforms: google, groq, cerebras, openrouter, mistral, nvidia, github, cohere, cloudflare, ...)");
    const cfg = readConfig();
    const n = cfg.keys.filter((k) => k.platform === platform).length;
    cfg.keys.push({ platform, key: value, label: `ekip-${n + 1}` });
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
`;

async function lead(args) {
  const free = args[0] === "--free";
  if (free) args = args.slice(1);
  const env = free ? await freeEnv() : process.env;
  const argv = ["--append-system-prompt", LEAD_PROMPT, ...args];
  if (free) console.error("ekip: lead session on free-tier models (freellmapi)");
  const r = spawnSync("claude", argv, { stdio: "inherit", env });
  return r.status ?? 1;
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
  const recent = fs.readdirSync(RUNS).sort().slice(-5);
  if (recent.length) console.log(`recent runs:\n${recent.map((f) => `  ${path.join(RUNS, f)}`).join("\n")}`);
}

const HELP = `ekip — lead Claude session + workers on other quotas

  ekip [claude args]              start the lead Claude Code session (your subscription)
  ekip --free [claude args]       same, but the lead runs on free-tier models
  ekip run [--via auto|agy|free] [--cwd DIR] [--model M] "task"
                                  run one headless worker and print its report
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
  case "up": await up(); break;
  case "down": await down(); console.error("ekip: freellmapi stopped"); break;
  case "logs": spawnSync("tail", ["-n", "60", LOG], { stdio: "inherit" }); break;
  case "help": case "-h": case "--help": process.stdout.write(HELP); break;
  default: code = await lead(cmd ? [cmd, ...rest] : []);
}
process.exit(code);
