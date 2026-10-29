// Project-specific code review: deterministic local checks plus two read-only worker reviews.
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { HOME } from "./core.js";
import { autoOrder, AGENTS } from "./agents.js";
import { c, dot, fit } from "./ui.js";
import { t } from "./i18n.js";

const EKIP = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../bin/ekip.js");
const UNSAFE_NAME = /(?:format|prettier\s+--write|eslint\s+--fix|\beas\b|update:|deploy|publish|release|\bpush\b|migrate|seed|db\s+reset)/i;
const LIVE_URL = /fetch\s*\(\s*["'`]https?:\/\/(?!localhost|127\.0\.0\.1)/;
// Treat writes as live-service risks only when the receiver looks like an ORM or model repository.
const ORM_WRITE = /(?:\b(?:prisma|db|tx)\s*\.\s*\w+\s*\.\s*(?:create|update|delete|upsert|createMany|deleteMany|updateMany)\s*\(|\b\w*(?:prisma|db|repo|model)\w*\s*\.\s*(?:create|update|delete|upsert|createMany|deleteMany|updateMany)\s*\(|\b\w+\s*\.\s*\w+\s*\.\s*(?:create|update|delete|upsert|createMany|deleteMany|updateMany)\s*\()/i;
const DATABASE_URL = /process\.env\.DATABASE_URL/;

let skippedChecks = [];

const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const existsRepo = (dir) => fs.existsSync(path.join(dir, ".git")) || git(dir, "rev-parse", "--show-toplevel").status === 0;

// Find repositories nested under a registered project without descending into dependencies.
function repos(root) {
  if (existsRepo(root)) return [root];
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable directory */ }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "vendor"].includes(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (existsRepo(child)) found.push(child);
      else if (depth < 2) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function diffBase(repo, base) {
  if (base) return base;
  const branch = git(repo, "rev-parse", "--verify", "origin/main").status === 0 ? "origin/main"
    : git(repo, "rev-parse", "--verify", "main").status === 0 ? "main" : null;
  if (branch) return git(repo, "merge-base", "HEAD", branch).stdout.trim();
  return git(repo, "rev-parse", "HEAD~1").status === 0 ? "HEAD~1" : "HEAD";
}

function changed(repo, ref) {
  const diff = git(repo, "diff", "--name-only", ref, "--").stdout.split("\n").filter(Boolean);
  const status = git(repo, "status", "--porcelain", "-uall").stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
  return [...new Set([...diff, ...status])].filter((file) => file && !file.startsWith("../"));
}

const norm = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Read candidate check sources and reject scripts that appear to contact or mutate live services.
function safeSource(repo, name, command, all) {
  if (all) return true;
  const candidate = [command.match(/(?:node|tsx|ts-node|vitest|jest)\s+([^\s]+)/)?.[1],
    `scripts/${name.replace(/^(check|test|verify):/, "")}.ts`, `scripts/${name.replace(/^(check|test|verify):/, "")}.js`].filter(Boolean);
  let source = "";
  for (const file of candidate) {
    const resolved = path.resolve(repo, file);
    if (resolved.startsWith(repo + path.sep) && fs.existsSync(resolved)) source += fs.readFileSync(resolved, "utf8");
  }
  return !((DATABASE_URL.test(source) && ORM_WRITE.test(source)) || LIVE_URL.test(source));
}

// Select checks by changed-file references and names, retaining the established check limits.
function scriptsFor(repo, files, all) {
  const packageFile = path.join(repo, "package.json");
  if (!fs.existsSync(packageFile)) return [];
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(packageFile, "utf8")).scripts ?? {}; } catch { return []; }
  const out = [];
  const gates = Object.entries(scripts).filter(([name, command]) => /^(typecheck|type-check|tsc|lint)$/i.test(name) && !UNSAFE_NAME.test(name + " " + command));
  for (const [name] of gates) out.push({ name, why: "always-run gate" });
  const tokens = new Set(files.flatMap((file) => norm(file).split(" ")).filter((token) => token.length > 2));
  const targeted = Object.entries(scripts).filter(([name]) => /^(check|test|verify):/.test(name))
    .filter(([name]) => all || (!/(?:^|[-:])e2e(?:$|[-:])|e2e/i.test(name) && !/-e2e$/i.test(name)));
  let selected = 0;
  for (const [name, command] of targeted) {
    if (!all && UNSAFE_NAME.test(name + " " + command)) {
      skippedChecks.push({ name, why: "mutating/deploy script" });
      continue;
    }
    if (!all && /(?:e2e|demo[-_]account|email[-_]delivery|endpoint[-_]reach|health[-_]ready|storage[-_]region)/i.test(name)) {
      skippedChecks.push({ name, why: "live-service check safety filter" });
      continue;
    }
    if (!safeSource(repo, name, command, all)) {
      skippedChecks.push({ name, why: "safety filter (live service/database writes)" });
      continue;
    }
    const stem = name.replace(/^(check|test|verify):/, "");
    const scriptFile = command.match(/(?:node|tsx|ts-node|vitest|jest)\s+([^\s]+)/)?.[1] ?? `scripts/${stem}.ts`;
    let source = "";
    for (const file of [scriptFile, `scripts/${stem}.ts`, `scripts/${stem}.js`]) {
      const resolved = path.resolve(repo, file);
      if (resolved.startsWith(repo + path.sep) && fs.existsSync(resolved)) source += fs.readFileSync(resolved, "utf8");
    }
    const normalizedStem = norm(stem);
    const textual = files.some((file) => {
      const base = path.basename(file);
      return source.includes(file) || source.includes(base) || source.includes(path.basename(base, path.extname(base)));
    });
    const overlap = [...new Set(normalizedStem.split(" "))].some((token) => token.length > 3 && tokens.has(token));
    if (textual || overlap) {
      out.push({ name, why: textual ? "script references changed file" : "name shares token with changed path" });
      if (++selected >= 12) break;
    }
  }
  return out;
}

function packageDirs(repo, files) {
  const dirs = new Set();
  for (const file of files) {
    let dir = path.dirname(path.resolve(repo, file));
    while (dir === repo || dir.startsWith(repo + path.sep)) {
      if (fs.existsSync(path.join(dir, "package.json"))) dirs.add(dir);
      if (dir === repo) break;
      dir = path.dirname(dir);
    }
  }
  if (!dirs.size && fs.existsSync(path.join(repo, "package.json"))) dirs.add(repo);
  return [...dirs].sort();
}

// Read project instructions used to build a review profile, with a bounded traversal depth.
function readFiles(root, patterns) {
  const matchers = Array.isArray(patterns) ? patterns : [patterns];
  const out = [];
  const walk = (dir, depth = 0) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable directory */ }
    for (const entry of entries) {
      if (["node_modules", ".git", ".next"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isFile() && matchers.some((pattern) => pattern.test(file))) out.push(file);
      else if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
    }
  };
  walk(root);
  return out;
}

function runCommand(repo, name) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    const child = spawn("npm", ["run", name], { cwd: repo });
    const timer = setTimeout(() => child.kill("SIGTERM"), 300000);
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, duration: Date.now() - started, tail: output.trim().split("\n").slice(-40).join("\n") });
    });
  });
}

