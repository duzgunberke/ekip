// Worker agent CLIs ekip can dispatch to. Each one runs on its own account and quota, so the more
// of them are logged in, the longer the work goes on without touching your Claude limit.
// `ekip agents` lists them; install and login are one command each; `test` probes a real prompt
// and marks the agent usable for --via auto.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DB, HOME, REMOTE, SETTINGS, URL_ROOT, die, has, keyCounts, saveSettings, unifiedKey, up } from "../core/core.js";
import { c, dot, fit } from "../core/ui.js";
import { t } from "../core/i18n.js";

const model = (o, flag = "--model") => (o.model ? [flag, o.model] : []);
const qwenOAuth = () => fs.existsSync(path.join(os.homedir(), ".qwen/oauth_creds.json"));

/**
 * name: { bin, pkg (npm, global), quota, login (interactive command), argv(prompt, o) -> args,
 *         env?(o) -> extra env, free? (runs on freellmapi) }
 * Flags checked against each CLI's --help (codex 0.165, gemini 0.66, qwen 0.26, opencode 1.19,
 * copilot 1.0, grok-cli 0.0.34, agy).
 */
export const AGENTS = {
  agy: {
    bin: "agy", quota: "Antigravity (Google account)", login: ["agy"],
    argv: (p, o) => ["-p", p, "--dangerously-skip-permissions", "--print-timeout", process.env.EKIP_AGY_TIMEOUT ?? "0s", ...model(o)],
  },
  codex: {
    bin: "codex", pkg: "@openai/codex", quota: "ChatGPT plan (OpenAI)", login: ["codex", "login"],
    argv: (p, o) => ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", o.cwd, ...model(o), p],
  },
  // Only with an API key: the personal Google tier is Antigravity (agy) now.
  gemini: {
    hidden: () => !process.env.GEMINI_API_KEY,
    bin: "gemini", pkg: "@google/gemini-cli", quota: "Gemini API key (GEMINI_API_KEY; the personal free tier moved to agy)", login: null,
    argv: (p, o) => ["-p", p, "--yolo", "--skip-trust", ...model(o)],
  },
  copilot: {
    bin: "copilot", pkg: "@github/copilot", quota: "GitHub Copilot (free tier or plan)", login: ["copilot"],
    argv: (p, o) => ["-p", p, "--allow-all-tools", "--allow-all-paths", ...model(o)],
  },
  qwen: {
    // Qwen's own free tier once you sign in (`qwen`, then /auth); until then Qwen Code runs on the
    // free pool, which makes it one more harness there.
    bin: "qwen", pkg: "@qwen-code/qwen-code", login: ["qwen"],
    get quota() { return qwenOAuth() ? "Qwen account (Qwen OAuth)" : "free pool via freellmapi (sign in with `qwen` → /auth for Qwen's own tier)"; },
    get free() { return !qwenOAuth(); },
    argv: (p, o) => ["-p", p, "--yolo", ...(qwenOAuth() ? ["--auth-type", "qwen-oauth", ...model(o)] : ["--auth-type", "openai", "--openai-api-key", unifiedKey(), "--openai-base-url", `${URL_ROOT}/v1`, "-m", o.model ?? "auto"])],
  },
  opencode: {
    bin: "opencode", pkg: "opencode-ai", quota: "OpenCode (its free models or your providers)", login: ["opencode", "auth", "login"],
    argv: (p, o) => ["run", "--auto", ...model(o, "-m"), p],
  },
  // jcode (Rust harness, ~60 MB per session instead of ~600): optional, on the free pool through a jcode
  // provider profile that points at freellmapi (jcodeProfile, default "ekip-freellmapi"). Hidden unless
  // its binary is found ("jcodeBin" in data/config.json, or jcode on PATH).
  jcode: {
    hidden: () => !has(SETTINGS.jcodeBin ?? "jcode"),
    get bin() { return SETTINGS.jcodeBin ?? "jcode"; },
    quota: "free pool via freellmapi, light harness (jcode)", login: null, free: true,
    env: { JCODE_RUN_MCP: "0", JCODE_RUN_AUTO_POKE: "0" },
    argv: (p, o) => ["--quiet", "--no-update", "--no-selfdev", "--provider-profile", SETTINGS.jcodeProfile ?? "ekip-freellmapi", "--model", o.model ?? "auto", "run", "--ndjson", p],
    // the NDJSON stream ends with {"type":"done","text":…}; failures come as {"type":"error"}
    parse: (out) => { let text = ""; for (const l of out.split("\n")) { try { const e = JSON.parse(l); if (e.type === "done" && e.text) text = e.text; else if (e.type === "error" && !text) text = `error: ${e.message ?? e.error ?? l}`; } catch { /* not an event */ } } return text; },
  },
  grok: {
    // grok-cli speaks any OpenAI-compatible API, so it doubles as a second harness on the free pool.
    bin: "grok", pkg: "@vibe-kit/grok-cli", quota: "free pool via freellmapi (or GROK_API_KEY for xAI)", login: null, free: !process.env.GROK_API_KEY,
    argv: (p, o) => ["-p", p, "-d", o.cwd, ...(process.env.GROK_API_KEY ? model(o) : ["-u", `${URL_ROOT}/v1`, "-k", unifiedKey(), "-m", o.model ?? "auto"])],
  },
};

