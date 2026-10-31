// `ekip status` (ekip durum): one screen in plain words, so the user never has to ask what is going
// on. Five parts: what really runs now (worker or tracked job, with percent, speed, finish and its
// last output line), what waits for the user (questions from `ekip task ask` with their options),
// what is stuck and what ekip did about it, what finished in the last 24 hours with its result and
// links, and where ekip itself stands (version, main under test, hub up to date). The task pane shows
// the short form of it on top.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME, ROOT, RUNS, SETTINGS } from "../core/core.js";
import { c, fit } from "../core/ui.js";
import { t, lang } from "../core/i18n.js";
import { clip as paneClip } from "./pane.js";
import { list, reapDead, paused, percent, eta, stalledFor, pidAlive, fmtDur } from "./tasks.js";

const DAY = 24 * 3600_000;
const OPEN_WORKER = ["running", "queued", "waiting"];
const clip = (s, n) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const clock = (iso) => new Date(iso).toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const ago = (iso) => t("{duration} önce", { duration: fmtDur(Date.now() - Date.parse(iso)) });
const pctText = (n) => (lang === "en" ? `${n}%` : `%${n}`);

function tail(file) {
  try {
    const st = fs.statSync(file), len = Math.min(st.size, 4096), fd = fs.openSync(file, "r"), b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd);
    return b.toString("utf8");
  } catch { return ""; }
}
// The last line a worker wrote: the end of its log, without ekip's own exit record.
const lastLine = (file) => tail(file).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/[\r\n]/).map((l) => l.trim()).filter((l) => l && !l.startsWith("[exit")).at(-1) ?? "";

