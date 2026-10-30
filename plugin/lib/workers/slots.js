// Machine slots: how many heavy workers (local renders, encodes, big builds) run on this Mac at
// once. Seven heavy workers plus a render drove the load to 120 and four workers died in the same
// second; a heavy `ekip run` now takes a slot first and waits in line when none is free, or while
// the load average is far above the core count. Light runs (a CLI talking to a remote model) do
// not wait. Slots are files with the holder's pid, so a killed holder frees its slot by itself.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, SETTINGS, sleep } from "../core/core.js";
import { t } from "../core/i18n.js";

const DIR = () => path.join(HOME, "slots");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const cores = () => os.availableParallelism?.() ?? os.cpus().length;

/** Heavy slots on this machine: settings.maxLocalWorkers, else from cores and memory (8 cores / 16 GB → 3). */
export function maxHeavy() {
  const own = Number(SETTINGS.maxLocalWorkers);
  if (own > 0) return own;
  return Math.max(1, Math.min(Math.floor(cores() / 2.5), Math.floor(os.totalmem() / 2 ** 30 / 5)));
}

/** The load is too high for another heavy job: the 1-minute average above 3x the cores. */
export const overloaded = () => os.loadavg()[0] > cores() * Number(SETTINGS.maxLoadPerCore ?? 3);

// Renders and encodes run on this machine whatever pool writes the code: those briefs are heavy
// unless --light says otherwise.
const HEAVY_RE = /\b(render|ffmpeg|blender|remotion|hyperframes|transcod|encode|upscal|video export)/i;
export const looksHeavy = (task) => HEAVY_RE.test(String(task ?? "").slice(0, 4000));

// Entries in a slot or queue directory, oldest first, with dead holders removed.
function live(sub) {
  const dir = path.join(DIR(), sub);
  fs.mkdirSync(dir, { recursive: true });
  return fs.readdirSync(dir).sort().filter((f) => {
    const pid = Number(f.split("-")[1]);
    if (pid && alive(pid)) return true;
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* another process removed it */ }
    return false;
  });
}

// One process at a time looks at the slots (an atomic directory lock, stale after 10 s).
async function locked(fn) {
  const lock = path.join(DIR(), ".lock");
  fs.mkdirSync(DIR(), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmdirSync(lock); } catch { /* gone */ }
      await sleep(50 + Math.random() * 100);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* gone */ } }
}

/**
 * Takes a heavy slot, waiting in line until one is free and the load allows it. onWait({ position,
 * reason }) is called whenever the place in line or the reason changes. Returns release().
 */
export async function acquire(id, { onWait = () => {} } = {}) {
  const name = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${String(id).replace(/[^\w.-]/g, "_").slice(0, 60)}`;
  const queued = path.join(DIR(), "queue", name), held = path.join(DIR(), "held", name);
  fs.mkdirSync(path.dirname(queued), { recursive: true });
  fs.writeFileSync(queued, "");
  const release = () => { for (const f of [queued, held]) try { fs.rmSync(f, { force: true }); } catch { /* gone */ } };
  process.once("exit", release);
  let last = "";
  for (;;) {
    const got = await locked(() => {
      const line = live("queue"), holders = live("held");
      const position = line.indexOf(name) + 1;
      const free = holders.length < maxHeavy();
      // first in line takes a free slot, unless the machine is already overloaded
      if (position === 1 && free && !overloaded()) { fs.renameSync(queued, held); return { ok: true }; }
      return { ok: false, position, reason: free ? "load" : "slots", holders: holders.length };
    });
    if (got.ok) return release;
    const key = `${got.position}:${got.reason}`;
    if (key !== last) { last = key; onWait(got); }
    await sleep(10_000);
  }
}

/** Waits (up to maxMs) until the load average is back under 1.5x the cores, for a retry after a kill. */
export async function calm(maxMs = 30 * 60_000) {
  const t0 = Date.now();
  while (os.loadavg()[0] > cores() * 1.5 && Date.now() - t0 < maxMs) await sleep(15_000);
}

// macOS keeps memory full of cache, so os.freemem() is always tiny; the kernel's own memory level
// (percent available) is what pressure is measured by there.
function freeMemoryPct() {
  if (process.platform === "darwin") {
    const r = spawnSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });
    if (r.status === 0 && Number.isFinite(Number(r.stdout.trim()))) return Number(r.stdout.trim());
  }
  return Math.round((os.freemem() / os.totalmem()) * 100);
}

/** Why a worker was likely killed by a signal: memory pressure, load, or someone outside. */
export function killCause(code) {
  const load = os.loadavg()[0], n = cores(), freePct = freeMemoryPct();
  const parts = [];
  if (load > n * 2) parts.push(t("yük çok yüksek ({load} / {n} çekirdek)", { load: load.toFixed(0), n }));
  if (freePct < 10) parts.push(t("bellek baskısı (%{pct} boş)", { pct: freePct }));
  if (code === 137 && !parts.length) parts.push(t("SIGKILL: büyük olasılıkla bellek ya da elle kill -9"));
  if (!parts.length) parts.push(t("dışarıdan sinyal (kullanıcı ya da başka bir süreç)"));
  return parts.join(", ");
}
