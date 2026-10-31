// Tasks: one per user request. The lead creates it with its steps, marks steps as it goes and links
// workers to it, so the user sees percent done, the current step and an estimated finish time —
// in a live pane next to the lead (`ekip tasks --watch`), with `ekip tasks`, and on the hub panel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, SETTINGS, die, sleep, notify } from "../core/core.js";
import { c, mark, fit } from "../core/ui.js";
import { painter, renderPane } from "./pane.js";
import { bar as stateBar, barCells, glyph, icon, paint, rank, taskState } from "../core/status-style.js";
import { leadId } from "../core/terminal.js";
import { t as tr, lang } from "../core/i18n.js";
import { setupBadge } from "../ops/setup.js";

const FILE = path.join(HOME, "tasks.json");
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } };
const write = (all) => { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(all, null, 2)); fs.renameSync(`${FILE}.tmp`, FILE); writeTerminalStatus(all); };
const now = () => new Date().toISOString();
const cap = (x) => x.charAt(0).toLocaleUpperCase(lang === "en" ? "en" : "tr") + x.slice(1);
const newId = () => `g${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`;
// A process we cannot signal (another user's) still exists; only ESRCH means gone.
export const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// Step states that wait on something outside the task (a condition, the user): no stall warning,
// no estimate, and the task stays open.
const HELD = ["blocked", "waiting-user"];
const OPEN_WORKER = ["running", "queued", "waiting"];
// Automatic review states (review/auto.js) that keep a task open: its result is not final yet.
export const REVIEW_OPEN = ["pending", "reviewing", "fixing"];
const reviewOpen = (t) => REVIEW_OPEN.includes(t?.review?.state);

function update(id, fn) {
  const all = read();
  const t = all.find((x) => x.id === id) ?? die(`no task ${id} (ekip tasks)`);
  fn(t);
  t.updatedAt = now();
  // the first measured percent and its time: the estimate uses the real rate since then, so a task
  // created half-way (or a slow job tracked late) does not get a made-up finish time
  if (t.p0 == null) Object.assign(t, { p0: percent(t), p0At: t.updatedAt });
  write(all);
  push(t);
  return t;
}

/** Percent done: finished steps count fully, the running step by its own percent (or half). */
export function percent(t) {
  if (t.status === "done") return 100;
  const steps = t.steps ?? [];
  if (!steps.length) return t.pct ?? 0;
  const part = steps.reduce((sum, s) => sum + (s.status === "done" || s.status === "skipped" ? 1 : s.status === "running" ? (s.pct ?? 50) / 100 : HELD.includes(s.status) ? (s.pct ?? 0) / 100 : 0), 0);
  return Math.min(99, Math.round((part / steps.length) * 100));
}

/** Estimated finish: elapsed time scaled by what is left, once anything is measurable. */
export function eta(t) {
  // a step measured by `ekip track` knows its own finish from its real speed: when it is the last
  // work of the task, that is the task's finish too
  const run = (t.steps ?? []).filter((s) => s.status === "running");
  if (t.status === "running" && !t.hold && run.length && run.every((s) => s.etaAt && Date.parse(s.etaAt) > Date.now()) && !t.steps.some((s) => s.status === "pending" || HELD.includes(s.status)))
    return new Date(Math.max(...run.map((s) => Date.parse(s.etaAt)))).toISOString();
  const p = percent(t);
  // no guess until there is a real basis: a stalled step or early progress gives absurd numbers
  if (t.status !== "running" || p < 15 || t.hold || paused(t) || t.steps.some((s) => HELD.includes(s.status) || (s.status === "running" && stalledFor(s, t)))) return null;
  const p0 = t.p0 ?? 0, since = Date.now() - Date.parse(t.p0At ?? t.createdAt);
  if (p <= p0 || since < 5 * 60_000) return null;
  return new Date(Date.now() + since * (100 - p) / (p - p0)).toISOString();
}

export const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? tr("<1 dk") : m < 60 ? tr("{n} dk", { n: m }) : tr("{h} sa {m} dk", { h: Math.floor(m / 60), m: m % 60 }); };
// Pushes in flight; ekip.js waits for them before it exits, or the update would be cut off.
export const pending = new Set();

// Tasks whose last state did not reach the hub (timeout, network, hub restart). They are sent
// again by the next task command and by `ekip doctor`, so the panel never keeps a task open that
// was closed here.
const UNSYNCED = path.join(HOME, "tasks-unsynced.json");
const readUnsynced = () => { try { return new Set(JSON.parse(fs.readFileSync(UNSYNCED, "utf8"))); } catch { return new Set(); } };
function markSynced(id, ok) {
  const s = readUnsynced();
  if (ok ? !s.delete(id) : s.has(id) || !s.add(id)) return;
  try { fs.writeFileSync(UNSYNCED, JSON.stringify([...s])); } catch { /* best effort */ }
}