// Worker runs alive with no running task of their own (an `ekip run` without --task).
function looseRuns(taskIds) {
  let files = [];
  try { files = fs.readdirSync(RUNS).filter((f) => f.endsWith(".log") && !f.endsWith("-track.log")).map((f) => ({ f, at: fs.statSync(path.join(RUNS, f)).mtimeMs })).filter((x) => Date.now() - x.at < DAY); } catch { return []; }
  return files.flatMap(({ f }) => {
    const file = path.join(RUNS, f);
    let head = "";
    try { const fd = fs.openSync(file, "r"), b = Buffer.alloc(2048); const n = fs.readSync(fd, b, 0, 2048, 0); fs.closeSync(fd); head = b.toString("utf8", 0, n); } catch { return []; }
    const pid = Number(head.match(/^pid: (\d+)$/m)?.[1]);
    const taskId = head.match(/^taskId: (.*)$/m)?.[1];
    if (!pid || !pidAlive(pid) || (taskId && taskIds.has(taskId)) || /\[exit -?\d+\]/.test(tail(file))) return [];
    const label = head.match(/^label: (.*)$/m)?.[1];
    const via = f.slice(0, -4).split("Z-")[1] ?? "?";
    const started = Date.parse(f.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3") + "Z");
    return [{ via, label: label && label !== "-" ? label : clip(head.split("\ntask:\n")[1]?.split("\n")[0], 60), since: Number.isNaN(started) ? null : new Date(started).toISOString(), lastLine: clip(lastLine(file), 160), log: file }];
  });
}

// What ekip did with a task that got stuck: pool switches, restarts, workers that died or were stopped.
const ACTION = /havuzuna geçildi|moved to|yeniden başlat|restart|öldü|died|durduruldu|stopped|sessiz|silent|kotası|quota|zayıf havuz|weak pools|yeniden başladı|resumed|sahipsiz|orphaned/i;

/** The four task parts of the digest, read from the task file, tracked jobs and run logs. */
export async function collect() {
  try { reapDead(); } catch { /* the digest never fails on this */ }
  const tasks = list();
  const open = tasks.filter((x) => x.status === "running");
  let tracks = [];
  try { tracks = (await import("../workers/track.js")).jobs(); } catch { /* none */ }
  const liveTrack = (id) => tracks.find((j) => j.id === id && !j.endedAt && pidAlive(j.pid));

  const running = [], waiting = [], stuck = [], done = [];
  for (const x of open) {
    const steps = x.steps ?? [];
    const stalled = steps.filter((s) => stalledFor(s, x));
    if (x.hold?.kind === "waiting-user") {
      waiting.push({ id: x.id, title: x.title, project: x.project, question: x.ask?.question ?? x.hold.reason, options: x.ask?.options ?? [], since: x.ask?.at ?? x.hold.at });
      continue;
    }
    const why = x.hold?.kind === "blocked" ? x.hold.reason
      : paused(x) ? t("çalışan süreç yok; \"{steps}\" sürüyor görünüyor", { steps: steps.filter((s) => s.status === "running").map((s) => s.title).join(", ") })
        : stalled.length ? t("\"{step}\" {duration} boyunca ilerlemedi", { step: stalled[0].title, duration: fmtDur(stalledFor(stalled[0], x)) }) : null;
    if (why) {
      stuck.push({ id: x.id, title: x.title, project: x.project, why, since: x.hold?.at ?? x.pausedAt ?? stalled[0]?.progressAt ?? x.updatedAt, actions: (x.notes ?? []).filter((n) => ACTION.test(n.text)).slice(-2).map((n) => n.text) });
      continue;
    }
    // what runs it: live workers (and tracked jobs, which link as via "track") with their last line
    const workers = (x.workers ?? []).filter((w) => OPEN_WORKER.includes(w.status) && (!w.pid || pidAlive(w.pid))).map((w) => {
      const job = w.via === "track" ? liveTrack(w.runId) : null;
      return { via: w.via ?? "?", label: w.label, status: w.status, queue: w.queue ?? null, why: w.why ?? null, since: w.startedAt, lastLine: clip(job?.lastLine || (w.log ? lastLine(w.log) : ""), 160), pct: job?.pct ?? null, rate: job?.rate ?? null, etaAt: job?.etaAt ?? null };
    });
    const cur = steps.filter((s) => s.status === "running").map((s) => ({ n: steps.indexOf(s) + 1, title: s.title, pct: s.pct ?? null, detail: s.detail ?? null, rate: s.rate ?? null, etaAt: s.etaAt ?? null }));
    running.push({ id: x.id, title: x.title, project: x.project, pct: percent(x), eta: eta(x), steps: cur, total: steps.length, workers });
  }
  // a tracked job or a worker without a running task is real work too
  const taskIds = new Set(open.map((x) => x.id));
  for (const j of tracks.filter((y) => !y.endedAt && pidAlive(y.pid) && !taskIds.has(y.taskId)))
    running.push({ id: j.id, title: j.label, project: null, pct: j.pct ?? null, eta: j.etaAt ?? null, steps: [], total: 0, workers: [{ via: "track", label: j.label, status: "running", since: j.startedAt ?? j.createdAt, lastLine: clip(j.lastLine || j.detail, 160), pct: j.pct ?? null, rate: j.rate ?? null, etaAt: j.etaAt ?? null }] });
  for (const r of looseRuns(taskIds)) running.push({ id: r.log, title: r.label || r.via, project: null, pct: null, eta: null, steps: [], total: 0, workers: [{ ...r, status: "running" }] });

  for (const x of tasks.filter((y) => y.status !== "running" && Date.now() - Date.parse(y.endedAt ?? y.updatedAt) < DAY)) {
    const last = x.notes?.at(-1)?.text;
    if (x.status === "failed") stuck.push({ id: x.id, title: x.title, project: x.project, why: last ?? t("başarısız bitti"), since: x.endedAt ?? x.updatedAt, failed: true, actions: (x.notes ?? []).filter((n) => ACTION.test(n.text) && n.text !== last).slice(-2).map((n) => n.text) });
    else if (x.status === "done") done.push({ id: x.id, title: x.title, project: x.project, at: x.endedAt ?? x.updatedAt, result: x.result?.text || last || null, links: x.result?.links ?? [], auto: !!x.result?.auto });
  }
  done.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // tracked jobs that finished without a task: their end is a result too
  for (const j of tracks.filter((y) => y.endedAt && !y.taskId && Date.now() - Date.parse(y.endedAt) < DAY)) {
    if (j.status === "done") done.push({ id: j.id, title: j.label, project: null, at: j.endedAt, result: j.lastLine || t("bitti, çıkış 0"), links: [j.log], auto: true });
    else stuck.push({ id: j.id, title: j.label, project: null, why: `${t("çıkış {code}", { code: j.exitCode })}${j.reason ? ` · ${j.reason}` : ""}`, since: j.endedAt, failed: true, actions: [] });
  }
  return { at: new Date().toISOString(), running, waiting, stuck, done };
}

// ---- ekip's own release state ------------------------------------------------------------------

const CACHE = path.join(HOME, "release-status.json");
const git = (...args) => spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 6000 });

