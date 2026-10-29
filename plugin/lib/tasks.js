// Tasks: one per user request. The lead creates it with its steps, marks steps as it goes and links
// workers to it, so the user sees percent done, the current step and an estimated finish time —
// in a live pane next to the lead (`ekip tasks --watch`), with `ekip tasks`, and on the hub panel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  if (t.status !== "running" || p < 5) return null;
  const elapsed = Date.now() - Date.parse(t.createdAt);
  return new Date(Date.now() + elapsed * (100 - p) / p).toISOString();
}

const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? tr("<1 dk") : m < 60 ? tr("{n} dk", { n: m }) : tr("{h} sa {m} dk", { h: Math.floor(m / 60), m: m % 60 }); };
const notify = (title, body) => process.platform === "darwin" && spawnSync("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`], { stdio: "ignore" });

// Pushes in flight; ekip.js waits for them before it exits, or the update would be cut off.
export const pending = new Set();

function push(t) {
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return;
  const pr = fetch(`${SETTINGS.hubUrl}/api/tasks`, {
    method: "PUT", signal: AbortSignal.timeout(4000),
    headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` },
    body: JSON.stringify({ ...t, pct: percent(t), eta: eta(t), host: os.hostname() }),
  }).catch(() => {}).finally(() => pending.delete(pr));
  pending.add(pr);
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
export function step(id, n, status = "done", { pct, note, detail, parallel = false } = {}) {
  return update(id, (t) => {
    const s = t.steps[n - 1] ?? die(`task ${id} has no step ${n}`);
    if (status === "running" && !parallel) for (const o of t.steps) if (o !== s && o.status === "running") Object.assign(o, { status: "done", endedAt: now() });
    // progressAt: when the step last moved; a running step that stops moving is shown as stalled
    if ((pct != null && pct !== s.pct) || (status === "running" && s.status !== "running")) s.progressAt = now();
    if (detail != null) s.detail = detail;
    Object.assign(s, { status, ...(pct != null ? { pct } : {}), ...(status === "running" && !s.startedAt ? { startedAt: now() } : {}), ...(["done", "failed", "skipped"].includes(status) ? { endedAt: now() } : {}) });
    if (note) t.notes.push({ at: now(), text: note });
    if (status === "failed") notify(`ekip · ${t.title}`, `${lang === "en" ? "Step stalled" : "Adım takıldı"}: ${s.title}`);
  });
}

export function addSteps(id, titles) { return update(id, (t) => t.steps.push(...titles.map((s) => ({ title: s, status: "pending" })))); }

export function finish(id, status = "done", note) {
  const t = update(id, (x) => {
    x.status = status;
    x.endedAt = now();
    for (const s of x.steps) if (s.status === "running" || (status === "done" && s.status === "pending")) Object.assign(s, { status: status === "done" ? "done" : s.status, endedAt: now() });
    if (note) x.notes.push({ at: now(), text: note });
  });
  notify(`ekip · ${status === "done" ? tr("bitti") : tr("durdu")}`, `${t.title}${note ? ` — ${note}` : ""}`);
  return t;
}

/** Called by `ekip run --task ID`: the worker shows under the task while it runs. */
export function linkWorker(id, w) { try { update(id, (t) => { t.workers.push({ ...w, startedAt: now(), status: "running" }); }); } catch { /* unknown task: ignore */ } }
export function endWorker(id, runId, status) { try { update(id, (t) => { const w = t.workers.find((x) => x.runId === runId); if (w) Object.assign(w, { status, endedAt: now() }); }); } catch { /* ignore */ } }

export function active() { return read().filter((t) => t.status === "running"); }

// ---- rendering ---------------------------------------------------------------------------------

function bar(p, cells = 20) { return progress(p, cells); }

// a running step whose pct/detail has not moved for 15 min is stalled, whatever its label says
const STALL_MS = 15 * 60 * 1000;
const stalledFor = (s) => (s.status === "running" && s.progressAt && Date.now() - Date.parse(s.progressAt) > STALL_MS ? Date.now() - Date.parse(s.progressAt) : 0);

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
    const stall = stalledFor(s);
    const warn = stall ? `  ${c.red(`⚠ ${fmtDur(stall)} ${lang === "en" ? "without progress" : "dır ilerleme yok"}`)}` : "";
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
  const running = t.steps.filter((s) => s.status === "running").map((s) => { const st = stalledFor(s); return `${st ? c.red("⚠") : c.yellow("▶")} ${s.title}${s.pct != null ? c.gray(lang === "en" ? ` ${s.pct}%` : ` %${s.pct}`) : ""}${st ? c.red(` ${fmtDur(st)} ${lang === "en" ? "without progress" : "dır ilerleme yok"}`) : s.detail ? c.gray(` · ${s.detail}`) : ""}`; });
  const failed = t.steps.filter((s) => s.status === "failed").map((s) => `${c.red("✗")} ${s.title}`);
  const state = t.status === "done" ? c.green(tr("bitti")) : t.status === "failed" ? c.red(tr("takıldı")) : t.status === "cancelled" ? c.gray(tr("iptal")) : "";
  const when = e ? c.gray(` · ${fmtDur(Date.parse(e) - Date.now())} ${lang === "en" ? "left" : "kaldı"}`) : "";
  const head = fit(`${dot(t.status === "done" ? "ok" : t.status === "running" ? "warn" : "bad")} ${c.bold(t.title)}${t.project ? c.gray(` · ${t.project}`) : ""}  ${bar(p, 10)} ${c.bold(`${p}%`)}${state ? ` ${state}` : ""}${when}`);
  const now = fit([...failed, ...running].join(c.gray("  ·  ")) || c.gray(t.steps.find((s) => s.status === "pending")?.title ? tr("sırada: {step}", { step: t.steps.find((s) => s.status === "pending").title }) : ""));
  return `${head}\n${fit(`    ${c.gray(tr("{done}/{total} bitti", { done, total: t.steps.length }))}${now ? `  ${now}` : ""}`)}`;
}

export async function main([sub = "ls", ...args]) {
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const rest = () => args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (sub === "new") {
    const t = create({ title: rest()[0], project: opt("--project"), steps: (opt("--steps") ?? "").split(";").map((s) => s.trim()).filter(Boolean) });
    console.log(t.id);
  } else if (sub === "step") {
    const [id, n, status = "done"] = rest();
    step(id, Number(n), status, { pct: opt("--pct") != null ? Number(opt("--pct")) : undefined, note: opt("--note"), detail: opt("--detail"), parallel: args.includes("--parallel") });
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
      const list = read().filter((t) => all || t.status === "running" || Date.now() - Date.parse(t.endedAt ?? t.updatedAt) < 5 * 60 * 1000)
        .sort((a, b) => (a.status === "running") - (b.status === "running") || String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-8).reverse();
      let out = `${mark()}  ${c.gray(tr("görevler"))}\n\n${list.length ? list.map(render).join("\n\n") : c.gray(`  ${tr("aktif görev yok")}`)}\n`;
      // too tall for the pane: every task in two lines, so none is cut off below the edge
      if (watching && out.split("\n").length > (process.stdout.rows || 40) - 1)
        out = `${mark()}  ${c.gray(`${tr("görevler")} · ${list.length}`)}\n${list.map(renderCompact).join("\n")}\n`;
      if (watching) {
        const rows = process.stdout.rows || 40, cols = process.stdout.columns || 120;
        const lines = out.split("\n").slice(0, rows - 1).map((l) => (l.replace(/\x1b\[[0-9;]*m/g, "").length > cols ? `${l.slice(0, cols - 1)}\x1b[0m` : l));
        process.stdout.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
      } else console.log(out);
      if (watching) await sleep(2000);
    } while (watching);
  } else die('usage: ekip tasks [--watch|--all] | ekip task new "title" [--project P] [--steps "a; b"] | step ID N [running|done|failed|skipped] [--pct N] [--note T] [--detail T] [--parallel] | add ID "a; b" | note ID text | done|fail|cancel ID [note]');
}
