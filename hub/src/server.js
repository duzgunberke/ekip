#!/usr/bin/env node
// ekip hub: always-on job runner + control panel. Node 22+, built-ins only.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Auth } from "./auth.js";
import { CodeMap } from "./codemap.js";
import { openStore, trim } from "./store.js";
import { Worker } from "./worker.js";

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const stripSlash = (u) => (u ? u.replace(/\/+$/, "") : "");
const DATA = env.EKIP_DATA ?? "/data";
const DEMO = env.EKIP_DEMO === "1";

const cfg = {
  // "Name|https://url,Name|https://url": other dashboards on the same server, shown as links.
  links: (env.EKIP_LINKS ?? "").split(",").map((x) => x.split("|")).filter(([n, u]) => n && /^https:\/\//.test(u ?? "")).map(([name, url]) => ({ name: name.trim(), url: url.trim() })),
  copilotToken: env.COPILOT_GITHUB_TOKEN || null,
  port: num(env.PORT, 7777),
  host: env.HOST ?? "0.0.0.0",
  data: DATA,
  demo: DEMO,
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
  // TencentDB knowledge service (code graphs) for the panel's code map.
  knowledgeUrl: stripSlash(env.KNOWLEDGE_URL ?? "http://tdai-memory-hub:8424"),
};

if (cfg.hubToken.length < 16) { console.error("EKIP_HUB_TOKEN must be set (at least 16 characters)"); process.exit(1); }
if (cfg.hubPassword.length < (DEMO ? 1 : 10)) { console.error(`EKIP_HUB_PASSWORD must be set (at least ${DEMO ? 1 : 10} characters)`); process.exit(1); }

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
const codemap = new CodeMap({ githubToken: cfg.githubToken, knowledgeUrl: cfg.knowledgeUrl });

// ---- http helpers --------------------------------------------------------------------------------

// The panel is a Vite build (hub/web -> hub/public): index.html plus content-hashed /assets/*.
const PUBLIC = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};
// No inline scripts or <style> elements anywhere (the build strips the few vendor ones); React and
// Radix only set element styles through the CSSOM, which style-src does not govern.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");
const staticCache = new Map(); // path -> { body, type } (the build is immutable inside the image)

function staticFile(rel) {
  if (staticCache.has(rel)) return staticCache.get(rel);
  const abs = path.resolve(PUBLIC, `.${rel}`);
  let hit = null;
  if (abs.startsWith(PUBLIC + path.sep) && !rel.split("/").some((seg) => seg.startsWith("."))) {
    try {
      if (fs.statSync(abs).isFile()) hit = { body: fs.readFileSync(abs), type: MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream" };
    } catch { /* missing */ }
  }
  if (hit || staticCache.size < 500) staticCache.set(rel, hit);
  return hit;
}

function serveStatic(req, res, p) {
  let rel;
  try { rel = decodeURIComponent(p); } catch { return send(res, 400, "bad path"); }
  if (rel.includes("\0")) return send(res, 400, "bad path");
  const isAsset = rel.startsWith("/assets/");
  let file = rel !== "/" && rel !== "/index.html" ? staticFile(rel) : null;
  let cache = isAsset ? "public, max-age=31536000, immutable" : "public, max-age=3600";
  if (!file) {
    // SPA fallback for client routes (/isler/abc, /login, ...); missing files with an extension 404.
    if (isAsset || /\.[a-z0-9]+$/i.test(rel)) return send(res, 404, "not found");
    file = staticFile("/index.html");
    cache = "no-cache";
    if (!file) return send(res, 503, "panel not built (run npm run build in hub/web)");
  }
  res.writeHead(200, {
    "content-type": file.type,
    "content-length": file.body.length,
    "cache-control": cache,
    "content-security-policy": CSP,
    "cross-origin-opener-policy": "same-origin",
  });
  return res.end(req.method === "HEAD" ? undefined : file.body);
}

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

function readJson(req, limit = 1_000_000, { allowEmpty = true } = {}) {
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || (allowEmpty ? "{}" : ""))); } catch { reject(new HttpError(400, "invalid JSON")); }
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
  if (p.dev != null) {
    if (typeof p.dev !== "object" || Array.isArray(p.dev)) bad("dev must be an object");
    out.dev = {};
    for (const [k, v] of Object.entries(p.dev)) if (/^(DATABASE_URL|REDIS_URL|PG[A-Z]+)$/.test(k) && v != null) out.dev[k] = str(String(v), 1000, `dev.${k}`);
  }
  if (p.tdai != null) {
    if (typeof p.tdai !== "object") bad("tdai must be an object");
    out.tdai = {};
    for (const k of ["teamId", "agentId", "wikiId", "codeGraphId"]) {
      const v = p.tdai[k];
      if (v != null && v !== "") out.tdai[k] = str(String(v), 200, `tdai.${k}`);
    }
    if (p.tdai.codeGraphs != null) {
      const cgs = p.tdai.codeGraphs;
      if (!Array.isArray(cgs) || cgs.length > 50) bad("tdai.codeGraphs must be an array (max 50)");
      out.tdai.codeGraphs = cgs.map((g, i) => {
        const f = `tdai.codeGraphs[${i}]`;
        if (!g || typeof g !== "object") bad(`${f} must be an object`);
        const id = str(g.id, 100, `${f}.id`, { required: true });
        if (!/^[\w.-]+$/.test(id)) bad(`${f}.id is invalid`);
        if (g.private != null && typeof g.private !== "boolean") bad(`${f}.private must be a boolean`);
        return {
          repo: str(g.repo, 300, `${f}.repo`, { required: true }),
          id,
          branch: str(g.branch, 200, `${f}.branch`) ?? null,
          private: g.private ?? null,
          status: str(g.status, 40, `${f}.status`) ?? null,
        };
      });
    }
  }
  return out;
}