/**
 * ekip's version, main's last commit and whether it is under test (the hub's CI, scripts/ci), and
 * whether the hub runs that commit. The hub answers from GET /api/release; without a hub, main's
 * head comes from git. Kept in data/release-status.json so the pane can show it without a network call.
 */
export async function release() {
  const u = await import("../ops/update.js");
  const out = { at: new Date().toISOString(), version: u.localVersion(), latest: null, behind: false, main: null, ci: null, testing: null, hub: null };
  try { const r = u.checkUpdate({ maxAgeH: 12 }); Object.assign(out, { latest: r.latest ?? null, behind: !!r.behind }); } catch { /* offline */ }
  if (SETTINGS.hubUrl && SETTINGS.hubToken) {
    try {
      const r = await fetch(`${SETTINGS.hubUrl}/api/release`, { headers: { authorization: `Bearer ${SETTINGS.hubToken}` }, signal: AbortSignal.timeout(5000) });
      if (r.ok) { const b = await r.json(); Object.assign(out, { main: b.main ?? null, ci: b.ci ?? null, testing: b.testing ?? null, hub: b.hub ?? null }); }
      else out.hubError = `HTTP ${r.status}`;
    } catch (e) { out.hubError = e?.name === "TimeoutError" ? t("zaman aşımı") : t("erişilemiyor"); }
  }
  if (!out.main?.sha) {
    const r = git("ls-remote", "origin", "refs/heads/main");
    const sha = r.status === 0 ? r.stdout.slice(0, 40).trim() : "";
    if (sha) out.main = { sha, at: null };
  }
  try { fs.writeFileSync(CACHE, JSON.stringify(out)); } catch { /* read-only data dir */ }
  return out;
}

/** The last release state `ekip status` saw, when it is recent enough to show. */
export function cachedRelease(maxAgeMs = 30 * 60_000) {
  try { const r = JSON.parse(fs.readFileSync(CACHE, "utf8")); return Date.now() - Date.parse(r.at) < maxAgeMs ? r : null; } catch { return null; }
}

/** "ekip v1.6.2 · main abc1234 test ediliyor (20 dk) · hub güncel" */
export function releaseLine(r) {
  if (!r) return "";
  const parts = [`ekip v${r.version}${r.behind && r.latest ? c.yellow(` (${t("yeni sürüm v{v}: ekip update", { v: r.latest })})`) : ""}`];
  const sha = r.main?.sha?.slice(0, 7);
  if (sha) {
    const ci = r.ci, mins = r.main.at ? fmtDur(Date.now() - Date.parse(r.main.at)) : null;
    const tested = ci?.sha && r.main.sha.startsWith(ci.sha);
    parts.push(r.testing ? c.yellow(`main ${sha} ${t("test ediliyor")}${mins ? ` (${mins})` : ""}`)
      : tested && ci.status === "pass" ? c.green(`main ${sha} ${t("testi geçti")}${ci.finishedAt ? c.gray(` · ${ago(ci.finishedAt)}`) : ""}`)
        : tested && ci.status === "fail" ? c.red(`main ${sha} ${t("testi başarısız ({step})", { step: ci.step ?? "?" })}`)
          : `main ${sha}${r.ci === null && !r.hub ? "" : c.gray(` · ${t("test sonucu yok")}`)}`);
  }
  if (r.hub) {
    const hc = r.hub.commit?.slice(0, 7);
    parts.push(!hc ? c.gray(t("hub sürümü bilinmiyor")) : r.main?.sha?.startsWith(hc) ? c.green(t("hub güncel")) : c.yellow(t("hub eski ({sha})", { sha: r.hub.version ?? hc })));
  } else if (r.hubError) parts.push(c.red(`hub ${r.hubError}`));
  else if (!SETTINGS.hubUrl) parts.push(c.gray(t("hub bağlı değil")));
  return parts.join(c.gray(" · "));
}

