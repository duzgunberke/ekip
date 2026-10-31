#!/usr/bin/env node
// UserPromptSubmit hook: whatever folder the session was opened in, find the registered project(s)
// a message is about and add that project's relevant facts (L1), skills and card summary to the
// context. Matching is typo-tolerant ("my-ap" finds my-app); with no name in the message, the
// project of the session's folder is used. Fails silently and never takes longer than ~6 s.
import { t } from "../core/i18n.js";
import fs from "node:fs";
import path from "node:path";
import { redact } from "../core/redact.js";

// Claude Code kills the hook at its timeout (6 s in plugin copies cached before 10 s) and prints an
// error under the message, so the hook ends itself well inside it, with whatever it has by then.
const BUDGET_MS = 4500;
setTimeout(() => process.exit(0), 5500).unref();
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

// Generic sub-repo folder names ("web", "api") say nothing about which project a message is about.
const GENERIC = new Set(["web", "api", "app", "apps", "mobile", "backend", "frontend", "server", "client", "core", "docs", "admin", "hub", "landing", "shared", "common", "worker", "site", "www", "ios", "android", "cli", "sdk", "lib", "packages", "infra", "scripts", "tools", "viewer", "render", "cockpit", "assets"]);

// Names a project answers to: its name, the name without separators, and its repos' folder names
// unless they are generic.
function aliases(p) {
  // the product name people actually type (a folder "shop-backend" for the product "Acme") comes from the card summary's
  // bold name and from an optional `aliases` list in the project entry
  // only the project's own product, written as **Name (`domain`)**: a card that merely mentions other
  // products in bold (a video studio for several apps) must not become those products
  const product = [...String(p.summary ?? "").matchAll(/\*\*([^*(]{3,40}?)\s*\(`?[\w.-]+\.[a-z]{2,}`?\)\*\*/g)].map((m) => m[1].trim()).filter((n) => n.split(/\s+/).length <= 2);
  const out = new Set([p.name, ...(p.aliases ?? []), ...product, ...(p.repos ?? []).map((r) => path.basename(r.path ?? "")).filter((n) => !GENERIC.has(fold(n)))].filter(Boolean).map(fold));
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

// words of 4+ letters that are not filler, folded (case, Turkish i, accents); a 5+ letter stem match
// counts too, so "takvime" meets "takvim" and "tarihte" meets "tarih"
const FILLER = new Set(["bunu", "bunun", "sonra", "once", "olarak", "icin", "gibi", "daha", "kadar", "nasil", "neden", "olan", "olsun", "artik", "yani", "sadece", "bence", "ama", "this", "that", "with", "from", "have", "what", "when", "will", "should", "would", "there", "their", "they", "your", "about", "into", "more", "only", "also", "than", "then"]);
const words = (s) => new Set((fold(String(s)).match(/[a-z0-9çğöşü]{4,}/g) ?? []).filter((w) => !FILLER.has(w)));
// facts about a moment, not knowledge: "background job b123 started, output in /tmp/claude-.../x.output"
const EPHEMERAL = /\/tmp\/claude-|\/tasks\/[a-z0-9]+\.output|\b(task|görev)[ -]?id\b|arka plan görevi|background (job|task)/i;
function related(content, prompt) {
  if (EPHEMERAL.test(String(content))) return false;
  const a = words(prompt), b = words(content);
  for (const w of a) { if (b.has(w)) return true; if (w.length >= 5) for (const x of b) if (x.length >= 5 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))) return true; }
  return false;
}
const withTimeout = (pr, ms) => Promise.race([pr, new Promise((r) => setTimeout(() => r(null), ms))]);
// a lookup and how long it took, for the knowledge usage log
const timed = async (pr) => { const t0 = Date.now(); const value = await pr; return { value, ms: Date.now() - t0 }; };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Tasks this lead opened that stopped moving: done work left open, or a step nobody advanced. The
// user watches them on the panel and should never have to say "this is still open"; the reminder
// comes with every message until each one is updated or closed.
const lastMove = (t) => Math.max(...[t.updatedAt, t.p0At, t.progressAt, ...(t.steps ?? []).map((x) => x.at ?? x.updatedAt)].map((x) => Date.parse(x ?? "") || 0));
// the lead's id as terminal.js leadId() records it (inlined: this hook runs on every message and
// stays off core.js)
const leadOf = (env = process.env) => (env.WEZTERM_PANE ? `wezterm-${env.WEZTERM_PANE}` : env.KITTY_WINDOW_ID ? `kitty-${env.KITTY_WINDOW_ID}` : env.ITERM_SESSION_ID?.split(":")[1] ?? env.TERM_SESSION_ID ?? null);
const mine = (t) => !t.lead || t.lead === leadOf();
function staleTasks(home) {
  try {
    const file = path.join(home, "tasks.json");
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    return JSON.parse(fs.readFileSync(file, "utf8")).filter((t) => t.status === "running" && mine(t)
      && Date.now() - lastMove(t) > 20 * 60_000
      && !(t.workers ?? []).some((w) => w.status === "running" && w.pid && alive(w.pid)));
  } catch { return []; }
}

