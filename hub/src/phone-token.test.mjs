// `ekip phone setup` on the hub: PUT/DELETE /api/phone/telegram-token against a fake Telegram API
// (a local HTTP server given as EKIP_TELEGRAM_API), so no real Telegram call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStore } from "./store.js";
import { Telegram } from "./telegram.js";

const HUB_TOKEN = "test-token-0123456789abcdef", PASSWORD = "test-password-123";
const BOT = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const OTHER_BOT = "987654321:AAAnotherFakeTokenForTests_abcdefghijk";
const BAD_BOT = "111111111:AARejectedFakeTokenForTests_abcdefghij";

// the fake Telegram: getMe answers for the good tokens, 401 for BAD_BOT; getUpdates waits a little
function fakeTelegram(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
    const [token, method] = m ? [decodeURIComponent(m[1]), m[2]] : [null, null];
    calls.push({ token, method });
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (token === BAD_BOT) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
    if (method === "getMe") return reply(200, { ok: true, result: { username: token === OTHER_BOT ? "other_test_bot" : "test_bot" } });
    if (method === "getUpdates") return setTimeout(() => reply(200, { ok: true, result: [] }), 200);
    return reply(200, { ok: true, result: true });
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, calls })));
}

async function startHub(t, env = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-phone-token-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", EKIP_DATA: data, EKIP_HUB_TOKEN: HUB_TOKEN, EKIP_HUB_PASSWORD: PASSWORD, EKIP_WORKERS: "1", FREELLMAPI_URL: "", TDAI_PROXY_URL: "", KNOWLEDGE_URL: "http://127.0.0.1:9", EKIP_HUB_RP_ID: "", EKIP_HUB_ORIGIN: "", EKIP_HUB_REQUIRE_PASSKEY: "", EKIP_TELEGRAM_TOKEN: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  t.after(() => server.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  return { base, data, log: () => log };
}
const bearer = (base) => (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { authorization: `Bearer ${HUB_TOKEN}`, "content-type": "application/json", ...init.headers } });
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("hub: the bot token is set with the hub token only, kept in a 600 file, never shown, and the poller starts", async (t) => {
  const tg = await fakeTelegram(t);
  const { base, data, log } = await startHub(t, { EKIP_TELEGRAM_API: tg.base });
  const machine = bearer(base);
  const put = (token) => machine("/api/phone/telegram-token", { method: "PUT", body: JSON.stringify({ token }) });

  // no credentials: a bare 404; a signed-in panel session: 403 (bearer only)
  assert.equal((await fetch(`${base}/api/phone/telegram-token`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: BOT }) })).status, 404);
  const login = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json", "x-ekip-csrf": "1" }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.equal((await fetch(`${base}/api/session`, { headers: { cookie } })).status, 200, "a panel session");
  assert.equal((await fetch(`${base}/api/phone/telegram-token`, { method: "PUT", headers: { cookie, "x-ekip-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ token: BOT }) })).status, 403);
  assert.equal((await fetch(`${base}/api/phone/telegram-token`, { method: "DELETE", headers: { cookie, "x-ekip-csrf": "1" } })).status, 403);
  assert.equal(fs.existsSync(path.join(data, "telegram-token")), false);

  // not a token, and a token Telegram rejects: nothing is stored
  assert.equal((await put("hello")).status, 400);
  const rejected = await put(BAD_BOT);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /rejected/);
  assert.equal(fs.existsSync(path.join(data, "telegram-token")), false);

  // a good one: stored (mode 600), the poller runs with it, no restart
  const r = await put(BOT);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual({ ok: body.ok, enabled: body.enabled, bot: body.bot }, { ok: true, enabled: true, bot: "test_bot" });
  const file = path.join(data, "telegram-token");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8").trim(), BOT);
  assert.ok(await until(() => tg.calls.some((c) => c.token === BOT && c.method === "getUpdates")), "the poller started with the new token");

  // redacted everywhere the hub answers or logs
  const status = await (await machine("/api/status")).text();
  assert.ok(!status.includes(BOT) && !status.includes(BOT.split(":")[1]), "/api/status never shows the token");
  assert.deepEqual(JSON.parse(status).phone, { enabled: true, source: "store", bot: "test_bot", chats: 0 });
  const phone = await (await machine("/api/phone")).text();
  assert.ok(!phone.includes(BOT.split(":")[1]));
  assert.equal(JSON.parse(phone).enabled, true);
  assert.equal((await machine("/api/phone/link", { method: "POST", body: "{}" })).status, 201, "pairing works at once");

  // another bot: the poller moves to it; the old token is no longer polled
  assert.equal((await put(OTHER_BOT)).status, 200);
  assert.ok(await until(() => tg.calls.some((c) => c.token === OTHER_BOT && c.method === "getUpdates")));
  await new Promise((r) => setTimeout(r, 600));
  const n = tg.calls.filter((c) => c.token === BOT && c.method === "getUpdates").length;
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(tg.calls.filter((c) => c.token === BOT && c.method === "getUpdates").length, n, "the old poll loop ended");

  // DELETE: the file goes, the bot stops
  assert.equal((await machine("/api/phone/telegram-token", { method: "DELETE" })).status, 200);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await (await machine("/api/phone")).json()).enabled, false);
  assert.equal((await machine("/api/phone/link", { method: "POST", body: "{}" })).status, 409);
  const quiet = tg.calls.length;
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(tg.calls.length <= quiet + 1, "no more polling after DELETE");

  for (const secret of [BOT, OTHER_BOT, BAD_BOT]) assert.ok(!log().includes(secret.split(":")[1]), "the hub's log never has a token");
});

