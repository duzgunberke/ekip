// The phone on the Mac side: `ekip phone setup|link|unlink|status|on|off|verbose|quiet|listen|sync`, the
// inbox the hub's Telegram bot fills (answers, requests, /stop, /new, /sessions), and delivery to the
// live lead: a phone message is typed into the lead's terminal pane as the user would type it, only
// while the lead is idle at its prompt (Stop hook marker newer than the UserPromptSubmit one); while
// a turn runs it waits in a queue that the Stop hook empties. The Stop hook also sends the turn's
// last assistant message back to the phone.
//
// Files under data/phone/: state.json (link, mode, target lead, seen inbox ids), leads/<id>.json (one
// per open lead session, written by the hooks), queue/<id>.json (messages waiting for that lead),
// inbox.jsonl (requests for `ekip phone listen`, the fallback for terminals ekip cannot type into).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, ROOT, SETTINGS, ask, askSecret } from "../core/core.js";
import { lang, t } from "../core/i18n.js";
import { redact } from "../core/redact.js";
import { backendOf, detect, leadId } from "../core/terminal.js";

export const PREFIX = "📱 ";
const SYNC_GAP_MS = 3000;
const BUSY_STALE_MS = 3 * 60_000; // a turn interrupted with Esc never gets its Stop hook
const dir = (...p) => path.join(HOME, "phone", ...p);
const safe = (id) => String(id).replace(/[^\w.-]+/g, "_").slice(0, 120);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); };
const now = () => new Date().toISOString();
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// ---- state ----------------------------------------------------------------------------------------

export const readState = () => readJson(dir("state.json"), {});
export function writeState(patch) { const s = { ...readState(), ...patch }; writeJson(dir("state.json"), s); return s; }
export const linked = () => readState().linked === true;
const hubOk = () => !!(SETTINGS.hubUrl && SETTINGS.hubToken);

// A test or a worker with its own EKIP_HOME may still carry the lead's WEZTERM_PANE & co. from the
// environment it inherited: it must never type into, interrupt or open a tab in the user's window
// (the same guard as ensureTaskPane in core/terminal.js). A back end with an injected `run` is a test
// double that records calls and touches no terminal, so it is allowed.
export const testHome = (env = process.env) => !!env.EKIP_HOME && path.resolve(env.EKIP_HOME) !== path.resolve(ROOT, "data");
function termBackend(kind, run, env = process.env) {
  if (!run && testHome(env)) return null;
  return backendOf(kind, run ? { run } : {});
}

/** A lead session ekip started (not a worker it runs, not a plain `claude`). */
export const isLead = (env = process.env) => env.EKIP_LEAD === "1" && !(Number(env.EKIP_RUN_DEPTH ?? 0) > 0);
export function paneOf(env = process.env) {
  const kind = detect(env);
  if (kind === "wezterm") return env.WEZTERM_PANE;
  if (kind === "kitty") return env.KITTY_WINDOW_ID;
  if (kind === "iterm") return env.ITERM_SESSION_ID?.split(":")[1] ?? null;
  return null;
}

