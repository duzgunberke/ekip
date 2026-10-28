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
  CONFIG, DB, DEPS, FREELLMAPI_REPO, FREE_CLAUDE_HOME, FREE_DIR, FREE_NODE, HOME, KEYLESS, LOG, PID, PORT, REPO, RUNS, SETTINGS, SETTINGS_FILE, TDAI_PORTS, URL_ROOT, VENDOR, adminKey, ask, clone, containerRunning, depDir, die, down, has, healthy, key, keyCounts, openTerminal, openUrl, readConfig, saveSettings, sh, sleep, sql, tdaiDeploy, tdaiUp, unifiedKey, up, writeConfig,
} from "../lib/core.js";
import { POINTER, REMOTE, ROOT, TUNNEL_LABEL, restartFree, ssh } from "../lib/core.js";
import { AGENTS, autoOrder, main as agentsMain } from "../lib/agents.js";
import { main as vpsMain } from "../lib/vps.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    const v = await ask("   key: ").catch(() => "q");
    if (v === "q") break;
    if (!v) continue;
    if (p.platform === "cloudflare" && !v.includes(":")) { console.log("   skipped: Cloudflare needs ACCOUNT_ID:API_TOKEN"); continue; }
    const n = cfg.keys.filter((k) => k.platform === p.platform).length;
    cfg.keys.push({ platform: p.platform, key: v, label: `ekip-${n + 1}` });
    writeConfig(cfg);
    added++;
  }
  if (!added) return;
  await restartFree();
  const counts = Object.fromEntries(keyCounts());
  for (const p of PROVIDERS) if (cfg.keys.some((k) => k.platform === p.platform)) console.log(`${p.label}: ${counts[p.platform] ? "active" : "NOT accepted, see ekip logs"}`);
}

// ---- environments of the two non-subscription pools --------------------------------------------