const publicJob = (j) => {
  const { cancelRequested, ...rest } = j;
  return rest;
};

const runsCap = 2000, jobsCap = 2000, tasksCap = 500;
const runLogsDir = path.join(DATA, "runs");
const cleanLog = (s) => {
  const clean = String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s,;]+)/gi, "****").replace(/(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_|gsk_|hf_|nvapi-)[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})/gi, "****");
  return Buffer.from(clean).subarray(-64_000).toString("utf8");
};

// ---- tasks (live progress of user requests, pushed by the Mac) ------------------------------------

const TASK_STATUS = ["running", "done", "failed", "cancelled"];
const STEP_STATUS = ["pending", "running", "done", "failed", "skipped"];
const pctOf = (v, field) => {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) bad(`${field} must be a number`);
  return Math.max(0, Math.min(100, v));
};
const arr = (v, max, field) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) bad(`${field} must be an array (max ${max})`);
  return v.map((x, i) => { if (!x || typeof x !== "object") bad(`${field}[${i}] must be an object`); return x; });
};

function cleanTask(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) bad("task must be an object");
  const id = str(b.id, 128, "id", { required: true });
  if (!/^[\w.:-]+$/.test(id)) bad("invalid task id");
  const status = str(b.status, 20, "status", { required: true });
  if (!TASK_STATUS.includes(status)) bad(`status must be one of ${TASK_STATUS.join(", ")}`);
  const ts = (v, f) => str(v, 40, f) ?? null;
  return {
    id,
    title: str(b.title, 200, "title", { required: true }),
    project: str(b.project, 128, "project") ?? null,
    status,
    createdAt: ts(b.createdAt, "createdAt"),
    updatedAt: ts(b.updatedAt, "updatedAt"),
    endedAt: ts(b.endedAt, "endedAt"),
    steps: arr(b.steps, 50, "steps").map((s, i) => {
      const st = str(s.status, 20, `steps[${i}].status`, { required: true });
      if (!STEP_STATUS.includes(st)) bad(`steps[${i}].status must be one of ${STEP_STATUS.join(", ")}`);
      return { title: str(s.title, 200, `steps[${i}].title`, { required: true }), status: st, pct: pctOf(s.pct, `steps[${i}].pct`), startedAt: ts(s.startedAt, `steps[${i}].startedAt`), endedAt: ts(s.endedAt, `steps[${i}].endedAt`),
        progressAt: ts(s.progressAt, `steps[${i}].progressAt`), detail: str(s.detail, 300, `steps[${i}].detail`) ?? null };
    }),
    workers: arr(b.workers, 100, "workers").map((w, i) => ({
      runId: str(w.runId, 128, `workers[${i}].runId`) ?? null,
      via: str(w.via, 40, `workers[${i}].via`) ?? null,
      model: str(w.model, 200, `workers[${i}].model`) ?? null,
      label: str(w.label, 200, `workers[${i}].label`) ?? null,
      status: str(w.status, 40, `workers[${i}].status`) ?? null,
      startedAt: ts(w.startedAt, `workers[${i}].startedAt`),
      endedAt: ts(w.endedAt, `workers[${i}].endedAt`),
    })),
    notes: arr(b.notes, 200, "notes").map((n, i) => ({ at: ts(n.at, `notes[${i}].at`), text: str(n.text, 2000, `notes[${i}].text`) ?? "" })),
    pct: pctOf(b.pct, "pct") ?? 0,
    eta: ts(b.eta, "eta"),
    host: str(b.host, 200, "host") ?? null,
  };
}