function projectOf(cwd) {
  const list = readJson(path.join(HOME, "projects.json"), []);
  return (Array.isArray(list) ? list : []).filter((p) => p.path && (cwd === p.path || String(cwd).startsWith(`${p.path}/`))).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

// ---- lead sessions (written by the hooks) ---------------------------------------------------------

export const readLead = (id) => readJson(dir("leads", `${safe(id)}.json`), null);
export const writeLead = (rec) => writeJson(dir("leads", `${safe(rec.id)}.json`), rec);
export function leads() {
  let files = [];
  try { files = fs.readdirSync(dir("leads")).filter((f) => f.endsWith(".json")); } catch { return []; }
  return files.map((f) => readJson(dir("leads", f), null)).filter((x) => x?.id);
}
export function dropLead(id) {
  fs.rmSync(dir("leads", `${safe(id)}.json`), { force: true });
  fs.rmSync(dir("queue", `${safe(id)}.json`), { force: true });
}

/** Open leads: a pane the terminal still has (an unknown answer counts as open). Gone ones are removed. */
export function liveLeads({ run } = {}) {
  const out = [];
  const panes = new Map(); // terminal kind -> Set of open pane ids, or null for "could not ask"
  const open = (kind) => {
    if (!panes.has(kind)) { const list = termBackend(kind, run)?.listPanes() ?? null; panes.set(kind, list ? new Set(list.map((p) => String(p.id))) : null); }
    return panes.get(kind);
  };
  for (const rec of leads()) {
    const known = rec.term && rec.term !== "none" ? open(rec.term) : undefined;
    const alive = known === undefined ? Date.now() - Date.parse(rec.at ?? 0) < 12 * 3600_000 : known === null || known.has(String(rec.pane));
    if (alive) out.push(rec); else dropLead(rec.id);
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
/** Where phone messages go: the chosen lead while it is open, else the one used last. */
export function pickLead(list, target = readState().target) {
  return list.find((l) => l.id === target) ?? list[0] ?? null;
}

/** SessionStart: the lead is at its prompt. A compaction mid-turn does not make it idle. */
export function registerLead({ env = process.env, cwd = process.cwd(), sessionId = null, transcript = null, source = "startup" } = {}) {
  const id = leadId(env);
  if (!id) return null;
  const old = readLead(id);
  const p = projectOf(cwd);
  const rec = { ...(old ?? {}), id, term: detect(env), pane: paneOf(env), cwd, project: p?.name ?? null, sessionId, transcript, at: now(),
    ...(source === "compact" && old ? {} : { state: "idle", idleAt: now(), phoneTurn: false }) };
  writeLead(rec);
  // `/new <project>` from the phone: the lead that opens there takes the following messages
  const st = readState();
  if (st.pendingNew && Date.now() - Date.parse(st.pendingNew.at) < 3 * 60_000 && path.resolve(st.pendingNew.cwd) === path.resolve(cwd)) writeState({ target: id, pendingNew: null });
  return rec;
}
/** UserPromptSubmit: a turn runs. It is a phone turn when the prompt came from the phone. */
export function markBusy({ env = process.env, prompt = "" } = {}) {
  const rec = readLead(leadId(env));
  if (!rec) return null;
  Object.assign(rec, { state: "busy", busyAt: now(), phoneTurn: String(prompt).startsWith(PREFIX.trim()), tools: [] });
  writeLead(rec);
  return rec;
}
/** Stop: back at the prompt. Returns the record as it was (phoneTurn of the turn that ended). */
export function markIdle({ env = process.env, transcript = null } = {}) {
  const rec = readLead(leadId(env));
  if (!rec) return null;
  const was = { ...rec };
  Object.assign(rec, { state: "idle", idleAt: now(), phoneTurn: false, ...(transcript ? { transcript } : {}) });
  writeLead(rec);
  return was;
}
const idle = (rec) => rec.state === "idle" || (rec.state === "busy" && Date.now() - Date.parse(rec.busyAt ?? 0) > BUSY_STALE_MS && staleTranscript(rec));
function staleTranscript(rec) { try { return Date.now() - fs.statSync(rec.transcript).mtimeMs > BUSY_STALE_MS; } catch { return true; } }

// ---- typing into the lead -------------------------------------------------------------------------

const queueFile = (id) => dir("queue", `${safe(id)}.json`);
export const readQueue = (id) => readJson(queueFile(id), []);
export function enqueue(id, text) { const q = readQueue(id); q.push({ text, at: now() }); writeJson(queueFile(id), q); return q.length; }

function lock(name, fn) {
  const l = dir(`${name}.lock`);
  fs.mkdirSync(dir(), { recursive: true });
  try { if (Date.now() - fs.statSync(l).mtimeMs > 30_000) fs.rmSync(l, { recursive: true, force: true }); } catch { /* none */ }
  try { fs.mkdirSync(l); } catch { return undefined; }
  try { return fn(); } finally { fs.rmSync(l, { recursive: true, force: true }); }
}

/** Types the next queued message into the lead when it is idle. true when one was typed. */
export function pump(id, { run } = {}) {
  return lock(`pump-${safe(id)}`, () => {
    const rec = readLead(id);
    if (!rec || !idle(rec)) return false;
    const q = readQueue(id);
    if (!q.length) return false;
    const b = termBackend(rec.term, run);
    if (!b?.sendText) return false;
    if (!b.sendText(rec.pane, q[0].text)) return false;
    q.shift();
    writeJson(queueFile(id), q);
    Object.assign(rec, { state: "busy", busyAt: now(), phoneTurn: true });
    writeLead(rec);
    return true;
  }) ?? false;
}

/** The phone pressed /stop: Escape into the lead's pane interrupts the running turn. */
export function stopLead(rec, { run } = {}) {
  const b = rec ? termBackend(rec.term, run) : null;
  if (!b?.sendKey || !b.sendKey(rec.pane, "escape")) return false;
  // an interrupted turn gets no Stop hook: it is at the prompt again
  writeLead({ ...rec, state: "idle", idleAt: now(), phoneTurn: false });
  return true;
}

// ---- the transcript -------------------------------------------------------------------------------

const textOf = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []);
/**
 * The lead's last message of the turn that just ended, from the session transcript (JSONL): the text
 * blocks after the turn's last tool call (or its last text when it ended on a tool), "" when none.
 */
export function lastAssistantText(file, { maxBytes = 4_000_000 } = {}) {
  let raw = "";
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    raw = buf.toString("utf8");
  } catch { return ""; }
  let turn = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    const role = e.message?.role ?? e.type;
    const blocks = textOf(e.message?.content);
    if (role === "user" && !e.isMeta && !blocks.some((b) => b.type === "tool_result") && blocks.some((b) => b.type === "text" && b.text?.trim())) { turn = []; continue; }
    if (role !== "assistant") continue;
    for (const b of blocks) {
      if (b.type === "text" && b.text?.trim()) turn.push({ text: b.text });
      else if (b.type === "tool_use") turn.push({ tool: true });
    }
  }
  const lastTool = turn.map((x) => !!x.tool).lastIndexOf(true);
  const after = turn.slice(lastTool + 1).filter((x) => x.text);
  const pick = after.length ? after : turn.filter((x) => x.text).slice(-1);
  return pick.map((x) => x.text.trim()).join("\n\n").trim();
}