async function freeEnv(project = null) {
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

function parseRun(args) {
  const o = { via: "auto", cwd: process.cwd(), model: null, task: null, plugins: [], skills: [], project: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--via") o.via = args[++i];
    else if (a === "--cwd") o.cwd = path.resolve(args[++i]);
    else if (a === "--model") o.model = args[++i];
    else if (a === "--plugin") o.plugins.push(args[++i]);
    else if (a === "--skill") o.skills.push(args[++i]);
    else if (a === "--project") o.project = args[++i];
    else if (a === "-") o.task = fs.readFileSync(0, "utf8");
    else if (o.task == null) o.task = a;
    else o.task += ` ${a}`;
  }
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

// The project registry (written by `ekip project add`); empty until projects are registered.
function registry() {
  const f = path.join(HOME, "projects.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; }
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

// --plugin NAME: an installed Claude Code plugin; --skill NAME: a skill under ~/.claude/skills,
// wrapped as a one-skill plugin so --bare sessions can load it with --plugin-dir.
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
    const src = path.join(os.homedir(), ".claude/skills", name);
    if (!fs.existsSync(path.join(src, "SKILL.md"))) die(`no skill ${name} in ~/.claude/skills`);
    const pack = path.join(HOME, "skillpacks", name);
    fs.mkdirSync(path.join(pack, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pack, "skills"), { recursive: true });
    fs.writeFileSync(path.join(pack, ".claude-plugin/plugin.json"), JSON.stringify({ name: `skill-${name}`, version: "0.0.0", description: `ekip wrapper for the ${name} skill` }));
    const link = path.join(pack, "skills", name);
    if (!fs.existsSync(link)) fs.symlinkSync(src, link);
    dirs.push(pack);
  }
  return dirs.flatMap((d) => ["--plugin-dir", d]);
}

async function runVia(via, o, logFile) {
  const prompt = `${WORKER_BRIEF}\n${o.task}`;
  if (AGENTS[via]) {
    const a = AGENTS[via];
    if (!has(a.bin)) return { code: 127, out: `${a.bin} is not installed (ekip agents install ${via})` };
    if (a.free) await up({ quiet: true });
    const model = o.model ?? (via === "agy" ? process.env.EKIP_AGY_MODEL : null);
    return runChild(a.bin, a.argv(prompt, { ...o, model }), { cwd: o.cwd }, logFile);
  }
  if (via === "claude") {
    // Your own subscription with your full setup (skills, plugins, MCP): for the hard parts.
    const argv = ["-p", prompt, "--permission-mode", "bypassPermissions", ...pluginDirs(o)];
    if (o.model) argv.push("--model", o.model);
    return runChild("claude", argv, { cwd: o.cwd }, logFile);
  }
  const env = await freeEnv(o.project);
  env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (o.model) Object.assign(env, { ANTHROPIC_MODEL: o.model, ANTHROPIC_DEFAULT_SONNET_MODEL: o.model, ANTHROPIC_DEFAULT_OPUS_MODEL: o.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: o.model });
  // --bare: no user hooks, plugins or memory, so the free models get a small, plain context.
  const argv = ["--bare", "-p", prompt, "--permission-mode", "bypassPermissions", ...pluginDirs(o)];
  return runChild("claude", argv, { cwd: o.cwd, env }, logFile);
}

const git = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

async function runOne(o, via, id) {
  const logFile = path.join(RUNS, `${id}.log`);
  fs.writeFileSync(logFile, `cwd: ${o.cwd}\nproject: ${o.project ?? "-"}\ntask:\n${o.task}\n\n`);
  const order = via === "auto" ? autoOrder() : [via];
  let last = null;
  for (const v of order) {
    process.stderr.write(`ekip: worker via ${v} in ${o.cwd} (log: ${logFile})\n`);
    try { last = await runVia(v, o, logFile); } catch (e) { last = { code: 1, out: String(e?.message ?? e) }; }
    if (!failed(last)) return { ok: true, via: v, out: last.out.trim(), logFile };
    process.stderr.write(`ekip: ${v} failed (exit ${last.code}): ${last.out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}\n`);
  }
  return { ok: false, via, out: last?.out.trim() ?? "", logFile };
}

async function run(args) {
  const o = parseRun(args);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${o.vias.join("+")}`;
  if (o.vias.length === 1) {
    const r = await runOne(o, o.vias[0], id);
    process.stdout.write(`[ekip worker: ${r.ok ? r.via : "all pools failed"}]\n${r.out}\n`);
    report({ id, via: r.via, project: o.project, task: o.task, status: r.ok ? "done" : "failed", report: r.out.slice(-4000) });
    return r.ok ? 0 : 1;
  }
  // Several pools on the same task: each gets its own git worktree and branch, so they cannot
  // collide; you (or the lead) compare the branches and merge the best one.
  const top = git(o.cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (!top) die("running several pools on one task needs a git repository (each gets its own worktree)");
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
    report({ id: `${id}-${r.via}`, via: r.via, project: o.project, task: o.task, status: r.ok ? "done" : "failed", report: r.out.slice(-4000) });
  }
  process.stdout.write(`\nCompare: git diff HEAD...<branch>. Keep one: git merge <branch>. Clean up: ekip clean ${short}\n`);
  return results.some((r) => r.ok) ? 0 : 1;
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
  spawnSync("docker", ["rm", "-f", "tdai-proxy", "tdai-memory-hub", "tdai-memory-core"], { stdio: "ignore" });
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
  if (sub === "link") {
    if (!url || !token) die("usage: ekip hub link <https://ai.sazora.io> <token>");
    saveSettings({ hubUrl: url.replace(/\/$/, ""), hubToken: token });
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
      tdai: p.tdai ? { teamId: p.tdai.teamId, agentId: p.tdai.agentId, wikiId: p.tdai.wikiId, codeGraphId: p.tdai.codeGraphId } : undefined,
    }));
    const r = await hubFetch("/api/projects", { method: "PUT", body: JSON.stringify({ projects, replace: true }) });
    console.log(`pushed ${projects.length} projects to ${SETTINGS.hubUrl} (${r.count} on the hub)`);
  } else if (sub === "status" || !sub) console.log(JSON.stringify(await hubFetch("/api/status"), null, 2));
  else if (sub === "open") openUrl(SETTINGS.hubUrl ?? die("no hub linked"));
  else die("usage: ekip hub link <url> <token> | push | status | open");
}

// Runs are reported to the hub (when one is configured) so the panel shows Mac and VPS work together.
function report(run) {
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return;
  fetch(`${SETTINGS.hubUrl}/api/runs`, {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` },
    body: JSON.stringify({ ...run, host: os.hostname(), finishedAt: new Date().toISOString() }),
  }).catch(() => {});
}

