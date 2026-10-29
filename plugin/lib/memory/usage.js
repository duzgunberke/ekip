// Knowledge usage: one append-only log (data/knowledge-usage.jsonl) of every lookup in a project's
// memory, wiki, skills, code graph and card, by whoever made it (the lead's prompt hook, a worker
// brief, an MCP tool call from the lead or a worker). `ekip stats` reads it back with the run
// outcomes from skill-usage.jsonl and shows cheap signals of whether the knowledge helped.
import fs from "node:fs";
import path from "node:path";
import { HOME, RUNS, SETTINGS } from "../core/core.js";
import { redact } from "../core/redact.js";
import { c, title } from "../core/ui.js";
import { t } from "../core/i18n.js";

const LOG = path.join(HOME, "knowledge-usage.jsonl");
const SKILL_USAGE = path.join(HOME, "skill-usage.jsonl");
const KINDS = ["memory", "wiki", "skill", "local-skill", "codegraph", "card"];
const SOURCES = ["prompt-hook", "worker-brief", "mcp-lead", "mcp-worker", "review"];

// Append one lookup. Never throws: a full disk or a bad value must not break the call it describes.
export function recordUse({ source, kind, project, query, hits, names, skills, tool, runId, taskId, ms, logFrom, error, timeout } = {}) {
  try {
    const row = { at: new Date().toISOString(), source, kind, project: project?.name ?? project ?? null,
      query: query == null ? null : redact(String(query).replace(/\s+/g, " ")).slice(0, 200), hits: Number(hits) || 0 };
    if (tool) row.tool = tool;
    if (timeout) row.timeout = true;
    if (names?.length) row.names = names.slice(0, 10).map(String);
    if (skills?.length) row.skills = skills.slice(0, 10).map((s) => ({ name: s.name, file: s.file }));
    if (runId) row.runId = runId;
    if (taskId) row.taskId = taskId;
    if (Number.isFinite(ms)) row.ms = Math.round(ms);
    if (Number.isFinite(logFrom)) row.logFrom = logFrom;
    if (error) row.error = String(error).slice(0, 160);
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  } catch { /* usage logging must never affect the lookup */ }
}

// How many results a lookup returned, for the shapes memory.js and the MCP tools give back.
export function countHits(value) {
  if (value == null) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s || /^\(empty result|^no memories found|has no card yet/.test(s)) return 0;
    try { const parsed = JSON.parse(s); if (typeof parsed !== "string") return countHits(parsed); return /^no /i.test(parsed) ? 0 : 1; } catch { return 1; }
  }
  if (typeof value === "object") {
    const list = value.results ?? value.items ?? value.data ?? value.pages ?? value.hits;
    if (Array.isArray(list)) return list.length;
    if ("text" in value) return countHits(value.text);
    return Object.keys(value).length ? 1 : 0;
  }
  return 1;
}

const readJsonl = (file) => {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* partial line */ } }
  return out;
};

// The lookup rows, plus skill searches skill-usage.jsonl recorded before this log existed.
function lookupRows() {
  const rows = readJsonl(LOG);
  const first = rows[0]?.at ?? "9999";
  for (const r of readJsonl(SKILL_USAGE)) {
    if (!["skill_search", "skill_get"].includes(r.kind) || !(String(r.at) < first)) continue;
    rows.push({ at: r.at, source: "mcp", kind: "skill", tool: r.kind, project: r.project, query: r.query ?? r.name ?? null,
      hits: (r.hits ?? []).length, names: r.hits ?? [] });
  }
  return rows;
}

// The last known status of every run (done, failed, cancelled), from skill-usage.jsonl.
function runStatuses() {
  const out = new Map();
  for (const r of readJsonl(SKILL_USAGE)) if (r.kind === "run" && r.runId && r.status) out.set(r.runId, r.status);
  return out;
}

