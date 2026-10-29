// TencentDB Agent Memory client: per-project agent, wiki and code graphs, recall and capture.
// HTTP only, always to 127.0.0.1:<TDAI_PORTS> (on a VPS hub those ports are SSH tunnels).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, SETTINGS, TDAI_PORTS, adminKey, die } from "../core/core.js";
import { getProject, listProjects, updateProject, findProject } from "../projects/projects.js";
import { redact } from "../core/redact.js";

const SERVICE = SETTINGS.tdaiServiceId ?? "default";
const CORE = `http://127.0.0.1:${TDAI_PORTS.core}`;
const PANEL = `http://127.0.0.1:${TDAI_PORTS.panel}/api/v1`;
const KNOWLEDGE = `http://127.0.0.1:${TDAI_PORTS.knowledge}/v3`;
export const STATE_DIR = path.join(HOME, "memory-state");

// Limits of the stack (MemoryCore conversation/add, MemoryKnowledge raw/write + format registry).
const MSG_MAX = 8000, MSGS_PER_CALL = 100;
const WIKI_FILE_MAX = 400 * 1024, WIKI_BATCH_FILES = 10, WIKI_BATCH_BYTES = 15 * 1024 * 1024, WIKI_MAX_FILES = 80;
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "build", "dist", "out", "target", ".next", ".nuxt", "Pods",
  ".venv", "venv", "__pycache__", ".codegraph", "coverage", ".turbo", ".cache", "DerivedData", ".gradle", ".dart_tool"]);

// ---- HTTP -------------------------------------------------------------------------------------

// Retries connection-level failures (a busy port forward drops some connections); every call
// used here is idempotent or append-only on a failure that never reached the server.
async function post(url, body, headers = {}, timeoutMs = 30000) {
  // The panel answers 401 INVALID_USER_KEY / 5xx when memory-core is too busy to verify the key
  // within its own 15 s (seen during heavy extraction and restarts): back off and retry those too.
  for (let round = 1; ; round++) {
    try { return await postOnce(url, body, headers, timeoutMs); } catch (e) {
      const transient = /INVALID_USER_KEY|NOT_TEAM_MEMBER|FORBIDDEN|HTTP 5\d\d|ECONNRESET|ECONNREFUSED|fetch failed|socket/i.test(e.message);
      if (!transient || round >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * round));
    }
  }
}