const state = () => SETTINGS.agents ?? {};
const setState = (name, patch) => saveSettings({ agents: { ...state(), [name]: { ...state()[name], ...patch } } });

// Per-pool outcomes of real runs (data/pool-stats.json), so --via auto learns which pools deliver.
const STATS = () => path.join(HOME, "pool-stats.json");
const readStats = () => { try { return JSON.parse(fs.readFileSync(STATS(), "utf8")); } catch { return {}; } };

/** Called after every worker run: success, duration, last failure time (last 50 per pool). */
export function recordStat(via, ok, ms) {
  const all = readStats();
  const s = all[via] ??= { runs: [] };
  s.runs = [...s.runs, { ok, ms, at: Date.now() }].slice(-50);
  if (!ok) s.lastFailAt = Date.now();
  fs.writeFileSync(STATS(), JSON.stringify(all));
}

/** Success rate of the last runs (neutral 0.7 with no history) and whether it failed just now. */
export function poolScore(via) {
  const s = readStats()[via];
  const runs = s?.runs ?? [];
  const rate = runs.length ? runs.filter((r) => r.ok).length / runs.length : 0.7;
  const cooling = !!s?.lastFailAt && Date.now() - s.lastFailAt < 15 * 60 * 1000;
  return { rate, cooling, runs: runs.length, avgMin: runs.length ? Math.round(runs.reduce((a, r) => a + r.ms, 0) / runs.length / 60000) : null };
}

