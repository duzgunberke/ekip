// The phone bot against a fake Telegram API (an injected fetch): no real network call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "./store.js";
import { Telegram, inferProject, CODE_MS } from "./telegram.js";
import { redact } from "./redact.js";
import { mdToHtml, splitMessage, cutEscaped, fitLines, LIMIT } from "./phone-format.js";

// Secret-shaped fixtures are assembled at run time so the repository privacy check stays clean.
const FAKE_SK = "sk" + "-abcdefghijklmnopqrstuvwx";
const FAKE_GHP = "ghp" + "_abcdefghijklmnopqrstuvwxyz0123";
const PEM_KIND = "RSA PRIVATE" + " KEY";
const FAKE_PEM = `-----BEGIN ${PEM_KIND}-----\nMIIE\n-----END ${PEM_KIND}-----`;

// the bot's texts follow EKIP_LANG first; these tests read the English ones
delete process.env.EKIP_LANG;
const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const CHAT = 4242;

function fake() {
  const calls = [];
  let next = 100;
  const fetch = async (url, init = {}) => {
    const m = String(url).match(/\/bot[^/]+\/(\w+)$/);
    if (!m) return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => Buffer.from("PHOTO-BYTES") };
    const method = m[1];
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    const result = method === "sendMessage" ? { message_id: next++ } : method === "getFile" ? { file_path: "photos/a.jpg" } : method === "getMe" ? { username: "test_bot" } : true;
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  return { calls, fetch, of: (method) => calls.filter((c) => c.method === method) };
}

