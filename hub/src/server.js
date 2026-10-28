#!/usr/bin/env node
// ekip hub: always-on job runner + control panel. Node 22+, built-ins only.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Auth } from "./auth.js";
import { openStore, trim } from "./store.js";
import { Worker } from "./worker.js";

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const stripSlash = (u) => (u ? u.replace(/\/+$/, "") : "");
const DATA = env.EKIP_DATA ?? "/data";

const cfg = {
  // "Name|https://url,Name|https://url": other dashboards on the same server, shown as links.
  links: (env.EKIP_LINKS ?? "").split(",").map((x) => x.split("|")).filter(([n, u]) => n && /^https:\/\//.test(u ?? "")).map(([name, url]) => ({ name: name.trim(), url: url.trim() })),
  port: num(env.PORT, 7777),
  host: env.HOST ?? "0.0.0.0",
  data: DATA,
  jobsDir: path.join(DATA, "jobs"),
  workDir: path.join(DATA, "work"),
  claudeDir: env.CLAUDE_CONFIG_DIR ?? path.join(DATA, "claude"),
  hubToken: env.EKIP_HUB_TOKEN ?? "",
  hubPassword: env.EKIP_HUB_PASSWORD ?? "",
  workers: Math.min(num(env.EKIP_WORKERS, 2), 16),
  jobTimeoutMin: num(env.EKIP_JOB_TIMEOUT_MIN, 60),
  sessionHours: num(env.EKIP_SESSION_HOURS, 168),
  compactWindow: num(env.EKIP_COMPACT_WINDOW, 100000),
  trustProxy: env.EKIP_TRUST_PROXY === "1",
  allowLocalRepos: env.EKIP_ALLOW_LOCAL_REPOS === "1",
  freellmapiUrl: stripSlash(env.FREELLMAPI_URL),
  freellmapiKey: env.FREELLMAPI_KEY ?? "",
  tdaiUrl: stripSlash(env.TDAI_PROXY_URL),
  tdaiUserKey: env.TDAI_USER_KEY ?? "",
  githubToken: env.GITHUB_TOKEN ?? "",
};

if (cfg.hubToken.length < 16) { console.error("EKIP_HUB_TOKEN must be set (at least 16 characters)"); process.exit(1); }
if (cfg.hubPassword.length < 10) { console.error("EKIP_HUB_PASSWORD must be set (at least 10 characters)"); process.exit(1); }

fs.mkdirSync(DATA, { recursive: true });
function serverSecret() {
  if (env.EKIP_HUB_SECRET) return env.EKIP_HUB_SECRET;
  const f = path.join(DATA, "secret");
  try { return fs.readFileSync(f, "utf8").trim(); } catch {
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}

const store = openStore(DATA);
const auth = new Auth({ token: cfg.hubToken, password: cfg.hubPassword, secret: serverSecret(), sessionHours: cfg.sessionHours });
const worker = new Worker({ cfg, store });

// ---- http helpers --------------------------------------------------------------------------------

const PUBLIC = path.join(path.dirname(new URL(import.meta.url).pathname), "../public");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

function send(res, code, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(code, {
    "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg) => { throw new HttpError(400, msg); };

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) { reject(new HttpError(415, "content-type must be application/json")); return; }
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new HttpError(400, "invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  if (cfg.trustProxy) {
    // The proxy in front (Traefik) appends the address it saw; take the last entry, never the first.
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress ?? "?";
}

// ---- validation ----------------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const str = (v, max, field, { required = false } = {}) => {
  if (v == null || v === "") { if (required) bad(`${field} is required`); return undefined; }
  if (typeof v !== "string") bad(`${field} must be a string`);
  if (v.length > max) bad(`${field} is longer than ${max}`);
  return v;
};

function cleanProject(p) {
  if (!p || typeof p !== "object") bad("project must be an object");
  const name = str(p.name, 64, "name", { required: true });
  if (!NAME_RE.test(name)) bad(`invalid project name "${name}"`);
  const out = {
    name,
    repo: str(p.repo, 300, "repo") ?? null,
    summary: str(p.summary, 4000, "summary") ?? "",
    card: str(p.card, 200_000, "card") ?? "",
  };
  if (p.repos != null) {
    if (!Array.isArray(p.repos) || p.repos.length > 50) bad("repos must be an array (max 50)");
    out.repos = p.repos.map((r, i) => str(r, 300, `repos[${i}]`, { required: true }));
  }
  if (p.tdai != null) {
    if (typeof p.tdai !== "object") bad("tdai must be an object");
    out.tdai = {};
    for (const k of ["teamId", "agentId", "wikiId", "codeGraphId"]) {
      const v = p.tdai[k];
      if (v != null && v !== "") out.tdai[k] = str(String(v), 200, `tdai.${k}`);
    }
  }
  return out;
}

const publicJob = (j) => {
  const { cancelRequested, ...rest } = j;
  return rest;
};

const runsCap = 2000, jobsCap = 2000;

// ---- status --------------------------------------------------------------------------------------

async function getJson(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    let body = null;
    try { body = await r.json(); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, body };
  } catch (e) { return { ok: false, status: 0, error: e?.cause?.code ?? e?.name ?? "error" }; }
}

async function status() {
  const [ready, providers, tdai] = await Promise.all([
    cfg.freellmapiUrl ? getJson(`${cfg.freellmapiUrl}/readyz`) : null,
    cfg.freellmapiUrl && cfg.freellmapiKey ? getJson(`${cfg.freellmapiUrl}/v1/providers`, { authorization: `Bearer ${cfg.freellmapiKey}` }) : null,
    cfg.tdaiUrl ? getJson(`${cfg.tdaiUrl}/health`) : null,
  ]);
  const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const j of store.jobs.data) counts[j.status] = (counts[j.status] ?? 0) + 1;
  const plist = providers?.ok ? providers.body?.providers ?? [] : [];
  return {
    time: new Date().toISOString(),
    freellmapi: {
      configured: !!cfg.freellmapiUrl,
      up: !!ready && ready.status > 0,
      ready: !!ready?.ok,
      reason: ready?.body?.reason ?? ready?.error ?? null,
      providers: plist.map((p) => ({ platform: p.platform, name: p.name, status: p.status, keys: p.keys, resumeAt: p.resume_at ?? null })),
      providerCount: plist.length,
      counts: providers?.body?.counts ?? null,
      authError: providers && providers.status === 401 ? "FREELLMAPI_KEY rejected" : null,
    },
    tdai: {
      configured: !!cfg.tdaiUrl,
      up: !!tdai && tdai.status > 0 && tdai.status < 500,
      version: tdai?.body?.version ?? null,
      memory: !!cfg.tdaiUserKey,
    },
    github: { token: !!cfg.githubToken },
    queue: counts,
    workers: worker.status(),
    links: cfg.links,
    clients: Object.values(store.clients.data).sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "")),
  };
}

