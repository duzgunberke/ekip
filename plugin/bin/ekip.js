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
import {
  askSecret, CONFIG, DB, DEPS, notify, FREELLMAPI_REPO, FREE_CLAUDE_HOME, FREE_DIR, FREE_NODE, HOME, KEYLESS, LOG, PID, PORT, REPO, RUNS, SETTINGS, SETTINGS_FILE, TDAI_PORTS, URL_ROOT, VENDOR, adminKey, ask, clone, containerRunning, depDir, die, down, has, healthy, key, keyCounts, openTerminal, openUrl, readConfig, saveSettings, sh, sleep, sql, tdaiDeploy, tdaiUp, unifiedKey, up, writeConfig,
} from "../lib/core/core.js";
import { POINTER, REMOTE, ROOT, TDAI_CONTAINER_SH, TUNNEL_LABEL, ensureTaskPane, openPane, restartFree, ssh, tdaiContainer } from "../lib/core/core.js";
import { AGENTS, QUOTA, autoOrder, clearLimit, isStrong, main as agentsMain, onFreePool, poolLoad, poolMark, quotaInfo, recordLimit, recordStat } from "../lib/workers/agents.js";
import { killCause } from "../lib/workers/slots.js";
import { banner, c, dot, mark, rows, say, title, warn, fit, welcome } from "../lib/core/ui.js";
import { lang, t } from "../lib/core/i18n.js";
import { main as vpsMain } from "../lib/hub/vps.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  // DeepSeek models for free (DeepSeek's own API has no free tier)
  { platform: "routeway", label: "Routeway", url: "https://routeway.ai", note: "free key; DeepSeek V4 Flash" },
  { platform: "bazaarlink", label: "BazaarLink", url: "https://bazaarlink.ai", note: "free key; DeepSeek V4 Flash" },
  { platform: "router9", label: "Router9", url: "https://www.router9.com", note: "shared monthly credits; DeepSeek V4 Pro + Flash" },
  { platform: "modelscope", label: "ModelScope", url: "https://modelscope.cn/my/myaccesstoken", note: "free; DeepSeek V4 Pro; needs an Aliyun (cn) account binding" },
];

async function keyWizard({ all = false } = {}) {
  if (!process.stdin.isTTY) die("ekip keys is interactive; run it in a terminal");
  const cfg = readConfig();
  const have = new Set(cfg.keys.map((k) => k.platform));
  const todo = PROVIDERS.filter((p) => all || !have.has(p.platform));
  if (!todo.length) { console.log("Every provider already has a key (ekip keys --all to add more)."); return; }
  console.log("For each provider, its key page opens in your browser: sign in with your own account, create a key, paste it here.");
  console.log("Enter = skip this provider, q = stop. Use one account per provider; extra accounts to dodge limits break their terms.\n");
  let added = 0;
  // Ctrl+C mid-wizard still applies the keys entered so far.
  process.once("SIGINT", async () => { console.log("\nstopping; applying the keys entered so far"); if (added) await restartFree(); process.exit(0); });
  for (const p of todo) {
    console.log(`── ${p.label}: ${p.note}\n   ${p.url}`);
    openUrl(p.url);
    let v = await askSecret("   key: ").catch(() => "q");
    if (v === "q") break;
    if (!v) continue;
    if (p.platform === "cloudflare" && !v.includes(":")) {
      // A bare API token: look up the account it belongs to.
      const r = await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: { authorization: `Bearer ${v}` }, signal: AbortSignal.timeout(15000) }).then((x) => x.json()).catch(() => null);
      // A Workers-AI-only token may not list accounts; then ask (Account ID is on the dashboard's
      // right sidebar, under API).
      const acct = r?.result?.[0]?.id ?? await ask("   Account ID (dash.cloudflare.com, right sidebar): ");
      if (!/^[0-9a-f]{32}$/.test(acct ?? "")) { console.log("   skipped: that is not a Cloudflare account id"); continue; }
      v = `${acct}:${v}`;
      console.log(`   account ${acct.slice(0, 6)}… found`);
    }
    const n = cfg.keys.filter((k) => k.platform === p.platform).length;
    cfg.keys.push({ platform: p.platform, key: v, label: `ekip-${n + 1}` });
    writeConfig(cfg);
    added++;
  }
  if (!added) return;
  await restartFree();
  const counts = Object.fromEntries(keyCounts());
  for (const p of PROVIDERS) if (cfg.keys.some((k) => k.platform === p.platform)) console.log(`${p.label}: ${counts[p.platform] ? "added" : "NOT accepted, see ekip logs"}`);
  console.log("Live status of each provider: ekip status, or the panel.");
}

// ---- environments of the two non-subscription pools --------------------------------------------

// soft: a worker run gets a thrown error (a failed attempt) instead of die() killing the dispatcher.
async function freeEnv(project = null, { soft = false } = {}) {
  await up({ quiet: true, soft });
  if (!keyCounts(soft ? { timeout: 10_000 } : {}).length) {
    const msg = "no free provider keys yet — add one with: ekip key add <platform> <key>";
    if (soft) throw new Error(msg);
    die(msg);
  }
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
  }, await memoryRoute(project));
}

// A registered project's free sessions go through the TencentDB memory proxy: it injects the
// project's memory, skills and wiki tools, records the conversation, and forwards to freellmapi.
// The x-team-id / x-agent-id headers pick the project's agent so the proxy never shows its
// session form. Without the proxy (or an unregistered folder) they go to freellmapi directly.
async function memoryRoute(project) {
  const p = project && registry().find((x) => x.name === project);
  const key = adminKey();
  if (!p?.tdai?.agentId || !key || !(await tdaiUp())) return {};
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${TDAI_PORTS.proxy}/claude-code/default`,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_CUSTOM_HEADERS: `x-team-id: ${p.tdai.teamId}\nx-agent-id: ${p.tdai.agentId}`,
  };
}

// ---- workers ----------------------------------------------------------------------------------

const VIAS = ["auto", "free", "claude", ...Object.keys(AGENTS)];

const RUN_HELP = `usage: ekip run [--via POOL|a,b,c] [--project NAME | --cwd DIR] [--model ID] [--plugin NAME] [--skill NAME] [--no-watch] "task"
       ekip run ... -            read the task from stdin (use for long briefs: ekip run - <<'EOF' ... EOF)

  --via      auto (default) | ${Object.keys(AGENTS).filter((n) => !AGENTS[n].hidden?.()).join(" | ")} | free | claude
             a,b,c runs the same task on several pools, each in its own git worktree and branch
  --project  a registered project (ekip project ls); sets the folder and its memory
  --plugin   load an installed Claude plugin into a free/claude worker (e.g. lemo-opuscar)
  --skill    load a project-local skill, then ~/.claude/skills, into a worker
  --task ID  show this worker under a task (ekip task new ...) while it runs
  --label T  a short name for the worker in the task view
  --no-watch don't open a pane that shows the worker live
  --worktree run on its own git worktree and branch (for work on code that is running right now)
  --min-tier strong   never fall back to a weak pool (free-pool harnesses, free models)
  --no-fallback-free  never fall back to the free pool (a pool asked for by name still runs)
  --heavy | --light   the run renders/encodes on this machine (takes a machine slot) or not;
                      default: heavy when the brief mentions a render, encode or similar
  --after ID          start once task ID or run ID finished successfully (waits in the background)
  --when "CMD"        start once the shell command CMD exits 0 (checked every 30 s, background)
  --foreground        with --after/--when: wait in this process instead of the background
  --resume RUN        run RUN's brief again (same task and label), told to continue the half-done work
  --retry-on-kill     a worker killed by a signal (load, memory) is restarted once when the load drops
The worker's final report is printed to stdout; its full log is under data/runs/.`;

function parseRun(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) { console.log(RUN_HELP); process.exit(0); }
  const o = { via: "auto", cwd: process.cwd(), model: null, task: null, plugins: [], skills: [], project: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--via") o.via = args[++i];
    else if (a === "--cwd") o.cwd = path.resolve(args[++i]);
    else if (a === "--model") o.model = args[++i];
    else if (a === "--plugin") o.plugins.push(args[++i]);
    else if (a === "--skill") o.skills.push(args[++i]);
    else if (a === "--project") o.project = args[++i];
    else if (a === "--no-watch") o.watch = false;
    else if (a === "--worktree") o.worktree = true;
    else if (a === "--task") o.taskId = args[++i];
    else if (a === "--label") o.label = args[++i];
    else if (a === "--watch") o.watch = true;
    else if (a === "--min-tier") { o.minTier = args[++i]; if (o.minTier !== "strong" && o.minTier !== "any") die("--min-tier takes strong or any"); }
    else if (a === "--no-fallback-free") o.noFallbackFree = true;
    else if (a === "--heavy") o.heavy = true;
    else if (a === "--light") o.heavy = false;
    else if (a === "--after") o.after = args[++i];
    else if (a === "--when") o.when = args[++i];
    else if (a === "--foreground") o.foreground = true;
    else if (a === "--resume") o.resume = args[++i];
    else if (a === "--retry-on-kill") o.retryOnKill = true;
    else if (a === "--brief-file") o.task = fs.readFileSync(args[++i], "utf8");
    else if (a.startsWith("--")) die(`unknown option ${a} (ekip run --help)`);
    else if (a === "-") o.task = fs.readFileSync(0, "utf8");
    else if (o.task == null) o.task = a;
    else o.task += ` ${a}`;
  }
  if (o.resume) resumeBrief(o, args);
  if (!o.task?.trim()) die('usage: ekip run [--via auto|agy|free|claude|a,b,c] [--project NAME | --cwd DIR] [--model M] [--plugin NAME] [--skill NAME] "task"   (or - to read the task from stdin)');
  o.vias = o.via.split(",").map((v) => v.trim()).filter(Boolean);
  for (const v of o.vias) if (!VIAS.includes(v)) die(`--via takes ${VIAS.join(", ")} or a comma list of them`);
  if (o.project) {
    const p = registry().find((x) => x.name === o.project);
    if (!p) die(`unknown project ${o.project} (ekip project ls)`);
    o.cwd = p.path;
  } else o.project = registry().filter((x) => o.cwd === x.path || o.cwd.startsWith(`${x.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]?.name ?? null;
  if (!fs.existsSync(o.cwd)) die(`no such directory: ${o.cwd}`);
  return o;
}

// --resume RUN: the brief of an earlier run (as its log header kept it, before project knowledge
// was added), with the same task link and label, and a note to continue rather than start over.
const RESUME_NOTE = "NOTE: a previous attempt at this task was interrupted before it finished. Look at the half-finished changes in the working tree first (git status, git diff, new files, partial outputs) and continue from where it stopped; do not start over or redo finished parts.\n\n";
function resumeBrief(o, args) {
  const name = path.basename(o.resume).replace(/\.log$/, "");
  const file = fs.existsSync(o.resume) ? o.resume : path.join(RUNS, `${name}.log`);
  if (!fs.existsSync(file)) die(`no run log ${name} (data/runs)`);
  const text = fs.readFileSync(file, "utf8");
  const field = (k) => { const v = text.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1]; return v && v !== "-" ? v : null; };
  const body = text.split("\ntask:\n")[1] ?? "";
  const end = body.search(/\n\n(?:\[ekip pool |\$ |▸ |\[exit )/);
  const brief = (end >= 0 ? body.slice(0, end) : body).trim();
  if (!brief) die(`run ${name} has no brief in its log`);
  o.task = `${RESUME_NOTE}${brief.startsWith("NOTE: a previous attempt") ? brief.slice(RESUME_NOTE.length) : brief}${o.task ? `\n\n${o.task}` : ""}`;
  o.taskId ??= field("taskId");
  o.label ??= field("label");
  if (!args.includes("--project") && !args.includes("--cwd") && field("cwd") && fs.existsSync(field("cwd"))) o.cwd = field("cwd");
}

// The project registry (written by `ekip project add`); empty until projects are registered.
function registry() {
  const f = path.join(HOME, "projects.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
}

const WORKER_BRIEF = [
  "You are a worker agent dispatched by a lead agent. Do the task below completely and autonomously in the current directory; do not ask questions, make reasonable assumptions and state them.",
  "Finish with a short report: what you changed (files), what you verified and how, and anything left open.",
  // a worker once revoked a signing certificate to get past an error; the account owner got Apple's email
  "Never revoke, delete or rotate credentials, certificates, signing identities, API keys or tokens, and never delete accounts, app records or production data, even when it would get you past an error: stop and report what is needed instead.",
  // a worker stopped its own render with pkill -f and killed the renders of two other workers
  "Other workers run on this machine at the same time: stop only processes you started yourself, by their PID (kill <pid>). Never use pkill, killall or kill by name or pattern.",
  "A long job you start and must leave running after you finish (a render, an upload, a queue) is started with `ekip track --label \"<what>\" -- <command>`: it runs detached with its log, progress and stall checks, survives when you stop, and `ekip track ls` shows it. Never sit polling a long job yourself for many minutes.",
  "",
  "TASK:",
].join("\n");
// only in a git repo: elsewhere there is no code index to ask
const CODEGRAPH_LINE = "To find code, prefer the code index over reading many files: run `codegraph explore \"<what you look for>\"`, `codegraph callers <symbol>` or `codegraph impact <symbol>` in the repo (fall back to grep when it reports no index).";
const workerBrief = (cwd) => (spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" }).status === 0 ? WORKER_BRIEF.replace("\n\nTASK:", `\n${CODEGRAPH_LINE}\n\nTASK:`) : WORKER_BRIEF);

// Watchdog for every worker: one that prints nothing for EKIP_IDLE_MIN minutes (default 15) or runs
// past EKIP_TIMEOUT_MIN (default 90) is stopped, so a hung CLI never sits on a task for hours; the
// task gets the reason and the lead re-dispatches. Exit code 124, like timeout(1).
// Silence is measured on the whole process tree: a worker that waits for a long job it started (a
// render queue that prints nothing for minutes) is not idle while that job burns CPU.
function watchdog(child, log) {
  const idleMs = Number(process.env.EKIP_IDLE_MIN ?? SETTINGS.idleMin ?? 15) * 60_000;
  const maxMs = Number(process.env.EKIP_TIMEOUT_MIN ?? SETTINGS.timeoutMin ?? 90) * 60_000;
  const t0 = Date.now(); let seen = Date.now(), printed = Date.now(), why = null, cpu = 0, busyNoted = false;
  const tick = setInterval(() => {
    // 3 s of CPU in a 30 s tick (a tenth of a core) anywhere in the tree counts as work
    const now = treeCpu(child.pid);
    if (now - cpu >= 3) {
      seen = Date.now();
      if (Date.now() - printed >= idleMs && !busyNoted) { log.write("\n[ekip] çıktı yok ama alt süreçler çalışıyor (CPU); sessiz sayılmıyor\n"); busyNoted = true; }
    }
    cpu = Math.max(cpu, now);
    const idle = Date.now() - seen, total = Date.now() - t0;
    if (idle < idleMs && total < maxMs) return;
    why = idle >= idleMs ? `${Math.round(idle / 60000)} dk sessiz kaldı, durduruldu` : `${Math.round(total / 60000)} dk sınırını aştı, durduruldu`;
    log.write(`\n[ekip] ${why}\n`);
    killTree(child, "SIGTERM"); setTimeout(() => killTree(child, "SIGKILL"), 10_000).unref();
  }, 30_000);
  tick.unref();
  return { alive: () => { seen = printed = Date.now(); busyNoted = false; }, stop: () => clearInterval(tick), why: () => why };
}

// Workers run in their own process group: the watchdog and a stop signal kill the whole group, so a
// grandchild holding the pipes cannot keep the run alive.
// Processes a worker handed over with `ekip show --pid` are left alive (with their children).
const liveKids = new Set();
function killTree(child, sig) {
  const kept = detachedPids();
  const procs = kept.size ? processTable() : null;
  if (!procs) { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } } return; }
  const tree = treeOf(procs, child.pid), keep = new Set();
  for (const p of procs) if (kept.has(p.pid)) for (const q of treeOf(procs, p.pid)) keep.add(q.pid);
  for (const p of tree) if (!keep.has(p.pid)) { try { process.kill(p.pid, sig); } catch { /* gone */ } }
}

// pid, ppid, pgid and CPU seconds of every process ("ps -A"); null when ps is unavailable.
function processTable() {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,time="], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  const secs = (t) => { const [d, rest] = t.includes("-") ? t.split("-") : [0, t]; return Number(d) * 86400 + rest.split(":").reduce((a, x) => a * 60 + Number(x), 0); };
  return r.stdout.trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([pid, ppid, pgid, time]) => ({ pid: +pid, ppid: +ppid, pgid: +pgid, cpu: secs(time ?? "0") || 0 }));
}
// A worker's processes: its own group (it runs detached) plus any descendant that left the group.
function treeOf(procs, root) {
  const out = new Map(procs.filter((p) => p.pid === root || p.pgid === root).map((p) => [p.pid, p]));
  for (let grew = true; grew;) { grew = false; for (const p of procs) if (!out.has(p.pid) && out.has(p.ppid)) { out.set(p.pid, p); grew = true; } }
  return [...out.values()];
}
const treeCpu = (root) => { const procs = processTable(); return procs ? treeOf(procs, root).reduce((a, p) => a + p.cpu, 0) : 0; };
const DETACHED = () => path.join(HOME, "detached.json");
function detachedPids() {
  try { return new Set(JSON.parse(fs.readFileSync(DETACHED(), "utf8")).map((x) => x.pid).filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } })); } catch { return new Set(); }
}

