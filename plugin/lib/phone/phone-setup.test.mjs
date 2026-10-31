// `ekip phone setup` on the Mac with fake io: a fake Telegram getMe, a fake hub and no dialog. The
// token reaches the hub only: it is never printed, logged or written under EKIP_HOME. Also the setup
// step ("phone") and the one-time offer in `ekip init`. No real Telegram call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-phone-setup-"));
process.env.EKIP_HOME = home;
process.env.EKIP_LANG = "en";
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ hubUrl: "http://127.0.0.1:9", hubToken: "test-token-0123456789", taskPane: false }));

const phone = await import("./phone.js");
const setup = await import("../ops/setup.js");
const { snoozed, unsnooze } = await import("../ops/snooze.js");

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const SECRET = TOKEN.split(":")[1];

function telegram(status = 200) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (status !== 200) return { ok: false, status, json: async () => ({ ok: false, error_code: status, description: "Unauthorized" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { id: 123456789, is_bot: true, username: "test_bot" } }) };
  };
  return { fetchFn, calls };
}
function hub({ putStatus = 200, pairAfter = 2 } = {}) {
  const calls = [];
  let polls = 0;
  const fetchFn = async (url, init = {}) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ p, method: init.method ?? "GET", body, auth: init.headers?.authorization });
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (p === "/api/phone/telegram-token") return putStatus === 200 ? reply(200, init.method === "DELETE" ? { ok: true } : { ok: true, enabled: true, bot: "test_bot", chats: 0 }) : reply(putStatus, { error: "EKIP_TELEGRAM_TOKEN is set", source: "env" });
    if (p === "/api/phone/link") return reply(201, { code: "ABCD2345", bot: "test_bot" });
    if (p === "/api/phone") return reply(200, { enabled: true, bot: "test_bot", chats: ++polls >= pairAfter ? 1 : 0 });
    return reply(404, { error: "not found" });
  };
  return { fetchFn, calls };
}
const allFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(d, e.name)) : [path.join(d, e.name)]));

test("setup: token from stdin → getMe → hub, then the /link code and the wait; the token stays off the Mac", async () => {
  const lines = [], tg = telegram(), h = hub();
  const code = await phone.main(["setup", "--token-stdin"], { out: (s) => lines.push(s), fetchFn: h.fetchFn, tgFetch: tg.fetchFn, stdin: () => `${TOKEN}\n`, sleep: async () => {}, pollMs: 0 });
  assert.equal(code, 0, lines.join("\n"));
  const text = lines.join("\n");
  assert.match(text, /@BotFather/);
  assert.match(text, /\/newbot/);
  assert.match(text, /ending in "bot"/);
  assert.match(text, /bot verified: @test_bot/);
  assert.match(text, /\/link ABCD2345/);
  assert.match(text, /paired: @test_bot/);
  // the BotFather steps: four short numbered lines
  assert.equal(lines.filter((l) => /^ {2}\d\. /.test(l)).length, 4);

  assert.equal(tg.calls.length, 1);
  assert.match(tg.calls[0], /\/getMe$/);
  const put = h.calls.find((c) => c.p === "/api/phone/telegram-token");
  assert.equal(put.method, "PUT");
  assert.equal(put.body.token, TOKEN, "the token goes to the hub");
  assert.equal(put.auth, "Bearer test-token-0123456789", "with the hub token");
  assert.ok(h.calls.some((c) => c.p === "/api/phone/link" && c.method === "POST"), "then the link flow at once");

  assert.ok(!text.includes(SECRET), "never printed");
  for (const f of allFiles(home)) assert.ok(!fs.readFileSync(f, "utf8").includes(SECRET), `never written: ${path.relative(home, f)}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).telegramToken, undefined);
  assert.equal(phone.readState().linked, true);
});

test("setup: a token Telegram rejects (401) stops before the hub; nothing printed or stored", async () => {
  const lines = [], tg = telegram(401), h = hub();
  const code = await phone.main(["setup"], { out: (s) => lines.push(s), fetchFn: h.fetchFn, tgFetch: tg.fetchFn, token: TOKEN });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /rejected this token \(401\)/);
  assert.equal(h.calls.length, 0, "the hub is not called");
  assert.ok(!lines.join("\n").includes(SECRET));
});

test("getMe: ok, 401, a malformed token, a network error that would carry the token", async () => {
  assert.deepEqual(await phone.getMe(TOKEN, { fetchFn: telegram().fetchFn }), { ok: true, bot: "test_bot" });
  const bad = await phone.getMe(TOKEN, { fetchFn: telegram(401).fetchFn });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  const calls = [];
  const malformed = await phone.getMe("not-a-token", { fetchFn: async (u) => { calls.push(u); return {}; } });
  assert.equal(malformed.ok, false);
  assert.equal(calls.length, 0, "a malformed token is not sent anywhere");
  const net = await phone.getMe(TOKEN, { fetchFn: async () => { throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/getMe`); } });
  assert.equal(net.ok, false);
  assert.ok(!net.error.includes(SECRET), "an error message never shows the token");
});