async function postOnce(url, body, headers, timeoutMs) {
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tdai-service-id": SERVICE, ...headers },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (e) {
      const why = e.cause?.code ?? e.cause?.message ?? e.message;
      if (attempt >= 3 || e.name === "TimeoutError") throw new Error(`${url.replace(/^https?:\/\/[^/]+/, "")}: ${why}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${url}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (j.code !== 0) {
    const e = new Error(`${url.replace(/^https?:\/\/[^/]+/, "")}: ${j.code} ${j.message ?? ""}`);
    e.code = j.code; e.data = j.data;
    throw e;
  }
  return j.data;
}

const key = () => { const k = adminKey(); if (!k) throw new Error("no TDAI admin key yet; run: ekip memory up"); return k; };
// Data plane wants a non-empty Bearer even when the gateway has no API key configured.
const coreData = (p, body, t) => post(`${CORE}/v3${p}`, body, { Authorization: `Bearer ${SETTINGS.tdaiGatewayKey || "ekip"}` }, t);
const coreMeta = (p, body) => post(`${CORE}/v3/meta${p}`, body, { "x-tdai-user-key": key() });
const panel = (p, body, t) => post(`${PANEL}${p}`, body, { "x-tdai-user-key": key() }, t);
/** Deletes a project's wiki and code graphs on the memory server (its memories stay with its agent). */
export async function forgetKnowledge({ wikiId, codeGraphs = [] } = {}) {
  const ids = codeGraphs.map((g) => g.id ?? g).filter(Boolean);
  const errors = [];
  if (wikiId) await panel("/knowledge/wiki/delete", { wiki_ids: [wikiId] }).catch((e) => errors.push(`wiki: ${e.message}`));
  if (ids.length) await panel("/knowledge/code-graph/delete", { code_graph_ids: ids }).catch((e) => errors.push(`code graph: ${e.message}`));
  return { wiki: wikiId ?? null, codeGraphs: ids.length, errors };
}

export const knowledgeTool = (knowledgeId, tool, params = {}) =>
  post(`${KNOWLEDGE}/tools/call`, { knowledge_id: knowledgeId, tool_name: tool, params });

// ---- identity: admin user and its team (discovered, cached per process) ------------------------

let ident = null;
export async function identity() {
  if (ident) return ident;
  const v = await post(`${CORE}/v3/meta/auth/verify`, { user_key: key() });
  const userId = v?.user?.user_id ?? v?.user_id;
  if (!userId) throw new Error("auth/verify returned no user");
  const teams = (await coreMeta("/team/list", { user_id: userId, limit: 100 })).items ?? [];
  const team = teams.find((t) => t.team_id === SETTINGS.tdaiTeamId) ?? teams.find((t) => t.name === "default-team") ?? teams[0];
  if (!team) throw new Error("admin user has no team");
  ident = { userId, teamId: team.team_id };
  return ident;
}

const resolve = (p) => (typeof p === "string" ? (getProject(p) ?? die(`unknown project: ${p} (ekip project ls)`)) : p);

// ---- git remotes ------------------------------------------------------------------------------

const git = (cwd, ...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
export function httpsRemote(url) {
  if (!url) return null;
  url = url.trim();
  const m = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (m) url = `https://${m[1]}/${m[2]}`;
  return url.startsWith("https://") ? url.replace(/\/+$/, "") : null;
}

// Private flag + default branch: gh for GitHub, ls-remote elsewhere (no auth = public).
function repoInfo(url) {
  const gh = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (gh) {
    const r = spawnSync("gh", ["repo", "view", gh[1], "--json", "isPrivate,defaultBranchRef"], { encoding: "utf8" });
    if (r.status === 0) {
      const j = JSON.parse(r.stdout);
      return { private: j.isPrivate, branch: j.defaultBranchRef?.name || "main" };
    }
  }
  const r = spawnSync("git", ["ls-remote", "--symref", url, "HEAD"], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const b = r.stdout?.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
  return { private: r.status !== 0, branch: b?.[1] ?? "main" };
}

const ghToken = () => {
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

// ---- per-project resources ----------------------------------------------------------------------

async function ensureAgent(name, teamId, userId, summary) {
  const agentName = `ekip-${name}`;
  const list = await coreMeta("/agent/list", { team_id: teamId, owner_user_id: userId, limit: 100 });
  const hit = (list.items ?? []).find((a) => a.name === agentName && a.status !== "archived");
  if (hit) return hit.agent_id;
  const a = await coreMeta("/agent/create", { team_id: teamId, owner_user_id: userId, name: agentName,
    description: (summary || `ekip project ${name}`).slice(0, 500), visibility: "team" });
  return a.agent_id;
}

async function ensureWiki(name, teamId) {
  const w = await panel("/knowledge/wiki/create", { team_id: teamId, name: `ekip-${name}` });
  return w.wiki_id;
}

// Private GitHub repos: provider "gongfeng" (bearer token, URL basic-auth user "private") works for
// GitHub too; the hub must run with CODE_SOURCE_ENABLED=gongfeng. Token from `gh auth token`.
async function ensureCodeGraph(url, teamId, repoName) {
  const info = repoInfo(url);
  const body = { team_id: teamId, repo_url: url, branch: info.branch, repo_name: repoName };
  if (info.private) {
    const t = ghToken();
    if (!t) throw new Error(`${url} is private and gh has no token`);
    Object.assign(body, { provider_id: SETTINGS.tdaiCodeProvider ?? "gongfeng", secret: t });
  }
  const cg = await panel("/knowledge/code-graph/create", body, 60000);
  return { repo: url, id: cg.code_graph_id, branch: info.branch, private: info.private, status: cg.status };
}

// Creates (or finds) the project's agent, wiki and TDAI code graphs; stores the ids in the registry.
export async function ensureProject(project) {
  const p = resolve(project);
  const { userId, teamId } = await identity();
  const t = { ...(p.tdai ?? {}) };
  t.teamId = teamId;
  t.agentId = await ensureAgent(p.name, teamId, userId, p.summary);
  t.wikiId = await ensureWiki(p.name, teamId);
  try { await panel("/knowledge/allocate", { knowledge_id: t.wikiId, agent_id: t.agentId, team_id: teamId }); } catch { /* already allocated */ }
  const urls = p.repos?.length ? p.repos.map((r) => ({ url: r.url, name: `${p.name}/${r.path}` })) : p.repo ? [{ url: p.repo, name: p.name }] : [];
  const graphs = [];
  for (const { url, name } of urls) {
    if (!url) continue;
    const known = (t.codeGraphs ?? []).find((g) => g.repo === url && g.id);
    if (known) { graphs.push(known); continue; }
    try { graphs.push(await ensureCodeGraph(url, teamId, name)); }
    catch (e) { graphs.push({ repo: url, id: null, error: e.message }); console.error(`ekip: code graph ${url}: ${e.message}`); }
  }
  t.codeGraphs = graphs;
  t.codeGraphId = graphs.find((g) => g.id)?.id ?? null;
  updateProject(p.name, { tdai: t });
  return { teamId, agentId: t.agentId, wikiId: t.wikiId, codeGraphId: t.codeGraphId, codeGraphs: graphs };
}

// Re-pulls every TDAI code graph of the project (private ones re-clone with the stored token).
export async function syncCodeGraphs(project) {
  const p = resolve(project);
  const out = [];
  for (const g of p.tdai?.codeGraphs ?? []) {
    if (!g.id) continue;
    try { out.push({ id: g.id, ...(await panel("/knowledge/code-graph/sync", { code_graph_id: g.id })) }); }
    catch (e) { out.push({ id: g.id, error: e.message }); }
  }
  return out;
}

export async function codeGraphStatus(id) {
  const d = await panel("/knowledge/code-graph/get", { code_graph_id: id });
  return { id, status: d.status, step: d.internal_status ?? d.step, error: d.sync_error ?? d.error, stats: d.stats };
}

export async function wikiStatus(id) {
  const d = await panel("/knowledge/wiki/get", { wiki_id: id });
  return { id, status: d.status, pages: d.page_count ?? d.pages, progress: d.progress, error: d.sync_error ?? d.error };
}

// Lets an agent that holds the asset see it as a tool in proxied sessions (needs the graph ready).
export async function allocateReady(project) {
  const p = resolve(project);
  for (const g of p.tdai?.codeGraphs ?? []) {
    if (!g.id) continue;
    try { await panel("/knowledge/allocate", { knowledge_id: g.id, agent_id: p.tdai.agentId, team_id: p.tdai.teamId }); } catch { /* not ready or done */ }
  }
}

// ---- wiki ingest ----------------------------------------------------------------------------------

function mdFiles(dir, rel = "", depth = 0, out = []) {
  if (depth > 6) return out;
  let ents = [];
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) mdFiles(dir, r, depth + 1, out); }
    else if (/\.(md|markdown)$/i.test(e.name)) out.push(r);
  }
  return out;
}