// ---- routes --------------------------------------------------------------------------------------

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  let match;

  if (p === "/api/session" && m === "GET") return send(res, 200, { ok: true });
  if (p === "/api/status" && m === "GET") return send(res, 200, await status());

  if (p === "/api/projects" && m === "GET") return send(res, 200, store.projects.data);
  if (p === "/api/projects" && m === "PUT") {
    const body = await readJson(req, 5_000_000);
    const list = Array.isArray(body) ? body : body.projects;
    if (!Array.isArray(list) || list.length > 500) bad("expected an array of projects (or {projects, replace})");
    const clean = list.map(cleanProject);
    const now = new Date().toISOString();
    if (!Array.isArray(body) && body.replace === true) store.projects.data = [];
    for (const c of clean) {
      const i = store.projects.data.findIndex((x) => x.name === c.name);
      if (i >= 0) store.projects.data[i] = { ...store.projects.data[i], ...c, updatedAt: now };
      else store.projects.data.push({ ...c, updatedAt: now });
    }
    store.projects.data.sort((a, b) => a.name.localeCompare(b.name));
    store.projects.save();
    return send(res, 200, { ok: true, count: store.projects.data.length });
  }
  if ((match = p.match(/^\/api\/projects\/([^/]+)$/)) && m === "DELETE") {
    const name = decodeURIComponent(match[1]);
    const before = store.projects.data.length;
    store.projects.data = store.projects.data.filter((x) => x.name !== name);
    store.projects.save();
    return send(res, before === store.projects.data.length ? 404 : 200, { ok: before !== store.projects.data.length });
  }

  if (p === "/api/jobs" && m === "POST") {
    const b = await readJson(req);
    const project = str(b.project, 64, "project", { required: true });
    if (!store.projects.data.some((x) => x.name === project)) bad(`unknown project "${project}"`);
    const task = str(b.task, 50_000, "task", { required: true });
    if (!task.trim()) bad("task is empty");
    const via = b.via ?? "free";
    if (via !== "free") bad('via must be "free" (the hub only runs the free pool)');
    const model = str(b.model, 100, "model");
    if (model && !/^[\w.:/@-]+$/.test(model)) bad("invalid model id");
    if (b.push != null && typeof b.push !== "boolean") bad("push must be a boolean");
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const job = { id, project, task, via, model: model ?? null, push: b.push ?? true, status: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, branch: null, report: null, diffstat: null, error: null };
    store.jobs.data.push(job);
    trim(store.jobs.data, jobsCap, (j) => j.status === "queued" || j.status === "running");
    store.jobs.save();
    setImmediate(() => worker.tick());
    return send(res, 201, publicJob(job));
  }
  if (p === "/api/jobs" && m === "GET") {
    const limit = Math.min(num(url.searchParams.get("limit"), 100), 1000);
    const project = url.searchParams.get("project");
    const list = store.jobs.data.filter((j) => !project || j.project === project).slice(-limit).reverse();
    return send(res, 200, list.map(({ report, ...j }) => ({ ...publicJob(j), reportPreview: report ? report.slice(0, 300) : null })));
  }
  if ((match = p.match(/^\/api\/jobs\/([a-z0-9-]{1,40})$/)) && m === "GET") {
    const job = store.jobs.data.find((j) => j.id === match[1]);
    if (!job) return send(res, 404, { error: "no such job" });
    return send(res, 200, { ...publicJob(job), log: worker.tail(job.id, num(url.searchParams.get("tail"), 12_000)) });
  }
  if ((match = p.match(/^\/api\/jobs\/([a-z0-9-]{1,40})\/cancel$/)) && m === "POST") {
    const job = store.jobs.data.find((j) => j.id === match[1]);
    if (!job) return send(res, 404, { error: "no such job" });
    const ok = worker.cancel(job);
    return send(res, ok ? 200 : 409, ok ? { ok: true, status: job.status } : { error: `job is ${job.status}` });
  }

  if (p === "/api/runs" && m === "POST") {
    const b = await readJson(req);
    const id = str(b.id, 128, "id", { required: true });
    if (!/^[\w.:-]+$/.test(id)) bad("invalid run id");
    const run = {
      id,
      via: str(b.via, 40, "via") ?? null,
      project: str(b.project, 128, "project") ?? null,
      task: str(b.task, 50_000, "task") ?? "",
      status: str(b.status, 40, "status") ?? null,
      report: str(b.report, 100_000, "report") ?? "",
      startedAt: str(b.startedAt, 40, "startedAt") ?? null,
      finishedAt: str(b.finishedAt, 40, "finishedAt") ?? null,
      receivedAt: new Date().toISOString(),
    };
    const i = store.runs.data.findIndex((r) => r.id === id);
    if (i >= 0) store.runs.data[i] = run; else store.runs.data.push(run);
    trim(store.runs.data, runsCap);
    store.runs.save();
    return send(res, i >= 0 ? 200 : 201, { ok: true });
  }
  if (p === "/api/runs" && m === "GET") {
    const limit = Math.min(num(url.searchParams.get("limit"), 100), 1000);
    const list = [...store.runs.data].sort((a, b) => String(b.startedAt ?? b.receivedAt).localeCompare(String(a.startedAt ?? a.receivedAt))).slice(0, limit);
    return send(res, 200, list);
  }

  if (p === "/api/heartbeat" && m === "POST") {
    const b = await readJson(req, 200_000);
    const client = str(b.client, 100, "client", { required: true });
    const agents = b.agents ?? [];
    if (!Array.isArray(agents) || agents.length > 100) bad("agents must be an array (max 100)");
    if (JSON.stringify(agents).length > 50_000) bad("agents too large");
    if (!store.clients.data[client] && Object.keys(store.clients.data).length >= 200) bad("too many clients");
    store.clients.data[client] = { client, host: str(b.host, 200, "host") ?? null, agents, lastSeen: new Date().toISOString(), ip: clientIp(req) };
    store.clients.save();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "not found" });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://hub");
  const p = url.pathname;
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  if (cfg.trustProxy && req.headers["x-forwarded-proto"] === "https") res.setHeader("strict-transport-security", "max-age=31536000");

  if (p === "/healthz") return send(res, 200, { ok: true });

  if (p.startsWith("/api/")) {
    const viaBearer = auth.bearerOk(req);
    const viaCookie = !viaBearer && auth.sessionOk(req);
    if (!viaBearer && !viaCookie) return send(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    // Cookie-authenticated writes must carry a custom header, which a cross-site page cannot send
    // without a CORS preflight this server never grants (on top of SameSite=Strict).
    if (viaCookie && !["GET", "HEAD"].includes(req.method) && req.headers["x-ekip-csrf"] !== "1") return send(res, 403, { error: "missing csrf header" });
    return api(req, res, url);
  }

  if (p === "/login" && req.method === "POST") {
    const ip = clientIp(req);
    const gate = auth.loginAllowed(ip);
    if (!gate.ok) return send(res, 429, { error: "too many attempts" }, { "retry-after": String(gate.retryAfter) });
    const b = await readJson(req, 10_000);
    if (typeof b.password === "string" && auth.passwordOk(b.password)) {
      auth.loginSucceeded(ip);
      return send(res, 200, { ok: true }, { "set-cookie": auth.cookie(auth.newSession(), Math.floor(auth.ttl / 1000)) });
    }
    auth.loginFailed(ip);
    console.error(`login failed from ${ip}`);
    return send(res, 401, { error: "wrong password" });
  }
  if (p === "/logout" && req.method === "POST") {
    return send(res, 200, { ok: true }, { "set-cookie": auth.cookie("", 0) });
  }

  const s = STATIC[p];
  if (s && (req.method === "GET" || req.method === "HEAD")) {
    const body = fs.readFileSync(path.join(PUBLIC, s[0]));
    res.writeHead(200, { "content-type": s[1], "content-security-policy": CSP, "cache-control": p === "/" ? "no-cache" : "public, max-age=300" });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  return send(res, 404, "not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

worker.start();
server.listen(cfg.port, cfg.host, () => {
  console.log(`ekip hub on http://${cfg.host}:${cfg.port}  workers=${cfg.workers}  freellmapi=${cfg.freellmapiUrl || "-"}  tdai=${cfg.tdaiUrl || "-"}  github=${cfg.githubToken ? "token" : "none"}`);
});

function shutdown() {
  console.log("shutting down");
  worker.stopAll();
  store.flushAll();
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