/** One line for a tool call (verbose mode): "Bash: npm test", "Edit: app.js". */
export function toolLine(input = {}) {
  const name = String(input.tool_name ?? "tool");
  const i = input.tool_input ?? {};
  const short = name.startsWith("mcp__") ? name.split("__").slice(-1)[0] : name;
  const first = (s) => String(s ?? "").split("\n")[0].trim().slice(0, 100);
  const what = i.command ? first(i.command) : i.file_path ? path.basename(String(i.file_path)) : i.notebook_path ? path.basename(String(i.notebook_path))
    : i.pattern ? first(i.pattern) : i.description ? first(i.description) : i.url ? first(i.url).replace(/^https?:\/\/([^/]+).*/, "$1") : i.query ? first(i.query) : "";
  return redact(what ? `${short}: ${what}` : short);
}

// ---- the hub --------------------------------------------------------------------------------------

async function hubCall(pathname, { method = "GET", body, fetchFn = globalThis.fetch, timeoutMs = 8000, raw = false } = {}) {
  const r = await fetchFn(`${SETTINGS.hubUrl}${pathname}`, {
    method, signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error ?? (r.status === 404 ? t("token yanlış ya da hub eski sürüm; ekip hub link <url> <token>") : `HTTP ${r.status}`)); e.status = r.status; throw e; }
  return j;
}

/** A file the phone sent: from the hub into the project's scratch inbox (data/scratch/<project>/inbox). */
async function fetchFile(f, project, { fetchFn } = {}) {
  const folder = path.join(HOME, "scratch", safe(project ?? "general"), "inbox");
  fs.mkdirSync(folder, { recursive: true });
  const r = await hubCall(`/api/inbox/files/${encodeURIComponent(f.id)}`, { fetchFn, raw: true, timeoutMs: 60_000 });
  const name = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${String(f.name ?? f.id).replace(/[^\w.-]+/g, "_").slice(-80)}`;
  const file = path.join(folder, name);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}

const listener = () => readJson(dir("listener.json"), null);
export const listenerAlive = () => pidAlive(listener()?.pid);
function toListen(text) { fs.mkdirSync(dir(), { recursive: true }); fs.appendFileSync(dir("inbox.jsonl"), `${JSON.stringify({ text, at: now() })}\n`); }

/**
 * A phone message for the lead: typed into its pane (now, or after the running turn), or for `ekip
 * phone listen` in a terminal ekip cannot type into; with no lead open, a job on the hub's queue.
 */
export async function deliver(text, { chat = null, run, fetchFn, target } = {}) {
  const list = liveLeads({ run });
  const lead = target ?? pickLead(list);
  if (lead && lead.term && lead.term !== "none") {
    enqueue(lead.id, `${PREFIX}${text}`);
    pump(lead.id, { run });
    return { to: "lead", lead: lead.id };
  }
  if (listenerAlive()) { toListen(text); return { to: "listen" }; }
  await hubCall("/api/phone/tojob", { method: "POST", body: { text, chat }, fetchFn });
  return { to: "hub" };
}

function newLead(project, { run } = {}) {
  const p = readJson(path.join(HOME, "projects.json"), []).find?.((x) => x.name === project);
  if (!p?.path) return false;
  const open = liveLeads({ run }).find((l) => l.term && l.term !== "none");
  const kind = open?.term ?? detect();
  const b = termBackend(kind, run);
  if (!b?.spawnLead) return false;
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, "plugin/bin/ekip.js"))} --here`;
  const id = b.spawnLead(p.path, cmd, { near: open?.pane ?? null });
  if (id) writeState({ pendingNew: { project, cwd: p.path, at: now() } });
  return !!id;
}