function worker(project, via, brief, taskId, label) {
  return new Promise((resolve) => {
    const args = [EKIP, "run", "--allow-nested", "--via", via, "--project", project, "--no-watch", "--label", label];
    if (taskId) args.push("--task", taskId);
    args.push("-");
    const child = spawn(process.execPath, args);
    let output = "";
    let error = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { error += data; });
    child.stdin.end(brief);
    const timer = setTimeout(() => child.kill("SIGTERM"), 60 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ via, ok: code === 0, out: (output || error).replace(/^\[ekip worker:[^\]]*\]\n/, "").trim() });
    });
  });
}

function projectList() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, "projects.json"), "utf8")); } catch { return []; }
}

function profileBrief(name, root, card, checks) {
  const files = readFiles(root, /^(CLAUDE\.md|AGENTS\.md|\.github\/pull_request_template\.md)$/i);
  files.push(...readFiles(root, /\.claude\/agents\/.*review.*|docs\/.*review.*/i));
  const context = files.slice(0, 35).map((file) => `\n--- ${path.relative(root, file)} ---\n${fs.readFileSync(file, "utf8").slice(0, 12000)}`).join("\n");
  return `Create a Markdown review profile for project ${name}. Read-only: do not edit or create files. Your entire final response MUST be Markdown starting exactly with "# ${name}"; do not include a preamble or report. Keep it under 150 lines, with 3-6 named reviewer lenses specific to the project. Each lens must be a checklist of concrete rules and list backing check scripts (or "none"). Use the provided project instructions and the Gotchas section of the card.\n\nProject: ${name}\nCard:\n${card}\n\nCheck scripts:\n${checks}\n\nProject instruction/review files:${context}\n`;
}