// Wiki sources: the project card, CLAUDE.md / AGENTS.md / README*, other top-level *.md, docs/**;
// for multi-repo folders the same top-level files of each sub-repo.
export function wikiSources(p) {
  const files = [];
  const add = (rel) => { if (!files.includes(rel) && fs.existsSync(path.join(p.path, rel))) files.push(rel); };
  const roots = ["", ...(p.repos ?? []).map((r) => r.path)];
  for (const root of roots) {
    let top = [];
    try { top = fs.readdirSync(path.join(p.path, root)); } catch { continue; }
    for (const f of ["CLAUDE.md", "AGENTS.md"]) add(path.join(root, f));
    for (const f of top.filter((f) => /^readme/i.test(f) && /\.(md|markdown)$/i.test(f))) add(path.join(root, f));
    for (const f of top.filter((f) => /\.(md|markdown)$/i.test(f))) add(path.join(root, f));
    for (const d of ["docs", "doc"]) if (fs.existsSync(path.join(p.path, root, d))) for (const f of mdFiles(p.path, path.join(root, d))) add(f);
  }
  return files;
}

const flat = (rel) => rel.replace(/[\\/]+/g, "__").replace(/[^A-Za-z0-9._-]/g, "_");

export async function ingestWiki(project) {
  const p = resolve(project);
  if (!p.tdai?.wikiId) await ensureProject(p);
  const q = resolve(p.name);
  const { teamId, wikiId } = q.tdai;
  const items = [];
  if (q.card && fs.existsSync(q.card)) items.push({ filename: "_project-card.md", content: fs.readFileSync(q.card, "utf8") });
  for (const rel of wikiSources(q)) {
    if (items.length >= WIKI_MAX_FILES) break;
    let c;
    try { c = fs.readFileSync(path.join(q.path, rel), "utf8"); } catch { continue; }
    if (!c.trim()) continue;
    if (Buffer.byteLength(c) > WIKI_FILE_MAX) c = `${Buffer.from(c).subarray(0, WIKI_FILE_MAX - 64).toString("utf8").replace(/�+$/, "")}\n\n…(truncated)`;
    items.push({ filename: flat(rel), content: c });
  }
  if (!items.length) return { wikiId, files: 0 };
  let batch = [], bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await panel("/knowledge/wiki/raw/write", { team_id: teamId, wiki_id: wikiId,
      files: batch.map((f) => ({ filename: f.filename, content: f.content, encoding: "utf8" })) }, 60000);
    batch = []; bytes = 0;
  };
  for (const f of items) {
    const n = Buffer.byteLength(f.content);
    if (batch.length >= WIKI_BATCH_FILES || bytes + n > WIKI_BATCH_BYTES) await flush();
    batch.push(f); bytes += n;
  }
  await flush();
  // reingest: replaces a running ingest instead of failing with "busy".
  const r = await panel("/knowledge/wiki/import-and-ingest", { wiki_id: wikiId, mode: "reingest" }, 60000);
  if (r && r.ok === false) throw new Error(`wiki ingest: ${r.error_message}`);
  return { wikiId, files: items.length, filenames: items.map((f) => f.filename), status: r?.status };
}

