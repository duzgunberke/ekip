// Tasks: one per user request. The lead creates it with its steps, marks steps as it goes and links
// workers to it, so the user sees percent done, the current step and an estimated finish time —
// in a live pane next to the lead (`ekip tasks --watch`), with `ekip tasks`, and on the hub panel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HOME, SETTINGS, die, sleep } from "./core.js";
import { c, dot, mark, progress, fit } from "./ui.js";
import { t as tr, lang } from "./i18n.js";

const FILE = path.join(HOME, "tasks.json");
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } };
const write = (all) => { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(all, null, 2)); fs.renameSync(`${FILE}.tmp`, FILE); };
const now = () => new Date().toISOString();
const newId = () => `g${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`;

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
  const part = steps.reduce((sum, s) => sum + (s.status === "done" || s.status === "skipped" ? 1 : s.status === "running" ? (s.pct ?? 50) / 100 : 0), 0);
  return Math.min(99, Math.round((part / steps.length) * 100));
}

/** Estimated finish: elapsed time scaled by what is left, once anything is measurable. */
export function eta(t) {
  const p = percent(t);
  // no guess until there is a real basis: a stalled step or early progress gives absurd numbers
  if (t.status !== "running" || p < 15 || t.steps.some((s) => s.status === "running" && stalledFor(s, t))) return null;
  const p0 = t.p0 ?? 0, since = Date.now() - Date.parse(t.p0At ?? t.createdAt);
  if (p <= p0 || since < 5 * 60_000) return null;
  return new Date(Date.now() + since * (100 - p) / (p - p0)).toISOString();
}

const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? tr("<1 dk") : m < 60 ? tr("{n} dk", { n: m }) : tr("{h} sa {m} dk", { h: Math.floor(m / 60), m: m % 60 }); };
const notify = (title, body) => process.platform === "darwin" && spawnSync("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`], { stdio: "ignore" });

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
    body: JSON.stringify({ ...t, pct: percent(t), eta: eta(t), host: os.hostname() }),
  }).then((r) => markSynced(t.id, r.ok), () => markSynced(t.id, false)).finally(() => pending.delete(pr));
  pending.add(pr);
}

/** Sends the tasks the hub may have missed, plus everything touched in the last two days. */
export async function syncHub() {
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return 0;
  const missed = readUnsynced();
  const list = read().filter((t) => missed.has(t.id) || t.status === "running" || Date.now() - Date.parse(t.updatedAt ?? t.createdAt) < 48 * 3600_000);
  for (const t of list) push(t);
  await Promise.allSettled([...pending]);
  return list.length;
}

export function create({ title, project, steps = [] }) {
  if (!title) die('usage: ekip task new "title" [--project NAME] [--steps "a; b; c"]');
  const t = { id: newId(), title, project: project ?? null, status: "running", createdAt: now(), updatedAt: now(), steps: steps.map((s) => ({ title: s, status: "pending" })), workers: [], notes: [] };
  const all = read();
  all.push(t);
  write(all);
  push(t);
  return t;
}

/** Mark step n (1-based): running [pct] | done | failed | skipped; starting one finishes earlier running ones. */
export function step(id, n, status = "done", { pct, note, detail, parallel = false, alive = false } = {}) {
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
    Object.assign(s, { status, ...(pct != null ? { pct } : {}), ...(status === "running" && !s.startedAt ? { startedAt: now() } : {}), ...(["done", "failed", "skipped"].includes(status) ? { endedAt: now() } : {}) });
    if (note) t.notes.push({ at: now(), text: note });
    if (status === "failed") notify(`ekip · ${t.title}`, `${lang === "en" ? "Step stalled" : "Adım takıldı"}: ${s.title}`);
    autoClose(t);
  });
}

// A task finishes by itself: when every step is done or skipped, or when its last worker ended and
// no step is still running or pending. Nobody has to remember to close it.
function autoClose(t) {
  if (t.status !== "running") return;
  const terminal = t.steps.length && t.steps.every((x) => ["done", "skipped", "failed"].includes(x.status));
  const workersDone = t.workers.length && t.workers.every((w) => w.status !== "running");
  const open = t.steps.some((x) => ["running", "pending"].includes(x.status));
  if (terminal || (workersDone && !open)) {
    const failed = t.steps.some((x) => x.status === "failed");
    Object.assign(t, { status: failed ? "failed" : "done", endedAt: now() });
  }
}

export function addSteps(id, titles) { return update(id, (t) => t.steps.push(...titles.map((s) => ({ title: s, status: "pending" })))); }

