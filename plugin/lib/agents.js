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

/**
 * Agents for --via auto: those that passed `ekip agents test`, in the configured order, re-ranked
 * by their real success rate; a pool that failed in the last 15 minutes goes to the back. The
 * free pool is always last.
 */
export function autoOrder() {
  const order = SETTINGS.autoOrder ?? ["agy", "codex", "gemini", "copilot", "qwen", "opencode", "grok"];
  const ok = order.filter((n) => AGENTS[n] && !AGENTS[n].hidden?.() && has(AGENTS[n].bin) && state()[n]?.ok);
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
      const st = !has(a.bin) ? "off" : s?.ok ? "ok" : s ? "bad" : "warn";
      const label = !has(a.bin) ? c.gray("kurulu değil") : s?.ok ? c.green("hazır") : s ? c.red(a.login ? `giriş gerekiyor` : "çalışmıyor") : c.yellow("denenmedi");
      const sc = poolScore(n);
      const perf = sc.runs ? c.gray(` · ${sc.runs} iş, %${Math.round(sc.rate * 100)} başarı${sc.avgMin != null ? `, ort. ${sc.avgMin} dk` : ""}${sc.cooling ? ", şu an geri planda" : ""}`) : "";
      const labelText = !has(a.bin) ? "kurulu değil" : s?.ok ? "hazır" : s ? (a.login ? "giriş gerekiyor" : "çalışmıyor") : "denenmedi";
      console.log(fit(`  ${dot(st)} ${n.padEnd(9)} ${label}${" ".repeat(Math.max(1, 16 - labelText.length))}  ${c.gray(a.quota)}${perf}`));
    }
    console.log(fit(`\n  ${c.gray("auto sırası:")} ${autoOrder().map((x) => c.cyan(x)).join(c.gray(" → "))}`));
  } else if (sub === "install") {
    const pkgs = pick.filter((n) => AGENTS[n].pkg && !has(AGENTS[n].bin)).map((n) => AGENTS[n].pkg);
    if (pkgs.length) spawnSync("npm", ["i", "-g", ...pkgs], { stdio: "inherit" });
    if (pick.includes("agy") && !has("agy")) console.log("agy: install the Antigravity CLI from https://antigravity.google");
  } else if (sub === "login") {
    if (!process.stdin.isTTY) die("ekip agents login is interactive; run it in a terminal");
    for (const n of pick) {
      const a = AGENTS[n];
      if (!a.login || !has(a.bin)) continue;
      console.log(`\n── ${n}: ${a.quota}\n   sign in, then exit the tool (Ctrl+C or /quit) to continue`);
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
    console.log(`  ${dot(ok ? "ok" : "bad")} ${n.padEnd(9)} ${ok ? c.green("hazır") : c.red(`sorun: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0]?.slice(0, 140) ?? "çıktı yok"}`)}`);
  }
}
