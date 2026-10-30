// Tasks: one per user request. The lead creates it with its steps, marks steps as it goes and links
// workers to it, so the user sees percent done, the current step and an estimated finish time —
// in a live pane next to the lead (`ekip tasks --watch`), with `ekip tasks`, and on the hub panel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOME, SETTINGS, die, sleep, notify } from "../core/core.js";
import { c, dot, mark, progress, fit } from "../core/ui.js";
import { t as tr, lang } from "../core/i18n.js";

const FILE = path.join(HOME, "tasks.json");
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } };
const write = (all) => { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(all, null, 2)); fs.renameSync(`${FILE}.tmp`, FILE); };
const now = () => new Date().toISOString();
const cap = (x) => x.charAt(0).toLocaleUpperCase(lang === "en" ? "en" : "tr") + x.slice(1);
const newId = () => `g${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`;
// A process we cannot signal (another user's) still exists; only ESRCH means gone.
export const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// Step states that wait on something outside the task (a condition, the user): no stall warning,
// no estimate, and the task stays open.
const HELD = ["blocked", "waiting-user"];
const OPEN_WORKER = ["running", "queued", "waiting"];

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
  const lead = process.env.ITERM_SESSION_ID?.split(":")[1] ?? process.env.TERM_SESSION_ID ?? null;
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
  const open = t.hold || t.steps.some((x) => ["running", "pending", ...HELD].includes(x.status));
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
  if (t.status !== "running" || t.hold || !t.steps?.some((s) => s.status === "running")) return false;
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
/** Every task in the file (ekip status reads finished ones too). */
export function list() { return read(); }

// ---- rendering ---------------------------------------------------------------------------------

function bar(p, cells = 20) { return progress(p, cells); }

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
  if (t.hold?.kind === "waiting-user") return c.blue(tr("kullanıcı bekleniyor"));
  if (t.hold) return c.magenta(tr("engellendi"));
  if (paused(t)) return c.red(tr("duraklamış: çalışan ajan yok"));
  return c.yellow(tr("sürüyor"));
}
const heldLabel = (s) => (s.status === "blocked" ? c.magenta : c.blue)(`${s.status === "blocked" ? tr("engellendi") : tr("kullanıcı bekleniyor")}${s.reason ? `: ${s.reason}` : ""}`);