// ---- memory ----------------------------------------------------------------------------------------

function scope(p) {
  if (!p.tdai?.agentId) throw new Error(`project ${p.name} has no TDAI agent yet (ekip project sync ${p.name})`);
  return { team_id: p.tdai.teamId, agent_id: p.tdai.agentId, user_id: ident?.userId };
}

// L1 memories (extracted facts) first, then raw conversation hits (L0, includes fresh notes).
// facts: L1 only (distilled facts and decisions). Searching L0 too means a vector scan over every
// stored message, which is what makes a full recall take seconds; per-message hooks skip it.
export async function recall(project, query, limit = 5, { timeoutMs = 10000, factsOnly = false } = {}) {
  const p = resolve(project);
  await identity();
  const s = scope(p);
  const q = String(query).slice(0, 2048);
  const [l1, l0] = await Promise.allSettled([
    coreData("/atomic/search", { ...s, query: q, limit }, timeoutMs),
    factsOnly ? Promise.resolve(null) : coreData("/conversation/search", { ...s, query: q, limit }, timeoutMs),
  ]);
  const out = [];
  for (const m of l1.value?.items ?? []) out.push({ layer: "L1", type: m.type, content: m.content, score: m.score, at: m.updated_at });
  for (const m of l0.value?.messages ?? []) {
    if (out.some((o) => o.content === m.content)) continue;
    out.push({ layer: "L0", role: m.role, content: m.content, score: m.score, session: m.session_id, at: m.recorded_at ?? m.timestamp });
  }
  if (!out.length && l1.status === "rejected" && l0.status === "rejected") throw l1.reason;
  return out.slice(0, limit);
}

async function addConversation(p, sessionId, messages) {
  await identity();
  const s = scope(p);
  let sent = 0;
  for (let i = 0; i < messages.length; i += MSGS_PER_CALL) {
    const batch = messages.slice(i, i + MSGS_PER_CALL);
    await coreData("/conversation/add", { ...s, session_id: sessionId, messages: batch }, 30000);
    sent += batch.length;
  }
  return sent;
}