// ---- status --------------------------------------------------------------------------------------

async function getJson(url, headers = {}) {
  try {
    // 8 s: under load (a big import, a busy box) a healthy service answers late; late is not down
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    let body = null;
    try { body = await r.json(); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, body };
  } catch (e) { return { ok: false, status: 0, error: e?.cause?.code ?? e?.name ?? "error" }; }
}

async function status() {
  if (DEMO) {
    const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const j of store.jobs.data) counts[j.status] = (counts[j.status] ?? 0) + 1;
    const snap = store.limits.data ?? {};
    return { time: new Date().toISOString(), freellmapi: { configured: true, up: true, ready: true, reason: null,
      providers: (Array.isArray(snap.free) ? snap.free : []).map(({ platform, name, status, keys, resumeAt }) => ({ platform, name, status, keys, resumeAt })),
      providerCount: (snap.free ?? []).length, counts: { healthy: (snap.free ?? []).filter((p) => p.status === "healthy").length }, authError: null },
      tdai: { configured: true, up: true, version: "demo", memory: true }, github: { token: false, copilot: true }, queue: counts,
      workers: worker.status(), links: cfg.links, clients: Object.values(store.clients.data) };
  }
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
      // a timeout means slow, not offline: the panel says "slow" and keeps the provider data
      slow: ready?.error === "TimeoutError",
      up: (!!ready && ready.status > 0) || ready?.error === "TimeoutError",
      ready: !!ready?.ok,
      reason: ready?.error === "TimeoutError" ? "slow" : ready?.body?.reason ?? ready?.error ?? null,
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
    github: { token: !!cfg.githubToken, copilot: !!cfg.copilotToken },
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

  if (p === "/api/limits" && m === "PUT") {
    const body = await readJson(req, 500_000, { allowEmpty: false });
    if (!body || typeof body !== "object" || Array.isArray(body)) bad("expected a JSON object");
    store.limits.data = { ...body, receivedAt: new Date().toISOString() };
    store.limits.save();
    return send(res, 200, { ok: true });
  }
  if (p === "/api/limits" && m === "GET") return send(res, 200, store.limits.data);

  if (p === "/api/savings" && m === "PUT") {
    const body = await readJson(req, 500_000, { allowEmpty: false });
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.rows)) bad("expected a savings snapshot");
    store.savings.data = { ...body, receivedAt: new Date().toISOString() };
    store.savings.save();
    return send(res, 200, { ok: true });
  }
  if (p === "/api/savings" && m === "GET") return send(res, 200, store.savings.data);

  if (p === "/api/usage" && m === "PUT") {
    const body = await readJson(req, 500_000, { allowEmpty: false });
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.projects)) bad("expected a usage summary");
    store.usage.data = { ...body, receivedAt: new Date().toISOString() };
    store.usage.save();
    return send(res, 200, { ok: true });
  }
  if (p === "/api/usage" && m === "GET") return send(res, 200, store.usage.data);

  if (p === "/api/projects" && m === "GET") return send(res, 200, store.projects.data);
  if (p === "/api/projects" && m === "PUT") {
    const body = await readJson(req, 5_000_000);
    const list = Array.isArray(body) ? body : body.projects;
    if (!Array.isArray(list) || list.length > 500) bad("expected an array of projects (or {projects, replace})");
    const clean = list.map(cleanProject);
    const now = new Date().toISOString();
    if (!Array.isArray(body) && body.replace === true) store.projects.data = [];
    for (const c of clean) {
      // dev credentials go to their own store, so GET /api/projects never returns them
      if (c.dev) { store.devenv.data[c.name] = c.dev; delete c.dev; store.devenv.save(); }
      const i = store.projects.data.findIndex((x) => x.name === c.name);
      if (i >= 0) store.projects.data[i] = { ...store.projects.data[i], ...c, updatedAt: now };
      else store.projects.data.push({ ...c, updatedAt: now });
    }
    store.projects.data.sort((a, b) => a.name.localeCompare(b.name));
    store.projects.save();
    return send(res, 200, { ok: true, count: store.projects.data.length });
  }
  if ((match = p.match(/^\/api\/projects\/([^/]+)\/(repos|graph|symbols)$/)) && m === "GET") {
    const project = store.projects.data.find((x) => x.name === decodeURIComponent(match[1]));
    if (!project) return send(res, 404, { error: "no such project" });
    const fresh = url.searchParams.get("fresh") === "1";
    if (DEMO && match[2] === "repos") return send(res, 200, { project: project.name, fetchedAt: new Date().toISOString(), repos: (project.repos ?? [project.repo]).filter(Boolean).map((url) => ({ url, key: url.replace(/^https:\/\/github.com\//, "github.com/"), host: "github.com", owner: "northwind-labs", name: url.split("/").pop(), github: true, codeGraph: { id: project.tdai?.codeGraphs?.[0]?.id ?? "cg_demo_storefront", branch: "main", status: "ready" }, fullName: `northwind-labs/${url.split("/").pop()}`, htmlUrl: url, description: project.summary, private: true, archived: false, fork: false, pushedAt: new Date().toISOString(), defaultBranch: "main", language: project.name === "payments-api" ? "Go" : project.name === "ios-app" ? "Swift" : "TypeScript", languages: [{ name: project.name === "payments-api" ? "Go" : "TypeScript", color: "#3178c6", share: 82 }, { name: "Shell", color: "#89e051", share: 18 }], openPrs: 3, branchCount: 14, branches: [] })) });
    if (DEMO && match[2] === "graph") {
      const repo = url.searchParams.get("repo") ?? "";
      const demoFiles = project.name === "storefront-web" ? [
        { p: "src", l: null, s: null }, { p: "src/checkout", l: null, s: null },
        { p: "src/checkout/CheckoutFlow.tsx", l: "TypeScript", s: 318, b: 12640 }, { p: "src/checkout/useCart.ts", l: "TypeScript", s: 142, b: 5912 }, { p: "src/checkout/PaymentStep.tsx", l: "TypeScript", s: 96, b: 4210 },
        { p: "src/cart", l: null, s: null }, { p: "src/cart/CartDrawer.tsx", l: "TypeScript", s: 94, b: 3820 }, { p: "src/cart/cart-store.ts", l: "TypeScript", s: 132, b: 5300 },
        { p: "src/auth", l: null, s: null }, { p: "src/auth/session.ts", l: "TypeScript", s: 88, b: 3410 },
        { p: "src/ui", l: null, s: null }, { p: "src/ui/Button.tsx", l: "TypeScript", s: 46, b: 1900 },
        { p: "src/payments", l: null, s: null }, { p: "src/payments/stripe.ts", l: "TypeScript", s: 206, b: 8421 },
        { p: "tests", l: null, s: null }, { p: "tests/checkout-race.spec.ts", l: "TypeScript", s: 118, b: 4490 }, { p: "README.md", l: "Markdown", s: null, b: 6800 }
      ] : [
        { p: "src", l: null, s: null }, { p: "src/api", l: null, s: null }, { p: "src/api/handlers.ts", l: "Go", s: 42, b: 2400 },
        { p: "src/core", l: null, s: null }, { p: "src/core/service.go", l: "Go", s: 28, b: 1800 }, { p: "tests", l: null, s: null }, { p: "README.md", l: "Markdown", s: null, b: 2200 }
      ];
      return send(res, 200, { source: "codegraph+github", codeGraph: { id: project.tdai?.codeGraphs?.[0]?.id ?? "cg_demo_storefront", branch: "main", ok: true, error: null }, repo, branch: "main", indexed: demoFiles.length * 3, truncated: false, notes: [], files: demoFiles });
    }
    try {
      if (match[2] === "repos") return send(res, 200, await codemap.repos(project, { fresh }));
      const repo = str(url.searchParams.get("repo"), 300, "repo", { required: true });
      if (match[2] === "graph") return send(res, 200, await codemap.graph(project, repo, { fresh }));
      const file = str(url.searchParams.get("file"), 500, "file", { required: true });
      if (DEMO) {
        const leaf = file.split("/").pop().replace(/\.[^.]+$/, "");
        const base = leaf.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").split(" ").map((x) => x[0]?.toUpperCase() + x.slice(1)).join("");
        return send(res, 200, { repo, file, symbols: [
          { name: `${base}Controller`, kind: "class", line: 18, endLine: 126 },
          { name: `use${base}`, kind: "function", line: 34, endLine: 88 },
          { name: `handle${base}Submit`, kind: "function", line: 94, endLine: 117 }
        ] });
      }
      return send(res, 200, await codemap.symbols(project, repo, file));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return send(res, e.code === 404 ? 404 : 502, { error: worker.redact(e.message ?? String(e)) });
    }
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
    const via = b.via ?? "auto";
    if (!["auto", "free", "copilot"].includes(via)) bad('via must be "auto", "free" or "copilot"');
    if (via === "copilot" && !cfg.copilotToken) bad("copilot needs COPILOT_GITHUB_TOKEN on the hub");
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
      model: str(b.model, 200, "model") ?? null,
      project: str(b.project, 128, "project") ?? null,
      task: str(b.task, 50_000, "task") ?? "",
      status: str(b.status, 40, "status") ?? null,
      host: str(b.host, 200, "host") ?? null,
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
  if ((match = p.match(/^\/api\/runs\/([\w.:-]{1,128})\/log$/))) {
    const id = match[1];
    if (m === "PUT") {
      const body = await readJson(req, 300_000, { allowEmpty: false });
      if (typeof body.log !== "string") bad("log must be a string");
      fs.mkdirSync(runLogsDir, { recursive: true });
      fs.writeFileSync(path.join(runLogsDir, `${id}.log`), cleanLog(body.log), { mode: 0o600 });
      const files = fs.readdirSync(runLogsDir).filter((f) => f.endsWith(".log")).map((f) => ({ f, m: fs.statSync(path.join(runLogsDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
      for (const old of files.slice(300)) fs.rmSync(path.join(runLogsDir, old.f), { force: true });
      return send(res, 200, { ok: true });
    }
    if (m === "GET") {
      const file = path.join(runLogsDir, `${id}.log`);
      let log = "";
      try { log = fs.readFileSync(file, "utf8"); } catch {
        const job = store.jobs.data.find((j) => j.id === id);
        if (job) { try { log = worker.tail(id, 64_000); } catch { /* missing job log */ } }
      }
      if (!log) return send(res, 404, { error: "no log available" });
      return send(res, 200, { log: cleanLog(log).split("\n").slice(-400).join("\n") });
    }
  }

  if (p === "/api/tasks" && m === "PUT") {
    const task = { ...cleanTask(await readJson(req, 1_000_000)), receivedAt: new Date().toISOString() };
    const i = store.tasks.data.findIndex((t) => t.id === task.id);
    if (i >= 0) store.tasks.data[i] = task; else store.tasks.data.push(task);
    trim(store.tasks.data, tasksCap, (t) => t.status === "running");
    store.tasks.save();
    return send(res, i >= 0 ? 200 : 201, { ok: true });
  }
  if (p === "/api/tasks" && m === "GET") {
    const limit = Math.min(num(url.searchParams.get("limit"), 200), tasksCap);
    const key = (t) => String(t.createdAt ?? t.receivedAt);
    return send(res, 200, [...store.tasks.data].sort((a, b) => key(b).localeCompare(key(a))).slice(0, limit));
  }
  if ((match = p.match(/^\/api\/tasks\/([\w.:-]{1,128})$/)) && m === "GET") {
    const task = store.tasks.data.find((t) => t.id === match[1]);
    return task ? send(res, 200, task) : send(res, 404, { error: "no such task" });
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

  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, p);
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

if (!DEMO) worker.start();
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