// Spawns a worker and calls done(code, note) once: on a spawn error (missing binary), on close, or
// shortly after exit when a grandchild still holds the pipes open.
function spawnWorker(cmd, argv, opts, done) {
  const child = spawn(cmd, argv, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  liveKids.add(child);
  let ended = false, grace = null;
  const end = (code, note = "", sig = null) => {
    if (ended) return;
    ended = true; clearTimeout(grace); liveKids.delete(child);
    child.stdout?.destroy(); child.stderr?.destroy();
    // a CLI killed by a signal leaves its children behind: stop them too (ekip show --pid jobs stay)
    if (sig) killTree(child, "SIGTERM");
    done(code, note, sig);
  };
  // killed by a signal: 128 + its number, like a shell (143 SIGTERM, 137 SIGKILL)
  const codeOf = (code, sig) => code ?? (sig ? 128 + (os.constants.signals[sig] ?? 15) : 1);
  child.on("error", (e) => end(e.code === "ENOENT" ? 127 : 1, `${cmd}: ${e.message}`));
  child.on("exit", (code, sig) => { grace = setTimeout(() => end(codeOf(code, sig), "", sig), 2000); });
  child.on("close", (code, sig) => end(codeOf(code, sig), "", sig));
  return child;
}

// A worker CLI that died by a signal ekip did not send: say so in the log with the likely cause.
const killNote = (sig, code, dog) => (sig && !dog.why() && !stopping ? `[ekip] işçi ${sig} sinyaliyle öldü (çıkış ${code}); olası neden: ${killCause(code)}` : "");

function runChild(cmd, argv, opts, logFile) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`$ ${cmd} ${argv.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)).join(" ")}\n`);
    let out = "";
    const child = spawnWorker(cmd, argv, opts, (code, note, sig) => {
      dog.stop(); note = [note, killNote(sig, code, dog)].filter(Boolean).join("\n"); if (note) { out += `\n${note}`; log.write(`\n${note}`); }
      if (dog.why()) { code = 124; out += `\n${dog.why()}`; }
      log.end(`\n[exit ${code}]\n`); resolve({ code, out, signal: dog.why() ? null : sig });
    });
    const dog = watchdog(child, log);
    child.stdout.on("data", (d) => { dog.alive(); out += d; log.write(d); });
    child.stderr.on("data", (d) => { dog.alive(); out += d; log.write(d); });
  });
}

// Workers that can stream JSON events (agy, claude) are run that way: the log gets one readable
// line per tool call plus the text as it is written (so `ekip watch` shows the work live), and the
// final report is the last answer, not the whole event stream.
const brief = (o) => {
  if (!o || typeof o !== "object") return String(o ?? "");
  const v = o.CommandLine ?? o.command ?? o.file_path ?? o.AbsolutePath ?? o.TargetFile ?? o.path ?? o.pattern ?? o.Query ?? o.query ?? o.url ?? o.description ?? Object.values(o).find((x) => typeof x === "string") ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 160);
};

function runStream(cmd, argv, opts, logFile, kind) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`$ ${cmd} ${argv.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)).join(" ")}\n\n`);
    let buf = "", raw = "", final = "", lastStep = -1, steps = new Map(), loggedModel = false;
    const child = spawnWorker(cmd, argv, opts, (code, note, sig) => {
      dog.stop(); note = [note, killNote(sig, code, dog)].filter(Boolean).join("\n"); if (note) { raw += `\n${note}`; log.write(`\n${note}`); }
      if (dog.why()) { code = 124; raw += `\n${dog.why()}`; }
      if (kind === "agy" && steps.size) final = [...steps.entries()].sort((a, b) => a[0] - b[0]).at(-1)[1];
      log.end(`\n\n[exit ${code}]\n`);
      resolve({ code, out: final.trim() ? final : raw, signal: dog.why() ? null : sig });
    });
    const onEvent = (e) => {
      const reportedModel = e.model ?? e.response?.model ?? e.message?.model ?? e.data?.model;
      if (!loggedModel && typeof reportedModel === "string" && reportedModel.length < 200) { log.write(`model: ${reportedModel}\n`); loggedModel = true; }
      if (kind === "agy" && e.event === "step_update") {
        const u = e.step_update;
        if (u.step_type === "tool" && u.state === "ACTIVE" && u.tool_name) log.write(`\n▸ ${u.tool_name}: ${brief(u.tool_info?.parameters)}\n`);
        if (u.step_type === "agent_response" && u.text_delta) {
          if (u.step_index !== lastStep) { log.write("\n"); lastStep = u.step_index; }
          steps.set(u.step_index, (steps.get(u.step_index) ?? "") + u.text_delta);
          log.write(u.text_delta);
        }
      } else if (kind === "claude") {
        if (e.type === "assistant") for (const b of e.message?.content ?? []) {
          if (b.type === "tool_use") log.write(`\n▸ ${b.name}: ${brief(b.input)}\n`);
          else if (b.type === "text" && b.text.trim()) log.write(`\n${b.text}\n`);
        } else if (e.type === "result") final = e.result ?? "";
      }
    };
    const dog = watchdog(child, log);
    child.stdout.on("data", (d) => {
      dog.alive(); raw += d; buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { onEvent(JSON.parse(line)); } catch { if (line.trim()) log.write(`${line}\n`); }
      }
    });
    child.stderr.on("data", (d) => { dog.alive(); raw += d; log.write(d); });
  });
}

