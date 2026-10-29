// Project registry (data/projects.json): each project gets a card, a local codegraph index, a TDAI
// agent + wiki + code graph(s), and is found from any cwd inside it.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, REPO, SETTINGS, die } from "./core.js";
import * as mem from "./memory.js";

export const REGISTRY = path.join(HOME, "projects.json");
export const CARDS = path.join(HOME, "projects");
export const PROJECTS_ROOT = SETTINGS.projectsRoot ?? path.join(os.homedir(), "Projects");
const EKIP_JS = path.join(REPO, "plugin/bin/ekip.js");
const LOGS = path.join(HOME, "logs");

// ---- registry ---------------------------------------------------------------------------------

export function listProjects() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch { return []; }
}
function save(list) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
  fs.renameSync(tmp, REGISTRY);
}
export const getProject = (name) => listProjects().find((p) => p.name === name) ?? null;
export function updateProject(name, patch) {
  const list = listProjects();
  const i = list.findIndex((p) => p.name === name);
  if (i < 0) throw new Error(`unknown project ${name}`);
  list[i] = { ...list[i], ...patch };
  save(list);
  return list[i];
}

// Longest registered path that contains dir.
export function findProject(dir = process.cwd()) {
  let real = path.resolve(dir);
  try { real = fs.realpathSync(real); } catch { /* keep */ }
  let best = null;
  for (const p of listProjects()) {
    if ((real === p.path || real.startsWith(`${p.path}${path.sep}`)) && (!best || p.path.length > best.path.length)) best = p;
  }
  return best;
}

// ---- repo discovery -----------------------------------------------------------------------------

const git = (cwd, ...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const isRepo = (d) => fs.existsSync(path.join(d, ".git"));
const remote = (d) => mem.httpsRemote(git(d, "remote", "get-url", "origin").stdout);
const lastCommit = (d) => Number(git(d, "log", "-1", "--format=%ct").stdout.trim()) || 0;

// Sub-repos one or two levels down (multi-repo folders such as my-app).
function subRepos(dir) {
  const out = [];
  const walk = (rel, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = path.join(rel, e.name);
      if (isRepo(path.join(dir, r))) out.push(r);
      else if (depth < 2) walk(r, depth + 1);
    }
  };
  walk("", 1);
  return out;
}

function describeRepos(dir) {
  if (isRepo(dir)) return { repo: remote(dir), repos: undefined, last: lastCommit(dir) };
  const subs = subRepos(dir);
  return {
    repo: null,
    repos: subs.map((r) => ({ path: r, url: remote(path.join(dir, r)) })),
    last: Math.max(0, ...subs.map((r) => lastCommit(path.join(dir, r)))),
  };
}

// ---- local codegraph (@colbymchenry/codegraph) ------------------------------------------------------

// .codegraph/ stays untracked through .git/info/exclude; tracked files are never touched.
function excludeCodegraph(repoDir) {
  const gitDir = git(repoDir, "rev-parse", "--absolute-git-dir").stdout.trim();
  if (!gitDir) return;
  const f = path.join(gitDir, "info/exclude");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  if (!cur.split("\n").some((l) => l.trim() === ".codegraph/" || l.trim() === ".codegraph")) {
    fs.appendFileSync(f, `${cur && !cur.endsWith("\n") ? "\n" : ""}.codegraph/\n`);
  }
}

