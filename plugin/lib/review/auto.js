// Automatic review: every worker result goes through an independent review before it reaches the lead
// and the user, so work can be left running while nobody watches.
//
//   worker finishes → a reviewer from another model family (agents.reviewerPool) gets the brief, the
//   worker's report, the diff, the acceptance criteria (review/criteria.js) and the lessons; it runs
//   the checks itself and answers PASS or FAIL with findings → FAIL: the writer gets the findings and
//   fixes them (at most `reviewRounds`, default 2), then the reviewer looks again → still FAIL: the
//   task waits for the lead/user with a summary (ekip task ask); PASS: the result reaches the lead
//   with "review: passed (criteria 12/12)".
//
// Reviewer and fix rounds are ordinary `ekip run` processes, so the watchdog, machine slots, pool
// fallback and run logs apply to them like to any worker. On in mesai mode and with
// `ekip run --review`; `--no-review` turns it off for one run, "autoReview": true|false in
// data/config.json for every run.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HOME, SETTINGS, notify } from "../core/core.js";
import { t } from "../core/i18n.js";
import { family, reviewerPool } from "../workers/agents.js";

const EKIP = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../bin/ekip.js");
const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
export const maxRounds = () => Math.max(0, Number(SETTINGS.reviewRounds ?? 2));

/** Whether this run's result is reviewed: --review, mesai mode, or "autoReview" in the settings. */
export function wanted(o, settings = SETTINGS) {
  if (o.review === false || process.env.EKIP_REVIEW_ROLE) return false;
  // ekip's own housekeeping runs (cards, review profiles, the skill learner) are not deliveries
  if (/^(proje kartı: |review-|skill-learn)/.test(o.label ?? "")) return false;
  if (o.review === true || settings.autoReview === true) return true;
  return !!settings.mesai && settings.autoReview !== false;
}

/** Where the work stands before the worker starts: the commit and the files already changed. */
export function snapshot(cwd) {
  const head = git(cwd, "rev-parse", "HEAD");
  if (head.status !== 0) return { git: false };
  const dirty = git(cwd, "status", "--porcelain", "-uall").stdout.split("\n").filter(Boolean).map((l) => l.slice(3));
  return { git: true, base: head.stdout.trim(), dirty };
}

/** The worker's changes since the snapshot: tracked diff plus the start of new files, cut to max characters. */
export function diffText(cwd, snap, max = 50_000) {
  if (!snap?.git) return "(not a git repository: open the files the report names)";
  let out = git(cwd, "diff", snap.base, "--", ".").stdout;
  const fresh = git(cwd, "ls-files", "--others", "--exclude-standard").stdout.split("\n").filter(Boolean);
  for (const f of fresh.slice(0, 20)) {
    let body = "";
    try { const st = fs.statSync(path.join(cwd, f)); body = st.size > 40_000 ? `(${st.size} bytes, not shown)` : fs.readFileSync(path.join(cwd, f), "utf8").split("\n").slice(0, 150).join("\n"); } catch { /* gone */ }
    out += `\n+++ new file ${f}\n${body}\n`;
  }
  if (fresh.length > 20) out += `\n(${fresh.length - 20} more new files: git status)\n`;
  return out.length > max ? `${out.slice(0, max)}\n… (diff cut at ${max} characters: run git diff ${snap.base} yourself)` : out || "(no changes in the working tree)";
}

const OUTPUT = `## Your answer
End your answer with exactly this block and nothing after it (one FINDING line per problem; none when there are none):
REVIEW-RESULT
VERDICT: PASS or FAIL
CRITERIA: <criteria met>/<criteria total>
FINDING: <HIGH|MEDIUM|LOW> | <file:line or -> | <criterion id, e.g. C3> | <the problem and the evidence you saw>
NEW-CRITERION: <short-kebab-class> | <one line: what a delivery must be checked for so this kind of failure is caught next time>
END-REVIEW
Rules: FAIL when any criterion is not met or there is any HIGH or MEDIUM finding; LOW findings alone still PASS.
Write NEW-CRITERION lines only when you FAIL the work for a kind of problem no listed criterion covers.`;