// A run that exited 0 but only reports a quota failure counts as failed, so auto moves on; a short
// successful report that merely mentions "429" or "quota" does not. LIMIT_RE (broad) only reads
// the output of runs that already failed.
const LIMIT_RE = /quota|rate.?limit|resource.?exhausted|usage limit|limit reached|too many requests|\b429\b|not logged in|unauthori[sz]ed|overloaded_error|no_providers_configured/i;
// A short answer that only announces work ("I'll run…", a bare tool call) is a worker that stopped
// before doing the task (qwen did this on 30 Oct and the run counted as done).
const stoppedEarly = (out) => out.trim().length < 500 && /\[tool_call|^\s*(I'll|I will|Let me|Şimdi|Önce)\b/im.test(out) && !/\b(done|fixed|changed|verified|report|bitti|tamam|değiştir)/i.test(out);
const failed = (r) => r.code !== 0 || !r.out.trim() || stoppedEarly(r.out) || (r.out.length < 600 && QUOTA.some((re) => re.test(r.out)));

// --plugin NAME: an installed Claude Code plugin; --skill NAME: a project or user skill,
// wrapped as a one-skill plugin so --bare sessions can load it with --plugin-dir.
function localSkillPath(o, name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") return null;
  const project = registry().find((p) => p.name === o.project) ?? registry().filter((p) => o.cwd === p.path || o.cwd.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  const root = project?.path ?? o.cwd;
  const roots = [root];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") roots.push(path.join(root, entry.name));
    }
  } catch { /* a missing project root has no local skills */ }
  return roots.map((dir) => path.join(dir, ".claude", "skills", name)).find((dir) => fs.existsSync(path.join(dir, "SKILL.md"))) ?? null;
}

function pluginDirs(o) {
  const dirs = [];
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude/plugins/installed_plugins.json"), "utf8")).plugins ?? {}; } catch { /* none */ }
  for (const name of o.plugins) {
    const hit = Object.entries(installed).find(([k]) => k === name || k.split("@")[0] === name);
    if (!hit) die(`no installed plugin named ${name}`);
    dirs.push([hit[1]].flat()[0].installPath);
  }
  for (const name of o.skills) {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") die(`bad skill name ${name}`);
    const src = localSkillPath(o, name) ?? path.join(os.homedir(), ".claude/skills", name);
    if (!fs.existsSync(path.join(src, "SKILL.md"))) die(`no project-local or user skill named ${name}`);
    const pack = path.join(HOME, "skillpacks", `${name}-${Buffer.from(src).toString("base64url").slice(0, 16)}`);
    fs.mkdirSync(path.join(pack, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pack, "skills"), { recursive: true });
    fs.writeFileSync(path.join(pack, ".claude-plugin/plugin.json"), JSON.stringify({ name: `skill-${name}`, version: "0.0.0", description: `ekip wrapper for the ${name} skill` }));
    const link = path.join(pack, "skills", name);
    if (!fs.existsSync(link)) fs.symlinkSync(src, link);
    dirs.push(pack);
  }
  return dirs.flatMap((d) => ["--plugin-dir", d]);
}

// Where a --plugin / --skill lives on disk, so agents that cannot load Claude plugins can still read
// and follow the skill (a skill is markdown instructions plus scripts).
function skillDocs(o) {
  const docs = [];
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude/plugins/installed_plugins.json"), "utf8")).plugins ?? {}; } catch { /* none */ }
  for (const name of o.plugins) {
    const hit = Object.entries(installed).find(([k]) => k === name || k.split("@")[0] === name);
    const root = hit && [hit[1]].flat()[0].installPath;
    // the plugin's main SKILL.md (its own name) first, shallow ones next; a big plugin lists dozens
    const rank = (f) => (path.basename(path.dirname(f)) === name.split("@")[0] ? 0 : 1);
    if (root) docs.push(...spawnSync("find", [root, "-maxdepth", "4", "-name", "SKILL.md"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)
      .sort((a, b) => rank(a) - rank(b) || a.split("/").length - b.split("/").length || a.localeCompare(b)));
  }
  for (const name of o.skills) {
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") continue;
    const src = localSkillPath(o, name) ?? path.join(os.homedir(), ".claude/skills", name);
    const f = path.join(src, "SKILL.md");
    if (fs.existsSync(f)) docs.unshift(fs.realpathSync(f));
  }
  return docs.slice(0, 6);
}

async function runVia(via, o, logFile) {
  const docs = AGENTS[via] ? skillDocs(o) : [];
  // the project's learned skills come with projectKnowledge (added once to the brief); listing them
  // here as well sent the same descriptions twice
  const procs = "";
  const prompt = `${workerBrief(o.cwd)}\n${procs}${docs.length ? `Before you start, read these skill instructions completely and follow them (paths in them are relative to each file's folder):\n${docs.map((d) => `- ${d}`).join("\n")}\n\n` : ""}${o.task}`;
  if (AGENTS[via]) {
    const a = AGENTS[via];
    if (!has(a.bin)) return { code: 127, out: `${a.bin} is not installed (ekip agents install ${via})` };
    if (a.free) await up({ quiet: true, soft: true });
    const model = o.model ?? (via === "agy" ? process.env.EKIP_AGY_MODEL : null);
    if (via === "agy") return runStream(a.bin, [...a.argv(prompt, { ...o, model }), "--output-format", "stream-json"], { cwd: o.cwd }, logFile, "agy");
    const r = await runChild(a.bin, a.argv(prompt, { ...o, model }), { cwd: o.cwd, env: { ...process.env, ...(a.env ?? {}) } }, logFile);
    return a.parse ? { ...r, out: a.parse(r.out) || r.out } : r;
  }
  if (!has("claude")) return { code: 127, out: "claude is not installed" };
  if (via === "claude") {
    // Your own subscription with your full setup (skills, plugins, MCP): for the hard parts.
    const argv = ["-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", ...pluginDirs(o)];
    if (o.model) argv.push("--model", o.model);
    return runStream("claude", argv, { cwd: o.cwd }, logFile, "claude");
  }
  const env = await freeEnv(o.project, { soft: true });
  env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (o.model) Object.assign(env, { ANTHROPIC_MODEL: o.model, ANTHROPIC_DEFAULT_SONNET_MODEL: o.model, ANTHROPIC_DEFAULT_OPUS_MODEL: o.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: o.model });
  // --bare: no user hooks, plugins or memory, so the free models get a small, plain context.
  const argv = ["--bare", "-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", ...pluginDirs(o)];
  return runStream("claude", argv, { cwd: o.cwd, env }, logFile, "claude");
}

const git = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

// A heavy run (local render, encode) first takes a machine slot (lib/workers/slots.js) and waits in
// line while none is free; the task shows "queued (n)". A worker killed by a signal is restarted
// once with --retry-on-kill, after the load has come down.
async function runOne(o, via, id) {
  const tasks = o.taskId ? await import("../lib/tasks/tasks.js") : null;
  let release = null;
  if (o.heavy ?? (await import("../lib/workers/slots.js")).looksHeavy(o.task)) {
    const slots = await import("../lib/workers/slots.js");
    release = await slots.acquire(id, { onWait: ({ position, reason, holders }) => {
      const why = reason === "load" ? t("makine yükü çok yüksek") : t("{n} ağır iş çalışıyor (sınır {max})", { n: holders, max: slots.maxHeavy() });
      say(`${t("kuyrukta (sıra {n})", { n: position })} · ${why}`);
      tasks?.holdWorker(o.taskId, { runId: id, via, label: o.label ?? null, pid: process.pid }, { status: "queued", queue: position, why });
    } });
  }
  try {
    let r = await runOneTracked(o, via, id, tasks);
    if (!r.ok && r.killed && o.retryOnKill && !stopping) {
      const slots = await import("../lib/workers/slots.js");
      warn(t("işçi sinyalle öldü; yük düşünce bir kez yeniden başlatılıyor"));
      await slots.calm();
      const again = `${new Date().toISOString().replace(/[:.]/g, "-")}-${via}`;
      r = await runOneTracked({ ...o, task: `${RESUME_NOTE}${o.task}` }, via, again, tasks);
    }
    return r;
  } finally { release?.(); }
}

async function runOneTracked(o, via, id, tasks) {
  const r = await runOneInner(o, via, id);
  try { (await import("../lib/projects/skillgen.js")).recordRunFinish({ runId: id, project: o.project, via: r.via ?? via, label: o.label, brief: o.task, status: r.ok ? "done" : "failed" }); } catch { /* usage logging must never affect a run */ }
  activeRuns.delete(id);
  const why = r.ok ? null : r.out.match(/\d+ dk (sessiz kaldı|sınırını aştı), durduruldu/)?.[0] ?? r.out.match(/\[ekip\] (işçi SIG\w+ sinyaliyle öldü[^\n]*)/)?.[1] ?? r.stopped ?? "başarısız oldu";
  // a finished worker's report gives the task its result (first paragraph, up to three links) until the lead writes its own
  const result = r.ok && tasks ? tasks.autoResult(o.taskId, r.out, o.label) : null;
  tasks?.endWorker(o.taskId, id, r.ok ? "done" : r.killed ? "killed" : "failed", why ?? (result ? t("bitti, sonuç göreve yazıldı; lead inceliyor") : null), r.model, r.via);
  return r;
}

// Runs of this process, so a stop signal can still report them: a killed worker used to stay
// "running" on the hub forever.
const activeRuns = new Map();
let stopHandler = false, stopping = false;
function onStop() {
  if (stopHandler) return;
  stopHandler = true;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, async () => {
    stopping = true;
    for (const child of liveKids) killTree(child, "SIGTERM");
    for (const [id, r] of activeRuns) {
      try { fs.appendFileSync(path.join(RUNS, `${id}.log`), `\n[exit 143] durduruldu (${sig})\n`); } catch { /* gone */ }
      // the task must not keep a ghost "running" worker: say who stopped it and how
      if (r.taskId) { try { (await import("../lib/tasks/tasks.js")).endWorker(r.taskId, id, "cancelled", `${sig} ${t("sinyaliyle durduruldu")}`, r.model, r.via); } catch { /* task gone */ } }
      try { (await import("../lib/projects/skillgen.js")).recordRunFinish({ runId: id, project: r.project, via: r.via, label: r.label, brief: r.task, status: "cancelled" }); } catch { /* usage logging must never affect shutdown */ }
      await postRun({ ...r, status: "cancelled", report: "durduruldu", finishedAt: new Date().toISOString() });
      await uploadRunLog(id, path.join(RUNS, `${id}.log`));
    }
    const { pending } = await import("../lib/tasks/tasks.js");
    await Promise.race([Promise.allSettled([...pending]), sleep(4000)]);
    for (const child of liveKids) killTree(child, "SIGKILL");
    process.exit(143);
  });
}

// Runs whose process died without a word (killed hard, machine slept, terminal closed): their log
// has no [exit] line and their pid is gone. Close them in the log and on the hub.
export async function reconcileRuns() {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let files = [];
  try { files = fs.readdirSync(RUNS).filter((f) => f.endsWith(".log")); } catch { return 0; }
  let n = 0;
  const synced = runsSynced(), logs = logsSynced(), uploaded = [];
  for (const f of files) {
    const file = path.join(RUNS, f);
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs > 7 * 86400_000) continue;
    const tail = (() => { const fd = fs.openSync(file, "r"); const len = Math.min(st.size, 4096); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd); return b.toString("utf8"); })();
    const exit = tail.match(/\[exit (-?\d+)\][^\n]*\s*$/)?.[1];
    if (exit != null && SETTINGS.hubUrl && !logs.has(f.slice(0, -4)) && await uploadRunLog(f.slice(0, -4), file)) uploaded.push(f.slice(0, -4));
    if (exit != null) {
      if (SETTINGS.hubUrl && !synced.has(f.slice(0, -4))) {
        const head = fs.readFileSync(file, "utf8").slice(0, 4000);
        const id = f.slice(0, -4), project = head.match(/^project: (.*)$/m)?.[1];
        await postRun({ id, via: id.split("Z-")[1] ?? null, model: modelFromLog(file), project: project && project !== "-" ? project : null,
          task: head.match(/^task:\n([\s\S]*?)(?=\n\n|$)/m)?.[1] ?? "", status: exit === "0" ? "done" : "failed",
          report: tail.replace(/\n\[exit[\s\S]*$/, "").trim().slice(-1500), finishedAt: st.mtime.toISOString() });
      }
      continue;
    }
    const head = fs.readFileSync(file, "utf8").slice(0, 4000);
    const pid = Number(head.match(/^pid: (\d+)$/m)?.[1]) || null;
    // logs from before pids were written: only when quiet for 3 hours
    if (pid ? alive(pid) : Date.now() - st.mtimeMs < 3 * 3600_000) continue;
    const id = f.slice(0, -4);
    fs.appendFileSync(file, "\n[exit 143] durduruldu (süreç kayıp)\n");
    const project = head.match(/^project: (.*)$/m)?.[1];
    const task = head.match(/^task:\n([\s\S]*?)(?=\n\n(?:\$ |▸ |\[exit)|$)/m)?.[1] ?? "";
    const label = head.match(/^label: (.*)$/m)?.[1];
    const via = id.split("Z-")[1] ?? null;
    await postRun({ id, via, model: modelFromLog(file), project: project && project !== "-" ? project : null,
      task, status: "cancelled", report: "durduruldu (süreç kayıp)", finishedAt: st.mtime.toISOString() });
    try { (await import("../lib/projects/skillgen.js")).recordRunFinish({ runId: id, via, project: project && project !== "-" ? project : null, label, brief: task, status: "cancelled" }); } catch { /* usage logging must never affect reconciliation */ }
    n++;
  }
  markLogsSynced(uploaded);
  return n;
}

// Project knowledge reaches every worker whether or not the lead remembered to look it up: the
// project's own skills and memories that match the brief are appended to it. ekip's housekeeping
// runs (cards, review profiles, the skill learner) are left alone.
// Each brief is also logged to the knowledge usage log (ekip stats), with where the run's log
// output starts so that a worker opening a listed SKILL.md can be told apart from the brief itself.
async function projectKnowledge(o, runId) {
  if (/^(proje kartı: |review-|skill-learn)/.test(o.label ?? "")) return "";
  const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r([]), ms))]);
  const timed = async (p) => { const t0 = Date.now(); const value = await p; return { value, ms: Date.now() - t0 }; };
  const usage = await import("../lib/memory/usage.js").catch(() => null);
  let logFrom;
  try { logFrom = fs.statSync(path.join(RUNS, `${runId}.log`)).size; } catch { /* no log yet */ }
  const base = { source: "worker-brief", project: o.project, query: o.task.slice(0, 600), runId, taskId: o.taskId, logFrom };
  try {
    const mem = await import("../lib/memory/memory.js");
    const { redact } = await import("../lib/core/redact.js");
    const q = o.task.slice(0, 600);
    const general = o.project === "genel";
    const proj = general ? null : (await import("../lib/projects/projects.js")).getProject(o.project);
    const [skillsT, factsT, wikiT] = await Promise.all([
      timed(timeout(mem.skillSearch(o.project, q, 3).catch(() => []), 6000)),
      timed(timeout(mem.recall(o.project, q, 6, { timeoutMs: 6000, factsOnly: true }).catch(() => []), 7000)),
      proj?.tdai?.wikiId ? timed(timeout(mem.knowledgeTool(proj.tdai.wikiId, "search", { query: q.slice(0, 300), limit: 3 }).catch(() => null), 6000)) : null,
    ]);
    const [skills, facts, wiki] = [skillsT.value ?? [], factsT.value ?? [], wikiT?.value ?? null];
    const lines = [];
    // lessons first, whatever the brief is about: they are what the user already had to correct
    const projectLessons = proj ? (await import("../lib/projects/project-config.js")).lessons(proj) : "";
    if (projectLessons) lines.push("Lessons from this project (mistakes the user corrected before; never repeat them):", projectLessons);
    const projectRules = proj ? (await import("../lib/projects/project-config.js")).rules(proj) : "";
    if (projectRules) lines.push("Project rules (.ekip/rules.md), follow them:", projectRules);
    // the project's own process skills (<project>/.claude/skills), ranked by word overlap with the brief
    const local = proj ? (await import("../lib/projects/project-skills.js")).projectSkills(proj.path, q).slice(0, 4) : [];
    if (local.length) lines.push("Project process skills: read the SKILL.md of each one that fits before you start, and follow it:", ...local.map((k) => `- ${k.name}: ${k.description.slice(0, 180)} (${k.file})`));
    if (skills.length) lines.push("Project skills that may apply (read one with: ekip skill show " + o.project + " <name>):", ...skills.map((k) => `- ${k.name}: ${String(k.description ?? "").slice(0, 200)}`));
    // corrections the user made come before other facts
    facts.sort((a, b) => /^Lesson \(the user corrected/.test(String(b.content ?? b)) - /^Lesson \(the user corrected/.test(String(a.content ?? a)));
    if (facts.length) lines.push("Known facts and decisions from this project's memory (verify before relying on them):", ...facts.map((f) => `- ${String(f.content ?? f).replace(/\s+/g, " ").slice(0, 300)}`));
    const pages = (Array.isArray(wiki) ? wiki : wiki?.results ?? wiki?.items ?? wiki?.data ?? []).slice(0, 3);
    if (pages.length) lines.push("Project wiki pages that match (read with the wiki_read MCP tool):", ...pages.map((w) => `- ${String(w.title ?? w.ref ?? w.path ?? w.id ?? "").slice(0, 120)}${w.snippet ? `: ${String(w.snippet).replace(/\s+/g, " ").slice(0, 160)}` : ""}`));
    usage?.recordUse({ ...base, kind: "memory", hits: facts.length, ms: factsT.ms });
    usage?.recordUse({ ...base, kind: "skill", hits: skills.length, names: skills.map((k) => k.name), ms: skillsT.ms });
    if (wikiT) usage?.recordUse({ ...base, kind: "wiki", hits: pages.length, names: pages.map((w) => String(w.title ?? w.ref ?? w.path ?? w.id ?? "")), ms: wikiT.ms });
    usage?.recordUse({ ...base, kind: "local-skill", hits: local.length, skills: local });
    // the lessons are on top and get room of their own on top of the usual 3,000 characters
    return lines.length ? redact(`\n\n## ${general ? "Knowledge from earlier work outside projects" : "Project knowledge"} (ekip memory, added automatically)\n${lines.join("\n")}`).slice(0, 3000 + projectLessons.length) : "";
  } catch (e) { usage?.recordUse({ ...base, kind: "memory", hits: 0, error: e?.message }); return ""; /* memory down: the worker still gets the brief */ }
}

async function runOneInner(o, via, id) {
  process.env.EKIP_PARENT_RUN = id;
  const logFile = path.join(RUNS, `${id}.log`);
  if (o.taskId) (await import("../lib/tasks/tasks.js")).linkWorker(o.taskId, { runId: id, via, model: o.model ?? null, label: o.label ?? null, log: logFile, pid: process.pid });
  fs.writeFileSync(logFile, `cwd: ${o.cwd}\nproject: ${o.project ?? "-"}\nlabel: ${o.label ?? "-"}\ntaskId: ${o.taskId ?? "-"}\npid: ${process.pid}\ntask:\n${o.task}\n\n`);
  if (o.project) {
    const { SETTINGS } = await import("../lib/core/core.js");
    if (SETTINGS.dev?.projects?.[o.project]) o.task += `\n\nDevelopment DB/redis: source ${path.join((await import("../lib/projects/projects.js")).getProject(o.project)?.path ?? o.cwd, ".env.ekip-dev")}; never use production DATABASE_URL.`;
    if (!o.knowledgeAdded) { o.knowledgeAdded = true; o.task += await projectKnowledge(o, id); }
  } else if (!o.knowledgeAdded) {
    // outside registered projects: what the general space remembers (one-off work, unregistered repos)
    o.knowledgeAdded = true; o.task += await projectKnowledge({ ...o, project: "genel" }, id);
  }
  try { (await import("../lib/projects/skillgen.js")).recordRunStart({ project: o.project, label: o.label, via, brief: o.task, runId: id, skills: o.skills }); } catch { /* usage logging must never affect a run */ }
  await postRun({ id, via, project: o.project, task: o.task, model: o.model ?? null, status: "running", report: "" });
  activeRuns.set(id, { id, via, project: o.project, task: o.task, label: o.label, model: o.model ?? null, logFile, taskId: o.taskId ?? null });
  const upload = () => uploadRunLog(id, logFile);
  const uploadTimer = setInterval(upload, 60_000); uploadTimer.unref();
  onStop();
  // Show the worker live in its own terminal window (off with --no-watch or "watch": false).
  if ((o.watch ?? SETTINGS.watch ?? true) && process.platform === "darwin") openPane(`${JSON.stringify(path.join(ROOT, "plugin/bin/ekip.js"))} watch ${JSON.stringify(logFile)}`, { title: `ekip · ${o.label ?? via}` });
  // --min-tier strong / --no-fallback-free: pools the run may fall back to (a pool asked for by name always runs)
  const allowed = (v) => v === via || ((o.minTier !== "strong" || isStrong(v)) && (!o.noFallbackFree || !onFreePool(v)));
  const order = (via === "auto" ? autoOrder() : [via]).filter(allowed);
  if (!order.length) { clearInterval(uploadTimer); fs.appendFileSync(logFile, "\n[exit 1] uygun havuz yok\n"); return { ok: false, via, out: t("--min-tier/--no-fallback-free ile uygun havuz yok (ekip agents)"), logFile, model: null }; }
  const tasks = o.taskId ? await import("../lib/tasks/tasks.js") : null;
  const when = (iso) => new Date(iso).toLocaleString(lang === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let last = null, lastVia = via, idleRuns = [], stopped = null;
  for (let i = 0; i < order.length; i++) {
    const v = order[i];
    say(`${c.bold(v, process.stderr)} ${t("çalışıyor")} ${c.gray(`· ${o.project ?? o.cwd} · log ${logFile}`, process.stderr)}`);
    // which pool this run is on, so other `--via auto` runs see it as busy
    fs.appendFileSync(logFile, poolMark(v));
    const t0 = Date.now();
    try { last = await runVia(v, o, logFile); } catch (e) { last = { code: 1, out: String(e?.message ?? e) }; }
    lastVia = v;
    const ok = !failed(last);
    recordStat(v, ok, Date.now() - t0);
    if (stopping) break;
    if (ok) { clearLimit(v); clearInterval(uploadTimer); const model = o.model ?? modelFromLog(logFile); await upload(); return { ok: true, via: v, out: last.out.trim(), logFile, model }; }
    warn(`${c.bold(v, process.stderr)} ${t("başarısız")} (exit ${last.code}): ${c.gray(last.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300), process.stderr)}`);
    // a quota message with its reopen time goes into the pool state, so `ekip agents` and auto see it
    const quota = quotaInfo(last.out.slice(-4000));
    if (quota) recordLimit(v, quota);
    // A pool asked for by name that is out of quota hands the task on instead of failing it: the
    // next pools of the auto order (limited ones are already left out; never the headless Claude)
    if (via !== "auto" && i === order.length - 1 && LIMIT_RE.test(last.out.slice(-4000))) {
      const rest = autoOrder().filter((x) => !order.includes(x) && x !== "claude" && allowed(x));
      if (rest.length) { warn(`${c.bold(v, process.stderr)} ${t("kotası dolu; sıradaki havuza geçiliyor")}: ${rest.join(" → ")}`); order.push(...rest); }
    }
    // A pool that went silent until the watchdog stopped it says the brief is too much for the
    // pools after it that are weaker: they are dropped, and a second silent pool in a row ends the
    // chain with the task blocked, instead of four pools idling 15 minutes each.
    if (last.code === 124 && /sessiz kaldı/.test(last.out)) {
      idleRuns.push(v);
      const rest = order.slice(i + 1), strong = rest.filter(isStrong);
      order.splice(i + 1, order.length, ...strong);
      if (idleRuns.length >= 2 || (rest.length && !strong.length)) {
        stopped = t("{pools} sessiz kalıp durduruldu; zayıf havuzlar bu işte başarısız sayıldı. Brief'i bölün ya da güçlü bir havuz seçin (--via, --min-tier strong)", { pools: idleRuns.join(", ") });
        break;
      }
    } else idleRuns = [];
    const next = order[i + 1];
    if (next && o.taskId) {
      const why = quota ? t("{pool} kotası bitti (yenilenme: {at})", { pool: v, at: when(quota.resetAt) }) : last.code === 124 ? `${v}: ${last.out.match(/\d+ dk (sessiz kaldı|sınırını aştı)/)?.[0] ?? t("durduruldu")}` : t("{pool} başarısız (çıkış {code})", { pool: v, code: last.code });
      const dropped = last.code === 124 && /sessiz kaldı/.test(last.out) ? ` · ${t("zayıf havuzlar atlandı")}` : "";
      tasks.note(o.taskId, `${why} → ${t("{pool} havuzuna geçildi", { pool: next })}${dropped}`);
    }
  }
  if (stopped && o.taskId) tasks.hold(o.taskId, "blocked", stopped, null, { alert: true });
  else if (stopped) notify("ekip", stopped, { subtitle: o.label ?? o.project ?? "" });
  clearInterval(uploadTimer); const model = o.model ?? modelFromLog(logFile); await upload();
  // a failed run belongs to the last pool tried ("auto" is only the requested mode)
  return { ok: false, via: lastVia, out: `${last?.out.trim() ?? ""}${stopped ? `\n${stopped}` : ""}`, logFile, model, killed: !!last?.signal && !stopping, stopped };
}

function modelFromLog(file) {
  try { return fs.readFileSync(file, "utf8").match(/^\s*model\s*:\s*([^\r\n]{1,160})/im)?.[1]?.trim() ?? fs.readFileSync(file, "utf8").match(/"model"\s*:\s*"([^"\r\n]{1,160})"/)?.[1] ?? null; } catch { return null; }
}
async function uploadRunLog(id, file) {
  const { redact } = await import("../lib/core/redact.js");
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return;
  try {
    const st = fs.statSync(file), len = Math.min(st.size, 64 * 1024), fd = fs.openSync(file, "r"), b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
    const log = redact(b.toString("utf8").replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""));
    const r = await fetch(`${SETTINGS.hubUrl}/api/runs/${encodeURIComponent(id)}/log`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` }, body: JSON.stringify({ log }), signal: AbortSignal.timeout(8000) }).catch(() => null);
    return !!r?.ok;
  } catch { return false; /* log delivery is best effort */ }
}

// Finished runs whose final log tail reached the hub; reconcileRuns uploads the rest (runs from
// before log upload existed, or whose upload failed), so every run on the panel has its log.
const LOGS_SYNCED = () => path.join(HOME, "logs-synced.json");
const logsSynced = () => { try { return new Set(JSON.parse(fs.readFileSync(LOGS_SYNCED(), "utf8"))); } catch { return new Set(); } };
function markLogsSynced(ids) {
  if (!ids.length) return;
  const s = logsSynced();
  for (const id of ids) s.add(id);
  try { fs.writeFileSync(LOGS_SYNCED(), JSON.stringify([...s].slice(-2000))); } catch { /* best effort */ }
}

// Serialize sibling workers' count updates with an atomic directory lock.
function reserveChildRun(parentId, limit) {
  const dir = path.join(HOME, "run-children");
  const safeId = parentId.replace(/[^A-Za-z0-9._-]/g, "_");
  const file = path.join(dir, `${safeId}.count`), lock = `${file}.lock`;
  fs.mkdirSync(dir, { recursive: true });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const until = Date.now() + 5000;
  while (true) {
    try { fs.mkdirSync(lock); break; }
    catch (e) { if (e.code !== "EEXIST" || Date.now() >= until) throw new Error("çocuk işçi sayacı kilitlenemedi"); Atomics.wait(wait, 0, 0, 20); }
  }
  try {
    let count = 0; try { count = Number(fs.readFileSync(file, "utf8")) || 0; } catch {}
    if (count >= limit) return false;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, String(count + 1)); fs.renameSync(tmp, file);
    return true;
  } finally { fs.rmdirSync(lock); }
}

async function run(args) {
  const allowNested = args.includes("--allow-nested");
  args = args.filter((a) => a !== "--allow-nested");
  const depth = Number(process.env.EKIP_RUN_DEPTH ?? 0);
  if (depth >= 2 && !allowNested) die("İç içe işçi sınırı: --allow-nested ile açıkça izin verin.");
  // a run that waited in the background (--after/--when) was already counted by the process that queued it
  if (depth > 0 && !allowNested && !process.env.EKIP_QUEUED) {
    const parent = process.env.EKIP_PARENT_RUN ?? "unknown";
    if (!reserveChildRun(parent, Number(SETTINGS.maxChildRuns ?? 6))) die("Bu üst işçi için çocuk çalıştırma sınırı doldu; testleri --dry-run veya mock ile yapın.");
  }
  const o = parseRun(args);
  process.env.EKIP_RUN_DEPTH = String(depth + 1);
  process.env.EKIP_PARENT_RUN = process.env.EKIP_PARENT_RUN || `${Date.now()}-${process.pid}`;
  await reconcileRuns().catch(() => {});
  // --after / --when: the run waits for its condition in a background process of its own, so it
  // starts even when the lead's turn (or terminal) is over; the task shows what it waits for.
  if ((o.after || o.when) && !o.foreground && !process.env.EKIP_QUEUED) return queueInBackground(o, args);
  if (o.after || o.when) { const ok = await waitForCondition(o); if (!ok) return 1; }
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${o.vias.join("+")}`;
  // --worktree: one pool, but on its own branch like a race, so a worker that edits code that is
  // running right now (ekip itself, a dev server) cannot break it halfway through
  if (o.vias.length === 1 && !o.worktree) {
    const r = await runOne(o, o.vias[0], id);
    process.stdout.write(`[ekip worker: ${r.ok ? r.via : "all pools failed"}]\n${r.out}\n`);
    await report({ id, via: r.via, model: r.model, project: o.project, task: o.task, status: r.ok ? "done" : "failed", report: r.out.slice(-4000) });
    return r.ok ? 0 : 1;
  }
  // Several pools on the same task: each gets its own git worktree and branch, so they cannot
  // collide; you (or the lead) compare the branches and merge the best one.
  const top = git(o.cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (!top) die("--worktree and several pools need a git repository (each run gets its own worktree)");
  const short = id.slice(0, 19).replace(/[^0-9]/g, "");
  const results = await Promise.all(o.vias.map(async (via) => {
    const branch = `ekip/${short}-${via}`;
    const dir = path.join(HOME, "worktrees", short, via);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const wt = git(top, ["worktree", "add", "-b", branch, dir, "HEAD"]);
    if (wt.status !== 0) return { via, branch, ok: false, out: wt.stderr.trim() };
    const sub = path.relative(top, o.cwd);
    const r = await runOne({ ...o, cwd: path.join(dir, sub) }, via, `${id}-${via}`);
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "user.name=ekip", "-c", "user.email=ekip@localhost", "commit", "-qm", `ekip ${via}: ${o.task.split("\n")[0].slice(0, 60)}`]);
    const stat = git(top, ["diff", "--stat", `HEAD...${branch}`]).stdout.trim();
    return { ...r, via, branch, dir, stat };
  }));
  for (const r of results) {
    process.stdout.write(`\n=== ${r.via} (${r.ok ? "done" : "FAILED"}) branch ${r.branch}${r.dir ? `, worktree ${r.dir}` : ""}\n${r.stat || "(no changes)"}\n--- report\n${r.out.slice(-3000)}\n`);
    await report({ id: `${id}-${r.via}`, via: r.via, model: r.model, project: o.project, task: o.task, status: r.ok ? "done" : "failed", report: r.out.slice(-4000) });
  }
  process.stdout.write(`\nCompare: git diff HEAD...<branch>. Keep one: git merge <branch>. Clean up: ekip clean ${short}\n`);
  return results.some((r) => r.ok) ? 0 : 1;
}

// The background copy of a run with --after/--when: same options, the brief in a file (stdin is
// gone by then), its stdout in data/queued/. Prints where to look and returns at once.
function queueInBackground(o, args) {
  const dir = path.join(HOME, "queued");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const briefFile = path.join(dir, `${stamp}.brief`), outFile = path.join(dir, `${stamp}.out`);
  fs.writeFileSync(briefFile, o.task);
  // the brief goes by file: drop the task words, "-" and an earlier --brief-file / --resume from the args
  const keep = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (["--brief-file", "--resume"].includes(a)) { i++; continue; }
    if (a === "-" || !a.startsWith("--")) { if (i > 0 && TAKES_VALUE.includes(args[i - 1])) keep.push(a); continue; }
    keep.push(a);
  }
  const fd = fs.openSync(outFile, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run", ...keep, "--brief-file", briefFile, ...(o.taskId && !keep.includes("--task") ? ["--task", o.taskId] : []), ...(o.label && !keep.includes("--label") ? ["--label", o.label] : []), ...(!keep.includes("--cwd") && !keep.includes("--project") ? ["--cwd", o.cwd] : [])],
    // the depth this process had: the queued copy counts itself again when it starts
    { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, EKIP_QUEUED: "1", EKIP_RUN_DEPTH: String(Math.max(0, Number(process.env.EKIP_RUN_DEPTH ?? 1) - 1)) } });
  child.unref();
  console.log(t("kuyruğa alındı: {what} başlar (pid {pid}); rapor: {out}", { what: conditionText(o), pid: child.pid, out: outFile }));
  return 0;
}
const conditionText = (o) => [o.after && t("{ref} bitince", { ref: o.after }), o.when && t("`{cmd}` başarılı olunca", { cmd: o.when })].filter(Boolean).join(t(" ve "));
const TAKES_VALUE = ["--via", "--cwd", "--model", "--plugin", "--skill", "--project", "--task", "--label", "--min-tier", "--after", "--when"];

