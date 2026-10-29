// Worker agent CLIs ekip can dispatch to. Each one runs on its own account and quota, so the more
// of them are logged in, the longer the work goes on without touching your Claude limit.
// `ekip agents` lists them; install and login are one command each; `test` probes a real prompt
// and marks the agent usable for --via auto.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, SETTINGS, URL_ROOT, die, has, saveSettings, unifiedKey, up } from "./core.js";
import { c, dot, fit } from "./ui.js";
import { t } from "./i18n.js";

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
const QUOTA = [
  /Individual quota reached[^\n"]*/, /You have no remaining credits[^\n"]*/, /exceeded your (?:current )?quota[^\n"]*/i,
  /usage limit[^\n"]*reached[^\n"]*/i, /RESOURCE_EXHAUSTED[^\n"]*/,
];

/** The pool's last quota error in its run logs, until a later run succeeds or the reset time passes. */
export function lastQuotaHit(via) {
  const runs = path.join(HOME, "runs");
  let files = [];
  try { files = fs.readdirSync(runs).filter((f) => f.endsWith(`-${via}.log`) || f.includes(`-${via}+`) || f.endsWith(`+${via}.log`)).sort().reverse().slice(0, 8); } catch { return null; }
  for (const f of files) {
    const file = path.join(runs, f);
    const st = fs.statSync(file);
    const tail = (() => { const fd = fs.openSync(file, "r"); const len = Math.min(st.size, 20000); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd); return b.toString("utf8"); })();
    // Only a finished, failed run counts: a running worker's log can quote these strings (code it
    // writes, logs it reads), and a later success clears the pool.
    const exit = tail.match(/\n\[exit (\d+)\][^\n]*\s*$/)?.[1];
    if (exit == null) continue;
    if (exit === "0") return null;
    const end = tail.slice(-4000);
    const hit = QUOTA.map((re) => end.match(re)?.[0]).find(Boolean);
    if (!hit) continue;
    const m = tail.match(/Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    const resetAt = m ? st.mtimeMs + ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : null;
    if (resetAt && resetAt < Date.now()) return null;
    return { message: hit.slice(0, 140), at: new Date(st.mtimeMs).toISOString(), resetAt: resetAt ? new Date(resetAt).toISOString() : null };
  }
  return null;
}

/**
 * Agents for --via auto: those that passed `ekip agents test`, in the configured order, re-ranked
 * by their real success rate; a pool that failed in the last 15 minutes goes to the back, and one
 * whose quota ran out is left out until it resets. The free pool is always last.
 */
export function autoOrder() {
  const order = SETTINGS.autoOrder ?? ["agy", "codex", "gemini", "copilot", "qwen", "opencode", "grok"];
  const ok = order.filter((n) => AGENTS[n] && !AGENTS[n].hidden?.() && has(AGENTS[n].bin) && state()[n]?.ok && !lastQuotaHit(n));
  const ranked = ok.map((n, i) => ({ n, i, ...poolScore(n) }))
    .sort((a, b) => (a.cooling - b.cooling) || (Math.round((b.rate - a.rate) * 5) - Math.round((a.rate - b.rate) * 5)) / 2 || a.i - b.i);
  return [...ranked.map((x) => x.n), "free"];
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
