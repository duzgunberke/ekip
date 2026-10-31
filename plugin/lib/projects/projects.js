// Project registry (data/projects.json): each project gets a card, a local codegraph index, a TDAI
// agent + wiki + code graph(s), and is found from any cwd inside it.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, REPO, SETTINGS, die } from "../core/core.js";
import * as mem from "../memory/memory.js";
import { t } from "../core/i18n.js";

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
    const child = spawn(process.execPath, [EKIP_JS, "run", "--allow-nested", "--via", via, "--cwd", p.path, "--label", `proje kartı: ${p.name}`, "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.end(CARD_BRIEF(p.name));
    child.on("close", (code) => {
      const body = out.replace(/^\[ekip worker:[^\]]*\]\n/, "");
      // Some pools echo the brief (which itself shows "# NAME") and their transcript before the
      // answer: the card is the last "# NAME" heading to the end.
      const at = `\n${body}`.lastIndexOf(`\n# ${p.name}\n`);
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

const under = (p, root) => p === root || p.startsWith(`${root}${path.sep}`);
const encodeHistory = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

// Collect worktrees before the directory moves so external links can be repaired afterward.
function reposAtDepth(root) {
  const found = [];
  const visit = (dir, depth) => {
    if (isRepo(dir)) found.push(dir);
    if (depth >= 2) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") visit(path.join(dir, e.name), depth + 1);
  };
  visit(root, 0);
  return found;
}

function rewritePathFile(file, oldPath, newPath, dryRun = false) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(new RegExp(`${oldPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?![\\w.-])`, "g"), newPath);
  if (after === before) return false;
  if (!dryRun) fs.writeFileSync(file, after);
  return true;
}

function rewriteFiles(patterns, oldPath, newPath, dryRun = false) {
  const changed = [];
  for (const entry of patterns) {
    const abs = path.resolve(entry);
    if (!entry.includes("*") && !entry.includes("?")) { if (rewritePathFile(abs, oldPath, newPath, dryRun)) changed.push(abs); continue; }
    const base = path.resolve(entry.slice(0, Math.max(entry.lastIndexOf("/"), entry.lastIndexOf(path.sep))));
    const pattern = entry.slice(base.length + 1).replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const re = new RegExp(`^${pattern}$`);
    let names = []; try { names = fs.readdirSync(base); } catch { continue; }
    for (const name of names) if (re.test(name) && rewritePathFile(path.join(base, name), oldPath, newPath, dryRun)) changed.push(path.join(base, name));
  }
  return changed;
}

export function moveProject(identifier, destination, { dryRun = false } = {}) {
  const list = listProjects();
  const project = list.find((p) => p.name === identifier || path.resolve(p.path) === path.resolve(identifier));
  if (!project) throw new Error(`kayıtlı proje bulunamadı: ${identifier}`);
  const oldPath = path.resolve(project.path), newPath = path.resolve(destination);
  if (newPath === oldPath) throw new Error("hedef mevcut proje klasörüyle aynı");
  if (fs.existsSync(newPath)) throw new Error(`hedef zaten var: ${newPath}`);
  const lsof = spawnSync("sh", ["-c", "command -v lsof"], { stdio: "ignore" });
  if (lsof.status === 0) {
    const open = spawnSync("lsof", ["+D", oldPath], { encoding: "utf8", timeout: 10000 });
    if (open.status === 0 && open.stdout.trim().split("\n").length > 1) throw new Error("eski klasörde açık dosyalar var; önce kullanan süreçleri kapatın");
  }
  const repos = reposAtDepth(oldPath).map((repo) => ({ repo, worktrees: git(repo, "worktree", "list", "--porcelain").stdout.split("\n").filter((x) => x.startsWith("worktree ")).map((x) => x.slice(9)) }));
  const historyRoot = path.join(os.homedir(), ".claude/projects");
  const oldEncoded = encodeHistory(oldPath), newEncoded = encodeHistory(newPath);
  const historyMoves = [];
  const collectHistory = (oldE, newE) => { if (!fs.existsSync(historyRoot)) return; for (const n of fs.readdirSync(historyRoot)) if (n === oldE || n.startsWith(`${oldE}-`)) historyMoves.push([path.join(historyRoot, n), path.join(historyRoot, `${newE}${n.slice(oldE.length)}`)]); };
  collectHistory(oldEncoded, newEncoded);
  for (const d of fs.readdirSync(os.homedir(), { withFileTypes: true })) if (d.isSymbolicLink()) {
    const link = path.join(os.homedir(), d.name); let real; try { real = fs.realpathSync(link); } catch { continue; }
    if (under(oldPath, real)) collectHistory(encodeHistory(path.join(link, path.relative(real, oldPath))), encodeHistory(path.join(link, path.relative(real, newPath))));
  }
  const state = path.join(HOME, "memory-state/asset-import.json");
  let memoryStateChanged = false;
  try { memoryStateChanged = (JSON.parse(fs.readFileSync(state, "utf8")).done ?? []).some((k) => String(k).includes(oldEncoded)); } catch { /* no history state yet */ }
  const plan = { oldPath, newPath, repos, historyMoves: historyMoves.map(([a, b]) => [path.basename(a), path.basename(b)]), rewritten: [], memoryStateChanged };
  const rewrite = [path.join(CARDS, "*.md"), path.join(HOME, "config.json"), ...(SETTINGS.moveRewrite ?? [])];
  plan.rewritten = rewriteFiles(rewrite, oldPath, newPath, true);
  if (dryRun) return plan;
  fs.renameSync(oldPath, newPath);
  for (const { repo, worktrees } of repos) {
    const nextRepo = path.join(newPath, path.relative(oldPath, repo));
    for (const wt of worktrees) {
      const nextWt = under(path.resolve(wt), oldPath) ? path.join(newPath, path.relative(oldPath, path.resolve(wt))) : wt;
      git(nextRepo, "worktree", "repair", nextWt);
    }
  }
  save(list.map((p) => under(path.resolve(p.path), oldPath) ? { ...p, path: path.join(newPath, path.relative(oldPath, path.resolve(p.path))) } : p));
  for (const [src, dst] of historyMoves) {
    fs.mkdirSync(dst, { recursive: true });
    if (fs.existsSync(src)) for (const f of fs.readdirSync(src)) { const from = path.join(src, f), to = path.join(dst, f); if (!fs.existsSync(to)) fs.renameSync(from, to); }
    try { fs.rmdirSync(src); } catch { /* merged target may have retained files */ }
  }
  try { if (plan.memoryStateChanged) { const data = JSON.parse(fs.readFileSync(state, "utf8")); data.done = (data.done ?? []).map((k) => String(k).replaceAll(oldEncoded, newEncoded)); fs.writeFileSync(state, `${JSON.stringify(data, null, 2)}\n`); } } catch { /* no history state yet */ }
  rewriteFiles(rewrite, oldPath, newPath);
  return plan;
}

export async function main(argv) {
  const args = [...argv];
  const sub = args.shift();
  if (sub === "move") {
    const dryRun = bool(args, "--dry-run");
    if (!args[0] || !args[1]) die("kullanım: ekip project move <ad|eski-yol> <yeni-yol> [--dry-run]");
    const result = moveProject(args[0], args[1], { dryRun });
    console.log(`${dryRun ? "Plan" : "Taşındı"}: ${result.oldPath} → ${result.newPath}`);
    console.log(`Kayıt: ${dryRun ? "planlandı" : "güncellendi"}; Git depoları/worktree'ler: ${result.repos.length}; Claude geçmişi: ${result.historyMoves.length}; hafıza durumu: ${result.memoryStateChanged ? "güncellendi" : "yok"}; metinler: ${result.rewritten.length}`);
    for (const repo of result.repos) console.log(`  git: ${repo.repo} (${repo.worktrees.length} worktree)`);
    for (const [from, to] of result.historyMoves) console.log(`  Claude: ${from} → ${to}`);
    for (const file of result.rewritten) console.log(`  metin: ${file}`);
    return;
  }
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
  } else if (sub === "config") {
    const p = args[0] && !args[0].startsWith("-") ? getProject(args[0]) : null;
    if (!p) die("kullanım: ekip project config <ad>  (projede paylaşılan .ekip/ klasörünü kurar)");
    const r = (await import("./project-config.js")).initConfig(p);
    console.log(`${r.dir}${r.made.length ? `\n  oluşturuldu: ${r.made.join(", ")}` : "\n  zaten vardı"}\n  .ekip/rules.md'yi doldurun ve klasörü projeyle birlikte commit edin.`);
  } else if (sub === "lesson" || sub === "lessons") {
    // ekip project lesson <name> "text": a mistake the user corrected, added to every later brief
    // "genel": the lead's own lessons, outside any project (data/projects/genel.lessons.md)
    const p = args[0] && !args[0].startsWith("-") ? getProject(args[0]) ?? (args[0] === "genel" ? { name: "genel" } : null) : null;
    if (!p) die('kullanım: ekip project lesson <ad|genel> "ders"  |  ekip project lessons <ad|genel>');
    const cfg = await import("./project-config.js");
    if (sub === "lessons" || !args[1]) { console.log(cfg.lessons(p, 100_000) || `(${cfg.lessonsFile(p)})`); return; }
    console.log(cfg.addLesson(p, args.slice(1).join(" ")));
    // every lesson is also an acceptance criterion: the automatic review checks deliveries against it
    if (p.path) console.log(t("kabul kriteri olarak da sayılır (ekip project criteria {name})", { name: p.name }));
  } else if (sub === "criteria" || sub === "criterion") {
    // ekip project criteria <name>: what every delivery is reviewed against; criterion <name> "text" adds one
    const p = args[0] && !args[0].startsWith("-") ? getProject(args[0]) : null;
    if (!p) die(t('kullanım: ekip project criterion <ad> "kriter"  |  ekip project criteria <ad>'));
    const crit = await import("../review/criteria.js");
    if (sub === "criteria" || !args[1]) { console.log(crit.listText(p)); return; }
    const r = crit.addCriterion(p, args.slice(1).join(" "));
    console.log(r.added ? `${r.file}${r.merged ? `\n${t("{n} eski kriter birleştirildi", { n: r.merged })}` : ""}` : t("zaten var: {text}", { text: r.existing }));
  } else if (sub === "remove" || sub === "rm") {
    // For a project you deleted or no longer work on: registry entry, card and server-side wiki and
    // code graphs go; the project folder itself is never touched.
    const name = args[0];
    const p = name && !name.startsWith("-") ? getProject(name) : null;
    if (!p) die("kullanım: ekip project remove <ad>  (kayıtlı projeler: ekip project ls)");
    const r = await mem.forgetKnowledge({ wikiId: p.tdai?.wikiId, codeGraphs: p.tdai?.codeGraphs ?? [] }).catch((e) => ({ error: e.message }));
    if (p.card) fs.rmSync(p.card, { force: true });
    save(listProjects().filter((x) => x.name !== p.name));
    console.log(`${p.name}: kayıttan çıkarıldı · kart silindi · sunucu: ${r.error ? `atlandı (${r.error})` : r.errors?.length ? `hata: ${r.errors.join("; ")}` : `wiki ${r.wiki ? "silindi" : "yok"}, ${r.codeGraphs} kod grafiği silindi`}`);
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
  } else die("usage: ekip project add|scan|ls|show|sync|card|config|lesson|lessons|criteria|criterion ...");
}