/** Does what one inbox item asks. */
export async function apply(item, { run, fetchFn } = {}) {
  const tasks = () => import("../tasks/tasks.js");
  if (item.kind === "answer") {
    const tk = await tasks();
    const task = tk.list().find((x) => x.id === item.task);
    if (!task || task.status !== "running") return "gone";
    const question = task.ask?.question ?? task.hold?.reason ?? "";
    tk.answer(item.task, item.choice);
    // the lead that asked is told, so it carries on (typed when it is idle)
    const lead = task.lead ? liveLeads({ run }).find((l) => l.id === task.lead) : null;
    if (lead) await deliver(t("{title}: \"{question}\" sorusunun cevabı: {choice}", { title: task.title, question, choice: item.choice }), { run, fetchFn, target: lead });
    return "answered";
  }
  if (item.kind === "cancel") {
    const tk = await tasks();
    const task = tk.list().find((x) => x.id === item.task);
    if (!task || task.status !== "running") return "gone";
    tk.finish(item.task, "cancelled", t("telefondan iptal edildi"));
    return "cancelled";
  }
  if (item.kind === "stop") return stopLead(pickLead(liveLeads({ run })), { run }) ? "stopped" : "no-lead";
  if (item.kind === "select") { writeState({ target: item.lead }); return "selected"; }
  if (item.kind === "new") return newLead(item.project, { run }) ? "opened" : "not-opened";
  if (item.kind === "request") {
    const lead = pickLead(liveLeads({ run }));
    const files = [];
    for (const f of item.files ?? []) { try { files.push(await fetchFile(f, lead?.project, { fetchFn })); } catch { /* the file expired on the hub */ } }
    const text = [String(item.text ?? "").trim(), ...files.map((f) => `[${t("dosya")}: ${f}]`)].filter(Boolean).join(" ");
    if (!text) return "empty";
    return (await deliver(text, { chat: item.chat ?? null, run, fetchFn })).to;
  }
  return "unknown";
}

/**
 * One round with the hub: say which leads are open, take the inbox, do each item once, ack it.
 * Throttled across processes (task pane, hooks, heartbeat) to one round every few seconds.
 */
export async function sync({ force = false, run, fetchFn } = {}) {
  if (!hubOk() || !linked()) return null;
  const at = dir("sync.at");
  try { if (!force && Date.now() - fs.statSync(at).mtimeMs < SYNC_GAP_MS) return null; } catch { /* first */ }
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(at, "");
  const l = dir("sync.lock");
  try { if (Date.now() - fs.statSync(l).mtimeMs > 60_000) fs.rmSync(l, { recursive: true, force: true }); } catch { /* none */ }
  try { fs.mkdirSync(l); } catch { return null; }
  try {
    const st = readState();
    const open = liveLeads({ run });
    const target = pickLead(open, st.target);
    const res = await hubCall("/api/inbox/sync", { method: "POST", fetchFn, body: {
      client: "mac", host: os.hostname(), ack: st.acks ?? [],
      leads: open.slice(0, 20).map((x) => ({ id: x.id, project: x.project, cwd: x.cwd, state: x.state, target: x.id === target?.id })),
    } });
    const seen = new Set(st.seen ?? []);
    const done = [];
    for (const item of res.items ?? []) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        // seen before it runs: an item that crashes the process is not done twice
        writeState({ seen: [...seen].slice(-500) });
        try { await apply(item, { run, fetchFn }); } catch (e) { log(`apply ${item.kind}: ${e.message}`); }
      }
      done.push(item.id);
    }
    let acks = done;
    if (done.length) { try { await hubCall("/api/inbox/ack", { method: "POST", fetchFn, body: { ids: done } }); acks = []; } catch { /* next round */ } }
    writeState({ acks, seen: [...seen].slice(-500), syncedAt: now(), ...(res.phone ? { mode: res.phone.mode, verbose: res.phone.verbose, hubLinked: res.phone.linked, hubEnabled: res.phone.enabled } : {}) });
    return { items: done.length };
  } catch (e) { log(`sync: ${e.message}`); return null; } finally { fs.rmSync(l, { recursive: true, force: true }); }
}
let ticking = false;
/** From the task pane's loop: a sync in the background, never two at once in this process. */
export function tick() {
  if (ticking || !linked()) return;
  ticking = true;
  sync().catch(() => {}).finally(() => { ticking = false; });
}
function log(s) { try { fs.mkdirSync(path.join(HOME, "logs"), { recursive: true }); fs.appendFileSync(path.join(HOME, "logs/phone.log"), `${now()} ${redact(s)}\n`); } catch { /* ignore */ } }

// ---- hooks ----------------------------------------------------------------------------------------