// --after ID: a task (ekip task new) or a run (its log name in data/runs) that has to finish well.
function afterState(ref) {
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(path.join(HOME, "tasks.json"), "utf8")); } catch { /* none */ }
  const task = tasks.find((x) => x.id === ref);
  if (task) return task.status === "done" ? "done" : task.status === "running" ? "pending" : "failed";
  const name = path.basename(ref).replace(/\.log$/, "");
  let file = path.join(RUNS, `${name}.log`);
  if (!fs.existsSync(file)) { const hit = fs.readdirSync(RUNS).filter((f) => f.startsWith(name) && f.endsWith(".log")).sort().at(-1); if (!hit) return "unknown"; file = path.join(RUNS, hit); }
  const text = fs.readFileSync(file, "utf8");
  const exit = text.match(/\n\[exit (-?\d+)\][^\n]*\s*$/)?.[1];
  if (exit != null) return exit === "0" ? "done" : "failed";
  const pid = Number(text.match(/^pid: (\d+)$/m)?.[1]);
  try { process.kill(pid, 0); return "pending"; } catch { return "failed"; }
}

/** Waits until --after / --when holds (checked every 30 s, at most "waitMaxH" hours, default 24). */
async function waitForCondition(o) {
  const what = conditionText(o);
  const tasks = o.taskId ? await import("../lib/tasks/tasks.js") : null;
  const waitId = `wait-${process.pid}`;
  tasks?.holdWorker(o.taskId, { runId: waitId, via: o.via, label: o.label ?? null, pid: process.pid }, { status: "waiting", why: what });
  tasks?.hold(o.taskId, "blocked", t("koşul bekleniyor: {what}", { what }), null, { alert: false });
  const deadline = Date.now() + Number(SETTINGS.waitMaxH ?? 24) * 3600_000;
  let fail = null;
  for (;;) {
    if (o.after) {
      const st = afterState(o.after);
      if (st === "unknown") { fail = t("{ref} diye bir görev ya da çalıştırma yok", { ref: o.after }); break; }
      if (st === "failed") { fail = t("{ref} başarısız bitti; bu iş başlatılmadı", { ref: o.after }); break; }
      if (st === "done" && !o.when) break;
    }
    if (o.when && (!o.after || afterState(o.after) === "done") && spawnSync("sh", ["-c", o.when], { cwd: o.cwd, stdio: "ignore", timeout: 120_000 }).status === 0) break;
    if (Date.now() > deadline) { fail = t("koşul {h} saat içinde sağlanmadı: {what}", { h: SETTINGS.waitMaxH ?? 24, what }); break; }
    await sleep(30_000);
  }
  if (tasks) {
    // the placeholder worker goes; the real run links itself under its own id
    if (fail) tasks.endWorker(o.taskId, waitId, "failed", fail); else tasks.dropWorker(o.taskId, waitId);
    if (fail) tasks.hold(o.taskId, "blocked", fail, null, { alert: true }); else tasks.unhold(o.taskId, t("koşul sağlandı: {what}", { what }));
  }
  if (fail) warn(fail);
  return !fail;
}

// ekip mesai on|off|status (lib/workers/mesai.js); `ekip mesai all "task"` races the task on every
// ready pool with a free slot, each in its own worktree like --via a,b,c.
async function mesai(args) {
  if (args[0] !== "all") return (await (await import("../lib/workers/mesai.js")).main(args)) ?? 0;
  const { freePools } = await import("../lib/workers/agents.js");
  const pools = freePools();
  if (!pools.length) die(t("boş kapasiteli havuz yok (ekip mesai status)"));
  say(`${t("mesai all:")} ${pools.map((x) => c.cyan(x, process.stderr)).join(", ")}`);
  return run(["--via", pools.join(","), ...(pools.length === 1 ? ["--worktree"] : []), ...args.slice(1)]);
}

function clean([short]) {
  if (!short) die("usage: ekip clean <run id>");
  const base = path.join(HOME, "worktrees", short);
  for (const via of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const dir = path.join(base, via);
    const common = git(dir, ["rev-parse", "--git-common-dir"]).stdout.trim();
    const top = common ? path.dirname(path.resolve(dir, common)) : null;
    if (top) { git(top, ["worktree", "remove", "--force", dir]); git(top, ["branch", "-D", `ekip/${short}-${via}`]); }
  }
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`removed worktrees and branches of ${short}`);
}

// ekip watch <log>: follow a worker's log in color until it exits, then keep the window for reading.
async function watch([file]) {
  if (!file || !fs.existsSync(file)) die("usage: ekip watch <run log>");
  const name = path.basename(file, ".log");
  const head = fs.readFileSync(file, "utf8").split("\ntask:\n")[0].split("\n");
  const field = (k) => { const v = head.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2); return v && v !== "-" ? v : null; };
  const via = name.slice(25) || name, label = field("label"), project = field("project"), pid = Number(field("pid")) || null;
  const started = Date.parse(name.slice(0, 24).replace(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "$1T$2:$3:$4.$5Z")) || Date.now();
  const mins = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? "<1 dk" : m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa ${m % 60} dk`; };
  // The pane title is what tells panes apart: the worker's label, else its project.
  process.stdout.write(`\x1b]0;${label ?? project ?? "ekip"} · ${via}\x07`);
  console.log(`${mark()}  ${c.bold(label ?? project ?? "")} ${c.gray(`${via}${label && project ? ` · ${project}` : ""} · ${field("cwd") ?? ""}`)}`);
  const color = (line) => (line.startsWith("▸ ") ? c.cyan(line) : line.startsWith("$ ") ? c.gray(line.slice(0, 160)) : /^\[exit 0\]/.test(line) ? c.green(line) : /^\[exit/.test(line) ? c.red(line) : line);
  const alive = () => { if (!pid) return true; try { process.kill(pid, 0); return true; } catch { return false; } };
  let pos = 0, pending = "", done = false, lastOut = Date.now(), lastNote = 0, ended = "bitti";
  while (!done) {
    const size = fs.statSync(file).size;
    if (size > pos) {
      const fd = fs.openSync(file, "r");
      const b = Buffer.alloc(size - pos);
      fs.readSync(fd, b, 0, b.length, pos);
      fs.closeSync(fd);
      pos = size;
      lastOut = Date.now();
      pending += b.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const l of lines) { process.stdout.write(`${color(l)}\n`); if (/^\[exit -?\d+\]/.test(l)) done = true; }
      if (pending && !pending.startsWith("▸") && !pending.startsWith("[")) { process.stdout.write(pending); pending = ""; }
    }
    if (done) break;
    // A worker that was killed never writes [exit]; without this its pane stayed open forever.
    if (!alive()) { ended = "durduruldu"; console.log(`\n${c.yellow("■ işçi durduruldu (çıkış kaydı yok)")}`); break; }
    // While a worker thinks there is no output; a quiet line says it is still alive and for how long.
    if (Date.now() - lastOut > 60_000 && Date.now() - lastNote > 60_000) {
      lastNote = Date.now();
      console.log(c.gray(`· çalışıyor · ${mins(Date.now() - started)} · ${mins(Date.now() - lastOut)}dır sessiz`));
    }
    await sleep(400);
  }
  process.stdout.write(`\x1b]0;✓ ${label ?? project ?? "ekip"} · ${via}\x07`);
  // A finished worker's pane closes by itself after a while (Enter closes it now).
  console.log(`\n${c.gray(`${ended} · ${mins(Date.now() - started)} · bu bölme 90 sn sonra kapanır (Enter: hemen kapat)`)}`);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    await Promise.race([new Promise((r) => process.stdin.once("data", r)), sleep(90_000)]);
  } else await sleep(90_000);
  process.exit(0);
}

// ---- tunnel to the VPS hub (launchd keeps it up across sleep, network changes and reboots) ----

const TUNNEL_PORTS = [PORT, TDAI_PORTS.core, TDAI_PORTS.panel, TDAI_PORTS.knowledge, TDAI_PORTS.proxy];
const plistPath = () => path.join(os.homedir(), "Library/LaunchAgents", `${TUNNEL_LABEL}.plist`);

function tunnel([sub = "status"]) {
  if (!REMOTE) die("no remote hub configured (ekip remote <ssh-host>)");
  if (sub === "install") {
    const args = ["/usr/bin/ssh", "-N", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=3",
      "-o", "ExitOnForwardFailure=yes", ...TUNNEL_PORTS.flatMap((p) => ["-L", `127.0.0.1:${p}:127.0.0.1:${p}`]), REMOTE.ssh];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${TUNNEL_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), "Library/Logs/ekip-tunnel.log")}</string>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist);
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${TUNNEL_LABEL}`], { stdio: "ignore" });
    spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath()], { stdio: "inherit" });
    console.log(`tunnel to ${REMOTE.ssh} installed: ports ${TUNNEL_PORTS.join(", ")}`);
  } else if (sub === "uninstall") {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${TUNNEL_LABEL}`], { stdio: "ignore" });
    fs.rmSync(plistPath(), { force: true });
    console.log("tunnel removed");
  } else {
    const r = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${TUNNEL_LABEL}`], { encoding: "utf8" });
    console.log(r.status === 0 ? (r.stdout.match(/state = .*/)?.[0] ?? "loaded") : "not installed (ekip tunnel install)");
  }
}

// ekip remote <ssh-host> [dir]: switch to the VPS hub. Stops the local services whose ports the
// tunnel takes over; their data was migrated to the hub.
async function remote([host, dir = "/data/ekip"]) {
  if (!host) die("usage: ekip remote <ssh-host> [dir]   |   ekip remote --local");
  if (host === "--local") { saveSettings({ remote: undefined }); tunnel(["uninstall"]); console.log("back to local services (ekip up; ekip memory up)"); return; }
  saveSettings({ remote: { ssh: host, dir }, freellmapiKey: unifiedKey(), tdaiKey: adminKey() });
  console.log("stopping local freellmapi and memory containers (their ports go to the tunnel)");
  await down();
  spawnSync("docker", ["rm", "-f", ...["tdai-proxy", "tdai-memory-hub", "tdai-memory-core"].map(tdaiContainer)], { stdio: "ignore" });
  console.log("now run: ekip tunnel install");
}

// ---- hub (VPS) ------------------------------------------------------------------------------

