#!/usr/bin/env node
// UserPromptSubmit hook: whatever folder the session was opened in, find the registered project(s)
// a message is about and add that project's relevant facts (L1), skills and card summary to the
// context. Matching is typo-tolerant ("luamreef" finds lumareef); with no name in the message, the
// project of the session's folder is used. Fails silently and never takes longer than ~6 s.
import fs from "node:fs";
import path from "node:path";

const BUDGET_MS = 4000;
const fold = (s) => s.toLocaleLowerCase("tr").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] ? d[i - 2][j - 2] + 1 : 99);
  return d[a.length][b.length];
}

// Names a project answers to: its name, the name without separators, and its repos' folder names.
function aliases(p) {
  const out = new Set([p.name, ...(p.repos ?? []).map((r) => path.basename(r.path ?? ""))].filter(Boolean).map(fold));
  for (const a of [...out]) { out.add(a.replace(/[-_.]/g, "")); out.add(a.replace(/[-_.]/g, " ")); }
  return [...out].filter((a) => a.length >= 3);
}

export function mentioned(prompt, projects) {
  const text = fold(prompt);
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  const hits = [];
  for (const p of projects) {
    let best = null;
    for (const a of aliases(p)) {
      if (a.includes(" ") ? text.includes(a) : new RegExp(`(^|[^a-z0-9])${a}([^a-z0-9]|$)`).test(text)) { best = a; break; }
      // typos: only for names long enough that a near miss is not a different word
      if (a.length >= 6 && !a.includes(" ")) {
        const w = words.find((x) => distance(x, a) <= (a.length >= 9 ? 2 : 1));
        if (w) { best = w; break; }
      }
    }
    if (best) hits.push({ p, by: best });
  }
  return hits;
}

const withTimeout = (pr, ms) => Promise.race([pr, new Promise((r) => setTimeout(() => r(null), ms))]);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const prompt = String(input.prompt ?? "");
  if (prompt.trim().length < 8 || prompt.startsWith("/")) return;
  const { listProjects, findProject } = await import("./projects.js");
  const projects = listProjects().filter((p) => p.tdai?.agentId);
  let hits = mentioned(prompt, projects).slice(0, 2);
  if (!hits.length) { const here = findProject(input.cwd || process.cwd()); if (here?.tdai?.agentId) hits = [{ p: here, by: "folder" }]; }
  if (!hits.length) return;
  const mem = await import("./memory.js");
  const parts = await Promise.all(hits.map(async ({ p, by }) => {
    const [memories, skills] = await Promise.all([
      withTimeout(mem.recall(p, prompt, 6, { timeoutMs: BUDGET_MS - 800, factsOnly: true }).catch(() => []), BUDGET_MS - 300),
      withTimeout(mem.skillSearch(p, prompt, 3).catch(() => []), BUDGET_MS - 300),
    ]);
    const lines = [`## ${p.name}${by === "folder" ? "" : ` (matched "${by}")`}`];
    if (p.summary) lines.push(clip(p.summary.replace(/\s+/g, " "), 300));
    const facts = (memories ?? []).filter((m) => m.layer === "L1").slice(0, 5);
    if (facts.length) lines.push("Known facts and decisions:", ...facts.map((m) => `- ${clip(String(m.content).replace(/\s+/g, " "), 260)}`));
    if (skills?.length) lines.push("Project skills (read with the skill_get MCP tool):", ...skills.map((s) => `- ${s.name}: ${clip(s.description ?? "", 160)}`));
    if (p.card) lines.push(`Card: ${p.card}`);
    return lines.length > 1 ? lines.join("\n") : null;
  }));
  const body = parts.filter(Boolean).join("\n\n");
  if (!body) return;
  const context = `ekip project memory for this message (retrieved by relevance; verify before relying on it):\n\n${body}`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context.slice(0, 6000) } }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kill = setTimeout(() => process.exit(0), BUDGET_MS + 500);
  main().catch(() => {}).finally(() => { clearTimeout(kill); process.exit(0); });
}