/** `node lib/phone/hook.js <event>`: cheap when no phone is linked or the session is not a lead. */
// The lead records are kept even before a phone is linked, so a lead that was open when the phone
// got linked can be typed into; only the tool hook (one per tool call) is skipped without a phone.
export async function hook(event, input = {}, { env = process.env, run, fetchFn } = {}) {
  if (!isLead(env)) return;
  const known = () => readLead(leadId(env)) ?? registerLead({ env, cwd: input.cwd || process.cwd(), sessionId: input.session_id ?? null, transcript: input.transcript_path ?? null });
  if (event === "session") { registerLead({ env, cwd: input.cwd || process.cwd(), sessionId: input.session_id ?? null, transcript: input.transcript_path ?? null, source: input.source ?? "startup" }); return; }
  if (event === "end") { const id = leadId(env); if (id) dropLead(id); return; }
  if (event === "prompt") { known(); markBusy({ env, prompt: input.prompt ?? "" }); return; }
  if (!linked()) { if (event === "stop") { known(); markIdle({ env, transcript: input.transcript_path ?? null }); } return; }
  if (event === "tool") {
    const st = readState();
    if (!st.verbose || !hubOk()) return;
    const rec = readLead(leadId(env));
    if (!rec) return;
    rec.tools = [...(rec.tools ?? []), toolLine(input)].slice(-20);
    const due = Date.now() - Date.parse(rec.toolsAt ?? 0) > 2000;
    if (due) rec.toolsAt = now();
    writeLead(rec);
    if (due) await hubCall("/api/phone/activity", { method: "POST", fetchFn, timeoutMs: 3000, body: { lead: rec.id, project: rec.project, lines: rec.tools } }).catch(() => {});
    return;
  }
  if (event === "stop") {
    known();
    const was = markIdle({ env, transcript: input.transcript_path ?? null });
    if (!was) return;
    const st = readState();
    if (hubOk() && (st.mode !== "off" || was.phoneTurn)) {
      let text = "";
      // the last lines of the transcript can land a moment after the hook starts
      for (let i = 0; i < 4 && !text; i++) { text = lastAssistantText(input.transcript_path ?? was.transcript); if (!text) await new Promise((r) => setTimeout(r, 250)); }
      if (input.last_assistant_message && !text) text = String(input.last_assistant_message);
      if (text) await hubCall("/api/phone/reply", { method: "POST", fetchFn, timeoutMs: 5000, body: { lead: was.id, project: was.project, text: redact(text), phoneTurn: !!was.phoneTurn } }).catch((e) => log(`reply: ${e.message}`));
    }
    // what waited for this turn: typed a moment later, once Claude Code shows its prompt again
    if (readQueue(was.id).length) {
      const self = path.join(path.dirname(new URL(import.meta.url).pathname), "hook.js");
      spawn(process.execPath, [self, "pump", was.id], { detached: true, stdio: "ignore", env }).unref();
    }
  }
}

// ---- CLI ------------------------------------------------------------------------------------------

const USAGE = "usage: ekip phone setup [--token-stdin] [--remove] | link | unlink | status | on | off | verbose on|off | quiet HH:MM-HH:MM|off | listen [--timeout MIN] | sync";
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } };

export async function main([sub = "status", ...args] = [], { out = console.log, fetchFn, ...io } = {}) {
  const need = () => { if (!hubOk()) { out(t("Önce bir hub bağla: ekip hub link <url> <token> (ya da ekip hub local)")); return false; } return true; };
  if (sub === "setup") return need() ? setup(args, { out, fetchFn, ...io }) : 1;
  if (sub === "link") return need() ? ((await linkCode({ out, fetchFn })) ? 0 : 1) : 1;
  if (sub === "unlink") {
    if (hubOk()) await hubCall("/api/phone/link", { method: "DELETE", fetchFn }).catch(() => {});
    writeState({ linked: false, target: null });
    out(t("Telefon bağlantısı kaldırıldı."));
    return 0;
  }
  if (sub === "on" || sub === "off" || sub === "verbose" || sub === "quiet") {
    if (!need()) return 1;
    const body = sub === "verbose" ? { verbose: args[0] !== "off" } : sub === "quiet" ? { quiet: null } : { mode: sub };
    if (sub === "quiet" && args[0] && args[0] !== "off") {
      const m = args[0].match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      if (!m) { out(USAGE); return 1; }
      body.quiet = { from: m[1], to: m[2], tz: tz() };
    }
    try { const s = await hubCall("/api/phone/settings", { method: "PUT", fetchFn, body }); writeState({ mode: s.mode, verbose: s.verbose }); } catch (e) { out(`${t("hub yanıt vermedi")}: ${e.message}`); return 1; }
    out(sub === "verbose" ? t(body.verbose ? "Ayrıntılı mod açık: çalışan turun araç çağrıları telefonda görünür." : "Ayrıntılı mod kapalı.")
      : sub === "quiet" ? (body.quiet ? t("Sessiz saatler: {from}-{to} (mesajlar bildirimsiz gelir)", { from: body.quiet.from, to: body.quiet.to }) : t("Sessiz saatler kapalı."))
        : t(sub === "on" ? "Telefon modu açık: her turun cevabı telefona gider." : "Telefon modu kapalı: yalnız telefondan başlayan turların cevabı gider."));
    return 0;
  }
  if (sub === "status") {
    const st = readState();
    let hub = null;
    if (hubOk()) { try { hub = await hubCall("/api/phone", { fetchFn, timeoutMs: 5000 }); } catch { /* offline */ } }
    out(`${t("Telefon")}: ${st.linked ? (hub?.chats ? t("bağlı (Telegram)") : t("kod bekliyor ya da sohbet yok (ekip phone link)")) : t("bağlı değil (ekip phone setup)")}`);
    if (hub) {
      out(`  bot: ${hub.enabled ? (hub.bot ? `@${hub.bot}` : "telegram") : t("hub'da kapalı (ekip phone setup)")}  · ${t("mod")}: ${hub.mode}  · verbose: ${hub.verbose ? "on" : "off"}${hub.quiet ? `  · ${t("sessiz")}: ${hub.quiet.from}-${hub.quiet.to}` : ""}`);
      out(`  ${t("bekleyen mesaj")}: ${hub.inbox}`);
    } else if (hubOk()) out(`  ${t("hub yanıt vermedi")}`);
    const open = liveLeads();
    const target = pickLead(open, st.target);
    out(`  ${t("açık lead")}: ${open.length ? open.map((l) => `${l.id === target?.id ? "● " : ""}${l.project ?? path.basename(l.cwd ?? "")} (${l.state === "busy" ? t("çalışıyor") : t("boşta")})`).join(", ") : "-"}`);
    if (st.syncedAt) out(`  ${t("son eşitleme")}: ${new Date(st.syncedAt).toLocaleString(lang === "tr" ? "tr-TR" : "en-GB")}`);
    return 0;
  }
  if (sub === "sync") { const r = await sync({ force: true, fetchFn }); out(r ? t("{n} mesaj işlendi", { n: r.items }) : t("eşitlenmedi (telefon bağlı değil ya da hub yanıt vermedi)")); return r ? 0 : 1; }
  if (sub === "listen") {
    // the fallback for a terminal ekip cannot type into: blocks until a phone message arrives,
    // prints it and exits (the lead runs it in a background shell and is woken by its exit)
    const i = args.indexOf("--timeout");
    const until = Date.now() + (i >= 0 ? Number(args[i + 1]) || 50 : 50) * 60_000;
    writeJson(dir("listener.json"), { pid: process.pid, at: now() });
    const cleanup = () => { if (listener()?.pid === process.pid) fs.rmSync(dir("listener.json"), { force: true }); };
    process.on("exit", cleanup);
    while (Date.now() < until) {
      await sync({ force: true, fetchFn });
      const file = dir("inbox.jsonl");
      let lines = [];
      try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { /* empty */ }
      if (lines.length) {
        fs.rmSync(file, { force: true });
        for (const l of lines) { try { out(`${t("Telefondan")}: ${JSON.parse(l).text}`); } catch { /* skip */ } }
        return 0;
      }
      await new Promise((r) => setTimeout(r, SYNC_GAP_MS));
    }
    out(t("telefondan mesaj gelmedi; dinlemeyi yeniden başlat: ekip phone listen"));
    return 0;
  }
  out(USAGE);
  return 1;
}

/** `ekip phone link`: a one-time /link code from the hub. Returns it, or null (printed why). */
async function linkCode({ out, fetchFn }) {
  let r;
  try { r = await hubCall("/api/phone/link", { method: "POST", fetchFn, body: { lang, tz: tz() } }); } catch (e) {
    out(e.status === 409 ? t("Hub'da Telegram botu ayarlı değil: ekip phone setup") : `${t("hub yanıt vermedi")}: ${e.message}`);
    return null;
  }
  writeState({ linked: true, linkedAt: now(), mode: readState().mode ?? "on" });
  // the bot's name on its own line: pasted with the code it made the code wrong (31 Oct)
  if (r.bot) out(t("Telegram'da @{bot} sohbetini aç (BotFather değil)", { bot: r.bot }));
  out(t("ve yalnız şunu gönder: /link {code}", { code: r.code }));
  out(t("Kod 10 dakika geçerli ve tek kullanımlık. Sonra: ekip phone status"));
  return r.code;
}

// ---- ekip phone setup -----------------------------------------------------------------------------

export const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,100}$/;
const PAIR_MS = 10 * 60_000;
const hide = (s, token) => redact(String(s ?? "").split(token).join("****"));