function render(t) {
  const p = percent(t);
  const e = eta(t);
  const elapsed = Date.now() - Date.parse(t.createdAt);
  const state = t.status === "done" ? c.green(tr("bitti")) : t.status === "failed" ? c.red(tr("takıldı")) : t.status === "cancelled" ? c.gray(tr("iptal")) : runningState(t);
  const head = fit(`${dot(t.status === "done" ? "ok" : t.status === "running" ? (paused(t) ? "bad" : "warn") : "bad")} ${c.bold(t.title)}${t.project ? c.gray(` · ${t.project}`) : ""}  ${c.gray(t.id)}`);
  const line = fit(`  ${bar(p)} ${c.bold(`${p}%`)}  ${state}  ${c.gray(tr("geçen {duration}", { duration: fmtDur(elapsed) }))}${e ? c.gray(` · ${tr("tahmini bitiş {time} ({duration} kaldı)", { time: new Date(e).toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), duration: fmtDur(Date.parse(e) - Date.now()) })}`) : ""}`);
  const steps = t.steps.map((s, i) => {
    const icon = s.status === "done" ? c.green("✓") : s.status === "running" ? c.yellow("▶") : s.status === "failed" ? c.red("✗") : s.status === "skipped" ? c.gray("–") : s.status === "blocked" ? c.magenta("⏸") : s.status === "waiting-user" ? c.blue("?") : c.gray("○");
    const label = s.status === "running" || HELD.includes(s.status) ? c.bold(s.title) : s.status === "pending" ? c.gray(s.title) : s.title;
    const held = HELD.includes(s.status) ? `  ${heldLabel(s)}` : "";
    const extra = s.status === "running" && s.startedAt ? c.gray(` (${fmtDur(Date.now() - Date.parse(s.startedAt))}${s.pct != null ? (lang === "en" ? ` · ${s.pct}%` : ` · %${s.pct}`) : ""})`) : "";
    const stall = stalledFor(s, t);
    const warn = stall ? `  ${c.red(`⚠ ${fmtDur(stall)} ${lang === "en" ? "without progress" : "boyunca ilerleme yok"}`)}` : "";
    const det = s.status === "running" && s.detail ? `\n${fit(`       ${c.gray(s.detail)}`)}` : "";
    return fit(`    ${stall ? c.red("▶") : icon} ${i + 1}. ${label}${extra}${warn}${held}${det}`);
  });
  // A worker killed from outside never reports its end; its pid tells.
  const alive = (w) => !w.pid || pidAlive(w.pid);
  const waiting = t.workers.filter((w) => (w.status === "queued" || w.status === "waiting") && alive(w)).map((w) =>
    fit(`    ${c.magenta("⏳")} ${w.via ?? "auto"}${w.label ? ` · ${w.label}` : ""} ${c.gray(w.status === "queued" ? tr("kuyrukta (sıra {n})", { n: w.queue ?? "?" }) : tr("koşul bekleniyor"))}${w.why ? c.gray(` · ${w.why}`) : ""}`));
  const workers = t.workers.filter((w) => w.status === "running" && alive(w)).map((w) => {
    const stale = w.log && fs.existsSync(w.log) && Date.now() - fs.statSync(w.log).mtimeMs > 10 * 60 * 1000;
    return fit(`    ${stale ? c.yellow("⚠") : c.cyan("⚙")} ${w.via}${w.label ? ` · ${w.label}` : ""} ${c.gray(`${fmtDur(Date.now() - Date.parse(w.startedAt))}${stale ? ` · ${lang === "en" ? "no output for 10 min" : "10 dk'dır çıktı yok"}` : ""}`)}`);
  });
  const last = t.notes.at(-1);
  // a question with options waits on the user; a finished task says what it produced
  const asked = t.ask?.options?.length ? [fit(`    ${c.blue("?")} ${tr("seçenekler")}: ${t.ask.options.map((o, i) => `${c.cyan(`${String.fromCharCode(65 + i)})`)} ${o}`).join(c.gray("  ·  "))}`)] : [];
  const result = t.status !== "running" && t.result?.text ? [fit(`    ${c.green(`${tr("Sonuç")}:`)} ${t.result.text}`), ...(t.result.links ?? []).map((l) => fit(`      ${c.under(l)}`))] : [];
  const tail = result.length ? result : last ? [fit(`    ${c.gray(`↳ ${last.text}`)}`)] : [];
  return [head, line, ...steps, ...asked, ...workers, ...waiting, ...tail].join("\n");
}

// Two lines per task for a short pane: title + bar, then "n/m bitti" and what runs now. Finished
// steps are only counted; the full view lists them when there is room.
function renderCompact(t) {
  const p = percent(t);
  const e = eta(t);
  const done = t.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const running = t.steps.filter((s) => s.status === "running").map((s) => { const st = stalledFor(s, t); return `${st ? c.red("⚠") : c.yellow("▶")} ${s.title}${s.pct != null ? c.gray(lang === "en" ? ` ${s.pct}%` : ` %${s.pct}`) : ""}${st ? c.red(` ${fmtDur(st)} ${lang === "en" ? "without progress" : "boyunca ilerleme yok"}`) : s.detail ? c.gray(` · ${s.detail}`) : ""}`; });
  const failed = t.steps.filter((s) => s.status === "failed").map((s) => `${c.red("✗")} ${s.title}`);
  const held = t.steps.filter((s) => HELD.includes(s.status)).map((s) => `${s.status === "blocked" ? c.magenta("⏸") : c.blue("?")} ${s.title} ${heldLabel(s)}`);
  const state = t.status === "done" ? c.green(tr("bitti")) : t.status === "failed" ? c.red(tr("takıldı")) : t.status === "cancelled" ? c.gray(tr("iptal")) : t.hold || paused(t) ? runningState(t) : "";
  const when = e ? c.gray(` · ${fmtDur(Date.parse(e) - Date.now())} ${lang === "en" ? "left" : "kaldı"}`) : "";
  const head = fit(`${dot(t.status === "done" ? "ok" : t.status === "running" ? (paused(t) ? "bad" : "warn") : "bad")} ${c.bold(t.title)}${t.project ? c.gray(` · ${t.project}`) : ""}  ${bar(p, 10)} ${c.bold(`${p}%`)}${state ? ` ${state}` : ""}${when}`);
  const now = fit([...failed, ...held, ...running].join(c.gray("  ·  ")) || c.gray(t.steps.find((s) => s.status === "pending")?.title ? tr("sırada: {step}", { step: t.steps.find((s) => s.status === "pending").title }) : ""));
  if (t.status !== "running" && t.result?.text) return `${head}\n${fit(`    ${c.green(`${tr("Sonuç")}:`)} ${t.result.text}${t.result.links?.length ? c.gray(`  ${t.result.links[0]}`) : ""}`)}`;
  return `${head}\n${fit(`    ${c.gray(tr("{done}/{total} bitti", { done, total: t.steps.length }))}${now ? `  ${now}` : ""}`)}`;
}