// ---- rendering ---------------------------------------------------------------------------------

// Plain text over at most `max` lines of the terminal at word boundaries, the last one shortened
// with "…" (the pane's word-safe clip).
export function wrapText(text, width, max = 3) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if ([...next].length <= width || !cur) { cur = next; continue; }
    lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  if (lines.length <= max) return lines.map((l) => ([...l].length > width ? paneClip(l, width) : l));
  return [...lines.slice(0, max - 1), paneClip(lines.slice(max - 1).join(" "), width)];
}
const wrapped = (text, indent, paint = (x) => x) => wrapText(text, Math.max(20, (process.stdout.columns || Number(process.env.COLUMNS) || 100) - indent.length - 1)).map((l) => `${indent}${paint(l)}`);

const head = (label, n, color = (s) => s) => `\n${color(c.bold(`${label} (${n})`))}`;
const finishText = (iso) => `${t("bitiş ~{time}", { time: clock(iso) })} (${t("{duration} kaldı", { duration: fmtDur(Date.parse(iso) - Date.now()) })})`;

function runningLines(x) {
  const w0 = x.workers.find((w) => w.pct != null || w.rate || w.etaAt);
  const s0 = x.steps.find((s) => s.pct != null || s.rate || s.etaAt) ?? x.steps[0];
  const pct = s0?.pct ?? w0?.pct ?? x.pct;
  const rate = s0?.rate ?? w0?.rate;
  const fin = s0?.etaAt ?? w0?.etaAt ?? x.eta;
  const top = fit(`  ${c.yellow("▶")} ${c.bold(x.title)}${x.project ? c.gray(` · ${x.project}`) : ""}${pct != null ? `  ${c.bold(pctText(pct))}` : ""}${rate ? c.gray(` · ${rate}`) : ""}${fin && Date.parse(fin) > Date.now() ? c.gray(` · ${finishText(fin)}`) : ""}`);
  const lines = [top];
  for (const s of x.steps) lines.push(fit(`     ${c.gray(t("adım {n}/{total}", { n: s.n, total: x.total }))} ${s.title}${s.pct != null && s !== s0 ? c.gray(` · ${pctText(s.pct)}`) : ""}`));
  for (const w of x.workers) {
    const state = w.status === "queued" ? c.magenta(t("kuyrukta (sıra {n})", { n: w.queue ?? "?" })) : w.status === "waiting" ? c.magenta(t("koşul bekleniyor")) : c.gray(w.since ? fmtDur(Date.now() - Date.parse(w.since)) : "");
    lines.push(fit(`     ${c.cyan("⚙")} ${w.via}${w.label && w.label !== x.title ? ` · ${w.label}` : ""} ${state}${w.why ? c.gray(` · ${w.why}`) : ""}`));
    if (w.lastLine) lines.push(fit(`       ${c.gray(`${t("son çıktı")}: ${w.lastLine}`)}`));
  }
  if (!x.workers.length && x.steps.some((s) => s.detail)) lines.push(fit(`       ${c.gray(x.steps.find((s) => s.detail).detail)}`));
  return lines;
}