/** The reviewer's brief: read-only, independent, criteria by number, evidence required, fixed answer format. */
export function reviewerBrief({ brief, report, diff, criteria, rules = "", author, snap, round = 0, previous = [] }) {
  return [
    `You are the REVIEWER of another agent's delivery (written on the ${author} pool). Review it independently before it reaches the lead and the user.`,
    "Read-only: do not edit, create or delete project files and do not commit. You may run tests, checks and builds; scratch files only under /tmp.",
    "Do not trust the report: run the project's checks yourself, read the diff and the touched files, open every image, screenshot or page the work produced. Every claim needs evidence you saw (command output, a path you opened).",
    snap?.git ? `Everything the worker changed: git diff ${snap.base} and git status (base commit ${snap.base}).` : "",
    snap?.dirty?.length ? `Files that were already changed before the worker started (not its work): ${snap.dirty.slice(0, 30).join(", ")}` : "",
    round ? `This is review round ${round + 1}: the writer had the findings below and says it fixed them. Check each one again, then the whole delivery.\n${previous.map((f) => `- ${fmtFinding(f)}`).join("\n")}` : "",
    `\n## The brief the writer got\n${String(brief).trim().slice(0, 12_000)}`,
    `\n## The writer's report\n${String(report).trim().slice(0, 8000) || "(empty report)"}`,
    `\n## Acceptance criteria (check every one; the total is ${criteria.length})\n${criteria.map((c) => `${c.id} ${c.text}`).join("\n")}`,
    rules ? `\n## Project rules\n${rules}` : "",
    `\n## Diff\n${diff}`,
    `\n${OUTPUT}`,
  ].filter(Boolean).join("\n");
}

const fmtFinding = (f) => [f.severity, f.where || "-", f.criterion || "-", f.problem].join(" | ");

/**
 * The reviewer's answer: { verdict: "pass"|"fail", met, total, findings: [{ severity, where,
 * criterion, problem }], proposals: [{ class, text }] }, or null without a VERDICT line.
 */
export function parseVerdict(out) {
  const text = String(out ?? "").replace(/\r/g, "");
  const at = text.lastIndexOf("REVIEW-RESULT");
  const block = (at >= 0 ? text.slice(at) : text).split("END-REVIEW")[0];
  const clean = (l) => l.replace(/[*`_]/g, "").trim();
  const lines = block.split("\n").map(clean);
  const v = lines.map((l) => l.match(/^VERDICT\s*:\s*(PASS|FAIL|GEÇTİ|GECTI|DÜŞTÜ|DUSTU)\b/i)?.[1]).find(Boolean);
  if (!v) return null;
  const crit = lines.map((l) => l.match(/^CRITERIA\s*:\s*(\d+)\s*\/\s*(\d+)/i)).find(Boolean);
  const findings = lines.map((l) => l.match(/^FINDING\s*:\s*(.+)$/i)?.[1]).filter(Boolean).map((l) => {
    const [severity, where, criterion, ...rest] = l.split("|").map((x) => x.trim());
    return { severity: (severity ?? "").toUpperCase(), where: where === "-" ? "" : where ?? "", criterion: criterion === "-" ? "" : criterion ?? "", problem: rest.join(" | ") || "" };
  }).filter((f) => /^(HIGH|MEDIUM|LOW|CRITICAL)$/.test(f.severity));
  const proposals = lines.map((l) => l.match(/^NEW-CRITERION\s*:\s*(.+)$/i)?.[1]).filter(Boolean).map((l) => {
    const i = l.indexOf("|");
    return i < 0 ? { class: "", text: l.trim() } : { class: l.slice(0, i).trim(), text: l.slice(i + 1).trim() };
  }).filter((x) => x.text);
  let verdict = /^(PASS|GEÇTİ|GECTI)$/i.test(v) ? "pass" : "fail";
  // a HIGH finding fails the work whatever the verdict line says
  if (findings.some((f) => f.severity === "HIGH" || f.severity === "CRITICAL")) verdict = "fail";
  return { verdict, met: crit ? Number(crit[1]) : null, total: crit ? Number(crit[2]) : null, findings, proposals };
}

/** The brief of a fix round: the findings first, then the original task. */
export function fixBrief({ brief, findings, criteria, reviewer, snap, round, max }) {
  return [
    `REVIEW FIX ROUND ${round}/${max}: an independent reviewer (${reviewer}) checked your earlier delivery of the task below and FAILED it.`,
    `Your earlier changes are in the working tree${snap?.git ? ` (git diff ${snap.base})` : ""}. Do not start over and do not undo the parts that are right: fix every finding below, run the checks again, and report again with evidence (command output, screenshot paths).`,
    `\nFindings:\n${findings.map((f) => `- ${fmtFinding(f)}`).join("\n") || "- (the reviewer gave no line; see the criteria)"}`,
    `\nAcceptance criteria the delivery is checked against:\n${criteria.map((c) => `${c.id} ${c.text}`).join("\n")}`,
    `\nThe original task:\n${brief}`,
  ].join("\n");
}

// One `ekip run` child (reviewer or fix round), brief on stdin; resolves with its pool and report.
function child(args, brief, role) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [EKIP, "run", "--allow-nested", "--no-review", "--no-watch", ...args, "-"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, EKIP_REVIEW_ROLE: role } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stdin.end(brief);
    p.on("error", (e) => resolve({ ok: false, via: null, out: String(e.message) }));
    p.on("close", (code) => {
      const head = out.match(/^\[ekip worker: ([^\]]+)\]\n/);
      resolve({ ok: code === 0, via: head && head[1] !== "all pools failed" ? head[1] : null, out: head ? out.slice(head[0].length).trim() : out.trim() });
    });
  });
}

function saveReport(runId, round, reviewer, out) {
  try {
    const dir = path.join(HOME, "reviews");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${runId}-r${round + 1}-${reviewer}.md`);
    fs.writeFileSync(file, `# Review round ${round + 1} (${reviewer})\n\n${out}\n`);
    return file;
  } catch { return null; }
}