// ---- the lead session -------------------------------------------------------------------------

const LEAD_PROMPT = `# ekip: you lead a team on other quotas
The user has Claude Max and wants YOUR effort spent on judgment: understanding, design, splitting,
integration and review. Hand everything well-scoped to workers that run on other accounts and
quotas, through the shell command \`ekip run\` (\`ekip agents\` shows which pools are usable):

| --via | what | use for |
|---|---|---|
| auto (default) | first usable of: agy, codex, copilot, qwen, opencode, grok, then free | most delegated work |
| agy | Antigravity (strong models, Google quota) | substantial coding, research |
| codex / copilot / qwen / opencode | other vendors' CLIs on their own quotas | same; a different model family |
| grok, free | harnesses on pooled free-tier models (freellmapi) | small, precise, mechanical tasks |
| claude | a headless Claude on the user's subscription with all their skills/plugins | hard or skill-heavy work you would otherwise do yourself |

- Options: \`--project NAME\` (a registered project; sets the folder and its memory) or \`--cwd DIR\`,
  \`--model ID\`, \`--plugin NAME\` / \`--skill NAME\` (load a Claude plugin or skill into a free/claude
  worker, e.g. \`--plugin lemo-opuscar\` for films, \`--skill blender-modeling\`). Long briefs: \`ekip run - <<'EOF' ... EOF\`.
- Several models on the same task: \`--via agy,codex,free\` runs each in its own git worktree and branch
  and prints each diffstat and report. Compare, \`git merge\` the best, then \`ekip clean <id>\`.
  Use it when quality matters or an approach is uncertain.
- A worker is headless with full file and shell access, cannot ask questions, prints a final report
  (transcripts in the ekip data folder). Brief it like a capable colleague with no context: goal,
  files, constraints, how to verify, what to report.
- Run independent workers in parallel (Bash run_in_background; you are notified on exit). Never two
  concurrent workers on the same files without worktrees.
- Review every result (git diff, tests) before you report. Re-dispatch with a sharper brief or fix it.
- Projects: \`ekip project ls\` / \`ekip project show NAME\` list the user's registered projects with
  their cards (stack, commands, frequent tasks). The ekip MCP tools search each project's memory,
  wiki and code graph; codegraph MCP explores code. Save durable facts with memory_remember.
- The hub on the user's VPS (panel https://ai.sazora.io) runs queued jobs even when this Mac is off:
  \`ekip job "<task>" --project NAME\` queues one (it works on a branch and pushes it).
- Long-lived peers: \`ekip team up --open\` starts ekip-agy/ekip-free as hoptell peers in their own
  terminal windows; message them with hoptell send_message.
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
  if (SETTINGS.hubUrl && SETTINGS.hubToken && !member) {
    fetch(`${SETTINGS.hubUrl}/api/heartbeat`, { method: "POST", signal: AbortSignal.timeout(4000), headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` }, body: JSON.stringify({ client: "mac", host: os.hostname(), agents: autoOrder() }) }).catch(() => {});
  }
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
    await (await import("../lib/projects.js")).main(["scan", "--days", "30", "--yes"]);
  }
  console.log("\nDone. Open a new terminal and run: ekip");
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
  });
  patchTdaiScripts(dir);
  setEnvValues(env, { CODE_SOURCE_ENABLED: "gongfeng" });
  if (["tdai-memory-core", "tdai-memory-hub", "tdai-proxy"].every(containerRunning)) { console.log("memory stack already running"); return; }
  // start-all.sh probes the LLM from the host, where host.docker.internal does not resolve; the
  // three service scripts it wraps need no probe.
  for (const script of ["start-memory-core.sh", "start-memory-hub.sh", "start-proxy.sh"]) {
    sh(`./${script}`, [], { cwd: dir, env: { ...process.env, PROXY_FULL_STACK: "1" } });
  }
}