// Orphaned tasks: a step says "running" but no worker and no tracked job (ekip track) is alive for
// it, and it has not moved for 10 minutes: a long command started in a bare background shell and
// forgotten, or a worker that died. The panel shows them as running, so they come first, as an
// action the lead has to take, not a reminder it may skip.
async function orphanNote() {
  try {
    const tasks = await import("../tasks/tasks.js");
    const list = tasks.active().filter((t) => mine(t) && tasks.orphaned(t));
    if (!list.length) return { ids: new Set(), text: "" };
    const ago = (t) => Math.round((Date.now() - Math.max(...t.steps.filter((s) => s.status === "running").map((s) => Date.parse(s.progressAt ?? s.startedAt ?? "") || 0), ...(t.workers ?? []).map((w) => Date.parse(w.endedAt ?? "") || 0))) / 60000);
    const line = (t) => {
      const steps = t.steps.map((s, i) => (s.status === "running" ? `step ${i + 1} "${s.title}"` : null)).filter(Boolean).join(", ");
      const w = (t.workers ?? []).at(-1);
      return `- ${t.id} "${t.title}": ${steps} marked running, nothing moved for ${ago(t)} min${w ? `; last worker ${w.label ?? w.runId} (${w.via ?? "?"}) ${w.status}` : "; no worker or tracked job was ever linked"}`;
    };
    return {
      ids: new Set(list.map((t) => t.id)),
      text: `## ${t("SAHİPSİZ: çalışan süreç yok, ya kapat ya yeniden başlat")} (mandatory, before anything else)\nThese tasks show as running on the user's panel, but no worker or tracked job is alive for them:\n${list.map(line).join("\n")}\nFor each one, in this turn: check whether the work really finished (its log, output files, remote state). Finished: \`ekip task step <id> N done\` and \`ekip task done <id> "<result>"\`. Not finished: restart it under a live process (\`ekip run --task <id>\`, or \`ekip track --task <id> --step N -- <command>\` for a shell command) or \`ekip task fail <id> "<why>"\`. Tell the user which one you did; do not leave any of them as it is.`,
    };
  } catch { return { ids: new Set(), text: "" }; }
}

// The lessons of the project this message is about, and the lead's own ones (genel), on every
// message whatever it is about: the mistakes the user already had to correct once. Newest ten of
// the project, then the newest general ones, 1,500 characters at most.
async function lessonsNote(projects) {
  try {
    const { lessons } = await import("../projects/project-config.js");
    const out = [];
    let room = 1500;
    for (const p of [...projects.filter((x) => x && x.name !== "genel"), { name: "genel" }]) {
      if (room < 120 || out.some((x) => x.name === p.name)) continue;
      const items = lessons(p, room).split("\n").filter(Boolean).slice(p.name === "genel" ? -5 : -10);
      if (!items.length) continue;
      out.push({ name: p.name, items });
      room -= items.join("\n").length + p.name.length + 8;
    }
    if (!out.length) return "";
    return `## Lessons (mistakes the user already corrected; apply them whatever this message is about)\n${out.map((x) => `${x.name}:\n${x.items.join("\n")}`).join("\n")}`;
  } catch { return ""; }
}