/**
 * Reviews a finished worker run and drives the fix rounds. o: the run options (project, cwd, task id,
 * label, minTier, brief0 = the brief as given), first: { via, out } of the writer's run, snap: from
 * snapshot(). Returns { verdict: "pass"|"fail"|"error", report, summary, rounds, reviewer, met,
 * total, findings, links }.
 */
export async function reviewLoop({ o, first, snap, runId, say = () => {} }) {
  const tasks = o.taskId ? await import("../tasks/tasks.js") : null;
  const proj = o.project ? (await import("../projects/projects.js")).getProject(o.project) : null;
  const crit = await import("./criteria.js");
  const cfg = await import("../projects/project-config.js");
  const criteria = crit.all(proj ?? { name: null });
  const rules = proj ? cfg.rules(proj) : "";
  const max = maxRounds();
  const brief = o.brief0 ?? o.task;
  const label = o.label ?? brief.split("\n")[0].slice(0, 50);
  const minTier = o.minTier === "strong" ? ["--min-tier", "strong"] : [];
  // --cwd only: the run finds its project from the folder, and a worktree run stays in its worktree
  const where = ["--cwd", o.cwd, ...(o.taskId ? ["--task", o.taskId] : [])];
  let author = first.via, report = first.out, previous = [], last = null, reviewer = null;
  const links = [];
  const set = (patch, note) => tasks?.setReview(o.taskId, { pid: process.pid, max, author, ...patch }, note);

  for (let round = 0; round <= max; round++) {
    // a reviewer from another family than the writer of this round; a second one when the first gives no verdict
    const tried = [];
    let v = null, rr = null;
    for (let attempt = 0; attempt < 2 && !v; attempt++) {
      reviewer = reviewerPool(author, { minTier: o.minTier, exclude: tried });
      if (!reviewer) break;
      tried.push(reviewer);
      set({ state: "reviewing", reviewer, round }, t("{author} bitirdi; inceleme başladı (reviewer: {reviewer}, ailesi {family})", { author, reviewer, family: family(reviewer) }));
      say(t("inceleniyor (reviewer: {pool})", { pool: reviewer }));
      const diff = diffText(o.cwd, snap);
      rr = await child(["--via", reviewer, ...minTier, "--label", `review-${round + 1}: ${label}`, ...where], reviewerBrief({ brief, report, diff, criteria, rules, author, snap, round, previous }), "reviewer");
      if (rr.via) reviewer = rr.via;
      v = rr.ok ? parseVerdict(rr.out) : null;
      const file = saveReport(runId, round, reviewer, rr.out);
      if (file) links.push(file);
      if (!v) tasks?.note(o.taskId, t("{pool} sonuç vermedi (inceleme biçimi yok ya da hata); başka bir reviewer deneniyor", { pool: reviewer }));
    }
    if (!v) {
      const why = reviewer ? t("reviewer sonuç vermedi") : t("yazandan farklı ailede kullanılabilir havuz yok");
      // held first: a closed review with nothing else open would let the task close itself as done
      tasks?.hold(o.taskId, "blocked", t("otomatik inceleme yapılamadı ({why}); sonucu lead incelemeli", { why }), null, { alert: true });
      set({ state: "error", reviewer, round, why }, t("otomatik inceleme yapılamadı: {why}", { why }));
      return { verdict: "error", report, summary: t("review: yapılamadı ({why})", { why }), rounds: round, reviewer, links };
    }
    last = v;
    const total = v.total ?? criteria.length;
    const met = v.met ?? (v.verdict === "pass" ? total : null);
    if (v.verdict === "pass") {
      const summary = t("review: geçti (kriter {met}/{total})", { met: met ?? "?", total });
      set({ state: "passed", reviewer, round, met, total, findings: v.findings.length, items: v.findings.slice(0, 5).map(fmtFinding) }, `${summary} · reviewer: ${reviewer}${round ? ` · ${t("{n} düzeltme turundan sonra", { n: round })}` : ""}`);
      return { verdict: "pass", report, summary, rounds: round, reviewer, met, total, findings: v.findings, links };
    }
    // a kind of failure the criteria did not cover: a candidate, a criterion the second time it is seen
    const grown = proj ? crit.propose(proj, v.proposals, { runId: `${runId}-r${round}` }) : [];
    for (const g of grown) tasks?.note(o.taskId, t("yeni kabul kriteri (aynı hata ikinci kez): {text}", { text: g }));
    const top = v.findings.slice(0, 3).map(fmtFinding).join(" ; ");
    if (round === max) {
      const summary = t("review: düştü ({n} bulgu)", { n: v.findings.length });
      const q = t("İnceleme {n} düzeltme turundan sonra hâlâ düşüyor ({k} bulgu): {top}. Ne yapılsın?", { n: max, k: v.findings.length, top: top.slice(0, 300) });
      tasks?.ask(o.taskId, q, [t("Lead düzeltsin"), t("Güçlü havuzla yeniden dağıt"), t("Olduğu gibi kabul et")]);
      set({ state: "failed", reviewer, round, met, total, findings: v.findings.length, items: v.findings.slice(0, 5).map(fmtFinding) }, `${summary}: ${top}`);
      if (!tasks) notify("ekip", q, { subtitle: label });
      return { verdict: "fail", report, summary, rounds: round, reviewer, met, total, findings: v.findings, links };
    }
    // FAIL: the writer fixes it (same pool; the run moves on by itself when that pool is out of quota)
    set({ state: "fixing", reviewer, round: round + 1, met, total, findings: v.findings.length, items: v.findings.slice(0, 5).map(fmtFinding) }, `${t("review: düştü ({n} bulgu)", { n: v.findings.length })}: ${top} → ${t("düzeltme turu {n}/{max}", { n: round + 1, max })} (${author})`);
    say(t("düzeltme turu {n}/{max}", { n: round + 1, max }));
    const fr = await child(["--via", author, "--label", `${label} · fix ${round + 1}/${max}`, ...where], fixBrief({ brief, findings: v.findings, criteria, reviewer, snap, round: round + 1, max }), "fix");
    if (!fr.ok) {
      const summary = t("review: düştü ({n} bulgu)", { n: v.findings.length });
      tasks?.ask(o.taskId, t("Düzeltme turu {n} başarısız oldu ({k} bulgu açık): {top}. Ne yapılsın?", { n: round + 1, k: v.findings.length, top: top.slice(0, 300) }), [t("Lead düzeltsin"), t("Güçlü havuzla yeniden dağıt"), t("Olduğu gibi kabul et")]);
      set({ state: "failed", reviewer, round: round + 1, findings: v.findings.length }, t("düzeltme turu {n} başarısız: {why}", { n: round + 1, why: fr.out.split("\n").slice(-2).join(" ").slice(0, 200) }));
      return { verdict: "fail", report, summary, rounds: round + 1, reviewer, findings: v.findings, links };
    }
    if (fr.via) author = fr.via;
    report = fr.out;
    previous = v.findings;
  }
  return { verdict: "fail", report, summary: t("review: düştü ({n} bulgu)", { n: last?.findings.length ?? 0 }), rounds: max, reviewer, links };
}