function setup({ online = true, projects = ["shop-web", "api"] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-phone-"));
  const store = openStore(dir);
  store.projects.data = projects.map((name) => ({ name }));
  let clock = Date.parse("2026-10-31T10:00:00Z");
  const jobs = [];
  const api = fake();
  const tg = new Telegram({ token: TOKEN, store, fetch: api.fetch, now: () => clock, sendGapMs: 0, editGapMs: 0, filesDir: path.join(dir, "files"),
    queueJob: ({ project, task }) => { const j = { id: `job${jobs.length + 1}`, project, task }; jobs.push(j); return j; }, log: { error() {} } });
  if (online) tg.sync({ client: "mac", leads: [] });
  return { tg, store, api, jobs, dir, tick: (ms) => { clock += ms; } };
}
const msg = (text, extra = {}) => ({ update_id: Math.floor(Math.random() * 1e6), message: { message_id: 1, chat: { id: CHAT, type: "private" }, text, ...extra } });
async function paired(s) {
  const { code } = s.tg.linkCode({ lang: "en" });
  await s.tg.handleUpdate(msg(`/link ${code}`));
  await s.tg.flush();
  s.api.calls.length = 0;
}

test("pairing: a code works once, expires after ten minutes, and strangers get no answer", async () => {
  const s = setup();
  // an unpaired chat: nothing at all, not even for a command
  await s.tg.handleUpdate(msg("/status"));
  await s.tg.handleUpdate(msg("hello"));
  await s.tg.handleUpdate(msg("/link WRONGCODE"));
  await s.tg.flush();
  assert.equal(s.api.calls.length, 0);

  const { code } = s.tg.linkCode({ lang: "en" });
  assert.match(code, /^[A-Z2-9]{8}$/);
  assert.ok(!JSON.stringify(s.store.phone.data).includes(code), "only the code's hash is stored");
  // pasted with the bot's name after it, as the CLI used to print it
  await s.tg.handleUpdate(msg(`/link ${code.toLowerCase()}  (@ekip_test_bot)`));
  await s.tg.flush();
  assert.equal(s.store.phone.data.chats.length, 1);
  assert.equal(s.api.of("sendMessage").length, 1);

  // the same code a second time, from another chat: silence
  await s.tg.handleUpdate({ update_id: 9, message: { message_id: 2, chat: { id: 777, type: "private" }, text: `/link ${code}` } });
  await s.tg.flush();
  assert.equal(s.store.phone.data.chats.length, 1);
  assert.equal(s.api.of("sendMessage").length, 1);

  // an expired code
  const late = s.tg.linkCode();
  s.tick(CODE_MS + 1000);
  await s.tg.handleUpdate({ update_id: 10, message: { message_id: 3, chat: { id: 778, type: "private" }, text: `/link ${late.code}` } });
  assert.equal(s.store.phone.data.chats.length, 1);

  // a group chat cannot pair even with a good code
  const g = s.tg.linkCode();
  await s.tg.handleUpdate({ update_id: 11, message: { message_id: 4, chat: { id: -5, type: "group" }, text: `/link ${g.code}` } });
  assert.equal(s.store.phone.data.chats.length, 1);
  // callbacks from strangers are ignored too
  s.api.calls.length = 0;
  await s.tg.handleUpdate({ update_id: 12, callback_query: { id: "q", data: "k:abc:0", message: { message_id: 5, chat: { id: 999 } } } });
  await s.tg.flush();
  assert.equal(s.api.calls.length, 0);
});

const task = (over = {}) => ({ id: "g1", title: "Build the landing page", project: "shop-web", status: "running", pct: 10, steps: [{ title: "Design", status: "running" }, { title: "Build", status: "pending" }], notes: [], workers: [], ...over });

test("a task gets one live message that is edited in place; done, blocked and waiting send new ones", async () => {
  const s = setup();
  await paired(s);
  const t1 = task();
  s.tg.onTask(null, t1); await s.tg.flush();
  assert.equal(s.api.of("sendMessage").length, 1, "the live message");
  assert.equal(s.api.of("sendMessage")[0].body.disable_notification, true, "the live message is silent");
  assert.match(s.api.of("sendMessage")[0].body.text, /Design/);

  const t2 = task({ pct: 55, steps: [{ title: "Design", status: "done" }, { title: "Build", status: "running" }] });
  s.tg.onTask(t1, t2); await s.tg.flush();
  assert.equal(s.api.of("sendMessage").length, 1, "a step advancing edits, it does not send");
  assert.equal(s.api.of("editMessageText").length, 1);
  assert.match(s.api.of("editMessageText")[0].body.text, /Build/);
  assert.match(s.api.of("editMessageText")[0].body.text, /55%/);

  const t3 = { ...t2, hold: { kind: "blocked", reason: "waiting for the API key" } };
  s.tg.onTask(t2, t3); await s.tg.flush();
  const blocked = s.api.of("sendMessage").at(-1);
  assert.equal(s.api.of("sendMessage").length, 2);
  assert.match(blocked.body.text, /Blocked/);
  assert.notEqual(blocked.body.disable_notification, true, "a blocked task notifies");

  const t4 = { ...t2, hold: { kind: "waiting-user", reason: "Which colour?" }, ask: { question: "Which colour?", options: ["Blue", "Green"], at: "2026-10-31T10:01:00Z" } };
  s.tg.onTask(t3, t4); await s.tg.flush();
  const ask = s.api.of("sendMessage").at(-1);
  const rows = ask.body.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((r) => r[0].text), ["Blue", "Green", "Other…"]);

  const t5 = { ...t2, hold: null, ask: null, status: "done", pct: 100, result: { text: "Landing page live", links: ["https://example.com/pr/1"] } };
  s.tg.onTask(t4, t5); await s.tg.flush();
  const done = s.api.of("sendMessage").at(-1);
  assert.match(done.body.text, /Task done/);
  assert.match(done.body.text, /Landing page live/);
  assert.match(done.body.text, /example\.com\/pr\/1/);
  assert.ok(s.api.of("editMessageText").some((c) => /100%/.test(c.body.text)), "the live message ends at 100%");
  assert.ok(s.api.of("editMessageReplyMarkup").length >= 1, "the question's buttons go away");

  // the same done task resent (a sync): nothing new
  const before = s.api.calls.length;
  s.tg.onTask(t5, t5); await s.tg.flush();
  assert.equal(s.api.calls.length, before);
});

