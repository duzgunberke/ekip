// Worker agent CLIs ekip can dispatch to. Each one runs on its own account and quota, so the more
// of them are logged in, the longer the work goes on without touching your Claude limit.
// `ekip agents` lists them; install and login are one command each; `test` probes a real prompt
// and marks the agent usable for --via auto.
import { spawnSync } from "node:child_process";
import { SETTINGS, URL_ROOT, die, has, saveSettings, unifiedKey, up } from "./core.js";

const model = (o, flag = "--model") => (o.model ? [flag, o.model] : []);

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
  gemini: {
    bin: "gemini", pkg: "@google/gemini-cli", quota: "Gemini CLI (Google account free tier)", login: ["gemini"],
    argv: (p, o) => ["-p", p, "--yolo", "--skip-trust", ...model(o)],
  },
  copilot: {
    bin: "copilot", pkg: "@github/copilot", quota: "GitHub Copilot (free tier or plan)", login: ["copilot"],
    argv: (p, o) => ["-p", p, "--allow-all-tools", "--allow-all-paths", ...model(o)],
  },
  qwen: {
    bin: "qwen", pkg: "@qwen-code/qwen-code", quota: "Qwen Code (Qwen account)", login: ["qwen"],
    argv: (p, o) => ["-p", p, "--yolo", ...model(o)],
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

/** Agents for --via auto, in order: those that passed `ekip agents test`, then the free pool. */
export function autoOrder() {
  const order = SETTINGS.autoOrder ?? ["agy", "codex", "gemini", "copilot", "qwen", "opencode", "grok"];
  return [...order.filter((n) => AGENTS[n] && has(AGENTS[n].bin) && state()[n]?.ok), "free"];
}

export async function main([sub = "ls", ...names]) {
  const pick = names.length ? names : Object.keys(AGENTS);
  for (const n of pick) if (!AGENTS[n]) die(`unknown agent ${n} (${Object.keys(AGENTS).join(", ")})`);
  if (sub === "ls") {
    for (const [n, a] of Object.entries(AGENTS)) {
      const s = state()[n];
      console.log(`${n.padEnd(9)} ${has(a.bin) ? "installed" : "missing  "}  ${s?.ok ? "ok      " : s ? "failing " : "untested"}  ${a.quota}`);
    }
    console.log(`\nauto order: ${autoOrder().join(" → ")}`);
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
    console.log(`${n}: ${ok ? "ok" : `failing (${(r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0]?.slice(0, 160) ?? "no output"})`}`);
  }
}