export function finish(id, status = "done", note) {
  const t = update(id, (x) => {
    x.status = status;
    x.endedAt = now();
    for (const s of x.steps) if (s.status === "running" || (status === "done" && s.status === "pending")) Object.assign(s, { status: status === "done" ? "done" : s.status === "running" ? "failed" : s.status, endedAt: now() });
    if (note) x.notes.push({ at: now(), text: note });
  });
  notify(`ekip · ${status === "done" ? tr("bitti") : tr("durdu")}`, `${t.title}${note ? ` · ${note}` : ""}`);
  return t;
}

/** Called by `ekip run --task ID`: the worker shows under the task while it runs. */
export function linkWorker(id, w) { try { update(id, (t) => { t.workers.push({ ...w, startedAt: now(), status: "running" }); }); } catch { /* unknown task: ignore */ } }
export function endWorker(id, runId, status, why, model = null, via = null) { try { update(id, (t) => { const w = t.workers.find((x) => x.runId === runId); if (w) Object.assign(w, { status, endedAt: now(), model, ...(via ? { via } : {}) }); t.notes.push({ at: now(), text: `${w?.label ?? runId} (${via ?? w?.via ?? "?"}): ${why ?? (status === "done" ? (lang === "en" ? "finished, the lead is reviewing" : "bitti, lead sonucu inceliyor") : status)}` }); autoClose(t); }); } catch { /* ignore */ } }

// Tasks nobody moved for hours (no live worker, no step update) are orphans: flagged after 2 h,
// closed as failed after 6 h, so the pane and panel never show yesterday's work as running.
export function reapStale() {
  const alive = (w) => { if (!w.pid) return false; try { process.kill(w.pid, 0); return true; } catch { return false; } };
  for (const t of read().filter((x) => x.status === "running")) {
    const idle = Date.now() - Date.parse(t.updatedAt ?? t.createdAt);
    if (idle > 6 * 3600_000 && !t.workers.some((w) => w.status === "running" && alive(w)))
      update(t.id, (x) => { x.notes.push({ at: now(), text: lang === "en" ? "closed: no activity for 6 hours" : "kapatıldı: 6 saattir hareket yok" }); Object.assign(x, { status: "failed", endedAt: now() }); });
  }
}

export function active() { return read().filter((t) => t.status === "running"); }

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
const stalledFor = (s, t) => (s.status === "running" && s.progressAt && Date.now() - Date.parse(s.progressAt) > STALL_MS && !workerActive(t) ? Date.now() - Date.parse(s.progressAt) : 0);

function render(t) {
  const p = percent(t);
  const e = eta(t);
  const elapsed = Date.now() - Date.parse(t.createdAt);
  const state = t.status === "done" ? c.green(tr("bitti")) : t.status === "failed" ? c.red(tr("takıldı")) : t.status === "cancelled" ? c.gray(tr("iptal")) : c.yellow(tr("sürüyor"));
  const head = fit(`${dot(t.status === "done" ? "ok" : t.status === "running" ? "warn" : "bad")} ${c.bold(t.title)}${t.project ? c.gray(` · ${t.project}`) : ""}  ${c.gray(t.id)}`);
  const line = fit(`  ${bar(p)} ${c.bold(`${p}%`)}  ${state}  ${c.gray(tr("geçen {duration}", { duration: fmtDur(elapsed) }))}${e ? c.gray(` · ${tr("tahmini bitiş {time} ({duration} kaldı)", { time: new Date(e).toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), duration: fmtDur(Date.parse(e) - Date.now()) })}`) : ""}`);
  const steps = t.steps.map((s, i) => {
    const icon = s.status === "done" ? c.green("✓") : s.status === "running" ? c.yellow("▶") : s.status === "failed" ? c.red("✗") : s.status === "skipped" ? c.gray("–") : c.gray("○");
    const label = s.status === "running" ? c.bold(s.title) : s.status === "pending" ? c.gray(s.title) : s.title;
    const extra = s.status === "running" && s.startedAt ? c.gray(` (${fmtDur(Date.now() - Date.parse(s.startedAt))}${s.pct != null ? (lang === "en" ? ` · ${s.pct}%` : ` · %${s.pct}`) : ""})`) : "";
    const stall = stalledFor(s, t);
    const warn = stall ? `  ${c.red(`⚠ ${fmtDur(stall)} ${lang === "en" ? "without progress" : "boyunca ilerleme yok"}`)}` : "";
    const det = s.status === "running" && s.detail ? `\n${fit(`       ${c.gray(s.detail)}`)}` : "";
    return fit(`    ${stall ? c.red("▶") : icon} ${i + 1}. ${label}${extra}${warn}${det}`);
  });
  // A worker killed from outside never reports its end; its pid tells.
  const alive = (w) => { if (!w.pid) return true; try { process.kill(w.pid, 0); return true; } catch { return false; } };
  const workers = t.workers.filter((w) => w.status === "running" && alive(w)).map((w) => {
    const stale = w.log && fs.existsSync(w.log) && Date.now() - fs.statSync(w.log).mtimeMs > 10 * 60 * 1000;
    return fit(`    ${stale ? c.yellow("⚠") : c.cyan("⚙")} ${w.via}${w.label ? ` · ${w.label}` : ""} ${c.gray(`${fmtDur(Date.now() - Date.parse(w.startedAt))}${stale ? ` · ${lang === "en" ? "no output for 10 min" : "10 dk'dır çıktı yok"}` : ""}`)}`);
  });
  const last = t.notes.at(-1);
  return [head, line, ...steps, ...workers, ...(last ? [fit(`    ${c.gray(`↳ ${last.text}`)}`)] : [])].join("\n");
}

