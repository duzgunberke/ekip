// The phone: a Telegram bot run by the hub. Long polling (getUpdates), never a webhook, so the hub
// can stay private (reachable only over a VPN). Plain fetch, no dependency.
//
// Out: one live message per task, edited in place as its steps advance; a new message (so the phone
// notifies) when a task is done, fails, is blocked or stuck, waits for the user (with its options as
// buttons), when a review fails and when a release or CI result lands; the lead's reply of each turn.
// In: /status /tasks /task /cancel /stop /new /sessions /phone /help; plain text is a new request; a
// button or a reply to a question is the answer. What the Mac must do goes to a per-client inbox
// (GET /api/inbox); with no Mac online, a request becomes a hub job instead.
//
// Only chats paired with a one-time code (`ekip phone link`) are served; anyone else gets no answer.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bar, esc, fitLines, splitMessage } from "./phone-format.js";
import { redact } from "./redact.js";
import { setLang, t } from "./i18n.js";

export const ONLINE_MS = 2 * 60_000;
export const CODE_MS = 10 * 60_000;
const FILE_MAX = 20 * 1024 * 1024; // the Bot API's download limit
const FILE_KEEP_MS = 7 * 86400_000;
const HELD = ["blocked", "waiting-user"];
// command names are English everywhere; only their descriptions follow the language
export const COMMANDS = [
  ["status", "çalışan ve bekleyen görevlerin özeti"],
  ["tasks", "son görevler"],
  ["task", "bir görevin adımları, işçileri ve notları"],
  ["cancel", "görevi iptal et (onay ister)"],
  ["stop", "lead'in çalışan turunu durdur (Esc)"],
  ["new", "projede yeni bir lead oturumu aç"],
  ["sessions", "açık lead oturumları, birini seç"],
  ["phone", "telefon modu: on, off, verbose on|off"],
  ["link", "telefonu bağla"],
  ["help", "bu yardım"],
];

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols: a random byte maps without bias
export const normCode = (c) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashCode = (c) => crypto.createHash("sha256").update(normCode(c)).digest("hex");
const newCode = (n = 8) => [...crypto.randomBytes(n)].map((x) => ALPHABET[x % 32]).join("");
const rid = (n = 6) => crypto.randomBytes(n).toString("hex");
const sleep = (ms) => new Promise((r) => { const x = setTimeout(r, ms); x.unref?.(); });
const clip = (s, n) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };

const fresh = () => ({
  chats: [], codes: [], fails: {}, offset: 0, mode: "on", verbose: false, quiet: null, lang: null, tz: null,
  live: {}, cb: {}, replies: {}, asks: {}, leads: [], leadsAt: null, release: null,
});