test("a failed review notifies", async () => {
  const s = setup();
  await paired(s);
  const a = task();
  s.tg.onTask(null, a); await s.tg.flush();
  s.tg.onTask(a, { ...a, review: { state: "failed", findings: 3 } }); await s.tg.flush();
  assert.match(s.api.of("sendMessage").at(-1).body.text, /Review failed \(3 findings\)/);
});

test("a button answers the question: it lands in the Mac's inbox", async () => {
  const s = setup();
  await paired(s);
  const t = task({ hold: { kind: "waiting-user", reason: "Which colour?" }, ask: { question: "Which colour?", options: ["Blue", "Green"], at: "x" } });
  s.store.tasks.data = [t];
  s.tg.onTask(null, t); await s.tg.flush();
  const ask = s.api.of("sendMessage").find((c) => c.body.reply_markup);
  const green = ask.body.reply_markup.inline_keyboard[1][0].callback_data;
  assert.ok(Buffer.byteLength(green) <= 64);
  await s.tg.handleUpdate({ update_id: 50, callback_query: { id: "cq1", data: green, message: { message_id: 101, chat: { id: CHAT } } } });
  await s.tg.flush();
  assert.equal(s.api.of("answerCallbackQuery").length, 1);
  const items = s.tg.sync({ client: "mac" }).items;
  assert.equal(items.length, 1);
  assert.deepEqual({ kind: items[0].kind, task: items[0].task, choice: items[0].choice }, { kind: "answer", task: "g1", choice: "Green" });
  // the Mac acks it: gone
  assert.equal(s.tg.sync({ client: "mac", ack: [items[0].id] }).items.length, 0);

  // "Other…" asks for a reply, and the reply is the answer
  const other = ask.body.reply_markup.inline_keyboard[2][0].callback_data;
  s.tg.onTask(t, { ...t, ask: { ...t.ask, at: "y" } }); await s.tg.flush();
  const again = s.api.of("sendMessage").filter((c) => c.body.reply_markup?.inline_keyboard).at(-1);
  const other2 = again.body.reply_markup.inline_keyboard.at(-1)[0].callback_data;
  assert.notEqual(other, other2);
  await s.tg.handleUpdate({ update_id: 51, callback_query: { id: "cq2", data: other2, message: { message_id: 102, chat: { id: CHAT } } } });
  await s.tg.flush();
  const prompt = s.api.of("sendMessage").at(-1);
  assert.equal(prompt.body.reply_markup.force_reply, true);
  const promptId = 100 + s.api.of("sendMessage").length - 1;
  await s.tg.handleUpdate(msg("Purple, please", { reply_to_message: { message_id: promptId } }));
  await s.tg.flush();
  const it = s.tg.sync({ client: "mac" }).items.at(-1);
  assert.equal(it.kind, "answer");
  assert.equal(it.choice, "Purple, please");
});

test("plain text: to the Mac when it is online, a hub job when it is off", async () => {
  const s = setup();
  await paired(s);
  await s.tg.handleUpdate(msg("fix the checkout bug in shop-web"));
  await s.tg.flush();
  const items = s.tg.sync({ client: "mac" }).items;
  assert.equal(items.at(-1).kind, "request");
  assert.equal(items.at(-1).text, "fix the checkout bug in shop-web");
  assert.equal(s.jobs.length, 0);

  // the Mac goes quiet for more than two minutes
  s.tick(3 * 60_000);
  assert.equal(s.tg.macOnline(), false);
  await s.tg.handleUpdate(msg("fix the checkout bug in shop-web"));
  await s.tg.flush();
  assert.equal(s.jobs.length, 1);
  assert.deepEqual(s.jobs[0], { id: "job1", project: "shop-web", task: "fix the checkout bug in shop-web" });
  assert.match(s.api.of("sendMessage").at(-1).body.text, /VPS queue/);

  // no project named: buttons to pick one, and the pick queues the job
  await s.tg.handleUpdate(msg("write the release notes"));
  await s.tg.flush();
  const pick = s.api.of("sendMessage").at(-1);
  assert.equal(s.jobs.length, 1);
  const api = pick.body.reply_markup.inline_keyboard.flat().find((b) => b.text === "api");
  await s.tg.handleUpdate({ update_id: 60, callback_query: { id: "c", data: api.callback_data, message: { message_id: 1, chat: { id: CHAT } } } });
  await s.tg.flush();
  assert.equal(s.jobs.length, 2);
  assert.equal(s.jobs[1].project, "api");
});