// Two lines per task for a short pane: title + bar, then "n/m bitti" and what runs now. Finished
// steps are only counted; the full view lists them when there is room.
function renderCompact(t) {
  const p = percent(t);
  const e = eta(t);
  const done = t.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const running = t.steps.filter((s) => s.status === "running").map((s) => { const st = stalledFor(s, t); return `${st ? c.red("⚠") : c.yellow("▶")} ${s.title}${s.pct != null ? c.gray(lang === "en" ? ` ${s.pct}%` : ` %${s.pct}`) : ""}${st ? c.red(` ${fmtDur(st)} ${lang === "en" ? "without progress" : "boyunca ilerleme yok"}`) : s.detail ? c.gray(` · ${s.detail}`) : ""}`; });
  const failed = t.steps.filter((s) => s.status === "failed").map((s) => `${c.red("✗")} ${s.title}`);
  const state = t.status === "done" ? c.green(tr("bitti")) : t.status === "failed" ? c.red(tr("takıldı")) : t.status === "cancelled" ? c.gray(tr("iptal")) : "";
  const when = e ? c.gray(` · ${fmtDur(Date.parse(e) - Date.now())} ${lang === "en" ? "left" : "kaldı"}`) : "";
  const head = fit(`${dot(t.status === "done" ? "ok" : t.status === "running" ? "warn" : "bad")} ${c.bold(t.title)}${t.project ? c.gray(` · ${t.project}`) : ""}  ${bar(p, 10)} ${c.bold(`${p}%`)}${state ? ` ${state}` : ""}${when}`);
  const now = fit([...failed, ...running].join(c.gray("  ·  ")) || c.gray(t.steps.find((s) => s.status === "pending")?.title ? tr("sırada: {step}", { step: t.steps.find((s) => s.status === "pending").title }) : ""));
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

// The live pane runs for hours; after ekip is updated it restarts itself, so the terminal never
// shows older logic than the web panel.
const CODE = ["tasks.js", "ui.js", "i18n.js"].map((f) => path.join(path.dirname(new URL(import.meta.url).pathname), f));
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
  } else if (sub === "done" || sub === "fail" || sub === "cancel") {
    const [id, ...text] = rest();
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
    do {
      const list = read().filter((t) => all || t.status === "running" || Date.now() - Date.parse(t.endedAt ?? t.updatedAt) < 60 * 1000)
        .sort((a, b) => (a.status === "running") - (b.status === "running") || String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-8).reverse();
      const runs = watching ? recentRuns() : [];
      const runsBlock = runs.length ? `\n${c.gray(lang === "en" ? "workers" : "işçiler")}\n${runs.join("\n")}\n` : "";
      let out = `${mark()}  ${c.gray(tr("görevler"))}\n\n${list.length ? list.map(render).join("\n\n") : c.gray(`  ${tr("aktif görev yok")}`)}\n${runsBlock}`;
      // too tall for the pane: every task in two lines, so none is cut off below the edge
      if (watching && out.split("\n").length > (process.stdout.rows || 40) - 1)
        out = `${mark()}  ${c.gray(`${tr("görevler")} · ${list.length}`)}\n${list.map(renderCompact).join("\n")}\n`;
      if (watching) {
        const rows = process.stdout.rows || 40, cols = process.stdout.columns || 120;
        const lines = out.split("\n").slice(0, rows - 1).map((l) => (l.replace(/\x1b\[[0-9;]*m/g, "").length > cols ? `${l.slice(0, cols - 1)}\x1b[0m` : l));
        process.stdout.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
      } else console.log(out);
      if (watching) await sleep(2000);
      if (watching && codeChanged()) await restartWatch();
    } while (watching);
  } else die('usage: ekip tasks [--watch|--all] | ekip task new "title" [--project P] [--steps "a; b"] | step ID N [running|done|failed|skipped] [--pct N] [--note T] [--detail T] [--parallel] [--alive] | add ID "a; b" | note ID text | done|fail|cancel ID [note]');
}
