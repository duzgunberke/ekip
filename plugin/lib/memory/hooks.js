// Claude Code hooks: `ekip hook session-start|stop|capture`. Hooks never block or fail a session:
// every error is swallowed and the hook exits 0.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/core.js";
import { lang } from "../core/i18n.js";
import { findProject } from "../projects/projects.js";
import { setupGaps } from "../projects/onboarding.js";

const CARD_LINES = 80;

async function readStdin(timeoutMs = 2000) {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let s = "";
    const done = () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } };
    const t = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => { clearTimeout(t); done(); });
    process.stdin.on("error", () => { clearTimeout(t); done(); });
  });
}

const logErr = (e) => {
  try { fs.mkdirSync(path.join(HOME, "logs"), { recursive: true }); fs.appendFileSync(path.join(HOME, "logs/hooks.log"), `${new Date().toISOString()} ${e?.stack ?? e}\n`); } catch { /* ignore */ }
};

export async function sessionStartContext(cwd) {
  const p = findProject(cwd);
  const parts = p ? [`# ekip ${lang === "en" ? "project" : "projesi"}: ${p.name} (${p.path})`] : [`# ekip ${lang === "en" ? "project setup" : "proje kurulumu"}`];
  const gaps = await setupGaps({ cwd });
  if (gaps.length) parts.push(`# ${lang === "en" ? "Setup gaps" : "Kurulum eksikleri"}\n${gaps.map((g) => `- ${g.title} — ${g.why} — ${g.command}`).join("\n")}\nOffer the most useful one to the user once, in a single short sentence, at a natural moment (start of the session or when it is relevant to their request), e.g. 'Bu projeyi henüz indekslemedik, işçiler bağlamı bilerek başlasın diye şimdi yapayım mı?'. If they say yes, run it and track it as a task. Do not repeat an offer they declined in this session; do not block their request for it.`);
  if (p?.card && fs.existsSync(p.card)) {
    const lines = fs.readFileSync(p.card, "utf8").trim().split("\n");
    parts.push(lines.slice(0, CARD_LINES).join("\n") + (lines.length > CARD_LINES ? `\n…(${lang === "en" ? "card trimmed; full card: project_card tool or" : "kart kısaltıldı; tümü için project_card aracı veya"} ${p.card})` : ""));
  }
  if (p?.tdai?.agentId) {
    try {
      const mem = await import("./memory.js");
      const q = `${p.name} ${p.summary ?? ""} decisions conventions gotchas recent work`.slice(0, 300);
      const hits = await mem.recall(p, q, 5, { timeoutMs: 4000 });
      if (hits.length) parts.push(`## ${lang === "en" ? "Recalled memories" : "Hatırlanan anılar"}\n${hits.map((h) => `- ${h.content.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`);
    } catch (e) { logErr(e); }
  }
  if (p) parts.push(lang === "en" ? "ekip MCP tools are available for this project: project_card, memory_search, memory_remember, wiki_search, wiki_read, code_graph (TDAI graph of the GitHub repo); the local `codegraph` CLI/index (.codegraph/) is there too." : "ekip MCP araçları bu proje için kullanılabilir: project_card, memory_search, memory_remember, wiki_search, wiki_read, code_graph (GitHub deposunun TDAI grafiği); yerel `codegraph` CLI/dizini (.codegraph/) de kullanılabilir.");
  return parts.join("\n\n");
}

export async function main([sub, ...rest] = []) {
  try {
    if (sub === "session-start") {
      const input = await readStdin();
      const ctx = await sessionStartContext(input.cwd || process.cwd());
      if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }));
    } else if (sub === "stop") {
      const input = await readStdin();
      const cwd = input.cwd || process.cwd();
      if (input.transcript_path) {
        fs.mkdirSync(path.join(HOME, "logs"), { recursive: true });
        const out = fs.openSync(path.join(HOME, "logs/capture.log"), "a");
        // Runs this module directly (not via ekip.js) so capture never depends on CLI dispatch.
        const self = new URL(import.meta.url).href;
        const code = `const m = await import(${JSON.stringify(self)}); await m.main(["capture", ...process.argv.slice(1)]);`;
        spawn(process.execPath, ["--input-type=module", "-e", code, input.transcript_path, input.session_id ?? "", cwd],
          { detached: true, stdio: ["ignore", out, out] }).unref();
      }
    } else if (sub === "capture") {
      const [transcript, sessionId, cwd] = rest;
      const mem = await import("./memory.js");
      const p = findProject(cwd || process.cwd()) ?? mem.generalProject();
      if (p.tdai?.agentId && transcript && fs.existsSync(transcript)) {
        const r = await mem.capture(p, transcript, sessionId);
        console.log(`${new Date().toISOString()} ${p.name} ${sessionId}: ${JSON.stringify(r)}`);
      }
      // A lead opened in the home folder that works on a project: those turns belong to that project's
      // memory too, so its workers and later sessions find them (only turns that mention the project).
      if (p.name === "genel" && transcript && fs.existsSync(transcript)) {
        const { listProjects: all } = await import("../projects/projects.js");
        const list = all().filter((x) => x.tdai?.agentId);
        const counts = mem.projectsMentioned(fs.readFileSync(transcript, "utf8"), list);
        // projects the session really worked on, not ones it only listed in passing
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        for (const x of list.filter((x) => (counts[x.name] ?? 0) >= Math.max(5, total * 0.05))) {
          const named = new RegExp(`\\b${x.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
          const r = await mem.capture(x, transcript, sessionId, { only: (l) => named.test(l) || l.includes(x.path) });
          console.log(`${new Date().toISOString()} ${x.name} ${sessionId} (from home): ${JSON.stringify(r)}`);
        }
      }
    }
  } catch (e) { logErr(e); }
  return 0;
}