// Quota messages worth surfacing, newest log first; "Resets in 140h45m18s" gives the reopen time.
export const QUOTA = [
  /Individual quota reached[^\n"]*/, /You have no remaining credits[^\n"]*/, /exceeded your (?:current )?quota[^\n"]*/i,
  /usage limit[^\n"]*reached[^\n"]*/i, /RESOURCE_EXHAUSTED[^\n"]*/,
  // codex: "You've hit your usage limit. … try again at Nov 28th, 2026 2:43 PM."; copilot/others: premium or monthly caps
  /hit your usage limit[^\n"]*/i, /premium requests?[^\n"]*(?:limit|exhausted|exceeded|used up)[^\n"]*/i, /monthly (?:limit|quota)[^\n"]*(?:reached|exceeded)[^\n"]*/i,
];

// No reset time in the message: assume the quota is back this long after the failure.
const DEFAULT_COOLDOWN_MS = 6 * 3600_000;
const UNITS = { d: 86400, h: 3600, m: 60, s: 1 };

/** "Resets in 140h45m18s", "2h 45m", "5 days": milliseconds, or null when nothing parseable. */
export function parseResetIn(text) {
  const m = text.match(/Resets? in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i);
  if (!m) return null;
  let sec = 0;
  for (const u of m[1].matchAll(/(\d+)\s*([a-z]+)/gi)) sec += +u[1] * UNITS[u[2][0].toLowerCase()];
  return sec > 0 ? sec * 1000 : null;
}

// A run log split into its pool attempts: each `[ekip pool X]` mark starts one. Parsed segments are
// cached per file version (the same logs are read for every pool).
const segCache = new Map();
function logSegments(file, st) {
  const hit = segCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.segs;
  const fd = fs.openSync(file, "r");
  const len = Math.min(st.size, 64000), b = Buffer.alloc(len);
  try { fs.readSync(fd, b, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  const text = b.toString("utf8");
  const marks = [...text.matchAll(MARK_RE)];
  const only = poolFromName(path.basename(file));
  const segs = marks.length ? marks.map((m, i) => ({ via: m[1], text: text.slice(m.index + m[0].length, marks[i + 1]?.index) })) : only ? [{ via: only, text }] : [];
  segCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, segs });
  return segs;
}

/**
 * The pool's last quota error in its run logs, until a later attempt succeeds or the reset time
 * passes. A `--via auto` log holds several pools; each attempt counts for its own pool, by its own
 * [exit] line.
 */
export function lastQuotaHit(via) {
  const runs = path.join(HOME, "runs");
  let files = [];
  try { files = fs.readdirSync(runs).filter((f) => f.endsWith(".log")).sort().reverse().slice(0, 40); } catch { return null; }
  for (const f of files) {
    const file = path.join(runs, f);
    let st, segs;
    try { st = fs.statSync(file); segs = logSegments(file, st); } catch { continue; }
    for (const seg of segs.filter((x) => x.via === via).reverse()) {
      // Only a finished attempt counts: a running worker's log can quote these strings (code it
      // writes, logs it reads), and a later success clears the pool.
      const tail = `\n${seg.text}`;
      const exit = tail.match(/\n\[exit (-?\d+)\][^\n]*\s*$/)?.[1];
      if (exit == null) continue;
      const end = tail.slice(-4000);
      const hit = QUOTA.map((re) => end.match(re)?.[0]).find(Boolean);
      // exit 0 clears the pool, unless it is a short run that only reports the quota (as failed() sees it)
      if (exit === "0" && !(hit && seg.text.replace(/^\$[^\n]*\n/, "").length < 600)) return null;
      if (!hit) continue;
      const inMs = parseResetIn(tail);
      // "try again at Nov 28th, 2026 2:43 PM" (codex) is an absolute reopen time
      const at = tail.match(/try again at ([A-Z][a-z]{2,8} \d{1,2})(?:st|nd|rd|th)?,? (\d{4})(?: (\d{1,2}:\d{2} ?[AP]M))?/);
      const atMs = at ? Date.parse(`${at[1]} ${at[2]} ${at[3] ?? ""}`.trim()) : NaN;
      const parsed = inMs != null ? st.mtimeMs + inMs : Number.isFinite(atMs) ? atMs : null;
      const resetAt = parsed ?? st.mtimeMs + DEFAULT_COOLDOWN_MS;
      if (resetAt < Date.now()) return null;
      return { message: hit.slice(0, 140), at: new Date(st.mtimeMs).toISOString(), resetAt: new Date(resetAt).toISOString() };
    }
  }
  return null;
}

// How many workers each pool takes at once (mesai modu keeps them all busy); "poolConcurrency" in
// data/config.json overrides a pool. The headless Claude pool stays at 0 unless mesai includes it.
export const POOL_CONCURRENCY = { agy: 2, codex: 2, gemini: 1, copilot: 2, qwen: 1, opencode: 1, grok: 1, jcode: 3, free: 3, claude: 0 };

export function poolCapacity(via) {
  const own = SETTINGS.poolConcurrency?.[via];
  if (via === "claude" && own == null) return SETTINGS.mesai && SETTINGS.mesaiClaude ? 1 : 0;
  return Math.max(0, Number(own ?? POOL_CONCURRENCY[via] ?? 1));
}

// `ekip run` writes this line into its log each time it starts a pool, so a running `--via auto`
// log says which pool it is on.
export const poolMark = (via) => `[ekip pool ${via}]\n`;
const MARK_RE = /^\[ekip pool ([\w.-]+)\]$/gm;

// The pool in a log name without a mark: "<time>Z-codex.log", or "<time>Z-codex+agy-codex.log" for a race.
const poolFromName = (f) => {
  const v = f.slice(0, -4).split("Z-")[1] ?? "";
  const last = v.includes("-") ? v.slice(v.lastIndexOf("-") + 1) : v;
  return last && !last.includes("+") && last !== "auto" ? last : null;
};

/**
 * Workers running right now, per pool: run logs (data/runs) that end without an [exit] line and
 * whose `ekip run` process is still alive (logs without a pid count while written to recently).
 */
export function runningByPool(dir = path.join(HOME, "runs")) {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  const counts = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".log")); } catch { return counts; }
  for (const f of files) {
    const file = path.join(dir, f);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (Date.now() - st.mtimeMs > 6 * 3600_000) continue;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (/\n\[exit -?\d+\][^\n]*\s*$/.test(text)) continue;
    const pid = Number(text.match(/^pid: (\d+)$/m)?.[1]) || null;
    if (pid ? !alive(pid) : Date.now() - st.mtimeMs > 15 * 60_000) continue;
    const via = [...text.matchAll(MARK_RE)].at(-1)?.[1] ?? poolFromName(f);
    if (via) counts[via] = (counts[via] ?? 0) + 1;
  }
  return counts;
}