const sourceOf = (r) => (r.source === "mcp" ? (r.runId ? "mcp-worker" : "mcp-lead") : r.source);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const count = (s, needle) => { let n = 0, i = 0; while (needle && (i = s.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };

// Did the worker open a skill it was given? Signal only: its log mentions the SKILL.md path (more
// often than the brief line that listed it, in case the worker CLI echoes its prompt), or it read a
// learned skill with `ekip skill show` / skill_get.
function makeUsedCheck(rows) {
  const logs = new Map();
  const logOf = (runId, from = 0) => {
    if (!logs.has(runId)) { let s = ""; try { s = fs.readFileSync(path.join(RUNS, `${runId}.log`), "utf8"); } catch { /* log cleaned */ } logs.set(runId, s); }
    return logs.get(runId).slice(from);
  };
  const mcpGets = new Set(rows.filter((r) => r.source === "mcp" && r.runId && r.tool === "skill_get").flatMap((r) => (r.names ?? []).map((n) => `${r.runId}\n${n}`)));
  return (row, skill) => {
    const log = logOf(row.runId, row.logFrom ?? 0);
    if (!log) return null;
    if (skill.file) return count(log, `${skill.name}/SKILL.md`) > count(log, `(${skill.file})`);
    return mcpGets.has(`${row.runId}\n${skill.name}`) || log.includes(`skill show ${row.project} ${skill.name}`);
  };
}

// Per-project summary over the last `days` days (also what the hub receives).
export function summarize({ days = 30, project = null } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = lookupRows().filter((r) => String(r.at) >= since && r.project && (!project || r.project === project));
  const statuses = runStatuses();
  const used = makeUsedCheck(rows);
  const projects = new Map();
  const daily = new Map();
  const blank = () => ({ n: 0, hits: 0, bySource: {} });
  for (const r of rows) {
    const p = projects.get(r.project) ?? { name: r.project, lookups: 0, hits: 0, remembered: 0, kinds: {}, sources: {}, skills: new Map(), briefs: new Map() };
    projects.set(r.project, p);
    if (r.tool === "memory_remember") { p.remembered++; continue; }
    const src = sourceOf(r), hit = r.hits > 0 ? 1 : 0;
    p.lookups++; p.hits += hit;
    const k = (p.kinds[r.kind] ??= blank());
    k.n++; k.hits += hit; k.bySource[src] = (k.bySource[src] ?? 0) + 1;
    p.sources[src] = (p.sources[src] ?? 0) + 1;
    const day = String(r.at).slice(0, 10), d = daily.get(day) ?? { day, lookups: 0, hits: 0 };
    d.lookups++; d.hits += hit; daily.set(day, d);
    if (r.kind === "skill" || r.kind === "local-skill") {
      const given = r.source === "worker-brief";
      const list = r.skills ?? (r.names ?? []).map((name) => ({ name }));
      for (const sk of list) {
        const s = p.skills.get(sk.name) ?? { name: sk.name, local: r.kind === "local-skill", calls: 0, reads: 0, given: 0, checked: 0, used: 0 };
        p.skills.set(sk.name, s);
        s.calls++;
        if (r.tool === "skill_get") s.reads++;
        if (given && r.runId) {
          s.given++;
          const u = used(r, sk);
          if (u !== null) { s.checked++; if (u) s.used++; }
        }
      }
    }
    if (r.source === "worker-brief" && r.runId) p.briefs.set(r.runId, (p.briefs.get(r.runId) ?? false) || hit > 0);
  }
  const out = [...projects.values()].map((p) => {
    const runs = { with: { n: 0, ok: 0 }, without: { n: 0, ok: 0 } };
    for (const [runId, withKnowledge] of p.briefs) {
      const st = statuses.get(runId);
      if (st !== "done" && st !== "failed") continue;
      const b = withKnowledge ? runs.with : runs.without;
      b.n++; if (st === "done") b.ok++;
    }
    const kinds = Object.fromEntries(Object.entries(p.kinds).map(([k, v]) => [k, { ...v, hitRate: pct(v.hits, v.n) }]));
    const skills = [...p.skills.values()].sort((a, b) => b.calls - a.calls).slice(0, 8).map((s) => ({ ...s, usedRate: pct(s.used, s.checked) }));
    return { name: p.name, lookups: p.lookups, hitRate: pct(p.hits, p.lookups), remembered: p.remembered, kinds, sources: p.sources, skills,
      briefs: { total: p.briefs.size, withKnowledge: [...p.briefs.values()].filter(Boolean).length,
        successWith: pct(runs.with.ok, runs.with.n), successWithout: pct(runs.without.ok, runs.without.n), runs } };
  }).sort((a, b) => b.lookups - a.lookups);
  const lookups = out.reduce((s, p) => s + p.lookups, 0);
  const hits = rows.filter((r) => r.tool !== "memory_remember" && r.hits > 0).length;
  const bySource = {}, byKind = {};
  for (const p of out) {
    for (const [k, v] of Object.entries(p.sources)) bySource[k] = (bySource[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.kinds)) byKind[k] = (byKind[k] ?? 0) + v.n;
  }
  const timeouts = rows.filter((r) => r.timeout).length;
  return { at: new Date().toISOString(), days, totals: { lookups, hitRate: pct(hits, lookups), timeouts, timeoutRate: pct(timeouts, lookups), bySource, byKind },
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14), projects: out,
    note: "Signals, not proof: a hit means the lookup returned something; worker success and skill-file mentions in run logs only correlate with the knowledge being useful." };
}

export async function push(summary) {
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return;
  await fetch(`${SETTINGS.hubUrl}/api/usage`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` },
    body: JSON.stringify(summary ?? summarize()), signal: AbortSignal.timeout(8000) }).catch(() => {});
}

const rate = (v) => (v == null ? c.gray("–") : `${v}%`);
const KIND_LABEL = { memory: "hafıza", wiki: "wiki", skill: "beceri", "local-skill": "yerel beceri", codegraph: "kod grafiği", card: "kart" };
const SOURCE_LABEL = { "prompt-hook": "hook", "worker-brief": "brif", "mcp-lead": "mcp lead", "mcp-worker": "mcp işçi", review: "review" };

function render(s) {
  console.log(title(t("Bilgi kullanımı (son {n} gün)", { n: s.days })));
  console.log(c.gray(t("Sinyaller, kanıt değil: isabet = arama sonuç döndürdü; başarı ve SKILL.md okuması yalnızca birlikte görülür.")));
  if (!s.projects.length) { console.log(`\n${t("Henüz kayıt yok. Hook, işçi brifleri ve MCP araçları kullanıldıkça dolar.")}`); return; }
  for (const p of s.projects) {
    const sources = SOURCES.filter((x) => p.sources[x]);
    console.log(`\n${c.bold(p.name)}  ${c.gray(`${p.lookups} ${t("arama")} · ${t("isabet")} ${p.hitRate ?? "–"}%${p.remembered ? ` · ${p.remembered} ${t("not kaydedildi")}` : ""}`)}`);
    console.log(c.gray(`  ${[t("tür").padEnd(13), t("toplam").padStart(6), ...sources.map((x) => t(SOURCE_LABEL[x]).padStart(9)), t("isabet").padStart(7)].join(" ")}`));
    for (const k of KINDS) {
      const v = p.kinds[k];
      if (!v) continue;
      console.log(`  ${t(KIND_LABEL[k]).padEnd(13)} ${String(v.n).padStart(6)} ${sources.map((x) => String(v.bySource[x] ?? "·").padStart(9)).join(" ")} ${rate(v.hitRate).padStart(7)}`);
    }
    if (p.skills.length) {
      console.log(c.gray(`  ${t("beceriler (çağrı · okundu · işçiye verildi · işçi açtı)")}`));
      for (const sk of p.skills) console.log(`    ${c.cyan(sk.name.slice(0, 40).padEnd(40))} ×${String(sk.calls).padEnd(4)} ${String(sk.reads).padStart(3)}  ${String(sk.given).padStart(3)}  ${sk.checked ? `${sk.used}/${sk.checked} (${sk.usedRate}%)` : c.gray("–")}`);
    }
    const b = p.briefs;
    if (b.total) {
      const line = (x) => (x.n ? `${x.ok}/${x.n} (${pct(x.ok, x.n)}%)` : "–");
      console.log(`  ${t("işçi brifleri")}: ${b.total}, ${t("{n} tanesinde bilgi vardı", { n: b.withKnowledge })} · ${t("başarı bilgiyle")} ${line(b.runs.with)} · ${t("bilgisiz")} ${line(b.runs.without)}`);
    }
  }
}

// ekip stats [project] [--days N] [--json] [--local]
export async function main(args = []) {
  let days = 30, project = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") days = Math.max(1, Math.min(365, Number(args[++i]) || 30));
    else if (!args[i].startsWith("--")) project = args[i];
  }
  const s = summarize({ days, project });
  if (args.includes("--json")) { if (!args.includes("--silent")) console.log(JSON.stringify(s, null, 2)); }
  else render(s);
  // the hub always gets every project, whatever this view was filtered to
  if (!args.includes("--local")) await push(project || days !== 30 ? summarize() : s);
  return 0;
}

/** Share of per-message lookups in the last hours that ran out of time (doctor warns above 20%). */
export function recentTimeouts(hours = 24) {
  const since = Date.now() - hours * 3600_000;
  let n = 0, t = 0;
  try {
    for (const l of fs.readFileSync(LOG, "utf8").split("\n")) {
      if (!l.includes('"prompt-hook"')) continue;
      try { const r = JSON.parse(l); if (Date.parse(r.at) < since || r.kind !== "memory") continue; n++; if (r.timeout) t++; } catch { /* partial line */ }
    }
  } catch { /* no log yet */ }
  return { lookups: n, timeouts: t };
}