/** Telegram getMe for a token: { ok, bot } or { ok: false, status, error }. The token is never printed. */
export async function getMe(token, { fetchFn = globalThis.fetch, apiBase = "https://api.telegram.org" } = {}) {
  if (!BOT_TOKEN.test(token)) return { ok: false, status: 0, error: t("bu bir bot token'ı gibi görünmüyor (rakamlar:harfler, @BotFather'dan)") };
  try {
    const r = await fetchFn(`${apiBase}/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => null);
    if (j?.ok && j.result?.username) return { ok: true, bot: j.result.username };
    const status = j?.error_code ?? r.status;
    return { ok: false, status, error: status === 401 || status === 404 ? t("Telegram bu token'ı reddetti (401); BotFather'dan yeniden kopyala") : hide(j?.description ?? `HTTP ${r.status}`, token) };
  } catch (e) { return { ok: false, status: 0, error: `${t("Telegram'a ulaşılamadı")}: ${hide(e.message, token)}` }; }
}

const appleString = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The token, never echoed: --token-stdin reads it from stdin (scripts); on macOS a native dialog with
 * a hidden answer (works without a terminal, e.g. from the lead's `!` prompt); elsewhere a no-echo
 * prompt. "" when cancelled or there is no way to ask.
 */
export async function readToken(args = [], { platform = process.platform, run = spawnSync, stdin = () => fs.readFileSync(0, "utf8"), tty = !!process.stdin.isTTY, secret = askSecret } = {}) {
  if (args.includes("--token-stdin")) { try { return String(stdin()).trim(); } catch { return ""; } }
  if (platform === "darwin") {
    const prompt = t("@BotFather'ın verdiği bot token'ını yapıştır:");
    const script = `text returned of (display dialog ${appleString(prompt)} default answer "" with hidden answer with title "ekip" with icon note)`;
    const r = run("osascript", ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 });
    if (r.status === 0) return String(r.stdout ?? "").trim();
    if (/-128/.test(String(r.stderr ?? ""))) return ""; // Cancel
  }
  if (!tty) return "";
  return (await secret(`  ${t("bot token")}: `).catch(() => "")).trim();
}

/**
 * `ekip phone setup`: the BotFather steps, the token (hidden), getMe, the hub stores it and starts the
 * bot, then the /link code and a wait for the pairing. The token stays off the Mac: not printed, not
 * logged, not in config.json or the phone state. `--remove` takes the bot off the hub.
 */
export async function setup(args = [], { out = console.log, fetchFn, tgFetch = fetchFn ?? globalThis.fetch, token: given, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = PAIR_MS, pollMs = 3000, ...io } = {}) {
  if (args.includes("--remove")) {
    try { await hubCall("/api/phone/telegram-token", { method: "DELETE", fetchFn }); } catch (e) {
      out(e.status === 409 ? t("Bot hub'ın ortamındaki EKIP_TELEGRAM_TOKEN'dan geliyor; onu hub'ın .env dosyasından kaldır") : `${t("hub yanıt vermedi")}: ${e.message}`);
      return 1;
    }
    writeState({ linked: false, target: null, hubEnabled: false, hubLinked: false });
    out(t("Telegram botu hub'dan kaldırıldı."));
    return 0;
  }
  out(t("Telegram botu (bir kez, 1 dakika):"));
  out(`  1. ${t("Telegram'da @BotFather'ı aç ve /newbot yaz")}`);
  out(`  2. ${t("bir ad ver (ör. ekip)")}`);
  out(`  3. ${t("\"bot\" ile biten bir kullanıcı adı ver (ör. benim_ekip_bot)")}`);
  out(`  4. ${t("verdiği token'ı kopyala ve istendiğinde yapıştır (ekranda görünmez)")}`);
  const token = (given ?? await readToken(args, io)).trim();
  if (!token) { out(t("token girilmedi; sonra: ekip phone setup")); return 1; }
  const me = await getMe(token, { fetchFn: tgFetch });
  if (!me.ok) { out(me.error); return 1; }
  out(`${t("bot doğrulandı")}: @${me.bot}`);
  let r;
  try { r = await hubCall("/api/phone/telegram-token", { method: "PUT", fetchFn, timeoutMs: 30_000, body: { token } }); } catch (e) {
    out(e.status === 409 ? t("Hub'ın ortamında EKIP_TELEGRAM_TOKEN ayarlı ve o geçerli; botu değiştirmek için onu hub'ın .env dosyasında değiştir")
      : e.status === 404 ? t("hub bu komutu tanımıyor ya da hub token'ı yanlış; hub'ı güncelle (VPS'te docker compose up -d --build) ya da yeniden bağla: ekip hub link <url> <token>")
        : `${t("hub token'ı kaydetmedi")}: ${hide(e.message, token)}`);
    return 1;
  }
  writeState({ hubEnabled: true });
  out(t("hub botu başlattı (@{bot}); yeniden başlatma gerekmedi", { bot: r.bot ?? me.bot }));
  if (r.chats > 0) { writeState({ linked: true, hubLinked: true }); out(`${t("eşleşti")}: @${r.bot ?? me.bot}`); return 0; }
  if (!(await linkCode({ out, fetchFn }))) return 1;
  out(t("eşleşme bekleniyor (en çok 10 dakika; Ctrl-C: sonra ekip phone status)…"));
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    await sleep(pollMs);
    let s = null;
    try { s = await hubCall("/api/phone", { fetchFn, timeoutMs: 5000 }); } catch { /* try again */ }
    if (s?.chats > 0) { writeState({ hubLinked: true }); out(`${t("eşleşti")}: @${s.bot ?? r.bot ?? me.bot}`); return 0; }
  }
  out(t("10 dakikada eşleşme olmadı; yeni kod için: ekip phone link"));
  return 1;
}

/** For `ekip setup`: does the hub have a bot, and a paired chat? From the hub, else the last sync's answer. */
export async function phoneFacts({ fetchFn, timeoutMs = 1500 } = {}) {
  if (!hubOk()) return { bot: false, paired: false };
  try {
    const s = await hubCall("/api/phone", { fetchFn, timeoutMs });
    writeState({ hubEnabled: !!s.enabled, hubLinked: (s.chats ?? 0) > 0 });
    return { bot: !!s.enabled, paired: (s.chats ?? 0) > 0 };
  } catch {
    const st = readState();
    return { bot: !!st.hubEnabled, paired: !!st.hubLinked && !!st.linked };
  }
}

/**
 * `ekip init`: asked once, default no (it needs the user's own bot), only with a linked hub in an
 * interactive session; --no-phone skips it. Marks the setup step offered, so the wizard does not ask again.
 */
export async function initPhone(args = [], { interactive = !!(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI, prompt = ask, hub = hubOk(), facts = phoneFacts, exec = () => spawnSync(process.execPath, [path.join(ROOT, "plugin/bin/ekip.js"), "phone", "setup"], { stdio: "inherit" }).status ?? 1 } = {}) {
  if (args.includes("--no-phone") || !interactive || !hub) return "skipped";
  const { snooze, snoozed } = await import("../ops/snooze.js");
  if (snoozed("phone:offered") || snoozed("phone")) return "skipped";
  const f = await facts();
  if (f.bot && f.paired) return "done";
  snooze("phone:offered", 3650);
  const a = (await prompt(`${t("Telefondan takip için Telegram botu bağlansın mı? [e/H]")} `)).trim();
  if (!/^(e|evet|y|yes)$/i.test(a)) { console.log(t("Telefon atlandı; sonra: ekip phone setup")); return "no"; }
  return exec() === 0 ? "linked" : "failed";
}

/** "Telefon: bağlı (Telegram) · mod açık · 1 açık lead" for `ekip status`; "" without a hub. */
export function statusLine() {
  if (!hubOk()) return "";
  const st = readState();
  if (!st.linked) return `${t("Telefon")}: ${t("bağlı değil (ekip phone setup)")}`;
  const open = leads().length;
  const parts = [t("bağlı (Telegram)"), st.mode === "off" ? t("mod kapalı") : t("mod açık"), ...(st.verbose ? ["verbose"] : []), t("{n} açık lead", { n: open })];
  if (st.syncedAt) parts.push(`${t("son eşitleme")} ${new Date(st.syncedAt).toLocaleTimeString(lang === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit" })}`);
  return `${t("Telefon")}: ${parts.join(" · ")}`;
}

/** The lead's extra rules while a phone is linked (appended to the lead prompt). */
export function leadPrompt(env = process.env) {
  if (!linked()) return "";
  const fallback = detect(env) === "none";
  return `
## The user's phone (Telegram) is linked
- A message that starts with "${PREFIX.trim()}" was typed on the user's phone and delivered into this session. Treat it exactly as
  the user's own message. Your last message of each turn is sent back to the phone, so end every turn
  with a short, self-contained answer (what you did, what is open, what you need from the user).
- Questions that need the user's decision go through \`ekip task ask ID "question" --option A --option B\`: the
  phone shows the options as buttons and the answer comes back to the task.${fallback ? `
- This terminal cannot be typed into by ekip, so phone messages arrive through a listener: keep
  \`ekip phone listen\` running in a background shell (Bash run_in_background). When it exits, it has printed
  the message ("Telefondan: …" / "From phone: …"): handle it as a user request, then start the listener again.` : ""}
`;
}