/** Running workers and capacity for every pool ekip can use (worker CLIs, free, claude). */
export function poolLoad(running = runningByPool()) {
  const names = [...Object.keys(AGENTS).filter((n) => !AGENTS[n].hidden?.()), "free", "claude"];
  return Object.fromEntries(names.map((n) => [n, { running: running[n] ?? 0, capacity: poolCapacity(n) }]));
}

// The free pool is ready when provider keys are configured (cheap local check, cached 30 s); the
// server itself is started on demand by the run.
let freeSeen = { at: 0, ok: false };
export function freeReady() {
  if (Date.now() - freeSeen.at < 30_000) return freeSeen.ok;
  let ok = false;
  try { ok = !!(REMOTE || fs.existsSync(DB)) && keyCounts({ timeout: 2000 }).length > 0; } catch { /* unreadable: not ready */ }
  freeSeen = { at: Date.now(), ok };
  return ok;
}

/** Pools that are signed in, tested and not out of quota (ignores how busy they are). */
export function readyPools() {
  const order = SETTINGS.autoOrder ?? ["agy", "codex", "gemini", "copilot", "qwen", "opencode", "jcode", "grok"];
  return order.filter((n) => AGENTS[n] && !AGENTS[n].hidden?.() && has(AGENTS[n].bin) && state()[n]?.ok && !lastQuotaHit(n));
}

/**
 * Agents for --via auto: those that passed `ekip agents test`, in the configured order, re-ranked
 * by their real success rate; a pool that failed in the last 15 minutes goes to the back, and one
 * whose quota ran out is left out until it resets. The free pool is always last. A pool already
 * running as many workers as its capacity is skipped, so parallel `ekip run --via auto` calls
 * spread over the pools (the free pool stays as the last fallback); when every pool is full, the
 * least busy ones come first.
 */
export function autoOrder() {
  const ranked = readyPools().map((n, i) => ({ n, i, ...poolScore(n) }))
    .sort((a, b) => (a.cooling - b.cooling) || (Math.round((b.rate - a.rate) * 5) - Math.round((a.rate - b.rate) * 5)) / 2 || a.i - b.i)
    .map((x) => x.n);
  // mesai --include-claude: the headless Claude joins as the last real pool before the free one
  const all = [...ranked, ...(poolCapacity("claude") > 0 ? ["claude"] : []), "free"];
  const running = runningByPool();
  const open = all.filter((n) => (running[n] ?? 0) < poolCapacity(n));
  // the free pool stays the last resort even when full: it is only reached when the others fail
  if (open.length) return open.includes("free") ? open : [...open, "free"];
  const load = (n) => (running[n] ?? 0) / Math.max(1, poolCapacity(n));
  return all.filter((n) => n !== "claude").map((n, i) => ({ n, i })).sort((a, b) => load(a.n) - load(b.n) || a.i - b.i).map((x) => x.n);
}