// The last worker runs (`ekip run`), so the pane shows what the lead handed out and where each log
// is even when a worker is not linked to a task: running ones, and finished ones for 15 minutes.
function recentRuns(limit = 4) {
  const dir = path.join(HOME, "runs");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).map((f) => ({ f, st: fs.statSync(path.join(dir, f)) })); } catch { return []; }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  return files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 12).flatMap(({ f, st }) => {
    const file = path.join(dir, f);
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
    const exit = text.match(/\n\[exit (\d+)\][^\n]*\s*$/);
    const pid = Number(text.match(/^pid: (\d+)$/m)?.[1]);
    const running = !exit && (!pid || alive(pid));
    if (!running && Date.now() - st.mtimeMs > 15 * 60 * 1000) return [];
    const label = text.match(/^label: (.*)$/m)?.[1];
    const task = text.split("\ntask:\n")[1]?.split("\n")[0] ?? "";
    const tail = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("[exit")).at(-1) ?? "";
    const via = f.slice(0, -4).split("Z-")[1] ?? "?";
    const state = running ? c.cyan("⚙") : exit[1] === "0" ? c.green("✓") : c.red("✗");
    const head = fit(`  ${state} ${c.bold(via)} ${label && label !== "-" ? label : task.slice(0, 60)} ${c.gray(`· ${fmtDur(Date.now() - (running ? Date.parse(f.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3") + "Z") : st.mtimeMs))}${running ? "" : lang === "en" ? " ago" : " önce"}`)}`);
    return [`${head}\n${fit(`     ${c.gray(running ? tail : `log ${file}`)}`)}`];
  }).slice(0, limit);
}

// One line for the pane header: running/capacity of every ready pool ("havuzlar: codex 2/2 ·
// copilot 1/2 · free 0/3"). Which pools are ready is re-read every 30 s (it spawns `command -v`),
// the running counts on every repaint.
let ready = { at: 0, pools: [] };
async function poolLine() {
  try {
    const a = await import("../workers/agents.js");
    if (Date.now() - ready.at > 30_000) {
      // the pane outlives `ekip mesai on/off` and `ekip agents test`: pick up their settings
      try { const cfg = JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")); for (const k of ["mesai", "mesaiClaude", "poolConcurrency", "agents", "autoOrder"]) SETTINGS[k] = cfg[k]; } catch { /* keep the old ones */ }
      ready = { at: Date.now(), pools: [...a.readyPools(), ...(a.poolCapacity("claude") > 0 ? ["claude"] : []), "free"] };
    }
    const load = a.poolLoad();
    const part = (n) => { const l = load[n] ?? { running: 0, capacity: a.poolCapacity(n) }; const s = `${n} ${l.running}/${l.capacity}`; return l.running >= l.capacity ? c.yellow(s) : l.running ? c.cyan(s) : c.gray(s); };
    return fit(`  ${c.gray(`${tr("havuzlar")}${SETTINGS.mesai ? ` (${tr("mesai")})` : ""}:`)} ${ready.pools.map(part).join(c.gray(" · "))}`);
  } catch { return ""; }
}

// The live pane runs for hours; after ekip is updated it restarts itself, so the terminal never
// shows older logic than the web panel.
const CODE = ["tasks/tasks.js", "tasks/digest.js", "workers/agents.js", "core/ui.js", "core/i18n.js"].map((f) => path.join(path.dirname(new URL(import.meta.url).pathname), "..", f));
const codeStamp = () => CODE.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join();
const startedStamp = codeStamp();
const codeChanged = () => codeStamp() !== startedStamp;
function restartWatch() {
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
    // Watching draws on the alternate screen and repaints in place: clearing with 2J pushed every
    // frame into iTerm's scrollback, so the pane kept scrolling. Output is clipped to the pane height.
    if (watching) {
      process.stdout.write("\x1b[?1049h\x1b[?25l");
      const restore = () => { process.stdout.write("\x1b[?25h\x1b[?1049l"); process.exit(0); };
      process.on("SIGINT", restore); process.on("SIGTERM", restore);
    }
    let reconciled = 0;
    do {
      try { reapDead(); } catch { /* the pane never stops for this */ }
      // ghost runs on the hub (a worker killed with no word) are closed from here too, once a minute
      if (watching && Date.now() - reconciled > 60_000) { reconciled = Date.now(); try { spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "../../bin/ekip.js"), "reconcile"], { stdio: "ignore", detached: true }).unref(); } catch { /* best effort */ } }
      const list = read().filter((t) => all || t.status === "running" || Date.now() - Date.parse(t.endedAt ?? t.updatedAt) < 60 * 1000)
        .sort((a, b) => (a.status === "running") - (b.status === "running") || String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-8).reverse();
      const runs = watching ? recentRuns() : [];
      const runsBlock = runs.length ? `\n${c.gray(lang === "en" ? "workers" : "işçiler")}\n${runs.join("\n")}\n` : "";
      const pools = watching ? await poolLine() : "";
      // the short digest on top: what waits for the user, what is stuck, what runs, what finished
      let digest = "";
      if (watching) try { const dg = await import("./digest.js"); digest = `${dg.paneLines(await dg.collect()).join("\n")}\n`; } catch { /* the pane never stops for this */ }
      let out = `${mark()}  ${c.gray(tr("görevler"))}\n${digest}${pools ? `${pools}\n` : ""}\n${list.length ? list.map(render).join("\n\n") : c.gray(`  ${tr("aktif görev yok")}`)}\n${runsBlock}`;
      // too tall for the pane: every task in two lines, so none is cut off below the edge
      if (watching && out.split("\n").length > (process.stdout.rows || 40) - 1)
        out = `${mark()}  ${c.gray(`${tr("görevler")} · ${list.length}`)}\n${digest}${pools ? `${pools}\n` : ""}${list.map(renderCompact).join("\n")}\n`;
      if (watching) {
        const rows = process.stdout.rows || 40, cols = process.stdout.columns || 120;
        const lines = out.split("\n").slice(0, rows - 1).map((l) => (l.replace(/\x1b\[[0-9;]*m/g, "").length > cols ? `${l.slice(0, cols - 1)}\x1b[0m` : l));
        process.stdout.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
      } else console.log(out);
      if (watching) await sleep(2000);
      if (watching && codeChanged()) await restartWatch();
    } while (watching);
  } else die('usage: ekip tasks [--watch|--all] | ekip task new "title" [--project P] [--steps "a; b"] | step ID N [running|done|failed|skipped] [--pct N] [--note T] [--detail T] [--parallel] [--alive] | add ID "a; b" | note ID text | block ID "reason" [--step N] | wait ID "what the user decides" [--step N] | ask ID "question" [--option A]... | answer ID "choice" | unblock ID | result ID "result" [--link L]... | done ID ["result"] [--link L]... | fail|cancel ID [note]');
}