test("an answer while the Mac is off is kept until it is back", async () => {
  const s = setup();
  await paired(s);
  const t = task({ hold: { kind: "waiting-user", reason: "Ship it?" }, ask: { question: "Ship it?", options: ["Yes", "No"], at: "x" } });
  s.store.tasks.data = [t];
  s.tg.onTask(null, t); await s.tg.flush();
  s.tick(5 * 60_000);
  const ask = s.api.of("sendMessage").find((c) => c.body.reply_markup);
  await s.tg.handleUpdate({ update_id: 70, callback_query: { id: "c", data: ask.body.reply_markup.inline_keyboard[0][0].callback_data, message: { message_id: 101, chat: { id: CHAT } } } });
  await s.tg.flush();
  assert.match(s.api.of("sendMessage").at(-1).body.text, /applied when the Mac is back/);
  assert.equal(s.jobs.length, 0);
  s.tick(60 * 60_000);
  const items = s.tg.sync({ client: "mac" }).items;
  assert.equal(items[0].kind, "answer");
  assert.equal(items[0].choice, "Yes");
});

test("commands: /status, /task, /cancel with a confirm button, /stop, /new, /sessions", async () => {
  const s = setup();
  await paired(s);
  s.store.tasks.data = [task({ notes: [{ text: "deployed with token=supersecretvalue123" }] })];
  await s.tg.handleUpdate(msg("/status")); await s.tg.flush();
  assert.match(s.api.of("sendMessage").at(-1).body.text, /Mac online/);
  assert.match(s.api.of("sendMessage").at(-1).body.text, /Build the landing page/);
  await s.tg.handleUpdate(msg("/task g1")); await s.tg.flush();
  const detail = s.api.of("sendMessage").at(-1).body.text;
  assert.match(detail, /Steps/);
  assert.ok(!detail.includes("supersecretvalue123"), "notes are redacted");
  await s.tg.handleUpdate(msg("/cancel g1")); await s.tg.flush();
  const confirm = s.api.of("sendMessage").at(-1).body.reply_markup.inline_keyboard[0];
  assert.equal(s.tg.inbox("mac").length, 0, "nothing until confirmed");
  await s.tg.handleUpdate({ update_id: 80, callback_query: { id: "c", data: confirm[0].callback_data, message: { message_id: 1, chat: { id: CHAT } } } });
  await s.tg.flush();
  assert.equal(s.tg.inbox("mac").at(-1).kind, "cancel");
  await s.tg.handleUpdate(msg("/stop")); await s.tg.flush();
  assert.equal(s.tg.inbox("mac").at(-1).kind, "stop");
  await s.tg.handleUpdate(msg("/new api")); await s.tg.flush();
  assert.deepEqual([s.tg.inbox("mac").at(-1).kind, s.tg.inbox("mac").at(-1).project], ["new", "api"]);
  s.tg.sync({ client: "mac", leads: [{ id: "wezterm-3", project: "api", state: "busy" }, { id: "wezterm-7", project: "shop-web", state: "idle", target: true }] });
  await s.tg.handleUpdate(msg("/sessions")); await s.tg.flush();
  const rows = s.api.of("sendMessage").at(-1).body.reply_markup.inline_keyboard;
  assert.equal(rows.length, 2);
  await s.tg.handleUpdate({ update_id: 81, callback_query: { id: "c", data: rows[0][0].callback_data, message: { message_id: 1, chat: { id: CHAT } } } });
  await s.tg.flush();
  assert.deepEqual([s.tg.inbox("mac").at(-1).kind, s.tg.inbox("mac").at(-1).lead], ["select", "wezterm-3"]);
});