// One background indexer at a time (a mkdir lock), so registering many projects doesn't swamp the machine.
export function codegraphLocal(p, mode = "init") {
  if (spawnSync("sh", ["-c", "command -v codegraph"], { stdio: "ignore" }).status !== 0) return { skipped: "codegraph not installed" };
  if (isRepo(p.path)) excludeCodegraph(p.path);
  const cmd = mode === "sync" && fs.existsSync(path.join(p.path, ".codegraph")) ? "sync" : "init";
  fs.mkdirSync(LOGS, { recursive: true });
  const lock = path.join(HOME, "locks/codegraph");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const log = path.join(LOGS, `codegraph-${p.name}.log`);
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const script = `while ! mkdir ${q(lock)} 2>/dev/null; do sleep 5; done; trap 'rmdir ${q(lock)}' EXIT; `
    + `echo "== $(date) codegraph ${cmd}"; CODEGRAPH_TELEMETRY=0 nice -n 10 codegraph ${cmd} ${cmd === "init" ? "-y " : ""}${q(p.path)}; echo "== exit $?"`;
  const out = fs.openSync(log, "a");
  const child = spawn("sh", ["-c", script], { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  return { started: cmd, log };
}

// ---- project card (written by a worker) --------------------------------------------------------------

const CARD_BRIEF = (name) => `Write a concise PROJECT CARD in Markdown for the project in the current directory ("${name}").
Read what you need (README, CLAUDE.md/AGENTS.md, package manifests, build files, folder layout, recent git log)
but DO NOT modify, create or delete any file and do not run builds, installs or tests.
Sections (short bullets, concrete paths and commands, max ~80 lines total):
# ${name}
one-line summary of what it is
## Purpose
## Stack
## Layout (key directories/files and what lives where; for multi-repo folders, each sub-repo)
## Run / test / build / deploy (exact commands)
## Frequent tasks
## Gotchas
## Where notes live (docs, CLAUDE.md, ADRs, issue trackers)
Your final answer must be ONLY the card markdown, starting with the line "# ${name}". No preamble, no report.`;

export function generateCard(p, { via = process.env.EKIP_CARD_VIA ?? "auto" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [EKIP_JS, "run", "--via", via, "--cwd", p.path, "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.end(CARD_BRIEF(p.name));
    child.on("close", (code) => {
      const body = out.replace(/^\[ekip worker:[^\]]*\]\n/, "");
      const at = body.search(new RegExp(`^# `, "m"));
      if (code !== 0 || at < 0) return resolve({ ok: false, error: (err.trim().split("\n").pop() || body.slice(0, 300)) });
      let card = body.slice(at).replace(/\n```\s*$/, "").trim();
      fs.mkdirSync(CARDS, { recursive: true });
      const file = path.join(CARDS, `${p.name}.md`);
      fs.writeFileSync(file, `${card}\n`);
      const summary = card.split("\n").slice(1).map((l) => l.trim()).find((l) => l && !l.startsWith("#"))?.replace(/^[-*>]\s*/, "").slice(0, 200) ?? "";
      resolve({ ok: true, file, summary });
    });
  });
}

// ---- add / sync ---------------------------------------------------------------------------------------

export async function addProject(dir, { name, card = true, codegraph = true, tdai = true, wiki = true, log = console.error } = {}) {
  let abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${abs}`);
  abs = fs.realpathSync(abs);
  name ??= path.basename(abs);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`bad project name ${name} (use --name)`);
  const r = describeRepos(abs);
  const list = listProjects();
  const prev = list.find((p) => p.name === name || p.path === abs);
  const rec = {
    ...(prev ?? {}), name, path: abs, repo: r.repo ?? undefined, repos: r.repos?.length ? r.repos : undefined,
    summary: prev?.summary ?? "", card: prev?.card ?? null, tdai: prev?.tdai ?? {}, addedAt: prev?.addedAt ?? new Date().toISOString(),
  };
  save([...list.filter((p) => p !== prev), rec]);
  const res = { name, steps: {} };
  if (codegraph) res.steps.codegraph = codegraphLocal(rec, "init");
  if (tdai) {
    try { res.steps.tdai = await mem.ensureProject(name); log(`${name}: tdai agent ${res.steps.tdai.agentId}, wiki ${res.steps.tdai.wikiId}, ${res.steps.tdai.codeGraphs.filter((g) => g.id).length} code graph(s)`); }
    catch (e) { res.steps.tdai = { error: e.message }; log(`${name}: tdai failed: ${e.message}`); }
  }
  if (card) {
    log(`${name}: writing project card (worker)…`);
    const c = await generateCard(rec);
    if (c.ok) { updateProject(name, { card: c.file, summary: c.summary }); log(`${name}: card ${c.file}`); }
    else log(`${name}: card failed: ${c.error}`);
    res.steps.card = c;
  }
  if (tdai && wiki && !res.steps.tdai?.error) {
    try { res.steps.wiki = await mem.ingestWiki(name); log(`${name}: wiki ingest queued (${res.steps.wiki.files} files)`); }
    catch (e) { res.steps.wiki = { error: e.message }; log(`${name}: wiki failed: ${e.message}`); }
  }
  return res;
}

export async function syncProject(name, { log = console.error } = {}) {
  const p = getProject(name) ?? die(`unknown project: ${name}`);
  const d = describeRepos(p.path);
  updateProject(name, { repo: d.repo ?? undefined, repos: d.repos?.length ? d.repos : undefined });
  const out = { codegraph: codegraphLocal(getProject(name), "sync") };
  try { out.tdai = await mem.ensureProject(name); } catch (e) { out.tdai = { error: e.message }; }
  try { out.graphs = await mem.syncCodeGraphs(name); } catch (e) { out.graphs = { error: e.message }; }
  try { await mem.allocateReady(name); } catch { /* best effort */ }
  try { out.wiki = await mem.ingestWiki(name); } catch (e) { out.wiki = { error: e.message }; }
  log(`${name}: ${JSON.stringify({ codegraph: out.codegraph.started ?? out.codegraph.skipped, graphs: out.graphs, wiki: out.wiki.files ?? out.wiki.error })}`);
  return out;
}

// Run async jobs with at most n in flight.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

export function scan(days = 30, root = PROJECTS_ROOT) {
  const since = Date.now() / 1000 - days * 86400;
  const known = new Set(listProjects().map((p) => p.path));
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = path.join(root, e.name);
    const d = describeRepos(dir);
    if (d.last >= since && (d.repo || d.repos?.length || isRepo(dir))) out.push({ name: e.name, path: dir, last: d.last, registered: known.has(dir) });
  }
  return out.sort((a, b) => b.last - a.last);
}

// ---- CLI ------------------------------------------------------------------------------------------------

const flag = (args, f, def) => { const i = args.indexOf(f); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (args, f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };

export async function main(argv) {
  const args = [...argv];
  const sub = args.shift();
  if (sub === "add") {
    const name = flag(args, "--name");
    const noCard = bool(args, "--no-card");
    if (!args[0] || args[0].startsWith("-")) die("kullanım: ekip project add <klasör> [--name AD] [--no-card]");
    const r = await addProject(args[0], { name, card: !noCard });
    const p = getProject(r.name);
    console.log(`${p.name}: ${p.path}\n  card: ${p.card ?? "-"}\n  tdai: ${JSON.stringify({ agent: p.tdai?.agentId, wiki: p.tdai?.wikiId, codeGraphs: (p.tdai?.codeGraphs ?? []).map((g) => g.id ?? `failed: ${g.error}`) })}`);
  } else if (sub === "scan") {
    const days = Number(flag(args, "--days", "30"));
    const yes = bool(args, "--yes");
    const c = scan(days);
    for (const x of c) console.log(`${x.registered ? "*" : " "} ${x.name.padEnd(24)} ${new Date(x.last * 1000).toISOString().slice(0, 10)}  ${x.path}`);
    const todo = c.filter((x) => !x.registered);
    if (!yes) { console.log(`\n${todo.length} unregistered (* = registered). Add all with: ekip project scan --days ${days} --yes`); return; }
    await pool(todo, 4, (x) => addProject(x.path).catch((e) => console.error(`${x.name}: ${e.message}`)));
  } else if (sub === "ls" || !sub) {
    const list = listProjects();
    if (!list.length) { console.log("no projects yet — ekip project add <path> or ekip project scan"); return; }
    for (const p of list) console.log(`${p.name.padEnd(20)} ${p.path}${p.summary ? `\n${" ".repeat(21)}${p.summary.slice(0, 100)}` : ""}`);
  } else if (sub === "show") {
    const p = (args[0] ? getProject(args[0]) : findProject()) ?? die(`unknown project: ${args[0] ?? process.cwd()}`);
    console.log(JSON.stringify(p, null, 2));
    for (const g of p.tdai?.codeGraphs ?? []) if (g.id) { try { console.log(`code graph ${g.repo}: ${JSON.stringify(await mem.codeGraphStatus(g.id))}`); } catch (e) { console.log(`code graph ${g.id}: ${e.message}`); } }
    if (p.tdai?.wikiId) { try { console.log(`wiki: ${JSON.stringify(await mem.wikiStatus(p.tdai.wikiId))}`); } catch (e) { console.log(`wiki: ${e.message}`); } }
    if (p.card && fs.existsSync(p.card)) console.log(`\n${fs.readFileSync(p.card, "utf8")}`);
  } else if (sub === "sync") {
    const names = args[0] === "--all" ? listProjects().map((p) => p.name) : args[0] ? [args[0]] : [findProject()?.name ?? die("usage: ekip project sync <name|--all>")];
    for (const n of names) await syncProject(n);
  } else if (sub === "card") {
    const p = getProject(args[0]) ?? die("usage: ekip project card <name>");
    const c = await generateCard(p);
    if (!c.ok) die(`card failed: ${c.error}`);
    updateProject(p.name, { card: c.file, summary: c.summary });
    console.log(c.file);
  } else die("usage: ekip project add|scan|ls|show|sync|card ...");
}