export async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const prompt = String(input.prompt ?? "");
  const orphans = await orphanNote();
  const stale = staleTasks((await import("../core/core.js")).HOME).filter((t) => !orphans.ids.has(t.id));
  const staleText = stale.length
    ? `## Open tasks that stopped moving (update or close them now, before anything else)\n${stale.map((t) => `- ${t.id} "${t.title}": ${t.steps.filter((x) => x.status !== "done" && x.status !== "skipped").map((x, i) => `${x.title} (${x.status})`).join(", ") || "all steps done"}; last update ${Math.round((Date.now() - lastMove(t)) / 60000)} min ago`).join("\n")}\nIf the work is done: mark the steps and \`ekip task done <id> "<result>"\`. If it goes on: mark the running step or add a note. If it failed: \`ekip task fail <id> "<why>"\`.`
    : "";
  // orphaned tasks first: the context is cut at 6,000 characters and they must never be the part cut
  let staleNote = [orphans.text, staleText].filter(Boolean).join("\n\n");
  const emit = (text) => { if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text.slice(0, 6000) } })); };
  // system notifications (finished background tasks, agent results) arrive as prompts too: they are
  // not the user asking anything and only pulled in noise
  if (prompt.trim().length < 8 || prompt.startsWith("/") || /^\s*(<task-notification>|<system-reminder>|\[SYSTEM NOTIFICATION)/.test(prompt)) return emit(staleNote);
  const { listProjects, findProject } = await import("../projects/projects.js");
  const projects = listProjects().filter((p) => p.tdai?.agentId);
  let hits = mentioned(prompt, projects).slice(0, 2);
  const here = findProject(input.cwd || process.cwd());
  // the registered project of this folder, even before it has a memory agent: its rules and local
  // skills still apply (memory lookups for it then just come back empty)
  if (!hits.length && here) hits = [{ p: here, by: "folder" }];
  const lessonText = await lessonsNote(hits.length ? hits.map((h) => h.p) : [here]);
  staleNote = [staleNote, lessonText].filter(Boolean).join("\n\n");
  const mem = await import("./memory.js");
  // Work outside any project (a one-off ask, a repo that is not registered) is remembered in the
  // general space; it is searched for every such message, so nothing done there is lost.
  if (!hits.length) { const g = mem.generalProject(); if (g.tdai?.agentId) hits = [{ p: g, by: "general" }]; }
  if (!hits.length) return emit(staleNote);
  const parts = await Promise.all(hits.map(async ({ p, by }) => {
    const [memoriesT, skillsT, wikiT] = await Promise.all([
      // facts only: the raw conversation search scans tens of thousands of vectors and did not fit
      // the per-message budget for the general space; workers and memory_search still use it
      timed(withTimeout(mem.recall(p, prompt.slice(0, 1000), 8, { timeoutMs: BUDGET_MS - 800, factsOnly: true }).catch(() => []), BUDGET_MS - 300)),
      timed(withTimeout(mem.skillSearch(p, prompt, 3).catch(() => []), BUDGET_MS - 300)),
      p.tdai?.wikiId ? timed(withTimeout(mem.knowledgeTool(p.tdai.wikiId, "search", { query: prompt.slice(0, 300), limit: 3 }).catch(() => null), BUDGET_MS - 300)) : null,
    ]);
    const [memories, skills, wiki] = [memoriesT.value, skillsT.value, wikiT?.value ?? null];
    const { projectSkills } = await import("../projects/project-skills.js");
    // the home folder's skills are the user's general ones, which Claude Code already lists
    const local = by === "general" ? [] : projectSkills(p.path, prompt).slice(0, 4);
    const lines = [by === "general" ? "## genel (work outside registered projects)" : `## ${p.name}${by === "folder" ? "" : ` (matched "${by}")`}`];
    if (p.summary) lines.push(clip(redact(p.summary.replace(/\s+/g, " ")), 300));
    const projectRules = (await import("../projects/project-config.js")).rules(p, 900);
    if (projectRules) lines.push("Project rules (.ekip/rules.md):", redact(projectRules));
    // the vector search always returns its nearest records, related or not (a Polish forestry law
    // came back for a question about something else): a fact is used only when it shares a real word with the
    // message, so unrelated memories never reach the model
    const facts = (memories ?? []).filter((m) => m.layer === "L1" && related(m.content, prompt)).slice(0, 5);
    if (facts.length) lines.push("Known facts and decisions:", ...facts.map((m) => `- ${clip(redact(String(m.content).replace(/\s+/g, " ")), 260)}`));
    // the general space has few extracted facts yet: earlier exchanges on the same subject help too
    const snippets = by === "general" ? (memories ?? []).filter((m) => m.layer !== "L1").slice(0, 3) : [];
    if (snippets.length) lines.push("Earlier exchanges on this:", ...snippets.map((m) => `- ${m.role ? `${m.role}: ` : ""}${clip(redact(String(m.content).replace(/\s+/g, " ")), 300)}`));
    if (local.length) lines.push("Project process skills that fit this message (invoke or read their SKILL.md before planning):", ...local.map((k) => `- ${k.name}: ${clip(redact(k.description), 160)} (${k.file})`));
    if (skills?.length) lines.push("Learned skills (read with the skill_get MCP tool):", ...skills.map((s) => `- ${s.name}: ${clip(redact(s.description ?? ""), 160)}`));
    const pages = (Array.isArray(wiki) ? wiki : wiki?.results ?? wiki?.items ?? wiki?.data ?? []).slice(0, 3);
    if (pages.length) lines.push("Wiki pages that match (wiki_read):", ...pages.map((w) => `- ${clip(redact(String(w.title ?? w.ref ?? w.path ?? w.id ?? "")), 120)}`));
    const graph = fs.existsSync(path.join(p.path, ".codegraph")) || (p.tdai?.codeGraphs ?? []).some((g) => g.id);
    if (graph) lines.push(`Code: use codegraph_explore (projectPath ${p.path}) or the code_graph MCP tool before reading files one by one.`);
    if (p.card) lines.push(`Card: ${p.card}`);
    // what this message got from each kind of knowledge (what was injected, not what was searched)
    try {
      const { recordUse } = await import("./usage.js");
      const base = { source: "prompt-hook", project: p.name, query: prompt };
      // null = the search ran out of time (not "nothing found"): doctor warns when that becomes common
      recordUse({ ...base, kind: "memory", hits: facts.length, ms: memoriesT.ms, ...(memories === null ? { timeout: true } : {}) });
      recordUse({ ...base, kind: "skill", hits: skills?.length ?? 0, names: (skills ?? []).map((s) => s.name), ms: skillsT.ms, ...(skills === null ? { timeout: true } : {}) });
      if (wikiT) recordUse({ ...base, kind: "wiki", hits: pages.length, names: pages.map((w) => String(w.title ?? w.ref ?? w.path ?? w.id ?? "")), ms: wikiT.ms, ...(wiki === null ? { timeout: true } : {}) });
      recordUse({ ...base, kind: "local-skill", hits: local.length, skills: local });
    } catch { /* usage logging must never affect the hook */ }
    if (by === "general" && !facts.length && !snippets.length && !skills?.length) return null;
    return lines.length > 1 ? lines.join("\n") : null;
  }));
  const body = parts.filter(Boolean).join("\n\n");
  if (!body) return emit(staleNote);
  // The rule comes with the context, so analysing first does not depend on anyone remembering it.
  const rule = "Before you plan, answer, delegate or spend tokens on work in this project, analyse with what is below: read the process skills that fit, check the facts, search memory_search / wiki_search for anything missing, and explore code through the code graph. Pass what matters into every worker brief. Then do the work.";
  // Several projects (or the general space next to one) may be meant: let the user pick instead of guessing
  const named = parts.map((x, i) => (x ? hits[i] : null)).filter(Boolean);
  // projects not named but on topic: their card summary shares two or more real words with the message
  const pw = words(prompt);
  const stem = (w) => w.slice(0, 5);
  const overlap = (text) => { const ws = [...words(text)]; return [...pw].filter((w) => ws.some((x) => x === w || (w.length >= 5 && x.length >= 5 && stem(x) === stem(w)))).length; };
  const topical = projects.filter((x) => !hits.some((h) => h.p === x)).map((x) => ({ p: x, n: overlap(`${x.name} ${x.summary ?? ""}`) })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
  for (const t of topical) named.push({ p: t.p, by: "topic" });
  const ask = named.length > 1
    ? `\n\nThis message matches more than one project (${named.map((h) => `${h.p.name}${h.by === "topic" ? " (by topic, not named)" : ""}`).join(", ")}). Unless the request already makes the scope clear, ask the user once, before planning, with AskUserQuestion (multiSelect: true): one option per project above with its relevant skills in the description, plus related tool/skill groups you see fit (e.g. the VPS/dev environment skill). Then use only what they picked. Do not ask again for the same request.`
    : "";
  const context = redact(`ekip project context for this message (retrieved by relevance; verify before relying on it).\n${rule}${ask}\n\n${body}`);
  emit(staleNote ? `${staleNote}\n\n${context}` : context);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kill = setTimeout(() => process.exit(0), BUDGET_MS + 500);
  main().catch(() => {}).finally(() => { clearTimeout(kill); process.exit(0); });
}