// ---- skills (procedures TencentDB extracted from past sessions, per project agent) -------------

// Names of the user's general skills (~/.claude/skills and installed plugins): the importer copied
// those into every agent, so they are not project knowledge and are filtered out of "project skills".
let generic = null;
function genericSkillNames() {
  if (generic) return generic;
  generic = new Set();
  const home = os.homedir();
  try { for (const n of fs.readdirSync(path.join(home, ".claude/skills"))) generic.add(n); } catch { /* none */ }
  const r = spawnSync("find", [path.join(home, ".claude/plugins/cache"), "-name", "SKILL.md", "-maxdepth", "6"], { encoding: "utf8" });
  for (const f of (r.stdout ?? "").split("\n").filter(Boolean)) generic.add(path.basename(path.dirname(f)));
  return generic;
}

/** Skills that fit a task, best first (BM25 over name, description and body). */
export async function skillSearch(project, query, limit = 5, { projectOnly = true } = {}) {
  const p = resolve(project);
  await identity();
  const d = await coreData("/skill/search", { ...scope(p), query: String(query).slice(0, 500), limit: limit * 4, top_k: limit * 4 }, 20000);
  const items = (d?.items ?? []).filter((s) => !projectOnly || !genericSkillNames().has(s.name));
  return items.slice(0, limit).map((s) => ({ name: s.name, description: s.description, id: s.skill_id, score: s.score }));
}

/** Every active skill of the project's agent (project-specific ones unless projectOnly is false). */
export async function projectSkills(project, { projectOnly = true } = {}) {
  const p = resolve(project);
  await identity();
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const d = await coreData("/skill/list", { ...scope(p), filters: { status: ["active"] }, pagination: { limit: 100, offset } }, 30000);
    const batch = d?.items ?? [];
    out.push(...batch);
    if (!batch.length || out.length >= (d?.total ?? 0)) break;
  }
  return out.filter((s) => !projectOnly || !genericSkillNames().has(s.name)).map((s) => ({ name: s.name, description: s.description, id: s.skill_id }));
}

/** One skill's full text (by name or id). */
export async function skillGet(project, nameOrId) {
  const p = resolve(project);
  await identity();
  const id = /^skl-/.test(nameOrId) ? nameOrId : (await coreData("/skill/get-by-name", { ...scope(p), skill_name: nameOrId }, 20000))?.skill_id;
  if (!id) throw new Error(`no skill ${nameOrId} for ${p.name}`);
  const d = await coreData("/skill/get", { ...scope(p), skill_id: id }, 20000);
  return { name: d.name, description: d.description, content: d.content ?? "", files: (d.manifest ?? []).map((f) => f.path) };
}

/** Sessions outside any registered project go to the admin's default agent as "genel". */
export function generalProject() {
  return { name: "genel", path: os.homedir(), tdai: { agentId: SETTINGS.tdaiDefaultAgent ?? null } };
}

/** A worker run (task + final report) as a short exchange in the project's memory. */
export async function recordRun(project, { id, via, task, report, status }) {
  const p = project ? resolve(project) : generalProject();
  if (!p.tdai?.agentId) return { skipped: "no agent" };
  const sent = await addConversation(p, `ekip-run-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}`, [
    { role: "user", content: `[ekip worker task, via ${via}] ${String(task).slice(0, MSG_MAX - 60)}` },
    { role: "assistant", content: `[${status}] ${String(report || "(no report)").slice(-(MSG_MAX - 20))}` },
  ]);
  return { sent };
}

// A note goes in as a short exchange so L1 extraction picks it up; recall finds it at once in L0.
export async function remember(project, text) {
  const p = resolve(project);
  const t = redact(String(text)).trim().slice(0, MSG_MAX);
  if (!t) throw new Error("nothing to remember");
  await addConversation(p, `ekip-notes-${p.name}`, [
    { role: "user", content: `Remember this about the ${p.name} project: ${t}` },
    { role: "assistant", content: "Noted." },
  ]);
  return { ok: true };
}

