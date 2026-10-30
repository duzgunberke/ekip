// Tracked jobs (`ekip track`): a long shell command (an upload, an encode, a queue script) runs as a
// watched job tied to a task step instead of a bare background shell. A detached monitor owns the
// command: it writes the output to a log under data/runs (so the pane lists it like a worker),
// measures progress every 30 s (percent or byte patterns in the output, or a --measure command
// against --total), keeps the step's percent, speed and finish estimate true, blocks the step when
// nothing moves for --stall minutes, warns when the first minutes' speed puts the finish past
// --eta-max, and closes the step done or failed when the command ends. A step can no longer say
// "running" for hours after its command died.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, RUNS, SETTINGS, die, notify, openPane, sleep } from "../core/core.js";
import { c, fit } from "../core/ui.js";
import { t, lang } from "../core/i18n.js";
import { killCause } from "./slots.js";

const DIR = path.join(HOME, "tracks");
// the measuring interval and the speed probe window; tests shorten both
const TICK_MS = Number(process.env.EKIP_TRACK_TICK_S ?? 30) * 1000;
const PROBE_MS = Number(process.env.EKIP_TRACK_PROBE_S ?? 120) * 1000;
const EKIP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../bin/ekip.js");

const now = () => new Date().toISOString();
const file = (id) => path.join(DIR, `${id}.json`);
const load = (id) => { try { return JSON.parse(fs.readFileSync(file(id), "utf8")); } catch { return null; } };
const save = (st) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(`${file(st.id)}.tmp`, JSON.stringify(st, null, 2)); fs.renameSync(`${file(st.id)}.tmp`, file(st.id)); };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---- measuring ---------------------------------------------------------------------------------

/** "1.5G", "1.5 GiB", "1500MB", "120": bytes or a plain count. iB and a bare letter are 1024-based (du -h, aws). */
export function parseSize(s) {
  const m = String(s ?? "").trim().match(/^(\d+(?:[.,]\d+)?)\s*(?:([kmgtp])(i)?(b|bytes?)?|(b|bytes?))?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!m[2]) return n;
  const pow = "kmgtp".indexOf(m[2].toLowerCase()) + 1;
  return n * (m[3] || !m[4] ? 1024 : 1000) ** pow;
}

const BYTES = String.raw`(\d+(?:\.\d+)?)\s*([KMGTP]i?B|[KMGTP]|B|bytes)`;
/**
 * Progress in one line of output: a byte pair ("256.0 MiB/1.5 GiB", aws s3), a count ("3/12",
 * "[ 45/120]"), a percent ("12%", "45.5 %"), or bytes done alone ("size= 1024kB", ffmpeg). Rates
 * ("4.2 MiB/s") are not progress. Returns { done, total, unit } or null.
 */