/** The registered project a request names (word match, longest name first); null when none or several. */
export function inferProject(text, names) {
  const s = String(text ?? "").toLowerCase();
  const hits = new Set();
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const e = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\p{L}\\p{N}_-])${e}($|[^\\p{L}\\p{N}_-])`, "u").test(s)) hits.add(n);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

export class Telegram {
  constructor({ token = "", store, fetch: fetchFn = globalThis.fetch, now = () => Date.now(), queueJob = null, release = null, secrets = [],
    filesDir = null, apiBase = "https://api.telegram.org", sendGapMs = 1000, editGapMs = 4000, log = console } = {}) {
    Object.assign(this, { token, store, fetch: fetchFn, now, queueJob, release, apiBase, sendGapMs, editGapMs, log, filesDir });
    this.enabled = !!token;
    this.secrets = [token, ...secrets].filter((s) => s && s.length >= 6);
    this.st = Object.assign(fresh(), store.phone.data ?? {});
    store.phone.data = this.st;
    if (token) this.adopt(token);
    if (this.st.lang) setLang(this.st.lang);
    this.chain = Promise.resolve();
    this.lastCall = 0;
    this.pendingLive = new Map(); // key -> { html, final }
    this.liveTimer = null;
    this.bot = null;
    this.gen = 0; // one poll loop per token: a loop from an older start() ends on its next turn
    this.source = token ? "env" : null;
  }

  save() { this.store.phone.data = this.st; this.store.phone.save(); }
  clean(s) { return redact(s, this.secrets); }
  /** Escaped and redacted: every piece of task or reply text goes through this. */
  R(s) { return esc(redact(s, this.secrets)); }
  paired(chat) { return chat != null && this.st.chats.some((c) => String(c.id) === String(chat)); }

  // ---- Bot API --------------------------------------------------------------------------------

  async api(method, body = {}, { signal, retry = true } = {}) {
    const r = await this.fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(20_000),
    });
    let j = null;
    try { j = await r.json(); } catch { /* not json */ }
    if (j?.ok) return j.result;
    if (j?.error_code === 429 && retry) {
      await sleep(Math.min(30, Number(j.parameters?.retry_after) || 1) * 1000);
      return this.api(method, body, { signal, retry: false });
    }
    const e = new Error(`${method}: ${j?.description ?? `HTTP ${r.status}`}`);
    e.code = j?.error_code ?? r.status;
    throw e;
  }

  /** One call at a time, spaced out (Telegram allows about one message a second per chat). */
  call(method, body) {
    const run = async () => {
      const wait = this.lastCall + this.sendGapMs - this.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = this.now();
      try { return await this.api(method, body); } catch (e) {
        if (!/not modified/i.test(e.message)) this.log.error(this.clean(`telegram ${e.message}`));
        return null;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  quiet(at = this.now()) {
    const q = this.st.quiet;
    if (!q?.from || !q?.to) return false;
    const mins = (hm) => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + (m || 0); };
    let parts;
    try { parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: q.tz || this.st.tz || "UTC" }).format(new Date(at)); } catch { parts = new Date(at).toISOString().slice(11, 16); }
    const n = mins(parts), a = mins(q.from), b = mins(q.to);
    return a <= b ? n >= a && n < b : n >= a || n < b;
  }

  async send(chat, html, { keyboard = null, silent = false, forceReply = false } = {}) {
    const body = { chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent || this.quiet() };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    else if (forceReply) body.reply_markup = { force_reply: true };
    const r = await this.call("sendMessage", body);
    return r?.message_id ?? null;
  }
  async broadcast(html, opts) {
    const out = {};
    for (const c of this.st.chats) { const id = await this.send(c.id, html, opts); if (id) out[c.id] = id; }
    return out;
  }
  edit(chat, id, html, keyboard = null) {
    return this.call("editMessageText", { chat_id: chat, message_id: id, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
  }
  dropKeyboard(chat, id) { return this.call("editMessageReplyMarkup", { chat_id: chat, message_id: id, reply_markup: { inline_keyboard: [] } }); }

  /** A short key for a button's payload (callback_data holds at most 64 bytes). */
  cbKey(payload) {
    const key = rid(4);
    this.st.cb[key] = { ...payload, at: new Date(this.now()).toISOString() };
    const keys = Object.keys(this.st.cb);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete this.st.cb[k];
    return key;
  }
  remember(chat, msg, payload) {
    if (!msg) return;
    this.st.replies[`${chat}:${msg}`] = payload;
    const keys = Object.keys(this.st.replies);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete this.st.replies[k];
  }

  // ---- running --------------------------------------------------------------------------------

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    const gen = ++this.gen;
    this.api("deleteWebhook", {}).catch(() => {});
    this.api("getMe", {}).then((me) => { if (this.gen === gen) this.bot = me?.username ?? null; }).catch((e) => this.log.error(this.clean(`telegram getMe: ${e.message}`)));
    this.api("setMyCommands", { commands: COMMANDS.map(([command, d]) => ({ command, description: t(d) })) }).catch(() => {});
    (async () => {
      let backoff = 1000;
      while (this.running && this.gen === gen) {
        try { await this.pollOnce(); backoff = 1000; } catch (e) {
          if (!this.running || this.gen !== gen) break;
          this.log.error(this.clean(`telegram poll: ${e.message}`));
          await sleep(backoff); backoff = Math.min(60_000, backoff * 2);
        }
      }
    })();
    if (this.release) {
      this.checkRelease(true);
      this.releaseTimer = setInterval(() => this.checkRelease(), 60_000);
      this.releaseTimer.unref?.();
    }
  }
  stop() { this.running = false; this.gen++; this.abort?.abort(); clearInterval(this.releaseTimer); clearTimeout(this.liveTimer); }

  /**
   * A new bot token at run time (`ekip phone setup`), or "" to turn the bot off: the poller stops and
   * starts again in this process, no restart. Another bot (its id is the token's part before ":")
   * cannot write to the old bot's chats, so its pairing, live messages and update offset are reset.
   */
  setToken(token = "", { start = true, source = "store" } = {}) {
    this.stop();
    if (token) this.adopt(token);
    this.token = token;
    this.enabled = !!token;
    this.source = token ? source : null;
    this.bot = null;
    if (token && !this.secrets.includes(token)) this.secrets.push(token);
    if (start && token) this.start();
  }

  adopt(token) {
    const id = String(token).split(":")[0];
    if (this.st.botId === id) return;
    if (this.st.botId) Object.assign(this.st, { chats: [], codes: [], live: {}, asks: {}, cb: {}, replies: {}, offset: 0 });
    this.st.botId = id;
    this.save();
  }

  /** The bot's @username for a token, without keeping it: getMe through the hub's own route to Telegram. */
  async probe(token) {
    const r = await this.fetch(`${this.apiBase}/bot${token}/getMe`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
    let j = null;
    try { j = await r.json(); } catch { /* not json */ }
    if (j?.ok) return j.result?.username ?? null;
    const e = new Error(`getMe: ${j?.description ?? `HTTP ${r.status}`}`);
    e.code = j?.error_code ?? r.status;
    throw e;
  }

  async pollOnce() {
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(40_000)]);
    const updates = await this.api("getUpdates", { offset: this.st.offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, { signal });
    for (const u of updates ?? []) await this.handleUpdate(u);
  }

  // ---- pairing --------------------------------------------------------------------------------

  /** A one-time code for `/link CODE` (10 minutes, single use). Only its hash is stored. */
  linkCode({ lang = null, tz = null } = {}) {
    const at = this.now();
    this.st.codes = this.st.codes.filter((c) => c.exp > at).slice(-4);
    const code = newCode();
    this.st.codes.push({ hash: hashCode(code), exp: at + CODE_MS });
    if (lang === "en" || lang === "tr") { this.st.lang = lang; setLang(lang); }
    if (tz) this.st.tz = String(tz).slice(0, 64);
    this.save();
    return { code, expiresAt: new Date(at + CODE_MS).toISOString(), bot: this.bot };
  }
  unlink() { Object.assign(this.st, { chats: [], codes: [], live: {}, asks: {}, cb: {}, replies: {} }); this.save(); }

  async tryLink(chat, code, m) {
    const at = this.now();
    const f = this.st.fails[chat];
    if (f && f.n >= 5 && at - f.at < CODE_MS) return; // guessing: stay silent
    const hash = hashCode(code);
    const i = this.st.codes.findIndex((c) => c.exp > at && crypto.timingSafeEqual(Buffer.from(c.hash), Buffer.from(hash)));
    if (i < 0 || m?.chat?.type !== "private") { this.st.fails[chat] = { n: (f && at - f.at < CODE_MS ? f.n : 0) + 1, at }; return; }
    this.st.codes.splice(i, 1);
    delete this.st.fails[chat];
    this.st.chats.push({ id: chat, at: new Date(at).toISOString() });
    this.save();
    await this.send(chat, esc(t("Telefon bağlandı. Görevler buraya gelecek; yazdığın her mesaj lead'e gider. Komutlar: /help")));
  }

  // ---- the Mac --------------------------------------------------------------------------------

  /** The client that synced its inbox in the last two minutes (the Mac), or null. */
  onlineClient() {
    const at = this.now();
    const list = Object.values(this.store.clients.data ?? {}).filter((c) => c.inboxAt && at - Date.parse(c.inboxAt) < ONLINE_MS);
    return list.sort((a, b) => b.inboxAt.localeCompare(a.inboxAt))[0]?.client ?? null;
  }
  macOnline() { return !!this.onlineClient(); }

  enqueue(item) {
    const it = { id: rid(6), client: this.onlineClient() ?? "mac", at: new Date(this.now()).toISOString(), ...item };
    this.store.inbox.data.push(it);
    while (this.store.inbox.data.length > 500) this.dropItem(this.store.inbox.data[0].id);
    this.store.inbox.save();
    return it;
  }
  dropItem(id) {
    const i = this.store.inbox.data.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [it] = this.store.inbox.data.splice(i, 1);
    for (const f of it.files ?? []) { const p = this.filePath(f.id); if (p) fs.rmSync(p, { force: true }); }
  }
  inbox(client) { return this.store.inbox.data.filter((x) => !client || !x.client || x.client === client); }
  ack(ids = []) { for (const id of ids) this.dropItem(String(id)); this.store.inbox.save(); }

  /** POST /api/inbox/sync: the Mac acks what it applied, says which leads are open, gets the rest. */
  sync({ client = "mac", host = null, ack = [], leads = null } = {}) {
    const at = new Date(this.now()).toISOString();
    if (Array.isArray(ack) && ack.length) this.ack(ack.slice(0, 500));
    const prev = this.store.clients.data[client];
    if (!prev && Object.keys(this.store.clients.data).length >= 200) throw new Error("too many clients");
    this.store.clients.data[client] = { ...(prev ?? { client, agents: [] }), client, host: host ?? prev?.host ?? null, lastSeen: at, inboxAt: at };
    this.store.clients.save();
    if (Array.isArray(leads)) {
      this.st.leads = leads.slice(0, 20).map((l) => ({ id: clip(l.id, 128), project: l.project ? clip(l.project, 64) : null, cwd: l.cwd ? clip(l.cwd, 300) : null, state: l.state === "busy" ? "busy" : "idle", target: l.target === true }));
      this.st.leadsAt = at;
      this.save();
    }
    return { items: this.inbox(client), phone: { enabled: this.enabled, linked: this.st.chats.length > 0, mode: this.st.mode, verbose: this.st.verbose } };
  }

  status() {
    return { enabled: this.enabled, source: this.source, bot: this.bot, chats: this.st.chats.length, mode: this.st.mode, verbose: this.st.verbose, quiet: this.st.quiet,
      macOnline: this.macOnline(), inbox: this.store.inbox.data.length, leads: this.st.leads, codes: this.st.codes.filter((c) => c.exp > this.now()).length };
  }
  settings({ mode, verbose, quiet } = {}) {
    if (mode === "on" || mode === "off") this.st.mode = mode;
    if (typeof verbose === "boolean") this.st.verbose = verbose;
    if (quiet === null) this.st.quiet = null;
    else if (quiet && /^\d{1,2}:\d{2}$/.test(quiet.from ?? "") && /^\d{1,2}:\d{2}$/.test(quiet.to ?? "")) this.st.quiet = { from: quiet.from, to: quiet.to, tz: quiet.tz ? String(quiet.tz).slice(0, 64) : this.st.tz };
    this.save();
    return this.status();
  }

  // ---- outbound: tasks ------------------------------------------------------------------------

  time(iso) {
    try { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: this.st.tz || "UTC" }).format(new Date(iso)); } catch { return String(iso).slice(11, 16); }
  }
  icon(task) {
    if (task.status === "done") return "✅";
    if (task.status === "failed") return "❌";
    if (task.status === "cancelled") return "⏹";
    if (task.ask || task.hold?.kind === "waiting-user") return "❓";
    if (task.hold?.kind === "blocked") return "⛔";
    if (task.paused) return "⏸";
    return "▶️";
  }
  head(task) { return `${this.icon(task)} <b>${this.R(task.title)}</b>${task.project ? ` · ${this.R(task.project)}` : ""}`; }

  /** The live message: title, progress bar, the current step, the estimate. */
  renderLive(task) {
    const steps = task.steps ?? [];
    const pct = task.status === "done" ? 100 : task.pct ?? 0;
    const lines = [this.head(task), bar(pct)];
    const i = steps.findIndex((s) => s.status === "running" || HELD.includes(s.status));
    if (task.status === "running" && i >= 0) {
      const s = steps[i];
      lines.push(`${t("adım {n}/{total}", { n: i + 1, total: steps.length })}: ${this.R(s.title)}${s.detail ? ` — ${this.R(clip(s.detail, 120))}` : ""}`);
    } else if (task.status !== "running") lines.push(t(task.status === "done" ? "bitti" : task.status === "failed" ? "başarısız" : "iptal"));
    if (task.status === "running" && task.eta) lines.push(`⏱ ${t("tahmini bitiş {time}", { time: this.time(task.eta) })}`);
    lines.push(`<code>${esc(task.id)}</code>`);
    return lines.join("\n");
  }

  /** PUT /api/tasks calls this with the stored task (or nothing) and the new one. */
  onTask(old, task) {
    if (!this.enabled || !this.st.chats.length || !task) return;
    if (!old && task.status !== "running") return; // a resent old task: nothing new happened
    if (task.status === "running" || this.st.live[`t:${task.id}`]) this.queueLive(`t:${task.id}`, this.renderLive(task), task.status !== "running");
    const tasks = [];
    if (old?.status !== task.status && task.status !== "running") tasks.push(() => this.notifyEnd(task));
    if (task.status === "running") {
      if (task.hold?.kind === "blocked" && (old?.hold?.kind !== "blocked" || old.hold.reason !== task.hold.reason)) tasks.push(() => this.notify(task, `⛔ <b>${t("Takıldı")}</b>`, task.hold.reason));
      if (task.paused && !old?.paused) tasks.push(() => this.notify(task, `⏸ <b>${t("Çalışan işçi yok, görev ilerlemiyor")}</b>`));
      const asked = task.ask && (!old?.ask || old.ask.at !== task.ask.at || old.ask.question !== task.ask.question);
      const waited = !task.ask && task.hold?.kind === "waiting-user" && (old?.hold?.kind !== "waiting-user" || old.hold.reason !== task.hold.reason);
      if (asked || waited) tasks.push(() => this.notifyAsk(task));
    }
    if (task.review?.state === "failed" && old?.review?.state !== "failed") tasks.push(() => this.notify(task, `❌ <b>${t("İnceleme düştü ({n} bulgu)", { n: task.review.findings ?? 0 })}</b>`));
    // the question was answered (here or on the Mac) or the task closed: its buttons go away
    const open = this.st.asks[task.id];
    if (open && (task.status !== "running" || (!task.ask && task.hold?.kind !== "waiting-user") || (task.ask && task.ask.at !== open.at))) {
      delete this.st.asks[task.id];
      delete this.st.cb[open.key];
      for (const [chat, id] of Object.entries(open.msgs ?? {})) tasks.push(() => this.dropKeyboard(chat, id));
    }
    const p = (async () => { for (const f of tasks) await f(); this.save(); })();
    this.last = p;
    return p;
  }

  async notify(task, title, text = "") {
    await this.broadcast([title, this.head(task), ...(text ? [this.R(clip(text, 600))] : []), `<code>${esc(task.id)}</code>`].join("\n"));
  }
  async notifyEnd(task) {
    const lines = [`${this.icon(task)} <b>${t(task.status === "done" ? "Görev bitti" : task.status === "failed" ? "Görev başarısız" : "Görev iptal edildi")}</b>`, this.head(task)];
    if (task.result?.text) lines.push(`${t("Sonuç")}: ${this.R(clip(task.result.text, 800))}`);
    for (const l of task.result?.links ?? []) lines.push(this.R(l));
    if (task.status !== "done") { const n = (task.notes ?? []).at(-1); if (n?.text) lines.push(this.R(clip(n.text, 400))); }
    lines.push(`<code>${esc(task.id)}</code>`);
    await this.broadcast(lines.join("\n"));
  }
  async notifyAsk(task) {
    const question = task.ask?.question || task.hold?.reason || "";
    const options = task.ask?.options ?? [];
    const key = this.cbKey({ kind: "ask", task: task.id, question, options });
    const keyboard = [...options.map((o, i) => [{ text: clip(o, 60), callback_data: `k:${key}:${i}` }]), [{ text: t("Diğer…"), callback_data: `k:${key}:o` }]];
    const msgs = await this.broadcast([`❓ <b>${t("Senden bir karar bekleniyor")}</b>`, this.head(task), "", this.R(clip(question, 800)), `<code>${esc(task.id)}</code>`].join("\n"), { keyboard });
    for (const [chat, id] of Object.entries(msgs)) this.remember(chat, id, { kind: "answer", task: task.id, question });
    this.st.asks[task.id] = { key, msgs, at: task.ask?.at ?? null };
  }

  // Live messages (tasks and verbose turns) are coalesced: at most one edit per message every
  // editGapMs; the newest text wins. The first one is sent silent.
  queueLive(key, html, final = false) {
    this.pendingLive.set(key, { html, final: final || this.pendingLive.get(key)?.final === true });
    if (!this.liveTimer) { this.liveTimer = setTimeout(() => { this.liveTimer = null; this.flushLive(); }, 50); this.liveTimer.unref?.(); }
  }
  async flushLive() {
    let later = Infinity;
    for (const [key, { html, final }] of [...this.pendingLive]) {
      const e = this.st.live[key];
      if (!e) {
        this.pendingLive.delete(key);
        if (final) continue;
        this.st.live[key] = { msgs: {}, html, at: this.now() };
        this.st.live[key].msgs = await this.broadcast(html, { silent: true });
        continue;
      }
      const wait = e.at + this.editGapMs - this.now();
      if (wait > 0 && !final) { later = Math.min(later, wait); continue; }
      this.pendingLive.delete(key);
      if (html !== e.html) { e.html = html; e.at = this.now(); for (const [chat, id] of Object.entries(e.msgs)) await this.edit(chat, id, html); }
      if (final) delete this.st.live[key];
    }
    this.save();
    if (later < Infinity && !this.liveTimer) { this.liveTimer = setTimeout(() => { this.liveTimer = null; this.flushLive(); }, later); this.liveTimer.unref?.(); }
  }
  /** Sends what is pending now (tests, shutdown). */
  async flush() { clearTimeout(this.liveTimer); this.liveTimer = null; await this.last; await this.flushLive(); await this.chain; }

  // ---- outbound: the lead's turns --------------------------------------------------------------

  /** POST /api/phone/reply: the lead's last message of a turn (Stop hook). */
  async reply({ lead = null, project = null, text = "", phoneTurn = false } = {}) {
    if (!this.enabled || !this.st.chats.length) return { sent: false };
    const turn = lead ? `l:${lead}` : null;
    if (turn && this.st.live[turn]) { this.queueLive(turn, this.renderTurn(project, this.turnLines?.[turn] ?? [], true), true); await this.flushLive(); }
    if (this.st.mode === "off" && !phoneTurn) return { sent: false };
    const body = String(text ?? "").trim();
    if (!body) return { sent: false };
    const md = `${project ? `**💬 ${project}**\n\n` : ""}${redact(body, this.secrets)}`;
    let n = 0;
    for (const html of splitMessage(md)) { await this.broadcast(html); n++; }
    return { sent: true, messages: n };
  }
  renderTurn(project, lines, done = false) {
    return [`${done ? "✓" : "⏳"} <b>${this.R(project ?? "lead")}</b> · ${done ? t("tur bitti") : t("çalışıyor ({n} araç)", { n: lines.length })}`, ...lines.slice(-6).map((l) => `• ${this.R(clip(l, 120))}`)].join("\n");
  }
  /** POST /api/phone/activity: the latest tool calls of the running turn (ekip phone verbose on). */
  activity({ lead = null, project = null, lines = [] } = {}) {
    if (!this.enabled || !this.st.chats.length || !this.st.verbose || !lead) return { ok: false };
    const key = `l:${lead}`;
    (this.turnLines ??= {})[key] = (Array.isArray(lines) ? lines : []).slice(-20).map((l) => clip(l, 200));
    this.queueLive(key, this.renderTurn(project, this.turnLines[key]));
    return { ok: true };
  }

  async checkRelease(first = false) {
    let info;
    try { info = this.release(); } catch { return; }
    const ci = info?.ci;
    const key = { version: info?.version ?? null, ci: ci?.sha && ci?.finishedAt ? `${ci.sha}:${ci.status}:${ci.finishedAt}` : null };
    const prev = this.st.release;
    this.st.release = key;
    if (first || !prev || !this.st.chats.length) { this.save(); return; }
    if (key.version && key.version !== prev.version) await this.broadcast(`🚀 <b>${esc(t("Yayın: {version} hazır", { version: key.version }))}</b>`);
    if (key.ci && key.ci !== prev.ci) {
      const sha = esc(String(ci.sha).slice(0, 7));
      if (ci.status === "failed" || ci.status === "fail") await this.broadcast(`❌ ${esc(t("CI düştü ({step}) · {sha}", { step: ci.step ?? "?", sha }))}`);
      else if (ci.status === "passed" || ci.status === "pass" || ci.status === "ok") await this.broadcast(`✅ ${esc(t("CI geçti · {sha}", { sha }))}`, { silent: true });
    }
    this.save();
  }

  // ---- inbound --------------------------------------------------------------------------------

  async handleUpdate(u) {
    if (Number.isInteger(u?.update_id)) this.st.offset = Math.max(this.st.offset, u.update_id + 1);
    try {
      if (u?.callback_query) await this.onCallback(u.callback_query);
      else if (u?.message) await this.onMessage(u.message);
    } catch (e) { this.log.error(this.clean(`telegram update: ${e.message}`)); }
    this.save();
  }

  async onMessage(m) {
    const chat = m.chat?.id;
    if (chat == null) return;
    const text = String(m.text ?? m.caption ?? "").trim();
    const cmd = text.match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (!this.paired(chat)) {
      // only the code: a pasted "(@bot)" or anything after the first word is not part of it (31 Oct)
      if (cmd?.[1].toLowerCase() === "link" && cmd[2]) await this.tryLink(chat, cmd[2].trim().split(/\s+/)[0], m);
      return; // a stranger gets no answer at all
    }
    const rep = m.reply_to_message ? this.st.replies[`${chat}:${m.reply_to_message.message_id}`] : null;
    if (rep?.kind === "answer" && text && !cmd) return this.answer(chat, rep.task, text);
    if (cmd) return this.command(chat, cmd[1].toLowerCase(), (cmd[2] ?? "").trim());
    const files = await this.download(m);
    if (!text && !files.length) return;
    return this.request(chat, text, files);
  }

  async command(chat, name, arg) {
    const say = (s, opts) => this.send(chat, s, opts);
    const tasks = this.store.tasks.data ?? [];
    const find = (id) => tasks.find((x) => x.id === id) ?? tasks.find((x) => id && x.id.startsWith(id));
    switch (name) {
      case "start": case "help":
        return say([`<b>${esc(t("Komutlar"))}</b>`, ...COMMANDS.filter(([c]) => c !== "link").map(([c, d]) => `/${c} — ${esc(t(d))}`), "", esc(t("Düz metin yeni bir istektir; bir soruya düğmeyle ya da yanıtlayarak cevap verirsin."))].join("\n"));
      case "link": return say(esc(t("Bu sohbet zaten bağlı.")));
      case "status": return say(this.statusText());
      case "tasks": {
        const list = [...tasks].sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt))).slice(0, 12);
        return say(list.length ? list.map((x) => `${this.icon(x)} ${this.R(clip(x.title, 70))} · ${x.status === "done" ? 100 : x.pct ?? 0}% · <code>${esc(x.id)}</code>`).join("\n") : esc(t("Görev yok.")));
      }
      case "task": {
        if (!arg) return say(esc(t("kullanım: {usage}", { usage: "/task <id>" })));
        const x = find(arg);
        return say(x ? this.taskText(x) : esc(t("Böyle bir görev yok: {id}", { id: clip(arg, 40) })));
      }
      case "cancel": {
        if (!arg) return say(esc(t("kullanım: {usage}", { usage: "/cancel <id>" })));
        const x = find(arg);
        if (!x || x.status !== "running") return say(esc(t("Böyle bir görev yok: {id}", { id: clip(arg, 40) })));
        const key = this.cbKey({ kind: "cancel", task: x.id });
        return say(`${esc(t("Bu görev iptal edilsin mi?"))}\n${this.head(x)}`, { keyboard: [[{ text: t("Evet, iptal et"), callback_data: `k:${key}:y` }, { text: t("Hayır"), callback_data: `k:${key}:n` }]] });
      }
      case "stop":
        if (!this.macOnline()) return say(esc(t("Mac çevrimdışı; durdurulacak bir tur yok.")));
        this.enqueue({ kind: "stop", chat });
        return say(esc(t("Esc lead'e gönderiliyor.")), { silent: true });
      case "new": {
        if (!this.macOnline()) return say(esc(t("Mac çevrimdışı; yeni oturum açılamaz.")));
        const names = (this.store.projects.data ?? []).map((p) => p.name);
        if (arg) {
          const project = names.find((n) => n.toLowerCase() === arg.toLowerCase());
          if (!project) return say(esc(t("Böyle bir proje yok: {name}", { name: clip(arg, 64) })));
          this.enqueue({ kind: "new", project, chat });
          return say(esc(t("{project} için yeni lead açılıyor; sonraki mesajlar ona gider.", { project })));
        }
        if (!names.length) return say(esc(t("Hub'da kayıtlı proje yok (ekip project sync).")));
        const key = this.cbKey({ kind: "new", projects: names.slice(0, 24) });
        return say(esc(t("Hangi projede?")), { keyboard: this.grid(names.slice(0, 24), key) });
      }
      case "sessions": {
        const leads = this.st.leadsAt && this.now() - Date.parse(this.st.leadsAt) < ONLINE_MS ? this.st.leads : [];
        if (!leads.length) return say(esc(t("Açık lead oturumu yok.")));
        const key = this.cbKey({ kind: "lead", leads: leads.map((l) => ({ id: l.id, name: l.project ?? path.basename(l.cwd ?? "") ?? l.id })) });
        return say(esc(t("Lead oturumları (mesajların gideceğini seç):")), { keyboard: leads.map((l, i) => [{ text: `${l.target ? "● " : ""}${clip(l.project ?? path.basename(l.cwd ?? "") ?? l.id, 40)} · ${l.state === "busy" ? t("çalışıyor…") : t("boşta")}`, callback_data: `k:${key}:${i}` }]) });
      }
      case "phone": {
        const [a, b] = arg.toLowerCase().split(/\s+/);
        if (a === "on" || a === "off") this.settings({ mode: a });
        else if (a === "verbose" && (b === "on" || b === "off")) this.settings({ verbose: b === "on" });
        return say([esc(t(this.st.mode === "on" ? "Telefon modu: açık (her turun cevabı buraya gelir)" : "Telefon modu: kapalı (yalnız telefondan başlayan turlar)")), esc(t(this.st.verbose ? "Ayrıntılı mod: açık (araç çağrıları canlı mesajda)" : "Ayrıntılı mod: kapalı"))].join("\n"));
      }
      default: return say(esc(t("Bilinmeyen komut. /help")));
    }
  }
  grid(names, key, cols = 2) {
    const rows = [];
    names.forEach((n, i) => { if (i % cols === 0) rows.push([]); rows.at(-1).push({ text: clip(n, 30), callback_data: `k:${key}:${i}` }); });
    return rows;
  }

  statusText() {
    const tasks = this.store.tasks.data ?? [];
    const run = tasks.filter((x) => x.status === "running");
    const waiting = run.filter((x) => x.ask || x.hold?.kind === "waiting-user");
    const stuck = run.filter((x) => x.hold?.kind === "blocked" || x.paused);
    const done = tasks.filter((x) => x.status === "done" && x.endedAt && this.now() - Date.parse(x.endedAt) < 86400_000);
    const lines = [`<b>ekip</b> · ${this.macOnline() ? `🟢 ${esc(t("Mac çevrimiçi"))}` : `⚪ ${esc(t("Mac çevrimdışı (istekler VPS kuyruğuna gider)"))}`}`,
      esc(`${t("çalışıyor")}: ${run.length} · ${t("senden bekleniyor")}: ${waiting.length} · ${t("takıldı")}: ${stuck.length} · ${t("son 24 saatte biten")}: ${done.length}`), ""];
    if (!run.length) lines.push(esc(t("Çalışan görev yok.")));
    for (const x of run.slice(0, 10)) {
      const s = (x.steps ?? []).find((y) => y.status === "running" || HELD.includes(y.status));
      lines.push(`${this.icon(x)} ${this.R(clip(x.title, 60))} · ${x.pct ?? 0}%${s ? ` · ${this.R(clip(s.title, 40))}` : ""} · <code>${esc(x.id)}</code>`);
    }
    return lines.join("\n");
  }
  taskText(x) {
    const G = { done: "✓", running: "▶", pending: "·", failed: "✗", skipped: "⏭", blocked: "⛔", "waiting-user": "❓" };
    const lines = [this.head(x), bar(x.status === "done" ? 100 : x.pct ?? 0), "", `<b>${esc(t("Adımlar"))}</b>`];
    (x.steps ?? []).forEach((s, i) => lines.push(`${G[s.status] ?? "·"} ${i + 1}. ${this.R(clip(s.title, 80))}${s.detail ? ` — ${this.R(clip(s.detail, 80))}` : ""}`));
    if (x.workers?.length) { lines.push("", `<b>${esc(t("İşçiler"))}</b>`); for (const w of x.workers.slice(-6)) lines.push(`• ${this.R([w.via, w.label, w.status].filter(Boolean).join(" · "))}`); }
    const notes = (x.notes ?? []).slice(-3);
    if (notes.length) { lines.push("", `<b>${esc(t("Son notlar"))}</b>`); for (const n of notes) lines.push(`• ${this.R(clip(n.text, 300))}`); }
    if (x.result?.text || x.result?.links?.length) { lines.push("", `<b>${esc(t("Sonuç"))}</b>: ${this.R(clip(x.result.text ?? "", 600))}`); for (const l of x.result.links ?? []) lines.push(this.R(l)); }
    return fitLines(lines, 4000, [`<code>${esc(x.id)}</code>`]);
  }

  async onCallback(q) {
    const chat = q.message?.chat?.id;
    if (!this.paired(chat)) return; // no answer at all
    await this.call("answerCallbackQuery", { callback_query_id: q.id });
    const [, key, choice] = String(q.data ?? "").match(/^k:([a-f0-9]{1,16}):(\w{1,4})$/) ?? [];
    const p = key ? this.st.cb[key] : null;
    if (!p) return this.send(chat, esc(t("Bu soru artık geçerli değil.")), { silent: true });
    const msg = q.message?.message_id;
    const pick = (list) => (/^\d+$/.test(choice) ? list?.[Number(choice)] : undefined);
    if (p.kind === "ask") {
      if (choice === "o") {
        const id = await this.send(chat, `${esc(t("Cevabını yaz:"))}\n${this.R(clip(p.question, 600))}`, { forceReply: true });
        this.remember(chat, id, { kind: "answer", task: p.task, question: p.question });
        return;
      }
      const c = pick(p.options);
      if (c == null) return;
      return this.answer(chat, p.task, c);
    }
    delete this.st.cb[key];
    if (msg) await this.dropKeyboard(chat, msg);
    if (p.kind === "cancel") {
      if (choice !== "y") return this.send(chat, esc(t("Vazgeçildi.")), { silent: true });
      const online = this.macOnline();
      this.enqueue({ kind: "cancel", task: p.task, chat });
      return this.send(chat, esc(t(online ? "İptal Mac'e iletildi." : "İptal kaydedildi; Mac açılınca uygulanır.")));
    }
    if (p.kind === "job") { const project = pick(p.projects); if (project) return this.queue(chat, project, p.text, p.why); return; }
    if (p.kind === "new") {
      const project = pick(p.projects);
      if (!project) return;
      this.enqueue({ kind: "new", project, chat });
      return this.send(chat, esc(t("{project} için yeni lead açılıyor; sonraki mesajlar ona gider.", { project })));
    }
    if (p.kind === "lead") {
      const l = pick(p.leads);
      if (!l) return;
      this.enqueue({ kind: "select", lead: l.id, chat });
      return this.send(chat, esc(t("Mesajlar artık bu oturuma gidiyor: {name}", { name: l.name })), { silent: true });
    }
  }

  /** An answer to a task's question: to the Mac's inbox (applied there, or when it is back). */
  async answer(chat, taskId, choice) {
    const task = (this.store.tasks.data ?? []).find((x) => x.id === taskId);
    if (!task || task.status !== "running" || (!task.ask && task.hold?.kind !== "waiting-user")) return this.send(chat, esc(t("Bu soru artık geçerli değil.")), { silent: true });
    const text = clip(choice, 500);
    const online = this.macOnline();
    this.enqueue({ kind: "answer", task: taskId, choice: text, chat });
    const open = this.st.asks[taskId];
    if (open) { delete this.st.asks[taskId]; delete this.st.cb[open.key]; for (const [c, id] of Object.entries(open.msgs ?? {})) await this.dropKeyboard(c, id); }
    return this.send(chat, this.R(t(online ? "Cevap Mac'e iletildi: {choice}" : "Cevap kaydedildi; Mac açılınca uygulanır: {choice}", { choice: text })), { silent: true });
  }

  /** Plain text (and files): to the live lead through the Mac, else a hub job. */
  async request(chat, text, files = []) {
    if (this.macOnline()) {
      this.enqueue({ kind: "request", text: text.slice(0, 8000), files, chat });
      return this.send(chat, esc(t("Lead'e iletildi.")), { silent: true });
    }
    if (files.length) {
      this.enqueue({ kind: "request", text, files, chat });
      return this.send(chat, esc(t("Mac çevrimdışı; dosya Mac açılınca lead'e gider.")));
    }
    return this.toJob(chat, text);
  }

  /** A request for the VPS queue: the project it names, else buttons to pick one. */
  async toJob(chat, text, { project = null, why = "offline" } = {}) {
    chat ??= this.st.chats[0]?.id;
    if (chat == null) return null;
    const names = (this.store.projects.data ?? []).map((p) => p.name);
    const name = project && names.includes(project) ? project : inferProject(text, names);
    if (name) return this.queue(chat, name, text, why);
    if (!names.length) return this.send(chat, esc(t("Hub'da kayıtlı proje yok (ekip project sync).")));
    const key = this.cbKey({ kind: "job", text: String(text).slice(0, 8000), projects: names.slice(0, 24), why });
    // "offline" only when the Mac really is; with the Mac on and no lead open it says so (31 Oct: it said offline)
    return this.send(chat, esc(t(why === "nolead" ? "Mac açık ama açık bir lead oturumu yok. Bu iş VPS kuyruğunda hangi projede çalışsın?" : "Mac çevrimdışı. Bu iş hangi projede çalışsın?")), { keyboard: this.grid(names.slice(0, 24), key) });
  }
  async queue(chat, project, text, why = "offline") {
    if (!this.queueJob) return null;
    let job;
    try { job = await this.queueJob({ project, task: text }); } catch (e) { return this.send(chat, this.R(t("İş kuyruğa alınamadı: {error}", { error: e.message }))); }
    await this.send(chat, this.R(t(why === "nolead" ? "Lead açık değil; iş VPS kuyruğuna gitti: {project} · {id}" : "Mac çevrimdışı; iş VPS kuyruğuna gitti: {project} · {id}", { project, id: job.id })));
    return job;
  }

  // ---- files ----------------------------------------------------------------------------------

  filePath(id) {
    if (!this.filesDir || !/^[a-f0-9]{12}$/.test(String(id))) return null;
    return path.join(this.filesDir, String(id));
  }
  /** Photos and documents of a message: kept on the hub until the Mac fetched them. */
  async download(m) {
    if (!this.filesDir) return [];
    const photo = m.photo?.length ? m.photo.reduce((a, b) => ((b.file_size ?? 0) >= (a.file_size ?? 0) ? b : a)) : null;
    const want = [
      ...(photo ? [{ file_id: photo.file_id, name: `photo-${m.message_id}.jpg`, size: photo.file_size }] : []),
      ...[m.document, m.video, m.audio, m.voice].filter(Boolean).map((d) => ({ file_id: d.file_id, name: d.file_name ?? `file-${m.message_id}${d.mime_type === "audio/ogg" ? ".ogg" : ""}`, size: d.file_size })),
    ];
    if (!want.length) return [];
    fs.mkdirSync(this.filesDir, { recursive: true });
    // old files nobody fetched
    for (const f of fs.readdirSync(this.filesDir)) { try { const p = path.join(this.filesDir, f); if (this.now() - fs.statSync(p).mtimeMs > FILE_KEEP_MS) fs.rmSync(p, { force: true }); } catch { /* gone */ } }
    const out = [];
    for (const w of want) {
      if ((w.size ?? 0) > FILE_MAX) continue;
      try {
        const f = await this.api("getFile", { file_id: w.file_id });
        const r = await this.fetch(`${this.apiBase}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > FILE_MAX) continue;
        const id = rid(6);
        fs.writeFileSync(path.join(this.filesDir, id), buf, { mode: 0o600 });
        out.push({ id, name: String(w.name).replace(/[^\w.-]+/g, "_").slice(-80) || id, size: buf.length });
      } catch (e) { this.log.error(this.clean(`telegram file: ${e.message}`)); }
    }
    return out;
  }
}