// TencentDB's hub script passes a fixed list of env vars; private GitHub code graphs need the
// "gongfeng" code source (https clone with a token), so add that variable to the list.
export function patchTdaiScripts(dir) {
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
async function importHistory() {
  const key = adminKey() ?? die("no TencentDB admin key");
  const tdai = depDir("tdai");
  const importer = path.join(tdai, "agents/asset-import.ts");
  if (!fs.existsSync(importer)) die(`TencentDB is not cloned at ${tdai}`);
  const { identity } = await import("../lib/memory.js");
  const me = await identity();
  const base = path.join(os.homedir(), ".claude/projects");
  const projects = registry();
  const stateFile = path.join(HOME, "memory-state/asset-import.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const plan = [];
  for (const dir of fs.readdirSync(base)) {
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
      env: { ...process.env, HOME: shadow, PANEL_URL: `http://127.0.0.1:${TDAI_PORTS.panel}`, TDAI_SERVICE_ID: "default", TDAI_USER_KEY: key },
    });
  }
}

async function memory([sub = "status", ...rest]) {
  if (sub === "import-history") return importHistory();
  if (!["up", "down", "status", "open"].includes(sub)) return (await import("../lib/memory.js")).main([sub, ...rest]);
  if (REMOTE && sub !== "open") {
    const dir = `${REMOTE.dir}/tdai/deploy/global-images`;
    const cmd = sub === "up" ? `cd ${dir} && ./start-memory-core.sh && ./start-memory-hub.sh && PROXY_FULL_STACK=1 ./start-proxy.sh`
      : sub === "down" ? `cd ${dir} && ./stop-all.sh`
      : "docker ps --format '{{.Names}}: {{.Status}}' | grep -E '^(tdai-|ekip-hub|freellmapi)'";
    const r = ssh(cmd, { stdio: sub === "status" ? "pipe" : "inherit" });
    if (sub === "status") console.log(`on ${REMOTE.ssh}:\n${r.stdout.trim() || "nothing running"}`);
    return;
  }
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
  case "clean": clean(rest); break;
  case "agents": await agentsMain(rest); break;
  case "job": case "jobs": await job(rest); break;
  case "hub": await hub(rest); break;
  case "vps": await vpsMain(rest); break;
  case "tunnel": tunnel(rest); break;
  case "project": case "projects": code = (await (await import("../lib/projects.js")).main(rest)) ?? 0; break;
  case "mcp": code = (await (await import("../lib/mcp.js")).main(rest)) ?? 0; break;
  case "hook": code = (await (await import("../lib/hooks.js")).main(rest)) ?? 0; break;
  case "remote": await remote(rest); break;
  case "key": await key(rest); break;
  case "keys":
    if (rest[0] === "apply") { await restartFree(); console.log(keyCounts().map(([p, c]) => `${p}×${c}`).join(", ")); }
    else if (rest[0] && rest[0] !== "--all") await key(rest);
    else await keyWizard({ all: rest[0] === "--all" });
    break;
  case "status": await status(); break;
  case "init": case "setup": await init({ skipKeys: rest.includes("--no-keys") }); break;
  case "memory": await memory(rest); break;
  case "team": await team(rest); break;
  case "up": await up(); break;
  case "down": await down(); console.error("ekip: freellmapi stopped"); break;
  case "logs": spawnSync("tail", ["-n", "60", LOG], { stdio: "inherit" }); break;
  case "help": case "-h": case "--help": process.stdout.write(HELP); break;
  default:
    // Only flags (or nothing) start the lead session; an unknown word is a typo, not a prompt.
    if (cmd && !cmd.startsWith("-")) die(`unknown command ${cmd} (ekip help)`);
    code = await lead(cmd ? [cmd, ...rest] : []);
}
process.exit(code);