export function parseProgress(line) {
  const pair = line.match(new RegExp(`${BYTES}\\s*/\\s*${BYTES}(?!\\s*/\\s*s)`, "i"));
  if (pair) { const done = parseSize(`${pair[1]}${pair[2]}`), total = parseSize(`${pair[3]}${pair[4]}`); if (done != null && total > 0 && done <= total) return { done, total, unit: "B" }; }
  const count = [...line.matchAll(/(?:^|[\s[(#:])(\d+)\s*\/\s*(\d+)(?=$|[\s\]),:;.])/g)].map((m) => [Number(m[1]), Number(m[2])]).filter(([n, m]) => m > 0 && n <= m).at(-1);
  if (count) return { done: count[0], total: count[1], unit: "n" };
  const pct = [...line.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s?%/g)].map((m) => Number(m[1].replace(",", "."))).filter((x) => x <= 100).at(-1);
  if (pct != null) return { done: pct, total: 100, unit: "%" };
  const bytes = [...line.matchAll(new RegExp(`${BYTES}(?!\\s*/\\s*s|\\w)`, "gi"))].filter((m) => /[a-z]/i.test(m[2])).at(-1);
  if (bytes) return { done: parseSize(`${bytes[1]}${bytes[2]}`), total: null, unit: "B" };
  return null;
}

// The first number a --measure command prints (a size with a unit counts as bytes: "1.2G", "345 MB").
function measure(cmd, cwd) {
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", timeout: 20_000 });
  const m = String(r.stdout ?? "").match(/(\d+(?:[.,]\d+)?)\s*([KMGTP]i?B?|bytes?\b|B\b)?/i);
  if (!m) return null;
  return m[2] ? { done: parseSize(`${m[1]}${m[2]}`), unit: "B" } : { done: Number(m[1].replace(",", ".")), unit: "n" };
}

const fmtBytes = (n) => { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`; };
const fmtQty = (n, unit) => (unit === "B" ? fmtBytes(n) : unit === "%" ? (lang === "en" ? `${Math.round(n)}%` : `%${Math.round(n)}`) : String(Math.round(n)));
const fmtRate = (r, unit) => (unit === "B" ? `${fmtBytes(r)}/s` : unit === "%" ? t("%{n}/dk", { n: (r * 60).toFixed(r * 60 >= 10 ? 0 : 1) }) : t("{n}/dk", { n: (r * 60).toFixed(r * 60 >= 10 ? 0 : 1) }));
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? t("<1 dk") : m < 60 ? t("{n} dk", { n: m }) : t("{h} sa {m} dk", { h: Math.floor(m / 60), m: m % 60 }); };
const clock = (iso) => new Date(iso).toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// ---- the monitor (a detached process per tracked job) -------------------------------------------

async function monitor(id) {
  const st = load(id) ?? die(`no tracked job ${id}`);
  const tasks = st.taskId ? await import("../tasks/tasks.js") : null;
  const open = () => !tasks || tasks.active().some((x) => x.id === st.taskId);
  Object.assign(st, { pid: process.pid, status: "running", startedAt: now() });
  fs.writeFileSync(st.log, `cwd: ${st.cwd}\nproject: -\nlabel: ${st.label}\ntaskId: ${st.taskId ?? "-"}\npid: ${process.pid}\ntask:\n${st.cmd}\n\n$ ${st.cmd}\n`);
  const log = fs.createWriteStream(st.log, { flags: "a" });
  // its own process group: `ekip track stop` and a cancelled task stop the command and everything it started
  const child = spawn("/bin/sh", ["-c", st.cmd], { cwd: st.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, EKIP_TRACK_ID: id } });
  st.childPid = child.pid;
  save(st);
  if (tasks) {
    tasks.linkWorker(st.taskId, { runId: id, via: "track", label: st.label, log: st.log, pid: process.pid });
    if (st.step) tasks.step(st.taskId, st.step, "running", { parallel: true, detail: clip(`$ ${st.cmd}`, 300) });
  }

  // Output: whole lines go to the log; progress bars that redraw with \r are parsed every time but
  // written at most every 5 s, so an upload of hours does not leave a log of gigabytes.
  const last = [];
  let buf = "", cr = "", crWritten = 0, grew = false, parsed = null;
  const line = (l, write) => {
    const s = l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
    if (!s) return;
    const p = parseProgress(s);
    if (p) parsed = p;
    if (write) { log.write(`${s}\n`); last.push(s); if (last.length > 5) last.shift(); }
  };
  const onData = (d) => {
    grew = true;
    buf += d;
    let i;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const seg = buf.slice(0, i), sep = buf[i];
      buf = buf.slice(i + 1);
      if (sep === "\r" && buf[0] === "\n") continue; // \r\n: the \n ends the same line
      if (sep === "\n") { line(seg || cr, true); cr = ""; continue; }
      cr = seg;
      if (Date.now() - crWritten > 5000) { crWritten = Date.now(); line(seg, true); } else line(seg, false);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const total0 = st.total != null ? parseSize(st.total) : null;
  const stallMs = Number(st.stall ?? 10) * 60_000;
  const samples = [];
  let lastV = null, lastProgressAt = Date.now(), blocked = false, probed = false, unit = null;
  const tick = () => {
    let m = null;
    if (st.measure) { const r = measure(st.measure, st.cwd); if (r?.done != null) m = { done: r.done, total: total0, unit: r.unit }; }
    else if (parsed) m = { ...parsed, total: total0 && parsed.unit !== "%" ? total0 : parsed.total ?? total0 };
    const at = Date.now();
    // progress: the measured amount went up; with nothing to measure (yet), new output counts
    const progressed = m ? lastV == null || m.done > lastV : grew;
    grew = false;
    if (progressed) lastProgressAt = at;
    let pct = null, rate = null, etaAt = null;
    if (m) {
      unit = m.unit;
      lastV = m.done;
      samples.push({ at, v: m.done });
      while (samples.length > 2 && at - samples[1].at > 5 * 60_000) samples.shift();
      const s0 = samples[0], dt = (at - s0.at) / 1000;
      if (dt > 0 && m.done > s0.v) rate = (m.done - s0.v) / dt;
      if (m.total > 0) {
        pct = Math.max(0, Math.min(100, Math.round((m.done / m.total) * 100)));
        if (rate) etaAt = new Date(at + ((m.total - m.done) / rate) * 1000).toISOString();
      }
    }
    const lastLine = cr || last.at(-1) || "";
    const parts = [
      m ? (m.total > 0 && unit !== "%" ? `${fmtQty(m.done, unit)} / ${fmtQty(m.total, unit)}` : fmtQty(m.done, unit)) : t("ilerleme ölçülmüyor; yalnız canlılık"),
      rate ? fmtRate(rate, unit) : null,
      etaAt ? t("bitiş ~{time}", { time: clock(etaAt) }) : null,
      !m && lastLine ? clip(lastLine, 120) : null,
    ].filter(Boolean);
    const detail = clip(parts.join(" · "), 300);
    Object.assign(st, { pct, rate: rate ? fmtRate(rate, unit) : null, etaAt, lastLine: clip(lastLine, 300), detail, progressAt: new Date(lastProgressAt).toISOString() });
    save(st);
    const live = tasks && st.step && open();

    // Speed probe: the finish the first minutes' speed points to, against --eta-max; said at once
    // instead of discovered hours later.
    if (!probed && st.etaMax && at - Date.parse(st.startedAt) >= PROBE_MS) {
      probed = true;
      const total = etaAt ? Date.parse(etaAt) - Date.parse(st.startedAt) : null;
      const text = total == null
        ? t("{label}: ilk {n} dakikada hız ölçülemedi; --eta-max ({max} dk) denetlenemiyor (--total ya da --measure verin)", { label: st.label, n: Math.round(PROBE_MS / 60000), max: st.etaMax })
        : total > st.etaMax * 60_000 ? t("{label}: beklenenden yavaş: hız {rate}, tahmini bitiş {time} ({dur} sürer; sınır {max} dk)", { label: st.label, rate: st.rate ?? "?", time: clock(etaAt), dur: fmtDur(total), max: st.etaMax }) : null;
      if (text) {
        st.slow = text; save(st);
        log.write(`[ekip] ${text}\n`);
        if (tasks) tasks.note(st.taskId, text);
        notify(st.label, text, { subtitle: `⚠ ${t("Beklenenden yavaş")}`, group: st.taskId ?? id });
      }
    }

    if (blocked && progressed) {
      blocked = false;
      if (live) tasks.step(st.taskId, st.step, "running", { pct: pct ?? undefined, detail, parallel: true, alive: true, rate: st.rate, etaAt, note: t("{label}: ilerleme yeniden başladı", { label: st.label }) });
    } else if (!blocked && at - lastProgressAt >= stallMs) {
      blocked = true;
      const reason = t("{n} dk ilerleme yok (son: {line})", { n: Math.round((at - lastProgressAt) / 60000), line: clip(lastLine || t("çıktı yok"), 160) });
      log.write(`[ekip] ${reason}\n`);
      if (live) tasks.hold(st.taskId, "blocked", `${st.label}: ${reason}`, st.step, { alert: true });
      else notify(st.label, reason, { subtitle: `⏸ ${t("İlerleme yok")}`, group: id });
    } else if (!blocked && live) tasks.step(st.taskId, st.step, "running", { pct: pct ?? undefined, detail, parallel: true, alive: progressed, rate: st.rate, etaAt });
  };
  const timer = setInterval(() => { try { tick(); } catch (e) { log.write(`[ekip] ${e.message}\n`); } }, TICK_MS);

  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => {
    stopping = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 10_000).unref();
  });

  const [code0, sig] = await new Promise((resolve) => child.on("close", (code, s) => resolve([code, s])));
  clearInterval(timer);
  if (cr) line(cr, true);
  if (buf) line(buf, true);
  const fresh = load(id) ?? st;
  const code = code0 ?? (sig ? 128 + (os.constants.signals[sig] ?? 15) : 1);
  const reason = sig || code > 128
    ? (stopping || fresh.stopRequested ? t("durduruldu ({how})", { how: fresh.stopRequested ? "ekip track stop" : t("ekip sinyali") })
      : t("{sig} sinyaliyle öldü; olası neden: {cause}", { sig: sig ?? `${code - 128}`, cause: killCause(code) }))
    : "";
  await new Promise((r) => log.end(`\n[exit ${code}]${reason ? ` ${reason}` : ""}\n`, r));
  const tail = last.slice(-5);
  Object.assign(st, fresh, { status: code === 0 ? "done" : "failed", exitCode: code, reason: reason || null, endedAt: now(), etaAt: null, lastLine: clip(tail.at(-1) ?? "", 300) });
  if (code === 0 && st.pct != null) st.pct = 100;
  save(st);
  if (tasks) {
    const summary = code === 0 ? t("bitti, çıkış 0{last}", { last: tail.length ? ` · ${clip(tail.at(-1), 200)}` : "" }) : `${t("çıkış {code}", { code })}${reason ? ` · ${reason}` : ""}`;
    tasks.endWorker(st.taskId, id, code === 0 ? "done" : sig ? "killed" : "failed", summary, null, "track");
    if (st.step && open()) {
      if (code === 0) tasks.step(st.taskId, st.step, "done", { pct: 100, parallel: true });
      else tasks.step(st.taskId, st.step, "failed", { parallel: true, note: `${st.label}: ${t("son satırlar")}:\n${tail.map((l) => `  ${clip(l, 200)}`).join("\n") || `  (${t("çıktı yok")})`}` });
    }
    const { pending } = tasks;
    await Promise.race([Promise.allSettled([...pending]), sleep(5000)]);
  } else if (code !== 0) notify(st.label, `${t("çıkış {code}", { code })}${reason ? ` · ${reason}` : ""}${tail.length ? `\n${clip(tail.at(-1), 160)}` : ""}`, { subtitle: `✗ ${t("İzlenen iş başarısız")}`, group: id });
  process.exit(0);
}

// ---- the CLI -------------------------------------------------------------------------------------

const USAGE = 'kullanım: ekip track [--task ID] [--step N] --label "ne" [--total BYTES|N] [--measure "komut"] [--stall DK] [--eta-max DK] [--cwd DIR] [--show] [--wait] -- <komut...>  |  ekip track ls [--all]  |  ekip track stop ID';
// a single argument is a shell line ("aws s3 cp a b && echo ok"); several are quoted word by word
const shellQuote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

function all() {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => load(f.slice(0, -5))).filter(Boolean).sort((a, b) => String(a.id).localeCompare(String(b.id))); } catch { return []; }
}
/** Tracked jobs whose monitor is alive (the reaper and the hook count these as live work). */
export const running = () => all().filter((x) => !x.endedAt && alive(x.pid));
function find(ref) {
  const list = all();
  const hits = list.filter((x) => x.id === ref || x.id.includes(ref));
  if (hits.length === 1) return hits[0];
  die(hits.length ? t("\"{ref}\" birden fazla izlenen işe uyuyor: {ids}", { ref, ids: hits.map((x) => x.id).join(", ") }) : t("izlenen iş yok: {ref} (ekip track ls)", { ref }));
}

async function start(args) {
  const o = { cwd: process.cwd() };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (!a.startsWith("--")) break;
    const v = () => args[++i] ?? die(USAGE);
    if (a === "--task") o.taskId = v();
    else if (a === "--step") o.step = Number(v());
    else if (a === "--label") o.label = v();
    else if (a === "--total") { o.total = v(); if (parseSize(o.total) == null) die(t("--total sayı ya da boyut alır (ör. 1.5G, 120): {v}", { v: o.total })); }
    else if (a === "--measure") o.measure = v();
    else if (a === "--stall") o.stall = Number(v());
    else if (a === "--eta-max") o.etaMax = Number(v());
    else if (a === "--cwd") o.cwd = path.resolve(v());
    else if (a === "--show") o.show = true;
    else if (a === "--wait") o.wait = true;
    else die(`${t("bilinmeyen seçenek {a}", { a })}\n${t(USAGE)}`);
  }
  const words = args.slice(i);
  if (!words.length) die(USAGE);
  o.cmd = words.length === 1 ? words[0] : words.map(shellQuote).join(" ");
  o.label ??= clip(o.cmd, 60);
  if (!(o.stall > 0)) o.stall = 10;
  if (!fs.existsSync(o.cwd)) die(t("böyle bir klasör yok: {dir}", { dir: o.cwd }));
  if (o.taskId) {
    const tasks = await import("../tasks/tasks.js");
    const task = tasks.active().find((x) => x.id === o.taskId) ?? die(t("açık görev yok: {id} (ekip tasks)", { id: o.taskId }));
    // the step: --step, else the running one, else the next pending one, else a new step named after the label
    if (o.step) { if (!task.steps[o.step - 1]) die(t("{id} görevinde {n}. adım yok", { id: o.taskId, n: o.step })); }
    else {
      const i2 = task.steps.findIndex((s) => s.status === "running"), j = task.steps.findIndex((s) => s.status === "pending");
      if (i2 >= 0 || j >= 0) o.step = (i2 >= 0 ? i2 : j) + 1;
      else { tasks.addSteps(o.taskId, [o.label]); o.step = task.steps.length + 1; }
    }
  }
  const id = `${now().replace(/[:.]/g, "-")}-track`;
  const st = { id, label: o.label, cmd: o.cmd, cwd: o.cwd, taskId: o.taskId ?? null, step: o.step ?? null, total: o.total ?? null, measure: o.measure ?? null, stall: o.stall, etaMax: o.etaMax ?? null, log: path.join(RUNS, `${id}.log`), createdAt: now() };
  save(st);
  const out = fs.openSync(path.join(DIR, `${id}.monitor.log`), "a");
  const mon = spawn(process.execPath, [EKIP, "track", "--monitor", id], { detached: true, stdio: ["ignore", out, out], cwd: o.cwd });
  mon.unref();
  console.log(id);
  console.error(`${c.cyan("◆", process.stderr)} ${t("izleniyor")}: ${o.label} ${c.gray(`· pid ${mon.pid} · log ${st.log}${o.taskId ? ` · ${o.taskId}/${o.step}` : ""}`, process.stderr)}`);
  if (o.show && process.platform === "darwin") openPane(`tail -n 40 -F ${JSON.stringify(st.log)}`, { title: `ekip · ${o.label}` });
  if (!o.wait) return 0;
  // --wait: stays until the command ends and exits with its code (for a Bash background call
  // that should wake the lead when the job is over)
  for (;;) {
    await sleep(2000);
    const s = load(id);
    if (s?.endedAt) { console.log(`${s.status === "done" ? "✓" : "✗"} ${s.label}: ${t("çıkış {code}", { code: s.exitCode })}${s.reason ? ` · ${s.reason}` : ""}${s.lastLine ? `\n${s.lastLine}` : ""}`); return s.exitCode ?? 1; }
    if (!alive(mon.pid) && !alive(s?.pid)) { console.error(t("izleyici süreç kayboldu")); return 1; }
  }
}

function ls(showAll) {
  const list = all().filter((x) => showAll || !x.endedAt || Date.now() - Date.parse(x.endedAt) < 24 * 3600_000);
  if (!list.length) { console.log(c.gray(t("izlenen iş yok"))); return; }
  for (const x of list.reverse()) {
    const lost = !x.endedAt && !alive(x.pid);
    const state = x.endedAt ? (x.status === "done" ? c.green(t("bitti")) : c.red(`${t("başarısız")} (${x.exitCode})`)) : lost ? c.red(t("kayıp: izleyici yok")) : c.yellow(t("sürüyor"));
    const took = fmtDur((x.endedAt ? Date.parse(x.endedAt) : Date.now()) - Date.parse(x.startedAt ?? x.createdAt));
    console.log(fit(`${state}  ${c.bold(x.label)}  ${c.gray(`${x.id} · ${took}${x.taskId ? ` · ${x.taskId}/${x.step}` : ""}`)}`));
    const info = x.endedAt ? [x.reason, x.lastLine].filter(Boolean).join(" · ") : x.detail;
    if (info) console.log(fit(`   ${c.gray(info)}`));
    console.log(fit(`   ${c.gray(`log ${x.log}`)}`));
  }
}

function stop(ref) {
  if (!ref) die(t("kullanım: ekip track stop ID  (ekip track ls)"));
  const x = find(ref);
  if (x.endedAt) { console.log(t("zaten bitmiş: {id}", { id: x.id })); return; }
  save({ ...x, stopRequested: true });
  // only this job's own processes: its monitor (which stops the command's process group), or the
  // command's group itself when the monitor is already gone
  if (alive(x.pid)) process.kill(x.pid, "SIGTERM");
  else if (alive(x.childPid)) { try { process.kill(-x.childPid, "SIGTERM"); } catch { process.kill(x.childPid, "SIGTERM"); } }
  else { console.log(t("süreç zaten yok: {id}", { id: x.id })); return; }
  console.log(t("durduruluyor: {label}", { label: x.label }));
}

export async function main(args = []) {
  if (args[0] === "--monitor") { await monitor(args[1]); return 0; }
  if (!args.length || args[0] === "--help" || args[0] === "-h" || args[0] === "help") { console.log(t(USAGE)); return 0; }
  if (args[0] === "ls") { ls(args.includes("--all")); return 0; }
  if (args[0] === "stop") { stop(args[1]); return 0; }
  return start(args);
}
