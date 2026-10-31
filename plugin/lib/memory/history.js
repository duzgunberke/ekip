// Which Claude Code sessions of a project never reached memory, and the light catch-up that sends them.
// A session reaches memory three ways: the history import (memory-state/asset-import.json), the Stop
// hook's live capture (memory-state/capture/<session>.json) or, for ekip's own workers, the run record
// (task + report, memory.js recordRun). Only a user session that none of them took is a gap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME } from "../core/core.js";

// the first sentence of every ekip worker brief (WORKER_BRIEF in bin/ekip.js)
export const WORKER_MARK = "You are a worker agent dispatched by a lead agent";
const HOUR = 3600_000, DAY = 24 * HOUR;

export const sessionsRoot = () => process.env.EKIP_CLAUDE_PROJECTS ?? path.join(os.homedir(), ".claude/projects");
/** The session folders Claude Code keeps for a project: its own folder and its sub-folders and worktrees. */
export const ownsDir = (name, d) => d.endsWith(`-Projects-${name}`) || d.includes(`-Projects-${name}-`);

// Importer keys are "<agent>::session:claude-code:<file path>"; a session id names one file wherever the
// folder is (a symlinked alias of a project folder holds the same files), so ids are compared.
function importedIds(home) {
  try {
    const done = JSON.parse(fs.readFileSync(path.join(home, "memory-state/asset-import.json"), "utf8")).done ?? [];
    return new Set(done.filter((k) => !String(k).includes("/subagents/")).map((k) => path.basename(String(k), ".jsonl")));
  } catch { return new Set(); }
}

// capture state files: "<session>.json", or "<session>--<project>.json" for a home-folder lead
function captured(home) {
  const out = new Map();
  try {
    for (const f of fs.readdirSync(path.join(home, "memory-state/capture"))) {
      if (!f.endsWith(".json")) continue;
      const sid = f.slice(0, -5).split("--")[0];
      let at = 0;
      try { at = Date.parse(JSON.parse(fs.readFileSync(path.join(home, "memory-state/capture", f), "utf8")).at) || 0; } catch { /* half-written */ }
      out.set(sid, Math.max(out.get(sid) ?? 0, at));
    }
  } catch { /* nothing captured yet */ }
  return out;
}

function head(file, bytes = 32768) {
  let fd;
  try { fd = fs.openSync(file, "r"); const b = Buffer.alloc(bytes); return b.toString("utf8", 0, fs.readSync(fd, b, 0, bytes, 0)); }
  catch { return ""; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** A session's first lines: a worker (an ekip brief, or `claude -p` / the SDK) and the folder it ran in. */
export function sessionHead(file) {
  const h = head(file);
  let cwd = null;
  try { cwd = JSON.parse(`"${h.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1] ?? ""}"`) || null; } catch { /* no cwd */ }
  return { worker: h.includes(WORKER_MARK) || /"entrypoint":"sdk-/.test(h), cwd };
}

/**
 * Every top-level session file of the project's folders, with how it reached memory:
 * imported, captured (live), stale (captured, then written to again), worker, or missing.
 */
export function projectSessions(p, { base = sessionsRoot(), home = HOME } = {}) {
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => ownsDir(p.name, d)); } catch { return []; }
  const imported = importedIds(home), cap = captured(home), seen = new Set(), out = [];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(base, dir)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const sid = f.slice(0, -6);
      if (seen.has(sid)) continue;
      seen.add(sid);
      const file = path.join(base, dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const s = { sid, dir, file, size: st.size, mtimeMs: st.mtimeMs };
      // a minute of slack: the hook writes its state just after the turn that changed the file
      if (imported.has(sid)) s.state = "imported";
      else if (cap.has(sid)) s.state = st.mtimeMs > cap.get(sid) + 60_000 ? "stale" : "captured";
      else s.state = sessionHead(file).worker ? "worker" : "missing";
      out.push(s);
    }
  }
  return out;
}

/** User sessions older than a day that no import, capture or run record took (the setup gap). */
export function missingSessions(p, { now = Date.now(), minAge = DAY, ...o } = {}) {
  return projectSessions(p, o).filter((s) => s.state === "missing" && now - s.mtimeMs > minAge);
}

const busy = (pidFile) => { try { const pid = Number(fs.readFileSync(pidFile, "utf8")); process.kill(pid, 0); return pid > 0; } catch { return false; } };

/**
 * Sends sessions that never reached memory, and captured ones written to since, through the live
 * capture (incremental by line, so a session is never sent twice). Bounded: one run at a time, sessions
 * idle for half an hour, at most `maxSessions` and `maxMb` per run, nothing while the machine is busy.
 * Stops at the first memory error (service down) and leaves the rest for the next run.
 */
export async function catchUp({ projects, base = sessionsRoot(), home = HOME, now = Date.now(), idleMs = 30 * 60_000, maxSessions = 10, maxMb = 40, force = false, send } = {}) {
  if (!force && os.loadavg()[0] > os.cpus().length * 0.75) return { deferred: "load" };
  if (busy(path.join(home, "import-history.lock"))) return { deferred: "import-history" };
  const lock = path.join(home, "memory-state/catch-up.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch {
    try { if (now - fs.statSync(lock).mtimeMs < HOUR) return { deferred: "locked" }; } catch { /* gone */ }
  }
  const result = { sessions: 0, sent: 0, left: 0 };
  try {
    const mem = send ? null : await import("./memory.js");
    const { findProject, listProjects } = await import("../projects/projects.js");
    const list = projects ?? listProjects().filter((x) => x.tdai?.agentId);
    const todo = list.flatMap((p) => projectSessions(p, { base, home }).filter((s) => (s.state === "missing" || s.state === "stale") && now - s.mtimeMs > idleMs).map((s) => ({ ...s, p })))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    for (const s of todo) {
      // a session larger than the whole budget still goes, alone, as the first of a run
      if (result.sessions >= maxSessions || (maxMb && bytes && bytes + s.size > maxMb * 1024 * 1024)) { result.left++; continue; }
      // filed like the live capture: under the project of the folder it ran in, else the folder's owner
      const cwd = sessionHead(s.file).cwd;
      const target = (cwd && findProject(cwd)?.tdai?.agentId ? findProject(cwd) : null) ?? s.p;
      try {
        const r = send ? await send(target, s.file, s.sid) : await mem.capture(target, s.file, s.sid);
        result.sent += r?.sent ?? 0;
      } catch (e) { result.error = String(e?.message ?? e).slice(0, 200); result.left += todo.length - todo.indexOf(s); break; }
      result.sessions++;
      bytes += s.size;
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  return result;
}

/** From the Stop hook: a catch-up at most once an hour; a deferred one is tried again at the next turn. */
export async function catchUpIfDue({ home = HOME, every = HOUR, ...o } = {}) {
  const stamp = path.join(home, "memory-state/catch-up.json");
  try { if (Date.now() - JSON.parse(fs.readFileSync(stamp, "utf8")).at < every) return { skipped: "recent" }; } catch { /* first run */ }
  const r = await catchUp({ home, ...o });
  if (!r.deferred) { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, JSON.stringify({ at: Date.now(), ...r })); }
  return r;
}