const SYS_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
function turnText(entry) {
  if (!entry || entry.isSidechain || entry.isMeta || !["user", "assistant"].includes(entry.type)) return null;
  const c = entry.message?.content;
  let text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
  // History import reads local session files directly; redact the extracted text before upload.
  text = redact(text.replace(SYS_RE, "").trim());
  if (!text || /^<(command-|local-command|bash-|task-notification)/.test(text) || text.startsWith("Caveat:")) return null;
  if (text.length > MSG_MAX) text = `${text.slice(0, MSG_MAX - 20)}\n…(truncated)`;
  return { role: entry.type, content: text };
}

// Incremental: remembers how many complete transcript lines were already sent for this session.
export async function capture(project, transcriptPath, sessionId) {
  const p = resolve(project);
  const dir = path.join(STATE_DIR, "capture");
  fs.mkdirSync(dir, { recursive: true });
  const sid = String(sessionId || path.basename(transcriptPath, ".jsonl")).replace(/[^A-Za-z0-9_-]/g, "_");
  const stateFile = path.join(dir, `${sid}.json`);
  const lock = `${stateFile}.lock`;
  try { fs.mkdirSync(lock); } catch {
    // another capture of this session is running (or died long ago)
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 10 * 60 * 1000) return { skipped: "locked" }; } catch { /* gone */ }
  }
  try {
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { lines: 0 };
    const raw = fs.readFileSync(transcriptPath, "utf8");
    const lines = raw.split("\n");
    if (!raw.endsWith("\n")) lines.pop(); // last line still being written
    else lines.pop(); // empty tail after the final newline
    if (lines.length <= state.lines) return { sent: 0, lines: lines.length };
    const msgs = [];
    for (const l of lines.slice(state.lines)) {
      try { const m = turnText(JSON.parse(l)); if (m) msgs.push(m); } catch { /* not json */ }
    }
    const sent = msgs.length ? await addConversation(p, sid, msgs) : 0;
    fs.writeFileSync(stateFile, JSON.stringify({ lines: lines.length, project: p.name, transcript: transcriptPath, at: new Date().toISOString() }));
    return { sent, lines: lines.length };
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// ---- CLI: ekip memory search|remember|ingest|capture ------------------------------------------------

function projectArg(a) {
  if (a && a !== ".") return resolve(a);
  return findProject(process.cwd()) ?? die("not inside a registered project; pass a project name (ekip project ls)");
}

export async function main(args) {
  const [sub, proj, ...rest] = args;
  if (sub === "search") {
    const q = rest.join(" ");
    if (!q) die("usage: ekip memory search <project|.> <query>");
    const hits = await recall(projectArg(proj), q, 8);
    if (!hits.length) console.log("no memories found");
    for (const h of hits) console.log(`[${h.layer}${h.type ? `/${h.type}` : h.role ? `/${h.role}` : ""}${h.score != null ? ` ${Number(h.score).toFixed(2)}` : ""}] ${h.content.replace(/\s+/g, " ").slice(0, 400)}`);
  } else if (sub === "remember") {
    const t = rest.join(" ");
    if (!t) die("usage: ekip memory remember <project|.> <text>");
    await remember(projectArg(proj), t);
    console.log("remembered");
  } else if (sub === "ingest") {
    const p = projectArg(proj);
    const r = await ingestWiki(p);
    console.log(`wiki ${r.wikiId}: ${r.files} file(s) uploaded, ingest ${r.status ?? "queued"}`);
  } else if (sub === "capture") {
    const [transcript, session] = rest;
    if (!transcript) die("usage: ekip memory capture <project|.> <transcript.jsonl> [session-id]");
    console.log(JSON.stringify(await capture(projectArg(proj), transcript, session)));
  } else if (sub === "projects") {
    for (const p of listProjects()) console.log(`${p.name}\tagent=${p.tdai?.agentId ?? "-"}\twiki=${p.tdai?.wikiId ?? "-"}\tcg=${(p.tdai?.codeGraphs ?? []).map((g) => g.id ?? "x").join(",") || "-"}`);
  } else die("usage: ekip memory search|remember|ingest|capture <project|.> ...");
}