/** Ready pools with a free slot right now (for `ekip mesai all`): worker CLIs, then claude, then free (when it has keys). */
export function freePools() {
  const running = runningByPool();
  const pools = [...readyPools(), "claude", ...(freeReady() ? ["free"] : [])];
  return pools.filter((n) => (running[n] ?? 0) < poolCapacity(n));
}

export async function main([sub = "ls", ...names]) {
  const pick = names.length ? names : Object.keys(AGENTS).filter((n) => !AGENTS[n].hidden?.());
  for (const n of pick) if (!AGENTS[n]) die(`unknown agent ${n} (${Object.keys(AGENTS).join(", ")})`);
  if (sub === "ls") {
    for (const [n, a] of Object.entries(AGENTS).filter(([, a]) => !a.hidden?.())) {
      const s = state()[n];
      const st = !has(a.bin) ? "off" : lastQuotaHit(n) ? "warn" : s?.ok ? "ok" : s ? "bad" : "warn";
      const limit = has(a.bin) ? lastQuotaHit(n) : null;
      const opens = limit?.resetAt ? ` ${new Date(limit.resetAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
      const label = !has(a.bin) ? c.gray(t("kurulu değil")) : limit ? c.yellow(`${t("limitte")}${opens}`) : s?.ok ? c.green(t("hazır")) : s ? c.red(a.login ? t("giriş gerekiyor") : t("çalışmıyor")) : c.yellow(t("denenmedi"));
      const sc = poolScore(n);
      const perf = sc.runs ? c.gray(` · ${sc.runs} ${t("runs")}, ${Math.round(sc.rate * 100)}% ${t("success rate")}${sc.avgMin != null ? `, ${t("avg.")} ${sc.avgMin} ${t("min")}` : ""}${sc.cooling ? `, ${t("currently deprioritized")}` : ""}`) : "";
      const labelText = !has(a.bin) ? t("kurulu değil") : limit ? `${t("limitte")}${opens}` : s?.ok ? t("hazır") : s ? (a.login ? t("giriş gerekiyor") : t("çalışmıyor")) : t("denenmedi");
      console.log(fit(`  ${dot(st)} ${n.padEnd(9)} ${label}${" ".repeat(Math.max(1, 16 - labelText.length))}  ${c.gray(t(a.quota))}${perf}`));
    }
    console.log(fit(`\n  ${c.gray(t("auto sırası:"))} ${autoOrder().map((x) => c.cyan(x)).join(c.gray(" → "))}`));
  } else if (sub === "install") {
    const pkgs = pick.filter((n) => AGENTS[n].pkg && !has(AGENTS[n].bin)).map((n) => AGENTS[n].pkg);
    if (pkgs.length) spawnSync("npm", ["i", "-g", ...pkgs], { stdio: "inherit" });
    if (pick.includes("agy") && !has("agy")) console.log("agy: install the Antigravity CLI from https://antigravity.google");
  } else if (sub === "login") {
    if (!process.stdin.isTTY) die("ekip agents login is interactive; run it in a terminal");
    for (const n of pick) {
      const a = AGENTS[n];
      if (!a.login || !has(a.bin)) continue;
      console.log(`\n── ${n}: ${t(a.quota)}\n   sign in, then exit the tool (Ctrl+C or /quit) to continue`);
      spawnSync(a.login[0], a.login.slice(1), { stdio: "inherit" });
    }
    await test(pick);
  } else if (sub === "test") await test(pick);
  else die("usage: ekip agents ls|install|login|test [names]");
}

async function test(names) {
  for (const n of names) {
    const a = AGENTS[n];
    if (!has(a.bin)) continue;
    if (a.free) await up({ quiet: true });
    const r = spawnSync(a.bin, a.argv("Reply with exactly: OK", { cwd: process.cwd(), model: null }), { encoding: "utf8", timeout: 180_000 });
    const ok = r.status === 0 && /\bOK\b/.test(r.stdout ?? "");
    setState(n, { ok, testedAt: new Date().toISOString() });
    console.log(`  ${dot(ok ? "ok" : "bad")} ${n.padEnd(9)} ${ok ? c.green(t("hazır")) : c.red(`${t("sorun: ")}${(r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0]?.slice(0, 140) ?? "no output"}`)}`);
  }
}