/** The whole digest, as `ekip status` prints it. */
export function render(d, rel) {
  const out = [`${c.bold("ekip")} ${c.gray(`· ${t("durum")} · ${new Date(d.at).toLocaleString(lang === "tr" ? "tr-TR" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`)}`];

  out.push(head(t("Şimdi çalışan"), d.running.length, d.running.length ? c.cyan : c.gray));
  if (!d.running.length) out.push(c.gray(`  ${t("şu an çalışan iş yok")}`));
  for (const x of d.running) out.push(...runningLines(x));

  out.push(head(t("Senden beklenen"), d.waiting.length, d.waiting.length ? c.red : c.gray));
  if (!d.waiting.length) out.push(c.gray(`  ${t("şu an senden beklenen bir karar yok")}`));
  for (const w of d.waiting) {
    out.push(fit(`  ${c.red("?")} ${c.bold(w.question)}`));
    out.push(fit(`     ${c.gray(`${w.title}${w.project ? ` · ${w.project}` : ""} · ${w.id}${w.since ? ` · ${ago(w.since)}` : ""}`)}`));
    if (w.options.length) out.push(fit(`     ${t("seçenekler")}: ${w.options.map((o, i) => `${c.cyan(`${String.fromCharCode(65 + i)})`)} ${o}`).join(c.gray("  ·  "))}`));
  }

  out.push(head(t("Takılan"), d.stuck.length, d.stuck.length ? c.yellow : c.gray));
  if (!d.stuck.length) out.push(c.gray(`  ${t("takılan iş yok")}`));
  for (const s of d.stuck) {
    out.push(fit(`  ${s.failed ? c.red("✗") : c.yellow("⚠")} ${c.bold(s.title)}${s.project ? c.gray(` · ${s.project}`) : ""}${s.since ? c.gray(` · ${ago(s.since)}`) : ""}`));
    // the reason in full words over up to three lines of the terminal, never cut on the right
    out.push(...wrapped(`${t("neden")}: ${clip(s.why, 400)}`, "     "));
    for (const a of s.actions) out.push(...wrapped(`${t("ekip ne yaptı")}: ${clip(a, 300)}`, "     ", c.gray));
  }

  out.push(head(t("Son 24 saatte biten"), d.done.length, d.done.length ? c.green : c.gray));
  if (!d.done.length) out.push(c.gray(`  ${t("son 24 saatte biten iş yok")}`));
  for (const x of d.done.slice(0, 8)) {
    out.push(fit(`  ${c.green("✓")} ${c.bold(x.title)}${x.project ? c.gray(` · ${x.project}`) : ""} ${c.gray(`· ${clock(x.at)} (${ago(x.at)})`)}`));
    if (x.result) out.push(fit(`     ${t("Sonuç")}: ${clip(x.result, 300)}`));
    for (const l of x.links) out.push(`     ${c.under(l)}`);
  }
  if (d.done.length > 8) out.push(c.gray(`  … ${t("{n} iş daha (ekip tasks --all)", { n: d.done.length - 8 })}`));

  out.push(`\n${c.bold(t("ekip sürümü ve yayın"))}`);
  out.push(fit(`  ${rel ? releaseLine(rel) : c.gray(t("bilinmiyor"))}`));
  return `${out.join("\n")}\n`;
}

/** "Havuzlar": the same chips as the task pane (pool-view.js), wrapped to the terminal. */
export async function poolsSection(stream = process.stdout) {
  const [{ currentView }, pv, { styleFor }, { kittyUpload }] = await Promise.all([import("../workers/limits.js"), import("../workers/pool-view.js"), import("./pane.js"), import("../workers/logos.js")]);
  const st = styleFor(stream);
  const width = Math.max(40, stream.columns || Number(process.env.COLUMNS) || 100);
  const sent = new Set();
  const lines = pv.chipLines(currentView(), width, st, { proto: pv.imageProtocol(stream, process.env, SETTINGS.poolLogos), logos: SETTINGS.poolLogos ?? "auto", label: "" }).map((l) => kittyUpload(l, sent));
  return [`\n${c.bold(t("Havuzlar"))}`, ...(lines.length ? lines : [c.gray(`  ${t("bağlı havuz yok → ekip setup")}`)])].join("\n");
}

export async function main(args = []) {
  const d = await collect();
  if (args.includes("--json")) { console.log(JSON.stringify({ ...d, release: await release() }, null, 2)); return 0; }
  const rel = args.includes("--offline") ? cachedRelease(Infinity) : await release();
  process.stdout.write(render(d, rel));
  // the pools as connected, the work behind the tasks, and at the bottom what setup still misses
  try { process.stdout.write(`${await poolsSection()}\n`); } catch { /* never fail the digest for it */ }
  try { const b = await import("../ops/background.js"); process.stdout.write(`${b.statusSection(b.backgroundJobs())}\n`); } catch { /* idem */ }
  try { const s = await import("../ops/setup.js"); process.stdout.write(`${s.statusSection(await s.checkSetup())}\n`); } catch { /* idem */ }
  return 0;
}