async function hubFetch(pathname, init = {}) {
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) die("no hub linked: ekip hub link <url> <token>");
  const r = await fetch(`${SETTINGS.hubUrl}${pathname}`, {
    ...init, signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}`, ...init.headers },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) die(`hub ${pathname}: HTTP ${r.status} ${body.error ?? ""}`);
  return body;
}

// ekip job "task" --project NAME [--no-push]: queue work on the hub; it runs even when the Mac is off.
async function job(args) {
  if (args[0] === "ls" || !args.length) {
    const jobs = await hubFetch("/api/jobs");
    for (const j of (Array.isArray(jobs) ? jobs : jobs.jobs ?? []).slice(0, 20)) console.log(`${j.id}  ${j.status.padEnd(8)} ${j.project ?? "-"}  ${String(j.task).split("\n")[0].slice(0, 70)}${j.branch ? `  [${j.branch}]` : ""}`);
    return;
  }
  if (args[0] === "show") { const j = await hubFetch(`/api/jobs/${args[1]}`); console.log(JSON.stringify(j, null, 2)); return; }
  let project = null, push = true, task = [], via;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project") project = args[++i];
    else if (args[i] === "--via") via = args[++i];
    else if (args[i] === "--no-push") push = false;
    else task.push(args[i]);
  }
  project ??= registry().filter((x) => process.cwd().startsWith(x.path)).sort((a, b) => b.path.length - a.path.length)[0]?.name;
  if (!project || !task.length) die('usage: ekip job "task" --project NAME [--via auto|copilot|free] [--no-push] | ekip job ls | ekip job show ID');
  const j = await hubFetch("/api/jobs", { method: "POST", body: JSON.stringify({ project, task: task.join(" "), push, ...(via ? { via } : {}) }) });
  console.log(`queued ${j.id ?? JSON.stringify(j)} on ${SETTINGS.hubUrl} (ekip job show ${j.id})`);
}

async function hub([sub, url, token]) {
  if (sub === "local") { process.exitCode = await (await import("../lib/hub/local-hub.js")).main([url]); return; }
  if (sub === "link") {
    if (!url || !token) die("usage: ekip hub link <https://hub.example.com> <token>");
    saveSettings({ hubUrl: url.replace(/\/$/, ""), hubToken: token, hubLocal: false });
    await hubFetch("/api/heartbeat", { method: "POST", body: JSON.stringify({ client: "mac", host: os.hostname() }) });
    console.log(`linked to ${url}`);
  } else if (sub === "push") {
    // The hub works from GitHub, so it gets each project's repo URLs, card and memory ids.
    const projects = registry().map((p) => ({
      name: p.name,
      repo: p.repo ?? null,
      repos: (p.repos ?? []).map((r) => r.url ?? r).filter(Boolean).slice(0, 50),
      summary: p.summary ?? "",
      card: p.card && fs.existsSync(p.card) ? fs.readFileSync(p.card, "utf8") : "",
      tdai: p.tdai ? {
        teamId: p.tdai.teamId, agentId: p.tdai.agentId, wikiId: p.tdai.wikiId, codeGraphId: p.tdai.codeGraphId,
        codeGraphs: (p.tdai.codeGraphs ?? []).slice(0, 50).map(({ repo, id, branch, private: priv, status }) => ({ repo, id, branch, private: !!priv, status })),
      } : undefined,
    }));
    // development env for projects that have one, addressed for the server (jobs use it, the API never shows it)
    if (SETTINGS.dev?.projects) {
      const { devEnv } = await import("../lib/dev/dev.js");
      for (const p of projects) if (SETTINGS.dev.projects[p.name]) { try { p.dev = devEnv(p.name, { onVps: true }); } catch { /* VPS unreachable: no dev env this time */ } }
    }
    const r = await hubFetch("/api/projects", { method: "PUT", body: JSON.stringify({ projects, replace: true }) });
    console.log(`pushed ${projects.length} projects to ${SETTINGS.hubUrl} (${r.count} on the hub)`);
  } else if (sub === "status" || !sub) console.log(JSON.stringify(await hubFetch("/api/status"), null, 2));
  else if (sub === "open") openUrl(SETTINGS.hubUrl ?? die("no hub linked"));
  else die("usage: ekip hub link <url> <token> | local [up|down|status] | push | status | open");
}

// Runs are reported to the hub (when one is configured) so the panel shows Mac and VPS work together,
// and written to the project's memory so later sessions know what was done.
async function report(run) {
  try {
    const { recordRun } = await import("../lib/memory/memory.js");
    await Promise.race([recordRun(run.project, run), sleep(15000)]);
  } catch { /* memory is best effort */ }
  await postRun({ ...run, finishedAt: new Date().toISOString() });
}

// The run id starts with its start time (2026-10-28T21-18-11-017Z-agy).
const runStart = (id) => id.slice(0, 24).replace(/^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "$1T$2:$3:$4.$5Z");

// Same hub record as report(), posted when a worker starts so the panel shows it while it runs;
// report() later overwrites it by id.
async function postRun(run) {
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return;
  const { pending } = await import("../lib/tasks/tasks.js");
  const pr = fetch(`${SETTINGS.hubUrl}/api/runs`, {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` },
    body: JSON.stringify({ startedAt: runStart(run.id), ...run, host: os.hostname() }),
  }).then((r) => { if (r.ok && run.status !== "running") markRunSynced(run.id); }, () => {}).finally(() => pending.delete(pr));
  pending.add(pr);
}

// Finished runs whose final state reached the hub. reconcileRuns resends the others, so a run that
// ended while the hub was unreachable (or as its process exited) does not stay "running" there.
const RUNS_SYNCED = () => path.join(HOME, "runs-synced.json");
const runsSynced = () => { try { return new Set(JSON.parse(fs.readFileSync(RUNS_SYNCED(), "utf8"))); } catch { return new Set(); } };
function markRunSynced(id) {
  const s = runsSynced();
  if (s.has(id)) return;
  s.add(id);
  try { fs.writeFileSync(RUNS_SYNCED(), JSON.stringify([...s].slice(-2000))); } catch { /* best effort */ }
}

// ---- the lead session -------------------------------------------------------------------------

const LEAD_PROMPT = `# ekip: you lead a team on other quotas
When SessionStart provides setup gaps, offer the most useful one once at a natural moment; if accepted, run it as a tracked task. Respect a declined offer for this session and never block the user's request.

## Public repository rules
Before committing in a public repo or one with scripts/privacy-check.sh, run that check. Never seed public code briefs with personal project names, hosts, or IDs; describe them as runtime config.
If the panel says a run is active after it finished locally, run \`ekip tasks sync\`. Move or remove registered projects only with \`ekip project move\` or \`ekip project remove\`.

## Development databases
For database or Redis work in a registered project, run \`ekip dev up PROJECT\` and have workers source the project's \`.env.ekip-dev\`. Never use production URLs from project \`.env\` files for tests or migrations. Use \`ekip dev reset PROJECT --yes\` to reset development data, and \`ekip dev down\` when finished.

## Your own subagents
Your Claude limit is the scarce resource. Hand work to ekip workers first. When you do need a
subagent of your own, pick the cheapest that fits: the \`scout\` agent (Haiku, read-only) to find code
or facts, the \`implementer\` agent (Sonnet) for a coding step that needs this session's tools or
skills. Other subagents run on Sonnet by default. Keep your own context for decisions and review.

## Progress the user can see (mandatory)
For EVERY user request that takes more than a minute, before doing anything else:
  id=$(ekip task new "<short Turkish title>" --project <name if any> --steps "<step 1>; <step 2>; ...")
Use 3-8 concrete steps in Turkish (e.g. "Araştırma; Senaryo; Seslendirme; Render; Kontrol"). Then keep it true:
- \`ekip task step $id N running\` when you start step N (\`--pct 40\` for partial progress inside a long step;
  starting a step marks the previous running one done, add \`--parallel\` when steps overlap),
  \`ekip task step $id N done\` when it is done, \`failed\` / \`skipped\` when that happens; \`ekip task add $id "new step"\`
  if the plan grows; \`ekip task note $id "<one line>"\` for anything the user should know.
- Pass \`--task $id --label "<what this worker does>"\` to every \`ekip run\` that belongs to it.
- \`ekip task done $id "<one-sentence result>" --link <file path or URL>\` at the end: the result and its
  links show on the panel and in \`ekip status\` (\`ekip task fail $id "<why>"\` if you must stop). A
  worker's report fills the result by itself; correct it with \`ekip task result $id "..." --link ...\`.
  \`ekip task cancel\` / \`done\` also stop that task's live workers.
- Every decision you ask the user in chat also goes on the panel: \`ekip task ask $id "<question>"
  --option "<A>" --option "<B>"\`; when they answer, \`ekip task answer $id "<their choice>"\`.
  \`ekip task block $id "<what it waits for>"\` for a file, another task or a quota; \`ekip task unblock
  $id\` when it moves again.
- When the user asks what is going on, run \`ekip status\` first and answer from its output, never from
  memory.
- Close what you open, the moment it is true: mark each step done when it is done, and the task done
  as soon as its result is reviewed. A task closes by itself when every step is done or its last worker
  ends with nothing pending, and is closed as failed after 6 hours without activity, but never leave
  that to the safety net. The user must never have to tell you "this is still open".
- Every worker has a watchdog: 15 min without output (CPU use of its child processes counts as
  activity) or 90 min in total stops it (EKIP_IDLE_MIN, EKIP_TIMEOUT_MIN) and notes why on the task.
  Two silent pools in a row stop the fallback chain and block the task. When that happens,
  re-dispatch at once with a sharper brief or a strong pool; for a long render, raise the limit on
  that run instead of waiting. A worker that was cut off: \`ekip run --resume <run id>\`.
- The same failure twice = stop: find the root cause before another attempt; no blind retries.
- Every shell command that may take more than a minute (an upload, an encode, a sync, a queue
  script) runs through \`ekip track --task $id --step N --label "<what>" -- <command>\`, never as a bare
  long job in a Bash background shell: track measures progress, speed and finish, blocks the step
  when nothing moves (\`--stall MIN\`, default 10) and closes it done or failed when the command
  ends. Give it \`--total\` (bytes or count) and, when the output has no percent, \`--measure "<cmd
  printing work done>"\`. \`--wait\` in a Bash background call wakes you when it ends.
- Before a big transfer or render, time a small sample first (one file, a few seconds of video),
  work out the full duration, and pass \`--eta-max <minutes>\`; track warns at once when the real speed
  would miss it. Never tell the user something "is uploading" without having looked at its progress.
- Never answer a mistake with "my fault" and move on. Say its root cause and what now prevents it
  permanently in ekip or the project, and put that in place in the same turn (\`ekip project lesson\`,
  \`--min-tier\`, \`ekip track\`, a project rule, a check).
- Never let a model wait on something long (a render queue, other workers, a file to appear): chain
  it with \`ekip run --after <task|run id>\` or \`--when "<shell test>"\`, which waits in the background
  and starts the run when the condition holds; or write a small script.
- Renders, encodes and other heavy local work: \`ekip run --heavy\` takes a machine slot (queued when the
  Mac is full); browser/DOM debugging and other hard work: \`--min-tier strong\` so it never falls to
  a weak free pool. Every pool switch is noted on the task.
- When the user corrects a mistake, in the same turn add one line to the project's lessons file:
  \`ekip project lesson NAME "<what to do instead>"\` (every later worker brief gets it).
- Be proactive: when a job is slow or stuck, look at why (logs, CPU, rate limits, a duplicate copy)
  and fix it or move it to a faster pool, then tell the user what you did. Don't wait to be asked.
- Check your own output before reporting it: look at every screenshot, video frame and page you made
  (leftover other-language text, em dashes, clipped or overlapping text, wrong aspect ratio, personal
  data in demos). Fix what you find; the user should not be the one who spots it.
The user watches percent, current step and estimated finish live in a pane and on the panel; a
request without a task is invisible to them. Several requests = several tasks, worked in parallel.
The user has Claude Max and wants YOUR effort spent on judgment: understanding, design, splitting,
integration and review. Hand everything well-scoped to workers that run on other accounts and
quotas, through the shell command \`ekip run\` (\`ekip agents\` shows which pools are usable):

| --via | what | use for |
|---|---|---|
| auto (default) | first usable of: agy, codex, copilot, qwen, opencode, grok, then free | most delegated work |
| agy | Antigravity (strong models, Google quota) | substantial coding, research |
| codex / copilot / qwen / opencode | other vendors' CLIs on their own quotas | same; a different model family |
| grok, free | harnesses on pooled free-tier models (freellmapi) | small, precise, mechanical tasks |
| claude | a headless Claude on the user's subscription | LAST RESORT: only when other pools failed at the task, or the user asks for it |

- Options: \`--project NAME\` (a registered project; sets the folder and its memory) or \`--cwd DIR\`,
  \`--model ID\`, \`--plugin NAME\` / \`--skill NAME\`: works with EVERY pool (Claude workers load it, the
  others are told to read and follow its SKILL.md), e.g. \`--via agy --plugin lemo-opuscar\` for films,
  \`--skill blender-modeling\`. Long briefs: \`ekip run - <<'EOF' ... EOF\`.
- Choosing a pool: the user's Claude limit is the scarce resource. Default to agy / copilot for real
  work (they are strong), qwen / opencode / grok / free for light work. Skill-heavy work too: agy or
  copilot with --plugin/--skill first. Use \`claude\` only after another pool failed at that task, or
  when the user asks. Say in the task note which pool you chose and why.
- Several models on the same task: \`--via agy,codex,free\` runs each in its own git worktree and branch
  and prints each diffstat and report. Compare, \`git merge\` the best, then \`ekip clean <id>\`.
  Use it when quality matters or an approach is uncertain.
- A worker is headless with full file and shell access, cannot ask questions, prints a final report
  (transcripts in the ekip data folder). Brief it like a capable colleague with no context: goal,
  files, constraints, how to verify, what to report.
- Run independent workers in parallel (Bash run_in_background; you are notified on exit). Never two
  concurrent workers on the same files without worktrees.
- Review every result (git diff, tests) before you report. Re-dispatch with a sharper brief or fix it.
- A long job you start yourself outside \`ekip run\` (an import, a render, a loop) runs through
  \`ekip track\` (above); \`ekip show <log...>\` only opens a pane on a log that already exists.
- A worker that edits code that is running right now (ekip itself, a live dev server) gets
  \`--worktree\`; merge its branch after review.
- Tasks never look frozen or skipped: mark every step you start, let long reporters pass \`--alive\`
  when they measure work, and do not leave a step pending for later; close the task and open a new
  one when that work starts. When something looks stuck, fix it and add the mechanism that prevents
  the same class of problem, not a one-off patch.
- Learn from failures: when a worker failed or was rejected and a later attempt worked, save the lesson
  with memory_remember in that project (what failed, the cause, what made it work, the pool that did
  it), one fact per call. Lessons that keep coming back become skill candidates (\`ekip skill learn\`).
- After workers change code in a registered project, run \`ekip review --project NAME\` before reporting.
- Failed checks and HIGH findings confirmed by both reviewers are must-fix; re-dispatch fixes. For recurring bug classes in projects with check:* scripts, propose a new check script.
- Projects: \`ekip project ls\` / \`ekip project show NAME\` list the user's registered projects with
  their cards (stack, commands, frequent tasks). The ekip MCP tools search each project's memory,
  wiki and code graph; codegraph MCP explores code. Save durable facts with memory_remember.
- Before dispatching work in a project, check its \`.claude/skills\` and pass a matching procedure with \`--skill NAME\`.
  Run \`ekip skill learn PROJECT\` weekly or whenever the user asks to turn repeated work into reusable skills.
- The hub on the user's VPS (if linked: \`ekip hub status\`) runs queued jobs even when this Mac is off:
  \`ekip job "<task>" --project NAME\` queues one (it works on a branch and pushes it).
- Long-lived peers: \`ekip team up --open\` starts ekip-agy/ekip-free as hoptell peers in their own
  terminal windows; message them with hoptell send_message.
`;

// Added to the lead's prompt while mesai modu is on (`ekip mesai on`).
const MESAI_PROMPT = () => `
## Mesai modu (work shift) is on
The user wants every ready pool busy at once. \`ekip mesai status\` shows each pool's running/capacity.
- Split each request into as many independent, well-scoped parts as the free capacity allows (no two
  parts on the same files), and dispatch them all at once: \`ekip run --via auto\` in the background
  (Bash run_in_background). auto skips pools that are full or out of quota, so parallel runs spread out.
- Race uncertain or quality-critical parts (\`--via a,b\`), or run one task on every free pool with
  \`ekip mesai all "<task>"\`; compare the branches and merge the best.
- When a worker finishes, review it and dispatch the next part at once, so no pool sits idle.
- Keep your own Claude for planning, integration and review only; do not do the parts yourself.${SETTINGS.mesaiClaude ? "\n- The headless claude pool is included as one more worker (capacity 1); use it like the others." : ""}
`;

const MEMBER_PROMPT = `# ekip team member
You are a long-running worker in an ekip team. Other agents send you tasks over hoptell. When the
inbox notice appears, read your inbox, do each task completely and autonomously, and reply to the
sender with send_message (reply_to the message id): what you changed, how you verified it, what is open.`;

const HOPTELL_MCP = JSON.stringify({ mcpServers: { hoptell: { command: "hoptell", args: ["mcp"] } } });