test("a photo is downloaded on the hub and handed to the Mac with the request", async () => {
  const s = setup();
  await paired(s);
  await s.tg.handleUpdate(msg(undefined, { caption: "what is wrong here?", photo: [{ file_id: "small", file_size: 10 }, { file_id: "big", file_size: 100 }] }));
  await s.tg.flush();
  assert.equal(s.api.of("getFile")[0].body.file_id, "big");
  const it = s.tg.inbox("mac").at(-1);
  assert.equal(it.text, "what is wrong here?");
  assert.equal(it.files.length, 1);
  assert.equal(fs.readFileSync(s.tg.filePath(it.files[0].id), "utf8"), "PHOTO-BYTES");
  s.tg.ack([it.id]);
  assert.equal(fs.existsSync(s.tg.filePath(it.files[0].id)), false, "an acked item's file is removed");
});

test("the lead's reply: phone mode, redaction, long messages split", async () => {
  const s = setup();
  await paired(s);
  await s.tg.reply({ lead: "wezterm-1", project: "api", text: `Done. The key is ${FAKE_SK} and \`npm test\` passes.` });
  await s.tg.flush();
  const out = s.api.of("sendMessage").at(-1).body;
  assert.equal(out.parse_mode, "HTML");
  assert.ok(!out.text.includes(FAKE_SK));
  assert.match(out.text, /<code>npm test<\/code>/);
  s.tg.settings({ mode: "off" });
  const n = s.api.of("sendMessage").length;
  await s.tg.reply({ lead: "wezterm-1", text: "not sent" });
  await s.tg.flush();
  assert.equal(s.api.of("sendMessage").length, n, "phone mode off: a turn typed on the Mac is not sent");
  await s.tg.reply({ lead: "wezterm-1", text: "x\n".repeat(3000), phoneTurn: true });
  await s.tg.flush();
  const parts = s.api.of("sendMessage").slice(n);
  assert.ok(parts.length >= 2, "a long reply is split");
  for (const p of parts) assert.ok(p.body.text.length <= LIMIT);
});

test("verbose: tool calls edit one live message for the turn", async () => {
  const s = setup();
  await paired(s);
  s.tg.activity({ lead: "L", project: "api", lines: ["Bash: npm test"] });
  await s.tg.flush();
  assert.equal(s.api.calls.length, 0, "verbose is off by default");
  s.tg.settings({ verbose: true });
  s.tg.activity({ lead: "L", project: "api", lines: ["Bash: npm test"] }); await s.tg.flush();
  s.tg.activity({ lead: "L", project: "api", lines: ["Bash: npm test", "Edit: app.js"] }); await s.tg.flush();
  assert.equal(s.api.of("sendMessage").length, 1);
  assert.equal(s.api.of("editMessageText").length, 1);
  assert.match(s.api.of("editMessageText")[0].body.text, /app\.js/);
});

test("project inference needs exactly one registered name", () => {
  assert.equal(inferProject("deploy shop-web now", ["shop-web", "api"]), "shop-web");
  assert.equal(inferProject("api and shop-web", ["shop-web", "api"]), null);
  assert.equal(inferProject("rapid fix", ["api"]), null, "inside a word is no match");
  assert.equal(inferProject("nothing", ["api"]), null);
});