// Extract a profile even when the worker starts its response directly with the heading.
function extractProfile(output, project) {
  const heading = new RegExp(`(?:^|\\n)# ${project.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:\\r?\\n)`);
  const match = heading.exec(output);
  if (!match) return "";
  return output.slice(match.index + (match[0].startsWith("\n") ? 1 : 0)).trim()
    .replace(/\n?```\s*$/, "").trim();
}

async function ensureProfile(project, root, checks, refresh = false, via = null) {
  const file = path.join(HOME, "projects", `${project}.review.md`);
  if (fs.existsSync(file) && !refresh) return fs.readFileSync(file, "utf8");
  const cardFile = path.join(HOME, "projects", `${project}.md`);
  const card = fs.existsSync(cardFile) ? fs.readFileSync(cardFile, "utf8") : "(no project card)";
  let memories = "";
  try {
    const memory = await import("./memory.js");
    if (memory.search) memories = JSON.stringify(await memory.search(project, "top project review risks", 5));
  } catch { /* memory context is optional */ }
  const brief = profileBrief(project, root, card + "\n" + memories, checks);
  const pool = via ?? autoOrder().find((name) => AGENTS[name]) ?? "auto";
  const result = await worker(project, pool, brief, null, "review-profile");
  const body = extractProfile(result.out, project);
  if (!result.ok || !body) throw new Error(`profile worker failed to return '# ${project}' markdown: ${result.out.slice(-500)}`);
  const limited = body.split("\n").slice(0, 150).join("\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, limited + "\n");
  return limited;
}

// Deduplicate findings reported by both reviewers using their severity and location.
function deduplicate(reviews) {
  const rows = reviews.flatMap((review) => review.out.split("\n")
    .filter((line) => /\b(?:HIGH|MEDIUM|LOW|CRITICAL)\s*\|/i.test(line))
    .map((line) => ({ via: review.via, line: line.trim() })));
  const done = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.line.split("|").slice(0, 2).join("|").toLowerCase();
    if (done.has(key)) continue;
    done.add(key);
    const count = rows.filter((other) => other.line.split("|").slice(0, 2).join("|").toLowerCase() === key).length;
    out.push(`${row.line} ${count === 2 ? "(2/2 reviewers)" : ""}`);
  }
  return out.join("\n") || "No actionable findings.";
}

function printSelection(plan, skipped) {
  for (const check of plan) console.log(fit(`  ${t("seçildi: {check} · {why}", { check: check.name, why: check.why })}`));
  for (const check of skipped) console.log(fit(`  ${t("atlandı: {check} · {why}", { check: check.name, why: check.why })}`));
}

export async function main(args) {
  skippedChecks = [];
  const sub = args[0] === "profile" ? "profile" : "run";
  if (sub === "profile") args = args.slice(1);
  const options = { project: null, base: null, checksOnly: false, all: false, via: null, task: null, refresh: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") options.project = args[++i];
    else if (arg === "--base") options.base = args[++i];
    else if (arg === "--checks-only") options.checksOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--via") options.via = args[++i];
    else if (arg === "--task") options.task = args[++i];
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--all") options.all = true;
    else if (sub === "profile" && !options.project) options.project = arg;
    else throw new Error(`unknown review option ${arg}`);
  }

  const projects = projectList();
  const project = options.project ? projects.find((entry) => entry.name === options.project)
    : projects.filter((entry) => process.cwd() === entry.path || process.cwd().startsWith(entry.path + path.sep)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!project) throw new Error("registered project required (use --project NAME)");

  const repoStates = repos(project.path).map((repo) => {
    const base = diffBase(repo, options.base);
    return { repo, base, files: changed(repo, base) };
  }).filter((entry) => entry.files.length);
  const plan = [];
  for (const entry of repoStates) {
    console.log(`\n${path.relative(project.path, entry.repo) || "."}: ${entry.files.length} ${t("changed file(s)")}`);
    for (const file of entry.files) console.log(`  ${file}`);
    for (const dir of packageDirs(entry.repo, entry.files)) {
      const rel = path.relative(entry.repo, dir);
      const scoped = entry.files.filter((file) => !rel || file === rel || file.startsWith(rel + path.sep)).map((file) => rel ? path.relative(rel, file) : file);
      const checks = scriptsFor(dir, scoped, options.all);
      plan.push(...checks.map((check) => ({ ...check, repo: dir, label: rel ? `${rel} / ` : "" })));
    }
  }
  if (!repoStates.length) console.log(t("No changed files found."));
  printSelection(plan.map((check) => ({ ...check, name: `${check.label}${check.name}` })), skippedChecks);

  // Profile mode only discovers check names; dry-run prints the plan and exits before spawning checks.
  if (sub === "profile") {
    const checkList = plan.map((check) => check.name).join(", ") || "none discovered";
    const profile = await ensureProfile(project.name, project.path, checkList, options.refresh, options.via);
    const file = path.join(HOME, "projects", `${project.name}.review.md`);
    console.log(`\n${file}\n${profile.split("\n").slice(0, 40).join("\n")}`);
    return 0;
  }
  if (options.dryRun) return 0;

  const results = [];
  for (let i = 0; i < plan.length; i += 4) results.push(...await Promise.all(plan.slice(i, i + 4).map((check) => runCommand(check.repo, check.name))));
  console.log(`\n${t("results")}`);
  console.log(`${t("check")}  ${t("result")}  ${t("time")}`);
  for (const result of results) console.log(fit(`${dot(result.ok ? "ok" : "bad")} ${result.name}  ${result.ok ? c.green(t("ok")) : c.red(t("failed"))}  ${(result.duration / 1000).toFixed(1)}s`));
  for (const result of results.filter((entry) => !entry.ok)) console.log(`\n--- ${result.name} ${t("failure (last 40 lines)")} ---\n${result.tail || result.error}`);
  if (options.checksOnly) return results.some((result) => !result.ok) ? 1 : 0;

  const profile = await ensureProfile(project.name, project.path, plan.map((check) => check.name).join(", ") || "none", false);
  const diffs = repoStates.map((entry) => `\n## ${path.relative(project.path, entry.repo)}\n${git(entry.repo, "diff", entry.base, "--", ...entry.files).stdout}`).join("\n").slice(0, 60000);
  const checkText = results.map((result) => `${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.tail}`).join("\n");
  const brief = `Read-only code review for ${project.name}. Do NOT edit files. Report only actionable findings as SEVERITY | file:line | lens | problem | why it is real. Ignore style nits. Failed checks are facts to explain.\n\nProfile:\n${profile}\n\nChanged files (complete):\n${repoStates.flatMap((entry) => entry.files.map((file) => `${path.relative(project.path, entry.repo)}/${file}`)).join("\n")}\n\nChecks:\n${checkText}\n\nDiff (truncated at 60k chars):\n${diffs}`;
  let vias = options.via ? options.via.split(",").map((name) => name.trim()) : autoOrder().filter((name) => AGENTS[name]).slice(0, 2);
  if (vias.length < 2) vias = autoOrder().filter((name) => AGENTS[name]).slice(0, 2);
  const reviews = await Promise.all(vias.slice(0, 2).map((via, i) => worker(project.name, via, brief, options.task, `review-${i + 1}`)));
  const report = `# Review: ${project.name}\n\n## Checks\n\n| Check | Result | Duration |\n|---|---|---:|\n${results.map((result) => `| ${result.name} | ${result.ok ? "PASS" : "FAIL"} | ${(result.duration / 1000).toFixed(1)}s |`).join("\n")}\n\n## Reviewers\n${reviews.map((review) => `\n### ${review.via}\n\n${review.out}`).join("\n")}\n\n## Deduplicated findings\n\n${deduplicate(reviews)}\n`;
  console.log(report);
  const dir = path.join(HOME, "reviews");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${project.name}-${stamp}.md`);
  fs.writeFileSync(file, report);
  console.log(fit(t("saved report: {file}", { file })));
  return results.some((result) => !result.ok) || /\bHIGH\s*\|/i.test(report) ? 1 : 0;
}