test("setup: EKIP_TELEGRAM_TOKEN on the hub wins (409); --remove deletes the bot", async () => {
  let lines = [];
  const code = await phone.main(["setup"], { out: (s) => lines.push(s), fetchFn: hub({ putStatus: 409 }).fetchFn, tgFetch: telegram().fetchFn, token: TOKEN });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /EKIP_TELEGRAM_TOKEN is set in the hub's environment/);
  lines = [];
  const h = hub();
  assert.equal(await phone.main(["setup", "--remove"], { out: (s) => lines.push(s), fetchFn: h.fetchFn }), 0);
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.p}`), ["DELETE /api/phone/telegram-token"]);
  assert.equal(phone.readState().linked, false);
});

test("readToken: a hidden macOS dialog, cancel, --token-stdin, a no-echo prompt elsewhere, nothing without a terminal", async () => {
  const runs = [];
  const run = (cmd, args) => { runs.push([cmd, ...args]); return { status: 0, stdout: `${TOKEN}\n`, stderr: "" }; };
  assert.equal(await phone.readToken([], { platform: "darwin", run, tty: false }), TOKEN, "works without a terminal (the lead's ! prompt)");
  assert.equal(runs[0][0], "osascript");
  assert.match(runs[0].join(" "), /with hidden answer/);
  assert.equal(await phone.readToken([], { platform: "darwin", run: () => ({ status: 1, stdout: "", stderr: "execution error: User canceled. (-128)" }), tty: true, secret: async () => { throw new Error("not asked"); } }), "");
  assert.equal(await phone.readToken(["--token-stdin"], { platform: "darwin", run: () => { throw new Error("no dialog"); }, stdin: () => ` ${TOKEN}\n` }), TOKEN);
  let asked = 0;
  assert.equal(await phone.readToken([], { platform: "linux", tty: true, secret: async () => { asked++; return TOKEN; } }), TOKEN);
  assert.equal(asked, 1);
  assert.equal(await phone.readToken([], { platform: "linux", tty: false, secret: async () => { asked++; return TOKEN; } }), "");
  assert.equal(asked, 1, "no prompt without a terminal");
});

test("setup step: shown with a hub, done only with a bot and a paired chat, offered once", () => {
  const base = { platform: "linux", node: 22, git: true, claude: true, docker: { ok: true }, env: { gitIdentity: true }, onPath: true, freeUp: true, memUp: true, keys: [], embeddings: false, logged: [], projects: [], projectGaps: [], vectors: null, wezterm: false, terminal: null, notifier: false, cwd: home };
  const step = (f) => setup.evaluate(f, { env: {} }).find((s) => s.id === "phone");
  assert.equal(step({ ...base, hub: false, phone: { bot: false, paired: false } }), undefined, "no hub: no phone step");
  const none = step({ ...base, hub: true, phone: { bot: false, paired: false } });
  assert.equal(none.done, false);
  assert.equal(none.command, "ekip phone setup");
  assert.equal(none.once, true);
  assert.equal(none.level, "optional");
  const half = step({ ...base, hub: true, phone: { bot: true, paired: false } });
  assert.equal(half.done, false);
  assert.match(half.detail, /no chat paired/);
  assert.equal(step({ ...base, hub: true, phone: { bot: false, paired: true } }).done, false);
  assert.equal(step({ ...base, hub: true, phone: { bot: true, paired: true } }).done, true);
  const cmds = setup.actions({ id: "phone" }, { hub: true });
  assert.deepEqual(cmds[0][1].slice(-2), ["phone", "setup"]);
});

test("phoneFacts: from the hub, else the last answer it gave", async () => {
  assert.deepEqual(await phone.phoneFacts({ fetchFn: hub({ pairAfter: 1 }).fetchFn }), { bot: true, paired: true });
  phone.writeState({ linked: true });
  assert.deepEqual(await phone.phoneFacts({ fetchFn: async () => { throw new Error("offline"); } }), { bot: true, paired: true });
});

test("ekip init: asked once (default no) with a hub in a terminal; never without one, with --no-phone or without a hub", async () => {
  unsnooze("phone:offered");
  const facts = async () => ({ bot: false, paired: false });
  let asked = 0, ran = 0;
  const prompt = async () => { asked++; return ""; };
  const exec = () => { ran++; return 0; };
  assert.equal(await phone.initPhone([], { interactive: false, prompt, hub: true, facts, exec }), "skipped");
  assert.equal(await phone.initPhone(["--no-phone"], { interactive: true, prompt, hub: true, facts, exec }), "skipped");
  assert.equal(await phone.initPhone([], { interactive: true, prompt, hub: false, facts, exec }), "skipped");
  assert.equal(asked, 0, "non-interactive, --no-phone and no hub never ask");

  assert.equal(await phone.initPhone([], { interactive: true, prompt, hub: true, facts, exec }), "no", "Enter is no");
  assert.equal(asked, 1);
  assert.equal(ran, 0);
  assert.ok(snoozed("phone:offered"), "the setup wizard does not offer it again");
  assert.equal(await phone.initPhone([], { interactive: true, prompt, hub: true, facts, exec }), "skipped");
  assert.equal(asked, 1, "asked once");

  unsnooze("phone:offered");
  assert.equal(await phone.initPhone([], { interactive: true, prompt: async () => "e", hub: true, facts, exec }), "linked");
  assert.equal(ran, 1, "yes runs ekip phone setup");
  unsnooze("phone:offered");
  assert.equal(await phone.initPhone([], { interactive: true, prompt, hub: true, facts: async () => ({ bot: true, paired: true }), exec }), "done");
});