test("redactor masks tokens, keys, passwords, bearer strings and URL credentials", () => {
  const s = redact([
    "Authorization: Bearer abc.def.ghi",
    "password=hunter22 api_key: \"k-123456\"",
    "postgres://admin:s3cret@db.internal:5432/app",
    "https://user:pa55@git.example.com/repo.git",
    `${FAKE_GHP} and AKIAABCDEFGHIJKLMNOP`,
    "https://example.com/cb?token=abcdef&x=1",
    `bot ${TOKEN}`,
    FAKE_PEM,
  ].join("\n"), ["my-hub-token-value"]);
  for (const bad of ["abc.def.ghi", "hunter22", "k-123456", "s3cret", "pa55", "ghp_abc", "AKIAABCD", "token=abcdef", TOKEN, "MIIE"]) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
  assert.match(s, /example\.com\/cb/);
  assert.equal(redact("ok my-hub-token-value", ["my-hub-token-value"]), "ok [REDACTED]");
});

test("Markdown to Telegram HTML: escaping, code blocks kept across a split", () => {
  assert.equal(mdToHtml("a < b & **c**"), "a &lt; b &amp; <b>c</b>");
  assert.equal(mdToHtml("```js\nif (a<b) x();\n```"), '<pre><code class="language-js">if (a&lt;b) x();</code></pre>');
  const long = ["intro", "```js", ...Array.from({ length: 600 }, (_, i) => `const v${i} = "${"x".repeat(10)}";`), "```", "outro"].join("\n");
  const parts = splitMessage(long);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.length <= LIMIT, `part of ${p.length}`);
    assert.equal((p.match(/<pre>/g) ?? []).length, (p.match(/<\/pre>/g) ?? []).length, "every part closes its code block");
  }
  assert.match(parts[1], /^<pre><code class="language-js">/);
  assert.match(parts.at(-1), /outro/);
  // one line longer than a message
  const one = splitMessage("y".repeat(10_000));
  assert.ok(one.length >= 3 && one.every((p) => p.length <= LIMIT));
});

test("a long Markdown-heavy reply: every part is balanced HTML within the limit", () => {
  const balanced = (h) => ["b", "a", "code", "pre"].every((tag) => (h.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length === (h.match(new RegExp(`</${tag}>`, "g")) ?? []).length);
  for (const md of ["**bold** ".repeat(500), "**bold**\n".repeat(1500), "[x](https://example.com/a?b=1&c=2) ".repeat(800), "`a` & ".repeat(3000)]) {
    const parts = splitMessage(md);
    assert.ok(parts.length >= 2);
    for (const p of parts) { assert.ok(p.length <= LIMIT, `part of ${p.length}`); assert.ok(balanced(p), "tags balanced"); assert.doesNotMatch(p, /&[#\w]*$/); }
  }
  assert.equal(cutEscaped("a & b", 4), "a ");
  // a /task card with many long notes and steps drops whole lines, never cuts a tag
  const html = fitLines(Array.from({ length: 200 }, (_, i) => `<b>step ${i}</b> ${"y".repeat(40)}`), 4000, ["<code>g1</code>"]);
  assert.ok(html.length <= 4000 && balanced(html) && html.endsWith("<code>g1</code>") && html.includes("…"));
});

test("every bot text has its English entry in hub/src/i18n.js", async () => {
  const { dictionaries } = await import("./i18n.js");
  const src = fs.readFileSync(new URL("./telegram.js", import.meta.url), "utf8");
  const keys = [...src.matchAll(/(?<![\w.$])t\(\s*"((?:\\.|[^"\\])*)"/g)].map((m) => m[1]);
  // the command descriptions are passed to t() from the COMMANDS table
  const table = src.slice(src.indexOf("export const COMMANDS"), src.indexOf("];", src.indexOf("export const COMMANDS")));
  keys.push(...[...table.matchAll(/\["[a-z]+", "([^"]+)"\]/g)].map((m) => m[1]));
  const missing = keys.filter((k) => !(k in dictionaries.en));
  assert.deepEqual(missing, []);
  // a ternary inside t(...) passes both texts; check those too
  const ternary = [...src.matchAll(/t\([^()]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)].flatMap((m) => [m[1], m[2]]);
  assert.deepEqual(ternary.filter((k) => !(k in dictionaries.en)), []);
});