// Tells the hub this Mac is alive (the panel's "Mac last seen"). Sent when the lead starts and by
// `ekip doctor`, which launchd runs every 30 minutes.
async function heartbeat() {
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return;
  await fetch(`${SETTINGS.hubUrl}/api/heartbeat`, { method: "POST", signal: AbortSignal.timeout(4000), headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` },
    body: JSON.stringify({ client: "mac", host: os.hostname(), agents: autoOrder() }) }).catch(() => {});
}

async function lead(args) {
  let free = false, member = false;
  while (args[0] === "--free" || args[0] === "--member") {
    if (args[0] === "--free") free = true; else member = true;
    args = args.slice(1);
  }
  // The lead runs without permission prompts by default, so a long team run never stalls on a
  // dialog; `ekip --safe` keeps Claude Code's normal prompts. An explicit mode in args wins.
  const safe = args.includes("--safe");
  args = args.filter((a) => a !== "--safe");
  const explicit = args.some((a) => a === "--permission-mode" || a === "--dangerously-skip-permissions");
  const env = free ? await freeEnv() : { ...process.env };
  // The lead thinks on your main model (Opus); subagents it spawns run on Sonnet unless set
  // otherwise ("subagentModel" in data/config.json; "inherit" keeps the lead's model).
  const sub = SETTINGS.subagentModel ?? "sonnet";
  if (!free && sub !== "inherit" && !env.CLAUDE_CODE_SUBAGENT_MODEL) env.CLAUDE_CODE_SUBAGENT_MODEL = sub;
  const argv = ["--append-system-prompt", member ? MEMBER_PROMPT : LEAD_PROMPT + (SETTINGS.mesai ? MESAI_PROMPT() : ""), ...(safe || explicit ? [] : ["--permission-mode", "bypassPermissions"]), ...args];
  const interactive = !member && process.stdout.isTTY && !args.some((a) => a === "-p" || a === "--print");
  if (interactive) {
    const here = registry().filter((x) => process.cwd() === x.path || process.cwd().startsWith(`${x.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    console.log(`\n${mark()}  ${c.gray("proje")} ${here ? c.bold(here.name) : c.gray("kayıtlı değil (ekip project add .)")}   ${c.gray("havuzlar")} ${autoOrder().map((x) => c.cyan(x)).join(c.gray(" → "))}   ${c.gray("lead")} ${free ? c.yellow("ücretsiz modeller") : c.green("Claude")}`);
    if (SETTINGS.hubUrl) console.log(`        ${c.gray("panel")} ${c.under(SETTINGS.hubUrl)}`);
    try { const up = (await import("../lib/ops/update.js")).autoUpdate(); if (up.updated) console.log(`        ${c.green(`ekip ${up.from} → ${up.to} güncellendi`)} ${c.gray("(yeni hook'lar bir sonraki açılışta)")}`); } catch { /* offline */ }
    const onboarding = await import("../lib/projects/onboarding.js");
    const gaps = await onboarding.setupGaps({ cwd: process.cwd() });
    onboarding.printGaps(gaps, { limit: 3 });
    const welcomeFile = path.join(HOME, "onboarding.json");
    let welcomed = false;
    try { welcomed = !!JSON.parse(fs.readFileSync(welcomeFile, "utf8")).welcomedAt; } catch { /* first start */ }
    if (!welcomed) { console.log(welcome()); fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(welcomeFile, JSON.stringify({ welcomedAt: new Date().toISOString() }, null, 2)); }
    console.log("");
    // Tasks, workers and their logs are visible under the lead from the start, not only after its
    // first task ("taskPane": false in data/config.json turns this off).
    ensureTaskPane();
    // WezTerm / kitty: an "ekip" tab title, so ekip's WezTerm config shows the task counts on it
    try { const term = await import("../lib/core/terminal.js"); if (["wezterm", "kitty"].includes(term.detect())) term.setTitle(null, `ekip · ${here?.name ?? path.basename(process.cwd())}`); } catch { /* cosmetic */ }
  }
  // The free config dir has none of the user's MCP servers; hand it hoptell when it is installed.
  if (free && has("hoptell")) argv.unshift("--mcp-config", HOPTELL_MCP);
  if (free && !member) console.error("ekip: lead session on free-tier models (freellmapi)");
  // awaited: spawnSync below blocks the event loop, so a request still in flight would never leave
  if (!member) await heartbeat();
  if (!member) await (await import("../lib/workers/limits.js")).push().catch(() => {});
  const r = spawnSync("claude", argv, { stdio: "inherit", env });
  return r.status ?? 1;
}

// ---- setup -----------------------------------------------------------------------------------

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

const step = (n, t) => console.log(`\n${c.magenta(`━━ ${n}.`)} ${c.bold(t)}`);

async function init({ skipKeys = false } = {}) {
  if (process.platform === "darwin" && has("brew") && !has("terminal-notifier")) spawnSync("brew", ["install", "terminal-notifier"], { stdio: "ignore", timeout: 120_000 });
  const self = fs.realpathSync(process.argv[1]);
  step(1, "prerequisites");
  const need = ["git", "claude", "sqlite3", "tmux", "docker"];
  const missing = need.filter((b) => !has(b));
  if (missing.length) die(`missing: ${missing.join(", ")}. On macOS: brew install ${missing.filter((b) => b !== "claude" && b !== "docker").join(" ")}; Claude Code from claude.com/claude-code; Docker Desktop or OrbStack`);
  const di = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (di.status !== 0) die(/permission denied/i.test(di.stderr ?? "")
    ? "docker is running but this user may not use it: run `sudo usermod -aG docker $USER`, log out and in (or `newgrp docker`), then ekip init again"
    : "docker is installed but not running; start Docker Desktop / OrbStack (or `sudo systemctl start docker`) and run ekip init again");
  const oldNode = findOldNode();
  if (!oldNode) die("freellmapi needs Node 22-24 next to your default node: brew install node@24");
  saveSettings({ freellmapiNode: oldNode });
  console.log(`ok (freellmapi node: ${oldNode}; agy: ${has("agy") ? "found" : "not found, optional"})`);
  // what ekip is doing, under every Claude Code prompt (kept if the user already has a status line)
  try { if ((await import("../lib/ops/statusline.js")).install(ROOT)) console.log("ok (Claude Code status line: ekip statusline)"); } catch { /* optional */ }

  // Global npm installs (worker CLIs, codegraph, hoptell) need a writable prefix. With a system node
  // that is root-owned; point npm at ~/.local instead, whose bin/ is on PATH after the next step.
  const prefix = spawnSync("npm", ["config", "get", "prefix"], { encoding: "utf8" }).stdout.trim();
  try { fs.accessSync(path.join(prefix, "lib"), fs.constants.W_OK); }
  catch { sh("npm", ["config", "set", "prefix", path.join(os.homedir(), ".local")]); console.log(`npm global installs go to ~/.local (${prefix} is not writable)`); }

  step(2, "ekip on PATH");
  const link = path.join(os.homedir(), ".local/bin/ekip");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(self, link);
  console.log(`${link} -> ${self}`);
  // ~/.local/bin not on PATH: add it to the shell's startup files instead of asking the user to
  if (!(process.env.PATH ?? "").split(":").includes(path.dirname(link))) {
    const line = 'export PATH="$HOME/.local/bin:$PATH"  # added by ekip init';
    for (const rc of [".zshrc", ".bashrc"].map((f) => path.join(os.homedir(), f))) {
      if ((rc.endsWith(".zshrc") && process.platform === "darwin") || fs.existsSync(rc)) {
        const text = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
        if (!text.includes(".local/bin")) fs.appendFileSync(rc, `\n${line}\n`);
      }
    }
    process.env.PATH = `${path.dirname(link)}:${process.env.PATH}`;
    console.log("~/.local/bin was added to your shell's PATH (new terminals pick it up)");
  }

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
    // npm link needs a writable global prefix (fine with Homebrew, not with a system node): link the
    // binary into ~/.local/bin like ekip itself when it fails
    if (spawnSync("npm", ["link"], { cwd: hdir, stdio: "ignore" }).status !== 0) {
      const bin = JSON.parse(fs.readFileSync(path.join(hdir, "package.json"), "utf8")).bin;
      const entry = typeof bin === "string" ? bin : bin?.hoptell ?? Object.values(bin ?? {})[0];
      const target = path.join(os.homedir(), ".local/bin/hoptell");
      fs.rmSync(target, { force: true });
      fs.symlinkSync(path.join(hdir, entry), target);
      fs.chmodSync(path.join(hdir, entry), 0o755);
    }
  }
  spawnSync("hoptell", ["local-relay", "install"], { stdio: "inherit" });
  if (spawnSync("claude", ["mcp", "get", "hoptell"], { stdio: "ignore" }).status !== 0) sh("claude", ["mcp", "add", "-s", "user", "hoptell", "--", "hoptell", "mcp"]);

  step(5, "TencentDB Agent Memory (memory, LLM wiki, code graph)");
  clone("tdai");
  await memoryUp();

  step(6, "Claude Code plugin, MCP servers, code graph");
  fs.mkdirSync(path.dirname(POINTER), { recursive: true });
  fs.writeFileSync(POINTER, `${ROOT}\n`);
  spawnSync("claude", ["plugin", "marketplace", "add", REPO], { stdio: "inherit" });
  spawnSync("claude", ["plugin", "install", "ekip@ekip"], { stdio: "inherit" });
  if (!has("codegraph")) sh("npm", ["i", "-g", "@colbymchenry/codegraph"]);
  for (const [name, argv] of [["ekip", ["node", path.join(ROOT, "plugin/bin/ekip.js"), "mcp"]], ["codegraph", ["codegraph", "serve", "--mcp"]]]) {
    if (spawnSync("claude", ["mcp", "get", name], { stdio: "ignore" }).status !== 0) sh("claude", ["mcp", "add", "-s", "user", name, "--", ...argv]);
  }

  step(7, "worker agent CLIs (each one is another quota)");
  await agentsMain(["install"]);

  if (!skipKeys && process.stdin.isTTY) {
    step(8, "free-tier keys");
    await keyWizard();
    step(9, "agent logins (codex, qwen, opencode, copilot; Enter through any you don't use)");
    await agentsMain(["login"]);
    step(10, "your projects");
    console.log("Registering projects with a commit in the last 30 days (cards, wiki, code graphs, memory):");
    await (await import("../lib/projects/projects.js")).main(["scan", "--days", "30", "--yes"]);
  }
  // the web panel: on this computer when no VPS hub is linked (same image the VPS runs)
  step(11, "web panel");
  try {
    const lh = await import("../lib/hub/local-hub.js");
    if (lh.remoteLinked()) console.log(`ok (linked hub: ${SETTINGS.hubUrl})`);
    else { await lh.up(); await hub(["push"]).catch(() => {}); }
  } catch (e) { console.log(`${c.yellow("skipped")}: ${e.message}; later: ekip hub local`); }
  console.log("\nDone. Open a new terminal and run: ekip");
  const onboarding = await import("../lib/projects/onboarding.js");
  onboarding.printGaps(await onboarding.setupGaps({ cwd: process.cwd(), refresh: true }), { heading: true });
}

// ---- TencentDB Agent Memory ---------------------------------------------------------------------

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
    // the images ekip's patches were written against, pinned by digest (hub/tools/tdai-patches/images.json)
    ...Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, "hub/tools/tdai-patches/images.json"), "utf8"))).filter(([k]) => !k.startsWith("_"))),
  });
  patchTdaiScripts(dir);
  setEnvValues(env, {
    CODE_SOURCE_ENABLED: "gongfeng",
    // Real vector search: one pinned embedding model for the whole index (nemotron-3-embed-1b, 2048-d:
    // served by NVIDIA and OpenRouter free, so a limit on one falls back to the other with identical vectors).
    MEMORY_EMBEDDING_PROVIDER: "openai", MEMORY_EMBEDDING_BASE_URL: `http://host.docker.internal:${PORT}/v1`,
    MEMORY_EMBEDDING_API_KEY: key, MEMORY_EMBEDDING_MODEL: "nemotron-3-embed-1b", MEMORY_EMBEDDING_DIMENSIONS: "2048",
    MEMORY_LLM_MODEL: "auto:memory",
  });
  if (["tdai-memory-core", "tdai-memory-hub", "tdai-proxy"].every((n) => containerRunning(tdaiContainer(n)))) { console.log("memory stack already running"); return; }
  // start-all.sh probes the LLM from the host, where host.docker.internal does not resolve; the
  // three service scripts it wraps need no probe.
  for (const script of ["start-memory-core.sh", "start-memory-hub.sh", "start-proxy.sh"]) {
    sh(`./${script}`, [], { cwd: dir, env: { ...process.env, PROXY_FULL_STACK: "1" } });
  }
}