function push(t) {
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return;
  const pr = fetch(`${SETTINGS.hubUrl}/api/tasks`, {
    method: "PUT", signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` },
    body: JSON.stringify({ ...t, pct: percent(t), eta: eta(t), paused: paused(t), host: os.hostname() }),
  }).then((r) => markSynced(t.id, r.ok), () => markSynced(t.id, false)).finally(() => pending.delete(pr));
  pending.add(pr);
}

/** Sends the tasks the hub may have missed, plus everything touched in the last two days. */
export async function syncHub() {
  try { reapDead(); } catch { /* never block a sync */ }
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return 0;
  const missed = readUnsynced();
  const list = read().filter((t) => missed.has(t.id) || t.status === "running" || Date.now() - Date.parse(t.updatedAt ?? t.createdAt) < 48 * 3600_000);
  for (const t of list) push(t);
  await Promise.allSettled([...pending]);
  return list.length;
}

export function create({ title, project, steps = [] }) {
  if (!title) die('usage: ekip task new "title" [--project NAME] [--steps "a; b; c"]');
  // the lead that opened it (its terminal session), so that lead is the one reminded to keep it true
  const lead = leadId();
  const t = { id: newId(), title, project: project ?? null, status: "running", createdAt: now(), updatedAt: now(), steps: steps.map((s) => ({ title: s, status: "pending" })), workers: [], notes: [], ...(lead ? { lead } : {}) };
  const all = read();
  all.push(t);
  write(all);
  push(t);
  return t;
}

/** Mark step n (1-based): running [pct] | done | failed | skipped; starting one finishes earlier running ones. */
export function step(id, n, status = "done", { pct, note, detail, parallel = false, alive = false, rate, etaAt } = {}) {
  return update(id, (t) => {
    const s = t.steps[n - 1] ?? die(`task ${id} has no step ${n}`);
    // a late progress update from a script must not reopen a step of a task that is already closed
    if (t.status !== "running" && status === "running") return;
    if (status === "running" && !parallel) for (const o of t.steps) if (o !== s && o.status === "running") Object.assign(o, { status: "done", endedAt: now() });
    // progressAt: when the step last moved; a running step that stops moving is shown as stalled.
    // --alive: the reporter measured real work (records written, batches sent) even though the
    // percent did not change yet, as with one very long item; that is progress, not a stall.
    if ((pct != null && pct !== s.pct) || alive || (status === "running" && s.status !== "running")) s.progressAt = now();
    if (detail != null) s.detail = detail;
    // speed and finish of a measured step (ekip track); a finished step has no finish ahead of it
    if (rate !== undefined) s.rate = rate;
    if (etaAt !== undefined) s.etaAt = etaAt;
    if (status !== "running") delete s.etaAt;
    if (HELD.includes(s.status) && !HELD.includes(status)) { delete s.reason; if (t.hold?.step === n) { delete t.hold; delete t.ask; } }
    Object.assign(s, { status, ...(pct != null ? { pct } : {}), ...(status === "running" && !s.startedAt ? { startedAt: now() } : {}), ...(["done", "failed", "skipped"].includes(status) ? { endedAt: now() } : {}) });
    if (note) t.notes.push({ at: now(), text: note });
    if (status === "failed") notify(t.title, s.title, { subtitle: `⚠ ${lang === "en" ? "Step stalled" : "Adım takıldı"}${t.project ? ` · ${t.project}` : ""}`, group: t.id, open: SETTINGS.hubUrl ? `${SETTINGS.hubUrl}/tasks` : "" });
    autoClose(t);
  });
}

// A task finishes by itself: when every step is done or skipped, or when its last worker ended and
// no step is still running or pending. Nobody has to remember to close it.
function autoClose(t) {
  if (t.status !== "running") return;
  const terminal = t.steps.length && t.steps.every((x) => ["done", "skipped", "failed"].includes(x.status));
  const workersDone = t.workers.length && t.workers.every((w) => !OPEN_WORKER.includes(w.status));
  const open = t.hold || reviewOpen(t) || t.steps.some((x) => ["running", "pending", ...HELD].includes(x.status));
  if (terminal || (workersDone && !open)) {
    const failed = t.steps.some((x) => x.status === "failed");
    Object.assign(t, { status: failed ? "failed" : "done", endedAt: now() });
  }
}

export function addSteps(id, titles) { return update(id, (t) => t.steps.push(...titles.map((s) => ({ title: s, status: "pending" })))); }

// ---- results and questions -----------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]"'`]+[^\s<>()\[\]"'`.,;:!?]/g;
// an absolute or home path, or a relative one with a folder and an extension (src/a.ts, out/x.mp4:12)
const PATH_RE = /(?:^|[\s(`'"])((?:~|\/)[\w.@+-]+(?:\/[\w.@+-]+)+|[\w.@+-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,8}(?::\d+)?)(?=$|[\s)`'",;:!?]|\.(?:\s|$))/g;

/** Up to `max` links in a text: URLs first, then file paths (not the ones inside a URL). */
export function findLinks(text, max = 3) {
  const s = String(text ?? "");
  const urls = s.match(URL_RE) ?? [];
  const paths = [...s.replace(URL_RE, " ").matchAll(PATH_RE)].map((m) => m[1]).filter((p) => !/^\/\//.test(p));
  return [...new Set([...urls, ...paths])].slice(0, max);
}

/**
 * The result of a worker report in one short paragraph: the first one that says something (not a
 * heading, a code block, a table or a bare "Done."), markdown removed, at most `max` characters.
 */
export function summarize(report, max = 300) {
  const text = String(report ?? "").replace(/```[\s\S]*?```/g, "\n\n").replace(/\r/g, "");
  const paras = text.split(/\n\s*\n/).map((p) => p.split("\n").filter((l) => !/^\s*(#{1,6}\s|\||[-*_]{3,}\s*$)/.test(l)).join(" "))
    .map((p) => p.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/\s+/g, " ").trim());
  const p = paras.find((x) => x.replace(/[^\p{L}\p{N}]/gu, "").length >= 20) ?? paras.find(Boolean) ?? "";
  if (p.length <= max) return p;
  const cut = p.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6))}…`;
}

/**
 * ekip task done ID "result" --link X / ekip task result ID "result": what the task produced, shown
 * as "Sonuç: …" with its links in the pane, `ekip status` and on the panel. A result the lead wrote
 * is never replaced by one taken from a worker report (auto).
 */
export function setResult(id, text, links = [], { auto = false } = {}) {
  return update(id, (t) => {
    if (auto && t.result && !t.result.auto) return;
    const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    const all = [...new Set([...links, ...(auto ? [] : findLinks(clean))].map((l) => String(l).trim()).filter(Boolean))].slice(0, 5);
    if (!clean && !all.length) return;
    t.result = { text: clean, links: all, at: now(), ...(auto ? { auto: true } : {}) };
  });
}

/** A worker's report becomes the task's result (and a note), until the lead writes its own. */
export function autoResult(id, report, label) {
  const text = summarize(report);
  if (!text) return null;
  const links = findLinks(report);
  try {
    setResult(id, text, links, { auto: true });
    note(id, `${label ? `${label}: ` : ""}${tr("sonuç")}: ${text}${links.length ? ` (${links.join(", ")})` : ""}`);
  } catch { /* unknown task: ignore */ }
  return { text, links };
}

/**
 * The automatic review of the task's last worker result (review/auto.js): { state, author, reviewer,
 * round, max, met, total, findings, items, pid }. An open review keeps the task from closing; the
 * pane, `ekip status` and the panel show it as one line (reviewLabel).
 */
export function setReview(id, patch, text = null) {
  try {
    return update(id, (t) => {
      t.review = { ...(t.review ?? {}), ...patch, at: now() };
      if (text) t.notes.push({ at: now(), text });
      autoClose(t);
    });
  } catch { return null; /* unknown task: ignore */ }
}

/** "inceleniyor (reviewer: claude) · düzeltme turu 1/2", "review: geçti (kriter 12/12)", "review: düştü (3 bulgu)". */
export function reviewLabel(r) {
  if (!r?.state) return "";
  const round = r.round ? tr("düzeltme turu {n}/{max}", { n: r.round, max: r.max ?? 2 }) : "";
  if (r.state === "pending") return tr("incelemeye gidiyor");
  if (r.state === "reviewing") return [tr("inceleniyor (reviewer: {pool})", { pool: r.reviewer ?? "?" }), round].filter(Boolean).join(" · ");
  if (r.state === "fixing") return [round, tr("düzeltiyor: {pool}", { pool: r.author ?? "?" }), r.findings ? tr("{n} bulgu", { n: r.findings }) : ""].filter(Boolean).join(" · ");
  if (r.state === "passed") return tr("review: geçti (kriter {met}/{total})", { met: r.met ?? "?", total: r.total ?? "?" });
  if (r.state === "failed") return tr("review: düştü ({n} bulgu)", { n: r.findings ?? 0 });
  return tr("review: yapılamadı");
}
/** The status-style state a review line is painted with. */
export const reviewState = (r) => (r?.state === "passed" ? "done" : r?.state === "failed" ? "failed" : r?.state === "error" ? "blocked" : "running");

/**
 * ekip task ask ID "question" --option A --option B: the task waits for the user's decision, shown
 * at the top of the panel ("Senden beklenenler") and of `ekip status` until `ekip task answer`.
 */
export function ask(id, question, options = [], n = null) {
  hold(id, "waiting-user", question, n);
  return update(id, (t) => { if (t.status === "running") t.ask = { question, options: options.slice(0, 8), at: now() }; });
}
export function answer(id, choice) {
  const t = update(id, (x) => {
    const q = x.ask?.question ?? x.hold?.reason ?? "";
    (x.answers ??= []).push({ question: q, answer: choice, at: now() });
    if (x.answers.length > 20) x.answers.splice(0, x.answers.length - 20);
    delete x.ask;
  });
  return unhold(id, `${tr("karar")}: ${choice}${t.answers.at(-1).question ? ` (${t.answers.at(-1).question})` : ""}`);
}

export function finish(id, status = "done", note) {
  const t = update(id, (x) => {
    stopWorkers(x, status === "done" ? (lang === "en" ? "task closed" : "görev kapatıldı") : (lang === "en" ? "task cancelled" : "görev iptal edildi"));
    delete x.hold;
    delete x.ask;
    x.status = status;
    x.endedAt = now();
    for (const s of x.steps) if (s.status === "running" || HELD.includes(s.status) || (status === "done" && s.status === "pending")) Object.assign(s, { status: status === "done" ? "done" : s.status === "pending" ? s.status : "failed", endedAt: now() });
    if (note) x.notes.push({ at: now(), text: note });
  });
  // no note: say what happened in numbers rather than repeating the state
  const doneSteps = t.steps.filter((x) => x.status === "done").length;
  const summary = `${doneSteps}/${t.steps.length} ${lang === "en" ? "steps" : "adım"} · ${fmtDur(Date.now() - Date.parse(t.createdAt))}${t.workers.length ? ` · ${[...new Set(t.workers.map((w) => w.via).filter(Boolean))].join(", ")}` : ""}`;
  notify(t.title, note || summary, { subtitle: `${status === "done" ? `✓ ${cap(tr("bitti"))}` : `■ ${cap(tr("durdu"))}`}${t.project ? ` · ${t.project}` : ""}`, group: t.id, open: SETTINGS.hubUrl ? `${SETTINGS.hubUrl}/tasks` : "" });
  return t;
}

/** Called by `ekip run --task ID`: the worker shows under the task while it runs. */
export function linkWorker(id, w) { try { update(id, (t) => { upsertWorker(t, { ...w, startedAt: now(), status: "running", queue: undefined, why: undefined }); }); } catch { /* unknown task: ignore */ } }
// One entry per run: a worker that waited in the queue (or on a condition) becomes the running one.
function upsertWorker(t, w) {
  const old = t.workers.find((x) => x.runId === w.runId);
  if (old) Object.assign(old, w); else t.workers.push(w);
}
/** A worker that has not started yet: "queued" for a machine slot (n = its place), "waiting" on a condition. */
export function holdWorker(id, w, { status = "queued", queue = null, why = null } = {}) {
  try {
    update(id, (t) => {
      const old = t.workers.find((x) => x.runId === w.runId);
      if (old && old.status === status && old.queue === queue && old.why === why) return;
      upsertWorker(t, { ...w, startedAt: old?.startedAt ?? now(), status, queue, why });
    });
  } catch { /* unknown task: ignore */ }
}
export function dropWorker(id, runId) { try { update(id, (t) => { t.workers = t.workers.filter((w) => w.runId !== runId); }); } catch { /* unknown task: ignore */ } }
export function note(id, text) { try { update(id, (t) => t.notes.push({ at: now(), text })); } catch { /* unknown task: ignore */ } }
export function endWorker(id, runId, status, why, model = null, via = null) { try { update(id, (t) => { const w = t.workers.find((x) => x.runId === runId); if (w?.status === "cancelled" && w.endedAt) return; /* stopped by ekip task cancel: already noted */ if (w) Object.assign(w, { status, endedAt: now(), model, ...(via ? { via } : {}) }); t.notes.push({ at: now(), text: `${w?.label ?? runId} (${via ?? w?.via ?? "?"}): ${why ?? (status === "done" ? (lang === "en" ? "finished, the lead is reviewing" : "bitti, lead sonucu inceliyor") : status)}` }); autoClose(t); }); } catch { /* ignore */ } }

// Stops the live workers of a task that is being closed by hand (ekip task cancel/done): their
// `ekip run` process gets SIGTERM, which ends its worker CLI and reports the run as cancelled.
function stopWorkers(t, why) {
  for (const w of t.workers.filter((x) => OPEN_WORKER.includes(x.status))) {
    if (w.pid && w.pid !== process.pid && pidAlive(w.pid)) { try { process.kill(w.pid, "SIGTERM"); } catch { /* gone meanwhile */ } }
    Object.assign(w, { status: "cancelled", endedAt: now() });
    t.notes.push({ at: now(), text: `${w.label ?? w.runId} (${w.via ?? "?"}): ${lang === "en" ? "stopped" : "durduruldu"} (${why})` });
  }
}

// Why a worker process is gone, from the end of its log: the [exit] line and ekip's own notes.
function deathReason(w) {
  let tail = "";
  try { const st = fs.statSync(w.log), len = Math.min(st.size, 4096), fd = fs.openSync(w.log, "r"), b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd); tail = b.toString("utf8"); } catch { /* no log */ }
  const exit = tail.match(/\[exit (-?\d+)\]([^\n]*)\s*$/);
  const ekip = [...tail.matchAll(/^\[ekip\] ([^\n]+)$/gm)].at(-1)?.[1];
  if (exit) return `${lang === "en" ? "exit" : "çıkış"} ${exit[1]}${exit[2].trim() ? ` ${exit[2].trim()}` : ""}${ekip ? ` · ${ekip}` : ""}`;
  return lang === "en" ? "process gone without an exit record (killed by a signal, or the machine slept)" : "süreç çıkış kaydı olmadan kayboldu (sinyalle öldürüldü ya da makine uyudu)";
}

/**
 * The reaper: a worker whose `ekip run` process is gone is closed as dead with the reason its log
 * gives, so neither the pane nor the panel keeps a ghost "running" for hours. Runs with every task
 * command, the pane's repaint and the hub sync.
 */
export function reapDead() {
  const all = read();
  const dead = all.filter((t) => t.status === "running" && t.workers.some((w) => OPEN_WORKER.includes(w.status) && w.pid && !pidAlive(w.pid)));
  for (const t of dead) update(t.id, (x) => {
    for (const w of x.workers.filter((y) => OPEN_WORKER.includes(y.status) && y.pid && !pidAlive(y.pid))) {
      // it ended when its log last moved, not when the reaper noticed
      let ended = now();
      try { ended = new Date(Math.min(Date.now(), fs.statSync(w.log).mtimeMs)).toISOString(); } catch { /* no log */ }
      Object.assign(w, { status: "killed", endedAt: ended });
      x.notes.push({ at: now(), text: `${w.label ?? w.runId} (${w.via ?? "?"}): ${lang === "en" ? "died" : "öldü"} (${deathReason(w)})` });
    }
    autoClose(x);
  });
  // a review whose `ekip run` process died will never report: it is closed as not done, held for the lead
  for (const t of read().filter((x) => x.status === "running" && reviewOpen(x) && x.review.pid && !pidAlive(x.review.pid))) {
    hold(t.id, "blocked", tr("otomatik inceleme yarıda kaldı; sonucu lead incelemeli"), null, { alert: true });
    setReview(t.id, { state: "error", why: "process gone" }, tr("otomatik inceleme yarıda kaldı (süreç kayıp); lead incelesin"));
  }
  // the hub cannot see pids: a task that just became paused (or stopped being) is pushed once, with
  // a note the first time, so the task's history says when its work was left without a process
  for (const t of read().filter((x) => x.status === "running" && !!x.pausedAt !== paused(x))) update(t.id, (x) => {
    if (!paused(x)) { delete x.pausedAt; return; }
    x.pausedAt = now();
    const s = x.steps.filter((y) => y.status === "running").map((y) => y.title).join(", ");
    x.notes.push({ at: now(), text: tr("sahipsiz: \"{steps}\" sürüyor görünüyor ama çalışan süreç yok; kapatın ya da yeniden başlatın", { steps: s }) });
  });
  return dead.length;
}

/**
 * Orphaned: a step is marked running, but no live process works for it (no worker, no tracked
 * job) and the step has not moved for `ms` since it or the last worker did. A long command the lead
 * started in a bare background shell and then forgot looks exactly like this.
 */
export function orphaned(t, ms = 10 * 60_000) {
  if (t.status !== "running" || t.hold || reviewOpen(t) || !t.steps?.some((s) => s.status === "running")) return false;
  if ((t.workers ?? []).some((w) => OPEN_WORKER.includes(w.status) && (!w.pid || pidAlive(w.pid)))) return false;
  const lastEnd = Math.max(0, ...(t.workers ?? []).map((w) => Date.parse(w.endedAt ?? w.startedAt ?? 0) || 0));
  const moved = Math.max(...t.steps.filter((s) => s.status === "running").map((s) => Date.parse(s.progressAt ?? s.startedAt ?? 0) || 0));
  return Date.now() - Math.max(lastEnd, moved) > ms;
}

/**
 * Paused: orphaned for 5 minutes after the task's last worker ended, or for 10 minutes when it never
 * had one. The pane and panel say "paused: no live worker" instead of "running", so a dropped
 * hand-off is visible, and the lead's next prompt lists it as orphaned (prompt-context.js).
 */
export function paused(t) { return orphaned(t, t.workers?.length ? 5 * 60_000 : 10 * 60_000); }

/**
 * ekip task block|wait ID "reason" [--step N]: the task waits on a condition (blocked) or on the
 * user (waiting-user). The step (the running one, else the next pending, else --step) shows the
 * reason; no stall warning and no estimate while it holds. `ekip task unblock ID` or marking the
 * step running again ends it.
 */
export function hold(id, kind, reason, n = null, { alert } = {}) {
  return update(id, (t) => {
    if (t.status !== "running") return;
    const i = n ? n - 1 : t.steps.findIndex((s) => s.status === "running" || HELD.includes(s.status));
    const j = i >= 0 ? i : t.steps.findIndex((s) => s.status === "pending");
    const s = t.steps[j];
    if (s) Object.assign(s, { status: kind, reason, progressAt: now(), ...(!s.startedAt ? { startedAt: now() } : {}) });
    t.hold = { kind, reason, at: now(), step: s ? j + 1 : null };
    t.notes.push({ at: now(), text: `${kind === "waiting-user" ? (lang === "en" ? "waiting for the user" : "kullanıcı bekleniyor") : (lang === "en" ? "blocked" : "engellendi")}: ${reason}` });
    if (alert ?? kind === "waiting-user") notify(t.title, reason, { subtitle: `⏸ ${kind === "waiting-user" ? (lang === "en" ? "Your decision is needed" : "Kararın bekleniyor") : (lang === "en" ? "Blocked" : "Engellendi")}${t.project ? ` · ${t.project}` : ""}`, group: t.id, open: SETTINGS.hubUrl ? `${SETTINGS.hubUrl}/tasks` : "" });
  });
}
export function unhold(id, note) {
  return update(id, (t) => {
    for (const s of t.steps.filter((x) => HELD.includes(x.status))) { s.status = "running"; s.progressAt = now(); delete s.reason; }
    delete t.hold;
    delete t.ask;
    if (note) t.notes.push({ at: now(), text: note });
  });
}

// Tasks nobody moved for hours (no live worker, no step update) are orphans: flagged after 2 h,
// closed as failed after 6 h, so the pane and panel never show yesterday's work as running.
export function reapStale() {
  for (const t of read().filter((x) => x.status === "running")) {
    const idle = Date.now() - Date.parse(t.updatedAt ?? t.createdAt);
    // a task held on the user or a condition waits up to three days, not six hours
    if (idle > (t.hold ? 72 : 6) * 3600_000 && !t.workers.some((w) => OPEN_WORKER.includes(w.status) && pidAlive(w.pid)))
      update(t.id, (x) => { x.notes.push({ at: now(), text: lang === "en" ? "closed: no activity for 6 hours" : "kapatıldı: 6 saattir hareket yok" }); Object.assign(x, { status: "failed", endedAt: now() }); });
  }
}

export function active() { return read().filter((t) => t.status === "running"); }

// data/terminal-status.json: the few numbers WezTerm's tab bar shows (waiting for you, stuck,
// running) and the registered projects (tab titles name the project, not the folder). Rewritten
// when a task changes, and by the task pane, only when something in it changed; the terminal reads
// this small file instead of starting ekip every second.
export const STATUS_FILE = path.join(HOME, "terminal-status.json");
// The task pane's own counts (digest.collect: stalled steps and failures of the last day are stuck
// too), kept for a moment so a task write in between does not flip the tab bar to other numbers.
const COUNTS_FILE = path.join(HOME, "pane-counts.json");
export const digestCounts = (d) => ({ waiting: d.waiting.length, blocked: d.stuck.length, running: d.running.length });
function paneCounts(maxAgeMs = 15_000) {
  try { const j = JSON.parse(fs.readFileSync(COUNTS_FILE, "utf8")); return Date.now() - j.at < maxAgeMs ? j.counts : null; } catch { return null; }
}
function countTasks(all, n) {
  for (const t of all.filter((x) => x.status === "running")) {
    if (t.hold?.kind === "waiting-user") n.waiting++;
    else if (t.hold || paused(t)) n.blocked++;
    else n.running++;
  }
  // a tracked job without a running task of its own is running work too
  const open = new Set(all.filter((x) => x.status === "running").map((x) => x.id));
  try {
    for (const f of fs.readdirSync(path.join(HOME, "tracks")).filter((x) => x.endsWith(".json"))) {
      try { const j = JSON.parse(fs.readFileSync(path.join(HOME, "tracks", f), "utf8")); if (!j.endedAt && pidAlive(j.pid) && !open.has(j.taskId)) n.running++; } catch { /* half-written */ }
    }
  } catch { /* no tracked jobs */ }
}
export function terminalStatus(all = read(), counts = paneCounts()) {
  const n = counts ? { ...counts } : { waiting: 0, blocked: 0, running: 0 };
  if (!counts) countTasks(all, n);
  let projects = [];
  try { projects = JSON.parse(fs.readFileSync(path.join(HOME, "projects.json"), "utf8")).filter((p) => p?.name && p?.path).map((p) => ({ name: p.name, path: p.path })); } catch { /* none registered */ }
  // missing required setup steps, from the cached check (ekip setup); the status bar shows "kurulum 5/9"
  let setup;
  try { const b = setupBadge({ spawnRefresh: false }); if (b?.missing.length) setup = { done: b.done, total: b.total, missing: b.missing.length }; } catch { /* no state yet */ }
  return { ...n, projects, ...(setup ? { setup } : {}) };
}
export function writeTerminalStatus(all, digest = null) {
  try {
    let counts;
    if (digest) {
      counts = digestCounts(digest);
      fs.writeFileSync(`${COUNTS_FILE}.${process.pid}.tmp`, JSON.stringify({ at: Date.now(), counts }));
      fs.renameSync(`${COUNTS_FILE}.${process.pid}.tmp`, COUNTS_FILE);
    }
    const body = JSON.stringify(terminalStatus(all, counts));
    let old = "";
    try { old = fs.readFileSync(STATUS_FILE, "utf8"); } catch { /* first write */ }
    if (body === old) return false;
    fs.writeFileSync(`${STATUS_FILE}.${process.pid}.tmp`, body);
    fs.renameSync(`${STATUS_FILE}.${process.pid}.tmp`, STATUS_FILE);
    return true;
  } catch { return false; } // the terminal status is never worth failing a task command for
}
/** Every task in the file (ekip status reads finished ones too). */
export function list() { return read(); }

// ---- rendering ---------------------------------------------------------------------------------

function bar(p, cells = barCells(), state = "running") { return stateBar(state, p, cells); }
const stateOf = (t) => taskState(t, { paused: t.status === "running" && !t.hold && paused(t) });

// a running step whose pct/detail has not moved for 15 min is stalled, whatever its label says
const STALL_MS = 15 * 60 * 1000;
// A running step with no update for STALL_MS, unless one of the task's workers is still writing
// its log: a long worker step only reports at its end, and that is not a stall.
const workerActive = (t) => (t?.workers ?? []).some((w) => {
  if (w.status !== "running" || !w.log) return false;
  try { return Date.now() - fs.statSync(w.log).mtimeMs < STALL_MS; } catch { return false; }
});
export const stalledFor = (s, t) => (s.status === "running" && s.progressAt && Date.now() - Date.parse(s.progressAt) > STALL_MS && !workerActive(t) ? Date.now() - Date.parse(s.progressAt) : 0);

// "sürüyor", or what really holds it: blocked / waiting for the user / paused with no live worker.
function runningState(t) {
  if (t.hold?.kind === "waiting-user") return paint("waiting-user", tr("kullanıcı bekleniyor"));
  if (t.hold) return paint("blocked", tr("engellendi"));
  if (paused(t)) return paint("paused", tr("duraklamış: çalışan süreç yok"));
  return paint("running", tr("sürüyor"));
}
const heldLabel = (s) => paint(s.status, `${s.status === "blocked" ? tr("engellendi") : tr("kullanıcı bekleniyor")}${s.reason ? `: ${s.reason}` : ""}`);

function render(t) {
  const p = percent(t);
  const e = eta(t);
  const elapsed = Date.now() - Date.parse(t.createdAt);
  const st = stateOf(t);
  const state = t.status === "done" ? paint("done", tr("bitti")) : t.status === "failed" ? paint("failed", tr("takıldı")) : t.status === "cancelled" ? paint("cancelled", tr("iptal")) : runningState(t);
  const head = fit(`${icon(st)} ${c.bold(t.title)}${t.project ? c.gray(` · ${t.project}`) : ""}  ${c.gray(t.id)}`);
  const line = fit(`  ${bar(p, barCells(), st)} ${c.bold(`${p}%`)}  ${state}  ${c.gray(tr("geçen {duration}", { duration: fmtDur(elapsed) }))}${e ? c.gray(` · ${tr("tahmini bitiş {time} ({duration} kaldı)", { time: new Date(e).toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), duration: fmtDur(Date.parse(e) - Date.now()) })}`) : ""}`);
  const steps = t.steps.map((s, i) => {
    const sym = icon(s.status === "running" && st === "paused" ? "paused" : s.status);
    const label = s.status === "running" || HELD.includes(s.status) ? c.bold(s.title) : s.status === "pending" ? c.gray(s.title) : s.title;
    const held = HELD.includes(s.status) ? `  ${heldLabel(s)}` : "";
    const extra = s.status === "running" && s.startedAt ? c.gray(` (${fmtDur(Date.now() - Date.parse(s.startedAt))}${s.pct != null ? (lang === "en" ? ` · ${s.pct}%` : ` · %${s.pct}`) : ""})`) : "";
    const stall = stalledFor(s, t);
    const warn = stall ? `  ${paint("stalled", `${glyph("stalled")} ${fmtDur(stall)} ${lang === "en" ? "without progress" : "boyunca ilerleme yok"}`)}` : "";
    const det = s.status === "running" && s.detail ? `\n${fit(`       ${c.gray(s.detail)}`)}` : "";
    return fit(`    ${stall ? icon("stalled") : sym} ${i + 1}. ${label}${extra}${warn}${held}${det}`);
  });
  // A worker killed from outside never reports its end; its pid tells.
  const alive = (w) => !w.pid || pidAlive(w.pid);
  const waiting = t.workers.filter((w) => (w.status === "queued" || w.status === "waiting") && alive(w)).map((w) =>
    fit(`    ${icon(w.status === "queued" ? "queued" : "blocked")} ${w.via ?? "auto"}${w.label ? ` · ${w.label}` : ""} ${paint(w.status === "queued" ? "queued" : "blocked", w.status === "queued" ? tr("kuyrukta (sıra {n})", { n: w.queue ?? "?" }) : tr("koşul bekleniyor"))}${w.why ? c.gray(` · ${w.why}`) : ""}`));
  const workers = t.workers.filter((w) => w.status === "running" && alive(w)).map((w) => {
    const stale = w.log && fs.existsSync(w.log) && Date.now() - fs.statSync(w.log).mtimeMs > 10 * 60 * 1000;
    return fit(`    ${icon(stale ? "stalled" : "running")} ${w.via}${w.label ? ` · ${w.label}` : ""} ${c.gray(`${fmtDur(Date.now() - Date.parse(w.startedAt))}${stale ? ` · ${lang === "en" ? "no output for 10 min" : "10 dk'dır çıktı yok"}` : ""}`)}`);
  });
  const last = t.notes.at(-1);
  // a question with options waits on the user; a finished task says what it produced
  const asked = t.ask?.options?.length ? [fit(`    ${icon("waiting-user")} ${tr("seçenekler")}: ${t.ask.options.map((o, i) => `${c.cyan(`${String.fromCharCode(65 + i)})`)} ${o}`).join(c.gray("  ·  "))}`)] : [];
  const result = t.status !== "running" && t.result?.text ? [fit(`    ${paint("done", `${tr("Sonuç")}:`)} ${t.result.text}`), ...(t.result.links ?? []).map((l) => fit(`      ${c.under(l)}`))] : [];
  const tail = result.length ? result : last ? [fit(`    ${c.gray(`↳ ${last.text}`)}`)] : [];
  const review = t.review?.state ? [fit(`    ${icon(reviewState(t.review))} ${paint(reviewState(t.review), reviewLabel(t.review))}`)] : [];
  return [head, line, ...steps, ...asked, ...workers, ...waiting, ...review, ...tail].join("\n");
}

// The pools for the pane's footer (workers/pool-view.js): which pools are connected and their limits
// are re-read every 30 s (it spawns `command -v`), the running counts on every repaint. While a
// free-pool worker runs, freellmapi's routing snapshot is refreshed in the background every 2 min,
// so the card says which provider and model it is on.
let ready = { at: 0, workers: [] };
let routingAsked = 0;
async function poolData() {
  try {
    const a = await import("../workers/agents.js");
    const lim = await import("../workers/limits.js");
    if (Date.now() - ready.at > 30_000) {
      // the pane outlives `ekip mesai on/off` and `ekip agents test`: pick up their settings
      try { const cfg = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")); for (const k of ["mesai", "mesaiClaude", "poolConcurrency", "agents", "autoOrder", "disabledPools", "poolLogos"]) SETTINGS[k] = cfg[k]; } catch { /* keep the old ones */ }
      ready = { at: Date.now(), workers: lim.workerPools() };
    }
    const load = a.poolLoad();
    const rs = lim.cachedRouting();
    const freeBusy = Object.entries(load).some(([n, l]) => l.running > 0 && a.onFreePool(n));
    if (freeBusy && Date.now() - (rs?.at ?? 0) > 120_000 && Date.now() - routingAsked > 120_000) {
      routingAsked = Date.now();
      try { spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "../../bin/ekip.js"), "limits", "--refresh"], { stdio: "ignore", detached: true }).unref(); } catch { /* next time */ }
    }
    const { freeServing } = await import("../workers/pool-view.js");
    return { view: lim.currentView({ workers: ready.workers, load, rs }), serving: freeServing(rs), onFree: (via) => a.onFreePool(via) };
  } catch { return { view: { pools: [], hidden: 0 }, serving: null, onFree: () => false }; }
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const pctLabel = (n) => (lang === "en" ? `${n}%` : `%${n}`);

/** A task as the pane's card model (plugin/lib/tasks/pane.js draws it). */
export function cardOf(t) {
  const state = stateOf(t), p = percent(t), e = eta(t);
  const status = t.status === "done" ? tr("bitti") : t.status === "failed" ? tr("takıldı") : t.status === "cancelled" ? tr("iptal")
    : t.hold?.kind === "waiting-user" ? tr("senden bekleniyor") : t.hold ? `${tr("engellendi")}${t.hold.reason ? `: ${t.hold.reason}` : ""}`
      : paused(t) ? tr("duraklamış: çalışan süreç yok") : tr("sürüyor");
  const when = [fmtDur((t.status === "running" ? Date.now() : Date.parse(t.endedAt ?? t.updatedAt)) - Date.parse(t.createdAt)), ...(e ? [tr("bitiş ~{time}", { time: hhmm(Date.parse(e)) })] : [])];
  const steps = t.steps ?? [];
  const cur = steps.find((s) => s.status === "running" || HELD.includes(s.status)) ?? (t.status === "running" ? steps.find((s) => s.status === "pending") : null);
  const n = cur ? steps.indexOf(cur) + 1 : 0;
  const note = !cur ? null : cur.status === "running" ? [cur.pct != null ? pctLabel(cur.pct) : "", cur.detail ?? ""].filter(Boolean).join(" · ") || null
    : cur.status === "pending" ? tr("sırada") : null;
  const stall = cur ? stalledFor(cur, t) : 0;
  const alive = (w) => !w.pid || pidAlive(w.pid);
  const workers = (t.status === "running" ? t.workers : []).filter((w) => OPEN_WORKER.includes(w.status) && alive(w)).map((w) => {
    if (w.status === "queued") return { state: "queued", via: w.via ?? "auto", label: w.label, note: tr("kuyrukta (sıra {n})", { n: w.queue ?? "?" }) };
    if (w.status === "waiting") return { state: "blocked", via: w.via ?? "auto", label: w.label, note: tr("koşul bekleniyor") };
    let stale = false;
    try { stale = !!w.log && Date.now() - fs.statSync(w.log).mtimeMs > 10 * 60 * 1000; } catch { /* no log yet */ }
    return { state: stale ? "stalled" : "running", via: w.via ?? "?", label: w.label && w.label !== t.title ? w.label : null, note: fmtDur(Date.now() - Date.parse(w.startedAt)) };
  });
  const ask = t.status === "running" && t.hold?.kind === "waiting-user" ? { question: t.ask?.question ?? t.hold.reason, options: t.ask?.options ?? [] } : null;
  return {
    id: t.id, state, title: t.title, project: t.project, pct: p, status, statusState: state, when,
    step: cur ? { n, total: steps.length, title: cur.title, note } : null,
    stalled: stall ? tr("{duration} boyunca ilerleme yok", { duration: fmtDur(stall) }) : null,
    workers, ask, result: t.status !== "running" ? t.result?.text ?? null : null,
    review: t.review?.state ? { state: reviewState(t.review), text: reviewLabel(t.review) } : null,
  };
}

/** Everything the pane shows, from the task file, the digest (counts, tracked jobs, loose workers) and the pools. */
export function paneModel({ tasks = [], digest = null, pools = [], version = null, at = Date.now(), setup = undefined, serving = null, onFree = (via) => via === "free", background = null } = {}) {
  const cards = tasks.map(cardOf);
  // a running free-pool worker says which provider and model answer it: "free · NVIDIA nemotron-…"
  if (serving) for (const x of cards) for (const w of x.workers ?? []) if (w.state === "running" && onFree(w.via)) w.note = [w.note, serving].filter(Boolean).join(" · ");
  const ids = new Set(tasks.map((t) => t.id));
  const loose = [];
  for (const x of digest?.running ?? []) {
    if (ids.has(x.id)) continue;
    const w = x.workers?.[0];
    // a tracked job knows its percent: a card; a worker run without a task: one line
    if (x.pct != null) cards.push({ id: x.id, state: "running", title: x.title, project: x.project, pct: x.pct, status: tr("sürüyor"), when: [...(w?.rate ? [w.rate] : []), ...(x.eta ? [tr("bitiş ~{time}", { time: hhmm(Date.parse(x.eta)) })] : [])], step: null, workers: w ? [{ state: "running", via: w.via, label: null, note: w.lastLine || null }] : [] });
    else if (w) loose.push({ state: "running", via: w.via, label: x.title, note: w.since ? fmtDur(Date.now() - Date.parse(w.since)) : null });
  }
  if (serving) for (const r of loose) if (onFree(r.via)) r.note = [r.note, serving].filter(Boolean).join(" · ");
  const counts = digest ? { waiting: digest.waiting.length, stuck: digest.stuck.length, running: digest.running.length, done: digest.done.length } : { waiting: 0, stuck: 0, running: tasks.filter((t) => t.status === "running").length, done: 0 };
  const recent = (digest?.done ?? []).slice(0, 3).map((d) => ({ title: d.title, result: d.result }));
  // missing required setup steps: one amber line under the header (cached check, refreshed in the background)
  if (setup === undefined) { try { setup = setupBadge(); } catch { setup = null; } }
  return { clock: hhmm(at), version, counts, cards, loose, recent, pools, mesai: !!SETTINGS.mesai, setup, background, logos: SETTINGS.poolLogos ?? "auto" };
}

// The live pane runs for hours; after ekip is updated it restarts itself, so the terminal never
// shows older logic than the web panel.
const CODE = ["tasks/tasks.js", "tasks/pane.js", "tasks/digest.js", "workers/agents.js", "workers/pool-view.js", "workers/limits.js", "ops/background.js", "ops/setup.js", "core/ui.js", "core/status-style.js", "core/i18n.js"].map((f) => path.join(path.dirname(new URL(import.meta.url).pathname), "..", f));
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join();
const startedStamp = codeStamp();
const codeChanged = () => codeStamp() !== startedStamp;
// Keyboard input of the live pane: raw mode, nothing echoed; keys go to onKey.
let inputHeld = false;
function holdInput(onKey) {
  if (!process.stdin.isTTY || inputHeld) return;
  inputHeld = true;
  try { process.stdin.setRawMode(true); } catch { inputHeld = false; return; }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onKey);
  process.stdin.resume();
}
function releaseInput() {
  if (!inputHeld) return;
  inputHeld = false;
  process.stdin.removeAllListeners("data");
  try { process.stdin.setRawMode(false); } catch { /* the tty is gone */ }
  process.stdin.pause();
}

function restartWatch() {
  releaseInput(); // the restarted pane takes the keyboard over
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  const child = spawn(process.execPath, process.argv.slice(1), { stdio: "inherit" });
  process.removeAllListeners("SIGINT"); process.removeAllListeners("SIGTERM");
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => process.exit(code ?? 0));
  return new Promise(() => {}); // the child owns the pane from here
}

export async function main([sub = "ls", ...args]) {
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const rest = () => args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  // a repeated option: --link a --link b, --option A --option B
  const many = (k) => args.flatMap((a, i) => (a === k && args[i + 1] != null ? [args[i + 1]] : []));
  if (sub === "new") {
    const t = create({ title: rest()[0], project: opt("--project"), steps: (opt("--steps") ?? "").split(";").map((s) => s.trim()).filter(Boolean) });
    console.log(t.id);
  } else if (sub === "step") {
    const [id, n, status = "done"] = rest();
    step(id, Number(n), status, { pct: opt("--pct") != null ? Number(opt("--pct")) : undefined, note: opt("--note"), detail: opt("--detail"), parallel: args.includes("--parallel"), alive: args.includes("--alive") });
  } else if (sub === "add") {
    const [id, ...titles] = rest();
    addSteps(id, titles.join(" ").split(";").map((s) => s.trim()).filter(Boolean));
  } else if (sub === "note") {
    const [id, ...text] = rest();
    update(id, (t) => t.notes.push({ at: now(), text: text.join(" ") }));
  } else if (sub === "block" || sub === "wait") {
    const [id, ...text] = rest();
    if (!id || !text.length) die(`usage: ekip task ${sub} ID "${sub === "wait" ? "what the user has to decide" : "reason"}" [--step N]`);
    hold(id, sub === "wait" ? "waiting-user" : "blocked", text.join(" "), opt("--step") ? Number(opt("--step")) : null);
  } else if (sub === "unblock" || sub === "resume") {
    const [id, ...text] = rest();
    unhold(id, text.join(" ") || undefined);
  } else if (sub === "ask") {
    const [id, ...text] = rest();
    if (!id || !text.length) die('usage: ekip task ask ID "question" [--option A] [--option B] [--step N]');
    ask(id, text.join(" "), many("--option"), opt("--step") ? Number(opt("--step")) : null);
  } else if (sub === "answer") {
    const [id, ...text] = rest();
    if (!id || !text.length) die('usage: ekip task answer ID "the user\'s choice"');
    answer(id, text.join(" "));
  } else if (sub === "result") {
    const [id, ...text] = rest();
    if (!id || (!text.length && !many("--link").length)) die('usage: ekip task result ID "one-line result" [--link URL|PATH]...');
    setResult(id, text.join(" "), many("--link"));
  } else if (sub === "done" || sub === "fail" || sub === "cancel") {
    const [id, ...text] = rest();
    const links = many("--link");
    // the closing sentence of a finished task is its result (with its links)
    if (sub === "done" && (text.length || links.length)) setResult(id, text.join(" "), links);
    finish(id, sub === "done" ? "done" : sub === "fail" ? "failed" : "cancelled", text.join(" ") || undefined);
  } else if (sub === "ls" || sub === "--watch" || sub === "watch") {
    const watching = sub !== "ls" || args.includes("--watch");
    const all = args.includes("--all");
    // --once: one frame of the pane on stdout (tests, screenshots), no alternate screen
    const once = args.includes("--once");
    const pick = () => read().filter((t) => all || t.status === "running" || Date.now() - Date.parse(t.endedAt ?? t.updatedAt) < 60 * 1000)
      .sort((a, b) => (a.status === "running") - (b.status === "running") || String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-8).reverse()
      .sort((a, b) => (rank(stateOf(a)) === 0 ? 0 : 1) - (rank(stateOf(b)) === 0 ? 0 : 1)); // waiting for the user: on top
    if (!watching) {
      try { reapDead(); } catch { /* never block the list */ }
      const list = pick();
      console.log(`${mark()}  ${c.gray(tr("görevler"))}\n\n${list.length ? list.map(render).join("\n\n") : c.gray(`  ${tr("aktif görev yok")}`)}\n`);
      return;
    }
    // Watching draws on the alternate screen and rewrites only the lines that changed (pane.js), so
    // nothing scrolls and nothing flickers.
    const draw = painter();
    if (!once) {
      process.stdout.write("\x1b[?1049h\x1b[?25l");
      const restore = () => { releaseInput(); process.stdout.write("\x1b[?25h\x1b[?1049l"); process.exit(0); };
      process.on("SIGINT", restore); process.on("SIGTERM", restore);
      // The pane reads its own keyboard: a terminal turns the mouse wheel into arrow keys on the alternate
      // screen (WezTerm, iTerm2), and with the tty in cooked mode they were echoed as ^[[A^[[B over the
      // frame (31 Oct). Raw mode swallows them; q or Ctrl+C closes the pane.
      holdInput((key) => { if (key === "\x03" || key === "q") restore(); });
    }
    let wake = null;
    process.stdout.on("resize", () => wake?.());
    let reconciled = 0, version = null;
    do {
      try { reapDead(); } catch { /* the pane never stops for this */ }
      // ghost runs on the hub (a worker killed with no word) are closed from here too, once a minute
      if (!once && Date.now() - reconciled > 60_000) { reconciled = Date.now(); try { spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "../../bin/ekip.js"), "reconcile"], { stdio: "ignore", detached: true }).unref(); } catch { /* best effort */ } }
      if (version == null) try { const dg = await import("./digest.js"); version = dg.cachedRelease(Infinity)?.version ?? (await import("../ops/update.js")).localVersion(); } catch { version = ""; }
      let digest = null;
      try { const dg = await import("./digest.js"); digest = await dg.collect(); } catch { /* the pane never stops for this */ }
      try { writeTerminalStatus(read(), digest); } catch { /* best effort */ }
      const pd = await poolData();
      let background = null;
      try { background = (await import("../ops/background.js")).backgroundJobs(); } catch { /* the pane never stops for this */ }
      const model = paneModel({ tasks: pick(), digest, pools: pd.view, serving: pd.serving, onFree: pd.onFree, background, version });
      const width = process.stdout.columns || Number(process.env.COLUMNS) || 100, height = process.stdout.rows || Number(process.env.LINES) || 30;
      const lines = renderPane(model, { width, height: once ? Math.min(height, 200) : height });
      if (once) { process.stdout.write(`${lines.join("\n")}\n`); break; }
      draw(lines);
      await new Promise((r) => { const timer = setTimeout(r, 2000); wake = () => { clearTimeout(timer); r(); }; });
      wake = null;
      if (codeChanged()) await restartWatch();
    } while (true);
  } else die('usage: ekip tasks [--watch|--all] | ekip task new "title" [--project P] [--steps "a; b"] | step ID N [running|done|failed|skipped] [--pct N] [--note T] [--detail T] [--parallel] [--alive] | add ID "a; b" | note ID text | block ID "reason" [--step N] | wait ID "what the user decides" [--step N] | ask ID "question" [--option A]... | answer ID "choice" | unblock ID | result ID "result" [--link L]... | done ID ["result"] [--link L]... | fail|cancel ID [note]');
}