test("hub: a stored token is used after a restart; EKIP_TELEGRAM_TOKEN wins and the endpoint refuses", async (t) => {
  const tg = await fakeTelegram(t);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-phone-token-"));
  fs.writeFileSync(path.join(data, "telegram-token"), `${BOT}\n`, { mode: 0o600 });
  const { base } = await startHub(t, { EKIP_TELEGRAM_API: tg.base, EKIP_DATA: data });
  assert.equal((await (await bearer(base)("/api/phone")).json()).source, "store");

  const tg2 = await fakeTelegram(t);
  const env = await startHub(t, { EKIP_TELEGRAM_API: tg2.base, EKIP_TELEGRAM_TOKEN: OTHER_BOT });
  const machine = bearer(env.base);
  assert.equal((await (await machine("/api/phone")).json()).source, "env");
  const r = await machine("/api/phone/telegram-token", { method: "PUT", body: JSON.stringify({ token: BOT }) });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).source, "env");
  assert.equal((await machine("/api/phone/telegram-token", { method: "DELETE" })).status, 409);
  assert.ok(await until(() => tg2.calls.some((c) => c.token === OTHER_BOT && c.method === "getUpdates")), "the env token still runs the bot");
});

test("Telegram.setToken: one poll loop per token, another bot resets the pairing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-phone-set-"));
  const store = openStore(dir);
  const polls = [];
  const fetchFn = async (url, init = {}) => {
    const [, token, method] = String(url).match(/\/bot([^/]+)\/(\w+)$/);
    if (method === "getUpdates") {
      polls.push(token);
      await new Promise((resolve, reject) => { const tm = setTimeout(resolve, 50); init.signal?.addEventListener("abort", () => { clearTimeout(tm); reject(new Error("aborted")); }); });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: method === "getMe" ? { username: "b" } : true }) };
  };
  const tg = new Telegram({ token: "", store, fetch: fetchFn, sendGapMs: 0, log: { error() {} } });
  assert.equal(tg.enabled, false);
  tg.setToken(BOT);
  assert.equal(tg.enabled, true);
  assert.equal(tg.status().source, "store");
  await new Promise((r) => setTimeout(r, 200));
  tg.st.chats.push({ id: 1 });
  tg.setToken(BOT); // the same bot again: the pairing stays
  assert.equal(tg.st.chats.length, 1);
  tg.setToken(OTHER_BOT);
  assert.equal(tg.st.chats.length, 0, "another bot cannot write to the old chats");
  polls.length = 0;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(polls.length > 0 && polls.every((x) => x === OTHER_BOT), "only the new token is polled");
  assert.equal(tg.clean(`x ${OTHER_BOT} y`).includes(OTHER_BOT), false, "the new token is redacted");
  tg.setToken("");
  assert.equal(tg.enabled, false);
  polls.length = 0;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(polls.length, 0);
  store.flushAll();
});