// TencentDB's hub script passes a fixed list of env vars; private GitHub code graphs need the
// "gongfeng" code source (https clone with a token), so add that variable to the list.
export function patchTdaiScripts(dir) {
  // ekip's fixes to TencentDB (hub/tools/tdai-patches). The repo holds only small diffs: the original
  // files come out of the pinned memory-core image, the diffs are applied, and the results go to
  // data/tdai/patched, which start-memory-core.sh mounts over the image (strict language rule in the
  // extraction prompts, fast L0 writes). The importer diff is applied to the clone. Idempotent.
  const patches = path.join(ROOT, "hub/tools/tdai-patches");
  const overlay = path.join(HOME, "tdai/patched");
  const image = JSON.parse(fs.readFileSync(path.join(patches, "images.json"), "utf8")).MEMORY_CORE_IMAGE;
  for (const name of fs.existsSync(path.join(patches, "memory-core")) ? fs.readdirSync(path.join(patches, "memory-core")).filter((n) => n.endsWith(".patch")) : []) {
    const diff = path.join(patches, "memory-core", name);
    const target = fs.readFileSync(diff, "utf8").match(/^\+\+\+ b\/(\S+)/m)?.[1];
    if (!target) continue;
    const out = path.join(overlay, target);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(diff).mtimeMs) continue;
    const orig = spawnSync("docker", ["run", "--rm", "--entrypoint", "cat", image, `/${target}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (orig.status !== 0) { console.error(`ekip: could not read ${target} from ${image}; memory-core runs unpatched`); continue; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-tdai-"));
    fs.mkdirSync(path.join(tmp, path.dirname(target)), { recursive: true });
    fs.writeFileSync(path.join(tmp, target), orig.stdout);
    const r = spawnSync("patch", ["-s", "-p1", "-d", tmp, "-i", diff], { encoding: "utf8" });
    if (r.status === 0) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(path.join(tmp, target), out); }
    else console.error(`ekip: ${name} did not apply to ${image}: ${r.stdout.trim().split("\n")[0]}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const coreScript = path.join(dir, "start-memory-core.sh");
  const cs = fs.readFileSync(coreScript, "utf8");
  if (!cs.includes("EKIP_TDAI_PATCHES") && cs.includes('-v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \\\n')) {
    fs.writeFileSync(coreScript, cs.replace('-v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \\\n',
      '-v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \\\n  $( P="${EKIP_TDAI_PATCHES:-' + overlay + '}"; [ -d "$P/app" ] && cd "$P" && find app -type f -name "*.ts" | while read f; do printf -- "-v %s/%s:/%s:ro " "$P" "$f" "$f"; done ) \\\n'));
  }
  const clone = path.dirname(path.dirname(dir));
  const ip = path.join(patches, "asset-import.patch");
  if (fs.existsSync(ip) && spawnSync("git", ["-C", clone, "apply", "--reverse", "--check", ip], { stdio: "ignore" }).status !== 0) {
    const r = spawnSync("git", ["-C", clone, "apply", "--3way", ip], { encoding: "utf8" });
    if (r.status !== 0) console.error(`ekip: importer patch did not apply (${r.stderr.trim().split("\n")[0]}); history import works without its retries`);
  }
  // memory-core reaches the free pool at host.docker.internal (LLM for facts, embeddings), but unlike
  // the proxy and hub scripts it is started without the host-gateway entry: on Linux Docker Engine the
  // name did not resolve and fact extraction and vectors failed silently (macOS Docker adds it itself)
  {
    const sc = path.join(dir, "start-memory-core.sh");
    const st = fs.readFileSync(sc, "utf8");
    if (!st.includes("host.docker.internal:host-gateway") && st.includes('$DOCKER run -d --name "$CONTAINER" \\\n'))
      fs.writeFileSync(sc, st.replace('$DOCKER run -d --name "$CONTAINER" \\\n', '$DOCKER run -d --name "$CONTAINER" \\\n  --add-host=host.docker.internal:host-gateway \\\n'));
  }
  // memory-core ships with embeddings off ("provider: none" = keyword search only); make the block
  // read MEMORY_EMBEDDING_* so it can use an OpenAI-compatible embeddings endpoint (freellmapi).
  const core = path.join(dir, "start-memory-core.sh");
  const ct = fs.readFileSync(core, "utf8");
  if (!ct.includes("MEMORY_EMBEDDING_PROVIDER")) {
    fs.writeFileSync(core, ct.replace("  embedding:\n    provider: none\n", '  embedding:\n    provider: ${MEMORY_EMBEDDING_PROVIDER:-none}\n    baseUrl: "${MEMORY_EMBEDDING_BASE_URL:-}"\n    apiKey: "${MEMORY_EMBEDDING_API_KEY:-}"\n    model: "${MEMORY_EMBEDDING_MODEL:-}"\n    dimensions: ${MEMORY_EMBEDDING_DIMENSIONS:-768}\n'));
  }
  const f = path.join(dir, "start-memory-hub.sh");
  const text = fs.readFileSync(f, "utf8");
  if (text.includes("CODE_SOURCE_ENABLED")) return;
  fs.writeFileSync(f, text.replace("  -e KNOWLEDGE_PORT=8424 \\\n", "  -e KNOWLEDGE_PORT=8424 \\\n  -e CODE_SOURCE_ENABLED=\"${CODE_SOURCE_ENABLED:-}\" \\\n"));
}

function memoryDown() {
  sh("./stop-all.sh", [], { cwd: tdaiDeploy() });
}

// Past Claude Code sessions → TencentDB memory and skills, through TencentDB's own importer.
// Each registered project's session folders go to that project's agent; other real projects go
// to the default agent (scratch and temp sessions included: they often hold useful work). A shared state file makes re-runs
// incremental (only new sessions are sent).
// Default: the last 30 days, sessions up to 200 MB (a first import of a full history took hours;
// the big ones are almost all tool output). --all imports everything; --days N / --max-mb N tune it.
async function importHistory(args = []) {
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const all = args.includes("--all");
  const days = all ? "0" : opt("--days") ?? "30";
  // Sessions above 20 MB are mostly tool output and take hours each through the memory server
  // (one took 3+ hours on 29 Oct); they are skipped unless --max-mb or --all asks for them.
  const maxMb = all ? "0" : opt("--max-mb") ?? "20";
  console.log(all ? "geçmişin tamamı içe aktarılıyor" : `son ${days} günün oturumları, en fazla ${maxMb} MB (hepsi için: --all)`);
  // one import at a time: two would read the same sessions and double the memory writes
  const lock = path.join(path.dirname(RUNS), "import-history.lock");
  let held = 0; try { held = Number(fs.readFileSync(lock, "utf8")); process.kill(held, 0); } catch { held = 0; }
  if (held) die(`import-history is already running (pid ${held})`);
  fs.writeFileSync(lock, String(process.pid));
  process.on("exit", () => { try { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock); } catch { /* ignore */ } });
  const key = adminKey() ?? die("no TencentDB admin key");
  const tdai = depDir("tdai");
  const importer = path.join(tdai, "agents/asset-import.ts");
  if (!fs.existsSync(importer)) die(`TencentDB is not cloned at ${tdai}`);
  const { identity } = await import("../lib/memory/memory.js");
  const me = await identity();
  const base = path.join(os.homedir(), ".claude/projects");
  const projects = registry();
  const stateFile = path.join(HOME, "memory-state/asset-import.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const plan = [];
  // Some project dirs are symlinks to others (-Volumes-SSD-Projects-x -> -Users-…-Projects-x); the
  // importer keys sessions by path, so importing both would store every session twice.
  const seen = new Set();
  for (const dir of fs.readdirSync(base)) {
    let real;
    try { real = fs.realpathSync(path.join(base, dir)); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const owner = projects.filter((p) => dir.endsWith(`-Projects-${p.name}`) || dir.includes(`-Projects-${p.name}-`)).sort((a, b) => b.name.length - a.name.length)[0];
    plan.push({ dir, agentId: owner?.tdai?.agentId ?? SETTINGS.tdaiDefaultAgent ?? die("set tdaiDefaultAgent in data/config.json (the default agent id)"), teamId: owner?.tdai?.teamId ?? me.teamId, project: owner?.name ?? "(default)" });
  }
  // The importer stats every entry of ~/.claude/skills and stops at the first broken symlink, so
  // it gets a shadow home that links only the skills that resolve.
  const shadow = path.join(HOME, "memory-state/home");
  const skillsSrc = path.join(os.homedir(), ".claude/skills"), skillsDst = path.join(shadow, ".claude/skills");
  fs.rmSync(skillsDst, { recursive: true, force: true });
  fs.mkdirSync(skillsDst, { recursive: true });
  for (const n of fs.existsSync(skillsSrc) ? fs.readdirSync(skillsSrc) : []) {
    try { const real = fs.realpathSync(path.join(skillsSrc, n)); if (fs.existsSync(path.join(real, "SKILL.md"))) fs.symlinkSync(real, path.join(skillsDst, n)); } catch { /* broken link */ }
  }
  for (const x of plan) {
    console.log(`\n── ${x.dir} → ${x.project}`);
    spawnSync("node", [importer, "--source", "claude-code", "--sessions", path.join(base, x.dir), "--agent-id", x.agentId, "--team-id", x.teamId, "--state-file", stateFile, "-y"], {
      cwd: tdai, stdio: "inherit",
      env: { ...process.env, HOME: shadow, PANEL_URL: `http://127.0.0.1:${TDAI_PORTS.panel}`, TDAI_SERVICE_ID: "default", TDAI_USER_KEY: key,
        // conversation only, no tool output (see agents/asset-import.ts LEAN); TDAI_IMPORT_LEAN=0 for everything
        // what people said and what was answered: tool calls and results were 85% of the rows and
        // made every vector search slower without adding decisions (TDAI_IMPORT_ESSENTIAL=0 keeps calls)
        TDAI_IMPORT_LEAN: process.env.TDAI_IMPORT_LEAN ?? "1", TDAI_IMPORT_ESSENTIAL: process.env.TDAI_IMPORT_ESSENTIAL ?? "1", TDAI_IMPORT_SINCE_DAYS: days, TDAI_IMPORT_MAX_MB: maxMb },
    });
  }
}

// ekip memory reindex: (re)start the vector backfill inside memory-core (resumable; only records
// without a vector are embedded). Runs where the memory stack runs: the VPS hub or local Docker.
function reindex() {
  const script = path.join(ROOT, "hub/tools/tdai-backfill-vectors.mjs");
  const env = `-e EMBED_URL=http://freellmapi:3001/v1 -e EMBED_KEY="$(grep ^MEMORY_LLM_API_KEY= .env | cut -d= -f2)" -e EMBED_MODEL="$(grep ^MEMORY_EMBEDDING_MODEL= .env | cut -d= -f2)"`;
  const cmd = (dir, src) => `cd ${dir} && C=$(${TDAI_CONTAINER_SH("tdai-memory-core")}) && docker cp ${src} $C:/tmp/backfill.mjs && (docker exec $C sh -c 'grep -qs backfill[.]mjs /proc/[0-9]*/cmdline' && echo "already running" || (docker exec -d ${env} $C node /tmp/backfill.mjs && echo started))`;
  if (REMOTE) {
    spawnSync("scp", ["-q", script, `${REMOTE.ssh}:${REMOTE.dir}/tdai-backfill-vectors.mjs`], { stdio: "inherit" });
    console.log(ssh(cmd(`${REMOTE.dir}/tdai/deploy/global-images`, `${REMOTE.dir}/tdai-backfill-vectors.mjs`)).stdout.trim());
  } else console.log(spawnSync("sh", ["-c", cmd(tdaiDeploy(), script)], { encoding: "utf8" }).stdout.trim());
}

// ekip memory compact: duplicates and tool noise out of memory-core's store (hub/tools/tdai-compact.mjs),
// with memory-core stopped for the few seconds it takes; a copy of the store is kept next to it (the
// previous copy is replaced). Runs where the memory stack runs: the VPS or local Docker.
function compact() {
  const script = path.join(ROOT, "hub/tools/tdai-compact.mjs");
  const body = (src) => `set -e; C=$(${TDAI_CONTAINER_SH("tdai-memory-core")}); [ -n "$C" ] || { echo "memory-core is not running"; exit 1; }
IMG=$(docker inspect -f '{{.Config.Image}}' $C)
DIR=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $C | sed -n 's/^TDAI_DATA_DIR=//p'); DIR=\${DIR:-/data/tdai-memory}
docker stop $C >/dev/null
docker run --rm --volumes-from $C -v ${src}:/tmp/ekip-compact.mjs:ro --entrypoint sh $IMG -c "rm -f $DIR/vectors.db.bak && cp $DIR/vectors.db $DIR/vectors.db.bak && node /tmp/ekip-compact.mjs $DIR/vectors.db" || { docker start $C >/dev/null; exit 1; }
docker start $C >/dev/null
echo "memory-core restarted; its first start rebuilds the vector tables per project (minutes on a large store)"`;
  if (REMOTE) {
    spawnSync("scp", ["-q", script, `${REMOTE.ssh}:${REMOTE.dir}/tdai-compact.mjs`], { stdio: "inherit" });
    const r = ssh(body(`${REMOTE.dir}/tdai-compact.mjs`), { stdio: "inherit" });
    return r.status ?? 1;
  }
  return spawnSync("sh", ["-c", body(script)], { stdio: "inherit" }).status ?? 1;
}

async function memory([sub = "status", ...rest]) {
  if (sub === "import-history") return importHistory(rest);
  if (sub === "reindex") return reindex();
  if (sub === "compact") { process.exitCode = compact(); return; }
  if (!["up", "down", "status", "open"].includes(sub)) return (await import("../lib/memory/memory.js")).main([sub, ...rest]);
  if (REMOTE && sub !== "open") {
    const dir = `${REMOTE.dir}/tdai/deploy/global-images`;
    // Under a PaaS the memory stack is a managed service: start/stop it through the PaaS, not with the
    // original scripts (which would recreate plain containers on the ports the service holds).
    // "memoryService": { "coolify": "<service uuid>" } in data/config.json; the API is called on the server.
    const svc = SETTINGS.memoryService?.coolify;
    const coolify = (action) => `curl -s -X POST -H "Authorization: Bearer $(cat /root/.coolify-api-token)" http://127.0.0.1:8000/api/v1/services/${svc}/${action}; echo`;
    const cmd = sub === "up" ? (svc ? coolify("start") : `cd ${dir} && ./start-memory-core.sh && ./start-memory-hub.sh && PROXY_FULL_STACK=1 ./start-proxy.sh`)
      : sub === "down" ? (svc ? coolify("stop") : `cd ${dir} && ./stop-all.sh`)
      : "docker ps --format '{{.Names}}: {{.Status}}' | grep -E '^(tdai-|ekip-hub|freellmapi)'";
    const r = ssh(cmd, { stdio: sub === "status" ? "pipe" : "inherit" });
    if (sub === "status") console.log(`on ${REMOTE.ssh}:\n${r.stdout.trim() || "nothing running"}`);
    return;
  }
  if (sub === "up") await memoryUp();
  else if (sub === "down") memoryDown();
  else if (sub === "open") openUrl(`http://127.0.0.1:${TDAI_PORTS.panel}`);
  else if (sub === "status") {
    for (const n of ["tdai-memory-core", "tdai-memory-hub", "tdai-proxy"]) console.log(`${n}: ${containerRunning(tdaiContainer(n)) ? "running" : "stopped"}`);
    console.log(`panel: http://127.0.0.1:${TDAI_PORTS.panel}   admin key: ${adminKey() ? path.join(tdaiDeploy(), ".admin-key") : "not created yet"}`);
  } else die("usage: ekip memory up|down|status|open");
}

async function memoryMcp() { /* filled in once the knowledge MCP wiring is verified */ }

// ---- open team members in terminal windows ---------------------------------------------------

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
  console.log(banner());
  const free = await healthy();
  const counts = free ? keyCounts() : [];
  const mem = await tdaiUp();
  const load = poolLoad();
  const busy = (n) => c.gray(` · ${load[n].running}/${load[n].capacity}`);
  console.log(title(`${t("Havuzlar")}${SETTINGS.mesai ? c.gray(` · ${t("mesai modu açık")}`) : ""}`));
  console.log(rows([
    [`${dot(free ? (counts.length > 1 ? "ok" : "warn") : "bad")} freellmapi`, free ? `${counts.length} ${t("sağlayıcı")} ${c.gray(counts.map(([p, n]) => `${p}×${n}`).join(" "))}${busy("free")}` : c.red(t("kapalı (ekip up)"))],
    ...Object.entries(AGENTS).filter(([, a]) => !a.hidden?.()).map(([n, a]) => {
      const st = SETTINGS.agents?.[n];
      const state = !has(a.bin) ? "off" : st?.ok ? "ok" : st ? "bad" : "warn";
      const label = !has(a.bin) ? c.gray(t("kurulu değil")) : st?.ok ? c.green(t("hazır")) : st ? c.red(a.login ? `${t("giriş gerekiyor")} → ekip agents login ${n}` : t("çalışmıyor → ekip agents test")) : c.yellow(t("denenmedi"));
      return [`${dot(state)} ${n}`, `${label}${st?.ok && has(a.bin) ? busy(n) : ""} ${c.gray(t(a.quota))}`];
    }),
    [`${dot("ok")} claude`, `${c.green(t("hazır"))}${load.claude.capacity ? busy("claude") : ""} ${c.gray(t("aboneliğin (lead)"))}`],
  ]));
  console.log(fit(`  ${c.gray(t("auto sırası:"))} ${autoOrder().map((x) => c.cyan(x)).join(c.gray(" → "))}`));

  console.log(title(t("Hafıza ve hub")));
  console.log(rows([
    [`${dot(mem ? "ok" : "bad")} TencentDB`, mem ? `${t("açık")} ${c.gray(REMOTE ? `VPS ${REMOTE.ssh} (${t("tünel")})` : t("yerel"))}` : c.red(t("kapalı"))],
    [`${dot(SETTINGS.hubUrl ? "ok" : "off")} panel`, SETTINGS.hubUrl ? c.under(SETTINGS.hubUrl) : c.gray(t("bağlı değil (ekip hub link)"))],
    [`${dot(registry().length ? "ok" : "off")} projeler`, `${registry().length} ${t("kayıtlı")} ${c.gray("(ekip project ls)")}`],
  ]));
  if (has("tmux")) {
    console.log(title(t("Ekip")));
    console.log(rows(Object.keys(TEAM).map((n) => [`${dot(tmuxHas(n) ? "ok" : "off")} ${n}`, tmuxHas(n) ? c.green(t("çalışıyor")) : c.gray(t("durdu"))])));
  }
  const recent = fs.readdirSync(RUNS).filter((f) => f.endsWith(".log")).sort().slice(-5).reverse();
  if (recent.length) {
    console.log(title(t("Son çalıştırmalar")));
    console.log(recent.map((f) => fit(`  ${c.gray(f.slice(0, 19).replace("T", " "))}  ${f.slice(25, -4)}`)).join("\n"));
  }
  try {
    const note = (await import("../lib/projects/skillgen.js")).statusCandidateNote();
    if (note) console.log(`${c.yellow("•")} ${note}`);
  } catch { /* status remains available if skill metadata is malformed */ }
  console.log("");
}

const HELP = () => lang === "en" ? `${banner()}

${c.bold("Everyday")}
  ${c.cyan("ekip")}                          lead Claude session (your subscription); delegates work
  ${c.cyan("ekip --free")}                   lead on free models (when Claude limits run out)
  ${c.cyan("ekip --safe")}                   ask before taking actions (default: automatic)
  ${c.cyan("ekip status")} ${c.gray("[--system]")}        what runs, waits for you, is stuck, finished; release (--system: pools, memory)
  ${c.cyan("ekip limits")}                   pool limits and where a new task will go
  ${c.cyan("ekip doctor")} ${c.gray("[--fix]")}           check and repair tunnel, pools, graph, wiki, memory
  ${c.cyan("ekip savings")}                  measure work routed outside Claude
  ${c.cyan("ekip stats")} ${c.gray("[project] [--days N] [--json]")} how memory, wiki, skills and code graph are used
  ${c.cyan("ekip statusline")} ${c.gray("[on|off]")} ekip's line under the Claude Code prompt (off removes it)
  ${c.cyan("ekip terminal")} ${c.gray("install [--dry-run]|open|status")} optional: ekip's own terminal (WezTerm, colours, fast panes)

${c.bold("Workers")}
  ${c.cyan("ekip run")} ${c.gray('[--via POOL|a,b,c] [--project NAME] [--model ID] [--plugin P] [--skill S] [--worktree] "task"')}
  ${c.cyan("ekip run")} ${c.gray('[--after ID | --when "CMD"] [--resume RUN] [--min-tier strong] [--heavy|--light] [--retry-on-kill]')}
  ${c.cyan("ekip review")} ${c.gray("[--project NAME] [--base REF] [--checks-only] [--via a,b] [--dry-run]")} review changes
  ${c.cyan("ekip review profile")} ${c.gray("NAME [--refresh]")} generate project review profile
  ${c.cyan("ekip clean")} ${c.gray("<id>")}               remove worktrees from a multi-pool race
  ${c.cyan("ekip mesai")} ${c.gray('on [--include-claude]|off|status|all "task"')} work shift: keep every ready pool busy
  ${c.cyan("ekip show")} ${c.gray("<log...>")}        open a live pane on any log
  ${c.cyan("ekip track")} ${c.gray('--task ID --label "what" [--total N|--measure "cmd"] [--stall MIN] [--eta-max MIN] -- CMD')} a long shell command as a watched job | ls | stop ID
  ${c.cyan("ekip show")} ${c.gray("<log...>")}           open a live pane on any log
  ${c.cyan("ekip agents")} ${c.gray("ls|install|login|test")} worker CLIs and quotas
  ${c.cyan("ekip team")} ${c.gray("up|down|ls|open [--open]")} persistent team members via hoptell
  ${c.cyan("ekip tasks")} ${c.gray("[--watch|--all]")}           live task tracker; task step supports --alive
  ${c.cyan("ekip task")} ${c.gray('block|wait ID "why" | unblock ID')} blocked / waiting for you, without a stall warning

${c.bold("Development environment")}
  ${c.cyan("ekip dev")} ${c.gray("init|ls|add|up|env|down|reset|sql|psql")} dev DB/Redis on Coolify

${c.bold("Projects and memory")}
  ${c.cyan("ekip project")} ${c.gray("add|remove|move|config|scan|ls|show|sync|card")}
  ${c.cyan("ekip project lesson")} ${c.gray('NAME "lesson"')}    a corrected mistake, added to every worker brief
  ${c.cyan("ekip memory")} ${c.gray("search|remember|ingest|import-history|reindex|compact|up|down|status|open")}
  ${c.cyan("ekip skill")} ${c.gray("ls|search|show|learn|prune|candidates|accept|reject")} project procedures

${c.bold("VPS hub")} ${c.gray("(works while your Mac is off)")}
  ${c.cyan("ekip job")} ${c.gray('"task" --project NAME [--via auto|copilot|free] | ls | show ID')}
  ${c.cyan("ekip hub")} ${c.gray("link|push|status|open")}    ${c.cyan("ekip remote")} ${c.gray("<ssh-host>")}    ${c.cyan("ekip tunnel")} ${c.gray("install|status")}
  ${c.cyan("ekip vps")} ${c.gray("add|token|status|sh|apps|deploy|logs|restart")}

${c.bold("Setup")}
  ${c.cyan("ekip init")}                     one-time setup
  ${c.cyan("ekip keys")} ${c.gray("[--all|apply]")}         free provider API keys (opens provider pages)
  ${c.cyan("ekip key")} ${c.gray("add|list")}  ${c.cyan("ekip up|down|logs")}
`.split("\n").map((line) => fit(line)).join("\n") : `${banner()}

${c.bold("Günlük")}
  ${c.cyan("ekip")}                          lead Claude oturumu (aboneliğin); işi kendisi dağıtır
  ${c.cyan("ekip --free")}                   lead ücretsiz modellerle (Claude limitin bitince)
  ${c.cyan("ekip --safe")}                   lead izin sorarak çalışsın (varsayılan: sormadan)
  ${c.cyan("ekip durum")} ${c.gray("[--system]")}         ne çalışıyor, senden ne bekleniyor, ne takıldı, ne bitti; yayın (--system: havuzlar, hafıza)
  ${c.cyan("ekip limits")}                   hangi havuz limitte, yeni iş hangi modele gider
  ${c.cyan("ekip doctor")} ${c.gray("[--fix]")}           her şeyi kontrol et (ve onar): tünel, havuzlar, graph, wiki, hafıza
  ${c.cyan("ekip savings")}                  Claude dışındaki işleri ölç
  ${c.cyan("ekip stats")} ${c.gray("[proje] [--days N] [--json]")} hafıza, wiki, beceri ve kod grafiği ne kadar kullanılıyor
  ${c.cyan("ekip terminal")} ${c.gray("install [--dry-run]|open|status")} isteğe bağlı: ekip'in kendi terminali (WezTerm, renkli, hızlı bölmeler)

${c.bold("İşçiler")}
  ${c.cyan("ekip run")} ${c.gray('[--via POOL|a,b,c] [--project NAME] [--model ID] [--plugin P] [--skill S] [--worktree] "iş"')}
  ${c.cyan("ekip run")} ${c.gray('[--after ID | --when "KOMUT"] [--resume RUN] [--min-tier strong] [--heavy|--light] [--retry-on-kill]')}
  ${c.cyan("ekip review")} ${c.gray("[--project NAME] [--base REF] [--checks-only] [--via a,b] [--dry-run]")} ${t("değişiklikleri denetle")}
  ${c.cyan("ekip review profile")} ${c.gray("NAME [--refresh]")} ${t("inceleme profili oluştur")}
  ${c.cyan("ekip clean")} ${c.gray("<id>")}               çoklu havuz yarışının worktree'lerini sil
  ${c.cyan("ekip mesai")} ${c.gray('on [--include-claude]|off|status|all "iş"')} mesai modu: tüm hazır havuzlar aynı anda çalışsın
  ${c.cyan("ekip show")} ${c.gray("<log...>")}        logları canlı izleyen panel aç
  ${c.cyan("ekip track")} ${c.gray('--task ID --label "ne" [--total N|--measure "komut"] [--stall DK] [--eta-max DK] -- KOMUT')} uzun kabuk komutu izlenen iş olarak | ls | stop ID
  ${c.cyan("ekip agents")} ${c.gray("ls|install|login|test")} işçi CLI'ları ve kotaları
  ${c.cyan("ekip team")} ${c.gray("up|down|ls|open [--open]")} hoptell üzerinden kalıcı ekip üyeleri
  ${c.cyan("ekip tasks")} ${c.gray("[--watch|--all]")}           canlı görev takibi; task step --alive
  ${c.cyan("ekip task")} ${c.gray('block|wait ID "neden" | unblock ID')} engellendi / kullanıcı bekleniyor, takıldı uyarısı yok

${c.bold("Geliştirme ortamı")}
  ${c.cyan("ekip dev")} ${c.gray("init|ls|add|up|env|down|reset|sql|psql")} Coolify üzerinde dev DB/Redis

${c.bold("Projeler ve hafıza")}
  ${c.cyan("ekip project")} ${c.gray("add|remove|move|config|scan|ls|show|sync|card")}
  ${c.cyan("ekip project lesson")} ${c.gray('NAME "ders"')}      düzeltilen bir hata, her işçi brief'ine eklenir
  ${c.cyan("ekip memory")} ${c.gray("search|remember|ingest|import-history|reindex|compact|up|down|status|open")}
  ${c.cyan("ekip skill")} ${c.gray("ls|search|show|learn|prune|candidates|accept|reject")} proje prosedürleri

${c.bold("VPS hub")} ${c.gray("(Mac kapalıyken de çalışır)")}
  ${c.cyan("ekip job")} ${c.gray('"iş" --project NAME [--via auto|copilot|free] | ls | show ID')}
  ${c.cyan("ekip hub")} ${c.gray("link|push|status|open")}    ${c.cyan("ekip remote")} ${c.gray("<ssh-host>")}    ${c.cyan("ekip tunnel")} ${c.gray("install|status")}
  ${c.cyan("ekip vps")} ${c.gray("add|token|status|sh|apps|deploy|logs|restart")}

${c.bold("Kurulum")}
  ${c.cyan("ekip init")}                     tek seferlik kurulum
  ${c.cyan("ekip keys")} ${c.gray("[--all|apply]")}         ücretsiz sağlayıcı anahtarları (sayfaları açar)
  ${c.cyan("ekip key")} ${c.gray("add|list")}  ${c.cyan("ekip up|down|logs")}
`.split("\n").map((line) => fit(line)).join("\n");

// ekip's own commands, read from the dispatch below so the list never goes stale.
const COMMANDS = [...new Set([...fs.readFileSync(fileURLToPath(import.meta.url), "utf8").matchAll(/case "([a-z][a-z-]*)":/g)].map((m) => m[1]))];

// Claude Code's own flags (from `claude --help`, cached for a day): those go to the lead session
// even when they look like an ekip command (`--agents`, `--debug`).
function claudeFlags() {
  const file = path.join(HOME, "claude-flags.json");
  try { const c = JSON.parse(fs.readFileSync(file, "utf8")); if (Date.now() - c.at < 86400_000) return new Set(c.flags); } catch { /* refresh */ }
  const out = spawnSync("claude", ["--help"], { encoding: "utf8", timeout: 10000 }).stdout ?? "";
  const flags = [...new Set([...out.matchAll(/(?:^|[\s,])--?([a-zA-Z][\w-]*)/gm)].map((m) => m[1]))];
  try { fs.writeFileSync(file, JSON.stringify({ at: Date.now(), flags })); } catch { /* read-only data dir */ }
  return new Set(flags);
}

const distance = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const nearest = (word) => COMMANDS.map((x) => [x, distance(word, x)]).filter(([x, n]) => n <= Math.max(1, Math.floor(x.length / 3))).sort((a, b) => a[1] - b[1])[0]?.[0];

// `ekip -help`, `ekip --status`, `ekip -doctor`: a dashed ekip command runs that command; a dashed
// word close to one (`--stats`) gets a suggestion instead of a Claude "unknown option" error.
let [cmd, ...rest] = process.argv.slice(2);
if (cmd?.startsWith("-") && !["--free", "--safe", "--member", "-h", "--help"].includes(cmd)) {
  const word = cmd.replace(/^-+/, "").split("=")[0];
  const flags = claudeFlags();
  // Claude's long flags always take two dashes, so `-status` / `-help` can only mean ekip.
  const ours = !cmd.startsWith("--") && word.length > 1;
  if (COMMANDS.includes(word) && (ours || !flags.has(word))) cmd = word;
  else if ((ours || !flags.has(word)) && nearest(word)) die(`${cmd} tanınmadı. Bunu mu demek istedin: ekip ${nearest(word)}  (tüm komutlar: ekip help)`);
}
let code = 0;
switch (cmd) {
  case "run": code = await run(rest); await (await import("../lib/workers/limits.js")).push().catch(() => {}); break;
  // a usage problem (no registered project, unknown option) is a message, not a stack trace
  case "review": try { code = await (await import("../lib/review/review.js")).main(rest); } catch (e) { die(e.message); } break;
  case "clean": clean(rest); break;
  case "mesai": code = await mesai(rest); if (rest[0] === "all") await (await import("../lib/workers/limits.js")).push().catch(() => {}); break;
  case "watch": await watch(rest); break;
  case "update": code = (await import("../lib/ops/update.js")).update(); break;
  case "version": { const u = (await import("../lib/ops/update.js")).checkUpdate({ maxAgeH: 0 }); console.log(`ekip ${u.local}${u.behind ? `  (yeni sürüm ${u.latest}: ekip update)` : u.latest ? "  (güncel)" : ""}`); break; }
  // ekip show LOG...: a long job started outside `ekip run` (an import, a render, a script) gets the
  // same live pane next to the lead, so nothing runs out of sight.
  case "show": {
    // --pid PID: the job keeps running when the worker that started it is stopped (killTree skips it)
    const pidAt = rest.indexOf("--pid"), keepPid = pidAt >= 0 ? Number(rest[pidAt + 1]) : null;
    if (pidAt >= 0) {
      if (!keepPid) die("kullanım: ekip show --pid <PID> <log>");
      const f = path.join(HOME, "detached.json");
      let list = [];
      try { list = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* first one */ }
      list = list.filter((x) => { try { process.kill(x.pid, 0); return true; } catch { return false; } });
      list.push({ pid: keepPid, at: new Date().toISOString(), run: process.env.EKIP_PARENT_RUN ?? null });
      fs.writeFileSync(f, JSON.stringify(list));
      rest.splice(pidAt, 2);
    }
    const files = rest.filter((f) => !f.startsWith("-")).map((f) => path.resolve(f));
    if (!files.length) die("kullanım: ekip show [--pid PID] <log> [log...]  (logları canlı izleyen bir panel açar)");
    openPane(`tail -n 40 -F ${files.map((f) => JSON.stringify(f)).join(" ")}`, { title: `ekip · ${rest.find((x) => x.startsWith("--title="))?.slice(8) ?? path.basename(files[0])}` });
    break;
  }
  // ekip track [...] -- CMD: a long shell command as a watched job tied to a task step (workers/track.js)
  case "track": code = (await (await import("../lib/workers/track.js")).main(rest)) ?? 0; break;
  case "skill": case "skills": {
    const [sub = "ls", proj, ...q] = rest;
    const gen = await import("../lib/projects/skillgen.js");
    if (sub === "learn") { await gen.learn(rest.slice(1)); break; }
    if (sub === "prune") { await gen.prune(rest.slice(1)); break; }
    if (sub === "candidates") { gen.candidates(); break; }
    if (sub === "accept") { gen.accept(proj, q[0]); break; }
    if (sub === "reject") { gen.reject(proj, q[0]); break; }
    const mem = await import("../lib/memory/memory.js");
    const pName = proj ?? registry().filter((x) => process.cwd().startsWith(x.path)).sort((a, b) => b.path.length - a.path.length)[0]?.name;
    if (!pName) die("usage: ekip skill ls|search|show <project> [query|name]");
    if (sub === "ls") for (const sk of await mem.projectSkills(pName)) console.log(`${c.cyan(sk.name)}  ${c.gray(sk.description ?? "")}`);
    else if (sub === "search") for (const sk of await mem.skillSearch(pName, q.join(" "), 5)) console.log(`${c.cyan(sk.name)}  ${c.gray(sk.description ?? "")}`);
    else if (sub === "show") { const sk = await mem.skillGet(pName, q.join(" ")); console.log(`# ${sk.name}\n${sk.description ?? ""}\n\n${sk.content}`); }
    else die("usage: ekip skill ls|search|show <project> [query|name]; learn|prune [project|--all]; candidates; accept|reject <project> <name>");
    break;
  }
  case "doctor": await reconcileRuns().catch(() => {});
    await (await import("../lib/projects/skillgen.js")).doctorLearnOnceDaily().catch(() => {});
    code = await (await import("../lib/ops/doctor.js")).main(rest);
    // refresh the limits snapshot on the hub (doctor runs every 30 min via launchd), and resend
    // task states the hub missed
    await (await import("../lib/workers/limits.js")).push().catch(() => {});
    await (await import("../lib/tasks/tasks.js")).syncHub().catch(() => {});
    await heartbeat();
    try { (await import("../lib/ops/update.js")).autoUpdate(); } catch { /* offline */ }
    await (await import("../lib/workers/savings.js")).report(["--json", "--silent"]).catch(() => {});
    await (await import("../lib/memory/usage.js")).push().catch(() => {}); break;
  case "limits": case "limitler": await (await import("../lib/workers/limits.js")).main(rest); break;
  case "savings": await (await import("../lib/workers/savings.js")).report(rest); break;
  case "statusline": code = await (await import("../lib/ops/statusline.js")).main(rest); break;
  case "terminal": code = (await (await import("../lib/ops/terminal.js")).main(rest)) ?? 0; break;
  case "stats": code = await (await import("../lib/memory/usage.js")).main(rest); break;
  case "reconcile": console.log(`${await reconcileRuns()} kayıp çalıştırma kapatıldı`); break;
  case "task": case "tasks": {
    const t = await import("../lib/tasks/tasks.js");
    try { t.reapDead(); t.reapStale(); } catch { /* never block a task command */ }
    if (cmd === "tasks" && rest[0] === "sync") { await reconcileRuns().catch(() => {}); console.log(`${await t.syncHub()} görev panele gönderildi`); await (await import("../lib/workers/limits.js")).push().catch(() => {}); break; }
    if (cmd === "task" && rest[0] === "new") {
      // A new task reopens the live task pane if the user closed it (iTerm2).
      await t.main(rest);
      ensureTaskPane();
    } else await t.main(cmd === "tasks" && !rest.length ? ["ls"] : rest);
    break;
  }
  case "agents": await agentsMain(rest); break;
  case "job": case "jobs": await job(rest); break;
  case "hub": await hub(rest); break;
  case "vps": await vpsMain(rest); break;
  case "dev": await (await import("../lib/dev/dev.js")).main(rest); break;
  case "tunnel": tunnel(rest); break;
  case "project": case "projects": code = (await (await import("../lib/projects/projects.js")).main(rest)) ?? 0; break;
  case "mcp": code = (await (await import("../lib/memory/mcp.js")).main(rest)) ?? 0; break;
  case "hook": code = (await (await import("../lib/memory/hooks.js")).main(rest)) ?? 0; break;
  case "remote": await remote(rest); break;
  case "key": await key(rest); break;
  case "keys":
    if (rest[0] === "apply") { await restartFree(); console.log(keyCounts().map(([p, c]) => `${p}×${c}`).join(", ")); }
    else if (rest[0] && rest[0] !== "--all") await key(rest);
    else await keyWizard({ all: rest[0] === "--all" });
    break;
  // the work digest; --system: pools, memory, panel and recent runs
  case "status": case "durum": if (rest.includes("--system") || rest.includes("--sistem")) await status(); else code = await (await import("../lib/tasks/digest.js")).main(rest); break;
  case "init": case "setup": await init({ skipKeys: rest.includes("--no-keys") }); break;
  case "memory": await memory(rest); break;
  case "team": await team(rest); break;
  case "up": await up(); break;
  case "down": await down(); console.error("ekip: freellmapi stopped"); break;
  case "logs": spawnSync("tail", ["-n", "60", LOG], { stdio: "inherit" }); break;
  case "help": case "-h": case "--help": process.stdout.write(HELP()); break;
  default:
    // Only flags (or nothing) start the lead session; an unknown word is a typo, not a prompt.
    if (cmd && !cmd.startsWith("-")) die(nearest(cmd) ? `bilinmeyen komut: ${cmd}. Bunu mu demek istedin: ekip ${nearest(cmd)}  (tüm komutlar: ekip help)` : `bilinmeyen komut: ${cmd}  (tüm komutlar: ekip help)`);
    code = await lead(cmd ? [cmd, ...rest] : []);
}
// Let hub pushes started by this command finish (task updates, run reports) before exiting.
try { const { pending } = await import("../lib/tasks/tasks.js"); await Promise.race([Promise.allSettled([...pending]), sleep(5000)]); } catch { /* none */ }
process.exit(code);
