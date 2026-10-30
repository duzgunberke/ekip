// `ekip mcp`: stdio MCP server (JSON-RPC 2.0, newline-delimited) over the project registry and
// TencentDB Agent Memory. stdout carries protocol messages only; logs go to stderr.
import fs from "node:fs";
import path from "node:path";
import { findProject, getProject, listProjects } from "../projects/projects.js";
import * as memStatic from "./memory.js";
import { redact } from "../core/redact.js";

const PROTOCOL = "2025-06-18";
const log = (...a) => process.stderr.write(`ekip-mcp: ${a.join(" ")}\n`);

const P = { type: "string", description: "Project name (ekip project ls), or \"genel\" for work outside registered projects (one-off asks, unregistered repos). Optional: defaults to the project containing the server's cwd, else genel." };
export const TOOLS = [
  { name: "projects_list", description: "List the registered projects (name, path, one-line summary, which knowledge exists).",
    inputSchema: { type: "object", properties: {} } },
  { name: "project_card", description: "The project's card: purpose, stack, layout, how to run/test/build/deploy, frequent tasks, gotchas.",
    inputSchema: { type: "object", properties: { project: P } } },
  { name: "memory_search", description: "Search the project's long-term memory (facts extracted from past sessions, plus raw notes and conversation snippets).",
    inputSchema: { type: "object", properties: { project: P, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] } },
  { name: "memory_remember", description: "Store a durable note (decision, convention, gotcha, fact) in the project's long-term memory. kind \"lesson\" or \"feedback\" (a mistake the user corrected) also goes into the project's lessons file, which every worker brief gets in full.",
    inputSchema: { type: "object", properties: { project: P, text: { type: "string" }, kind: { type: "string", enum: ["fact", "decision", "lesson", "feedback"] } }, required: ["text"] } },
  { name: "wiki_search", description: "Full-text search of the project's LLM wiki (built from its README, CLAUDE.md, docs and card). Returns page refs to read with wiki_read.",
    inputSchema: { type: "object", properties: { project: P, query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } },
  { name: "wiki_read", description: "Read project wiki pages by ref (page id or path without .md, as returned by wiki_search). Pass refs: [] to list all pages.",
    inputSchema: { type: "object", properties: { project: P, refs: { type: "array", items: { type: "string" } } }, required: ["refs"] } },
  { name: "skill_search", description: "Find the project's own procedures (skills TencentDB learned from past sessions: how this project builds, releases, fixes recurring issues). Use it before planning a task in a project; read a hit with skill_get.",
    inputSchema: { type: "object", properties: { project: P, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"] } },
  { name: "skill_get", description: "Full text of one project skill (name or id from skill_search / skill_list).",
    inputSchema: { type: "object", properties: { project: P, name: { type: "string" } }, required: ["name"] } },
  { name: "skill_list", description: "All of the project's own skills (name and one-line description).",
    inputSchema: { type: "object", properties: { project: P } } },
  { name: "code_graph", description: "Query the project's code graph (built from its GitHub repo). tool: search {query, kind?, limit?} | explore {query, maxFiles?} | callers {symbol} | callees {symbol} | impact {symbol, depth?} | node {symbol, includeCode?, file?, line?} | files {path?, pattern?, format?} | status {} | get_info {}. For multi-repo projects pass repo (URL or sub-folder) to pick the graph.",
    inputSchema: { type: "object", properties: { project: P, tool: { type: "string", enum: ["search", "explore", "callers", "callees", "impact", "node", "files", "status", "get_info"] }, params: { type: "object" }, repo: { type: "string" } }, required: ["tool"] } },
];

function project(name) {
  if (name === "genel" || name === "general") return memMod.generalProject();
  if (name) {
    const p = getProject(name);
    if (!p) throw new Error(`unknown project "${name}"; known: ${listProjects().map((x) => x.name).join(", ")}`);
    return p;
  }
  // outside any registered project: the general space (one-off work, unregistered repos)
  return findProject(process.cwd()) ?? memMod.generalProject();
}

function pickGraph(p, repo) {
  const gs = (p.tdai?.codeGraphs ?? []).filter((g) => g.id);
  if (!gs.length) throw new Error(`${p.name} has no TDAI code graph`);
  if (!repo) return gs[0];
  const hit = gs.find((g) => g.repo === repo || g.repo.includes(repo)
    || (p.repos ?? []).some((r) => r.path === repo && r.url === g.repo));
  if (!hit) throw new Error(`no code graph for "${repo}"; graphs: ${gs.map((g) => g.repo).join(", ")}`);
  return hit;
}

const text = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

// Which kind of knowledge each tool reads, for the knowledge usage log (ekip stats).
const KIND = { project_card: "card", memory_search: "memory", memory_remember: "memory", wiki_search: "wiki", wiki_read: "wiki",
  skill_search: "skill", skill_get: "skill", skill_list: "skill", code_graph: "codegraph" };

// Every knowledge tool call is logged with its result count; a worker's calls carry its run id
// (ekip run sets EKIP_PARENT_RUN for everything the worker starts), the lead's carry none.
export async function callTool(name, a = {}) {
  const t0 = Date.now();
  let out, error;
  try { out = await runTool(name, a); return out; } catch (e) { error = e; throw e; } finally {
    if (KIND[name]) {
      try {
        const { recordUse, countHits } = await import("./usage.js");
        let projectName = a.project ?? null;
        if (!projectName) try { projectName = findProject(process.cwd())?.name ?? null; } catch { /* no project */ }
        const list = Array.isArray(out) ? out : out && typeof out === "object" && out.name ? [out] : [];
        recordUse({ source: "mcp", kind: KIND[name], tool: name, project: projectName,
          query: a.query ?? a.name ?? a.refs?.join(", ") ?? a.params?.query ?? a.params?.symbol ?? (name === "memory_remember" ? a.text : null) ?? a.tool ?? null,
          hits: error ? 0 : countHits(out), names: list.map((x) => x?.name).filter(Boolean),
          runId: Number(process.env.EKIP_RUN_DEPTH ?? 0) > 0 ? process.env.EKIP_PARENT_RUN : null, ms: Date.now() - t0, error: error?.message });
      } catch { /* usage logging must never affect MCP */ }
    }
  }
}

// The MCP server lives as long as the Claude Code session, so after an ekip update it kept answering
// with the old memory code. The memory module is re-imported whenever its file changes.
let memMod = memStatic, memAt = 0;
async function freshMem() {
  try {
    const f = new URL("./memory.js", import.meta.url);
    const at = fs.statSync(f).mtimeMs;
    if (memAt && at !== memAt) memMod = await import(`${f.href}?v=${at}`);
    memAt = at;
  } catch { /* keep the loaded one */ }
  return memMod;
}

async function runTool(name, a = {}) {
  const mem = await freshMem();
  switch (name) {
    case "projects_list":
      return listProjects().map((p) => ({ name: p.name, path: p.path, summary: p.summary, card: !!p.card,
        wiki: !!p.tdai?.wikiId, codeGraphs: (p.tdai?.codeGraphs ?? []).filter((g) => g.id).map((g) => g.repo) }));
    case "project_card": {
      const p = project(a.project);
      if (!p.card || !fs.existsSync(p.card)) return `${p.name} has no card yet (ekip project card ${p.name}). Path: ${p.path}`;
      return fs.readFileSync(p.card, "utf8");
    }
    case "memory_search": {
      const hits = await mem.recall(project(a.project), a.query, a.limit ?? 8);
      return redact(JSON.stringify(hits.length ? hits : "no memories found"));
    }
    case "memory_remember": {
      const p = project(a.project);
      const lesson = a.kind === "lesson" || a.kind === "feedback";
      await mem.remember(p, lesson ? `Lesson (the user corrected this): ${a.text}` : a.text);
      // a lesson must reach every brief, not only the ones whose words match it
      if (lesson && p.path) return `remembered; lesson added to ${(await import("../projects/project-config.js")).addLesson(p, a.text)}`;
      return "remembered";
    }
    case "wiki_search": {
      const p = project(a.project);
      if (!p.tdai?.wikiId) throw new Error(`${p.name} has no wiki`);
      return redact(JSON.stringify(await mem.knowledgeTool(p.tdai.wikiId, "search", { query: a.query, ...(a.limit ? { limit: a.limit } : {}) })));
    }
    case "wiki_read": {
      const p = project(a.project);
      if (!p.tdai?.wikiId) throw new Error(`${p.name} has no wiki`);
      if (!a.refs?.length) return mem.knowledgeTool(p.tdai.wikiId, "list_pages", {});
      return mem.knowledgeTool(p.tdai.wikiId, "read_page", { refs: a.refs });
    }
    case "skill_search": {
      let p = a.project ?? null;
      let hits = [];
      try {
        p = project(a.project);
        const result = await mem.skillSearch(p, a.query, a.limit ?? 5);
        hits = result;
        return result;
      } finally {
        try { (await import("../projects/skillgen.js")).recordSkillCall("skill_search", p, { query: String(a.query ?? "").slice(0, 500) }, hits); } catch { /* telemetry must not affect MCP */ }
      }
    }
    case "skill_get": {
      let p = a.project ?? null;
      let hits = [];
      try {
        p = project(a.project);
        const result = await mem.skillGet(p, a.name);
        hits = [result];
        return result;
      } finally {
        try { (await import("../projects/skillgen.js")).recordSkillCall("skill_get", p, { name: a.name }, hits); } catch { /* telemetry must not affect MCP */ }
      }
    }
    case "skill_list": return mem.projectSkills(project(a.project));
    case "code_graph": {
      const p = project(a.project);
      const g = pickGraph(p, a.repo);
      const r = await mem.knowledgeTool(g.id, a.tool, a.params ?? {});
      if (r && typeof r === "object" && "text" in r) return r.text || "(empty result: graph may still be building; try tool status)";
      return r;
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return { protocolVersion: params?.protocolVersion === PROTOCOL ? PROTOCOL : PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: "ekip", version: "0.1.0" },
      instructions: "Project knowledge for the user's registered projects: cards, long-term memory, LLM wiki, code graph. Call project_card first in an unfamiliar project; memory_remember durable decisions." };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    try {
      const out = await callTool(params?.name, params?.arguments ?? {});
      return { content: [{ type: "text", text: text(out) }], isError: false };
    } catch (e) {
      log(`${params?.name}: ${e.message}`);
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
  if (id === undefined) return undefined; // notification (initialized, cancelled, ...)
  const err = new Error(`method not found: ${method}`); err.rpc = -32601; throw err;
}

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

export async function main() {
  let buf = "";
  const pending = new Set();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
      const job = (async () => {
        try {
          const result = await handle(msg);
          if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
        } catch (e) {
          if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: e.rpc ?? -32603, message: e.message } });
        }
      })();
      pending.add(job);
      job.finally(() => pending.delete(job));
    }
  });
  await new Promise((r) => process.stdin.on("end", r));
  await Promise.allSettled([...pending]);
  return 0;
}

if (process.argv[1] && path.resolve(new URL(import.meta.url).pathname) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
