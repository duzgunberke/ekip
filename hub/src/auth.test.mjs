// node --test hub/src/auth.test.mjs: panel login with a passkey as the second factor. A software
// authenticator (node:crypto) plays the browser side; a hub runs in a temporary data directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Auth, ENROL_TTL } from "./auth.js";
import { cborDecode, verifyAuthentication, verifyRegistration } from "./webauthn.js";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");

// ---- a software authenticator -------------------------------------------------------------------

function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: ${typeof v}`);
}

class SoftKey {
  constructor(kind = "ES256") {
    this.kind = kind;
    const { publicKey, privateKey } = kind === "Ed25519" ? crypto.generateKeyPairSync("ed25519") : crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    Object.assign(this, { publicKey, privateKey, id: crypto.randomBytes(16), count: 0 });
  }
  cose() {
    const j = this.publicKey.export({ format: "jwk" });
    if (this.kind === "Ed25519") return new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(j.x, "base64url")]]);
    return new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x, "base64url")], [-3, Buffer.from(j.y, "base64url")]]);
  }
  create(opts, origin) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin, crossOrigin: false }));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([sha256(opts.rp.id), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.id, cbor(this.cose())]);
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: b64u(this.id), rawId: b64u(this.id), type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] } };
  }
  get(opts, origin, { rpId = opts.rpId, counter = true } = {}) {
    if (counter) this.count++;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin }));
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.count);
    const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), cnt]);
    const data = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    const signature = this.kind === "Ed25519" ? crypto.sign(null, data, this.privateKey) : crypto.sign("sha256", data, this.privateKey);
    return { id: b64u(this.id), rawId: b64u(this.id), type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) } };
  }
}

// ---- unit: codes and the WebAuthn checks ----------------------------------------------------------

const newAuth = (clock, extra = {}) => new Auth({ token: "t".repeat(20), password: "p".repeat(12), secret: "s", sessionHours: 1, now: () => clock.t, ...extra });

test("enrolment code: single use, any case and dashes", () => {
  const clock = { t: 1_000_000 };
  const a = newAuth(clock);
  const { code } = a.newEnrolCode();
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(a.enrolCodeValid(code.toLowerCase().replace("-", " ")), true);
  assert.equal(a.consumeEnrolCode(code), true);
  assert.equal(a.consumeEnrolCode(code), false, "second use");
  assert.equal(a.enrolCodeValid("ABCDE-FGHJK"), false);
  assert.equal(a.enrolCodeValid(undefined), false);
});

test("enrolment code: expires", () => {
  const clock = { t: 1_000_000 };
  const a = newAuth(clock);
  const { code } = a.newEnrolCode();
  clock.t += ENROL_TTL - 1;
  assert.equal(a.enrolCodeValid(code), true);
  clock.t += 2;
  assert.equal(a.enrolCodeValid(code), false);
  assert.equal(a.consumeEnrolCode(code), false);
});

test("sessions bind to a registered passkey once one exists", () => {
  const clock = { t: 1_000_000 };
  const a = newAuth(clock);
  const req = (v, name = "ekip_session") => ({ headers: { cookie: `${name}=${v}` } });
  const legacy = a.newSession();
  assert.equal(a.sessionOk(req(legacy)), true, "no passkey yet: the password session works");
  a.addCredential({ id: "cred-1", name: "x" });
  assert.equal(a.sessionOk(req(legacy)), false, "the first passkey ends password-only sessions");
  assert.equal(a.sessionOk(req(a.newSession("cred-1"))), true);
  assert.equal(a.sessionOk(req(a.newSession("cred-2"))), false, "unknown passkey");
  assert.equal(a.sessionOk(req(a.newPending())), false, "the password ticket is not a session");
  const s = a.newSession("cred-1");
  a.removeCredential("cred-1");
  assert.equal(a.sessionOk(req(s)), false, "removing a passkey ends its sessions");
  assert.equal(newAuth(clock, { requirePasskey: true }).sessionOk(req(newAuth(clock).newSession())), false, "EKIP_HUB_REQUIRE_PASSKEY=1 with no passkey: no session");
  clock.t += 3600_000 + 1;
  assert.equal(a.pending(req(a.newPending(), "ekip_login")) !== null, true);
});

for (const kind of ["ES256", "Ed25519"]) {
  test(`webauthn ${kind}: register, sign in, reject tampering`, () => {
    const key = new SoftKey(kind), origin = "https://hub.example.com", rpId = "hub.example.com";
    const reg = verifyRegistration(key.create({ challenge: "c1", rp: { id: rpId } }, origin), { challenge: "c1", origin, rpId });
    assert.equal(reg.id, b64u(key.id));
    const stored = { ...reg };
    const ok = verifyAuthentication(key.get({ challenge: "c2", rpId }, origin), stored, { challenge: "c2", origin, rpId });
    assert.equal(ok.signCount, 1);
    stored.signCount = ok.signCount;
    assert.throws(() => verifyAuthentication(key.get({ challenge: "c3", rpId }, origin), stored, { challenge: "other", origin, rpId }), /challenge/);
    assert.throws(() => verifyAuthentication(key.get({ challenge: "c4", rpId }, "https://evil.example.com"), stored, { challenge: "c4", origin, rpId }), /origin/);
    assert.throws(() => verifyAuthentication(key.get({ challenge: "c5", rpId }, origin, { rpId: "evil.example.com" }), stored, { challenge: "c5", origin, rpId }), /rpId/);
    assert.throws(() => verifyAuthentication(new SoftKey(kind).get({ challenge: "c6", rpId }, origin), stored, { challenge: "c6", origin, rpId }), /id mismatch/);
    const forged = key.get({ challenge: "c7", rpId }, origin);
    forged.response.signature = b64u(crypto.randomBytes(70));
    assert.throws(() => verifyAuthentication(forged, stored, { challenge: "c7", origin, rpId }), /signature/);
    stored.signCount = 99;
    assert.throws(() => verifyAuthentication(key.get({ challenge: "c8", rpId }, origin), stored, { challenge: "c8", origin, rpId }), /counter/);
  });
}

test("cbor: refuses truncated and oversized input", () => {
  assert.throws(() => cborDecode(Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff])), /truncated/);
  assert.throws(() => cborDecode(Buffer.from([0x9f])), /indefinite/);
});

// ---- the hub over HTTP ----------------------------------------------------------------------------

const TOKEN = "test-token-0123456789abcdef", PASSWORD = "test-password-123";

async function startHub(t, env = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-auth-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", EKIP_DATA: data, EKIP_HUB_TOKEN: TOKEN, EKIP_HUB_PASSWORD: PASSWORD, EKIP_WORKERS: "1", FREELLMAPI_URL: "", TDAI_PROXY_URL: "", KNOWLEDGE_URL: "http://127.0.0.1:9", EKIP_HUB_RP_ID: "", EKIP_HUB_ORIGIN: "", EKIP_HUB_REQUIRE_PASSKEY: "", ...env },
    stdio: "ignore",
  });
  t.after(() => server.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  return { base, data };
}

// A browser-ish client: keeps cookies, sends the CSRF header on writes.
function client(base) {
  const jar = new Map();
  const call = async (p, { method = "GET", body, headers = {} } = {}) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { "x-ekip-csrf": "1" } : {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";");
      const i = kv.indexOf("="), k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!v || attrs.some((a) => a.trim() === "Max-Age=0")) jar.delete(k); else jar.set(k, v);
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text body */ }
    return { status: r.status, json, text, type: r.headers.get("content-type") };
  };
  return { call, jar };
}

const bearer = (base) => (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers } });

test("hub: strangers get a bare 404 everywhere but the sign-in page", async (t) => {
  const { base } = await startHub(t);
  for (const [method, p] of [["GET", "/"], ["GET", "/tasks"], ["GET", "/api/status"], ["GET", "/api/session"], ["GET", "/favicon.svg"], ["GET", "/index.html"], ["POST", "/api/jobs"], ["DELETE", "/api/passkeys/abcd"], ["PUT", "/anything"]]) {
    const r = await fetch(`${base}${p}`, { method, headers: { authorization: "Bearer wrong-token-0123456789" } });
    const text = await r.text();
    assert.equal(r.status, 404, `${method} ${p}`);
    assert.equal(text, "not found", `${method} ${p}: no branding`);
    assert.equal(r.headers.get("www-authenticate"), null);
  }
  if (fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"))) {
    assert.equal((await fetch(`${base}/login`)).status, 200, "the sign-in page renders");
    assert.equal((await fetch(`${base}/sign-in`)).status, 200);
  }
});

test("hub: password, enrolment code, passkey; the token keeps working", async (t) => {
  const { base, data } = await startHub(t);
  const machine = bearer(base);
  const origin = base;
  assert.equal((await machine("/api/session")).status, 200, "bearer before any passkey");

  // no passkey yet and none required: the password still opens a session (the old behaviour)
  const legacy = client(base);
  assert.equal((await legacy.call("/login", { method: "POST", body: { password: PASSWORD } })).json.ok, true);
  assert.equal((await legacy.call("/api/session")).status, 200);
  assert.equal((await legacy.call("/api/passkeys/code", { method: "POST", body: {} })).status, 403, "a password session cannot issue enrolment codes");
  assert.equal((await legacy.call("/api/passkeys/register/options", { method: "POST", body: {} })).status, 403, "nor register a passkey without a code");

  // ekip hub passkey add
  const issued = await (await machine("/api/passkeys/code", { method: "POST", body: "{}" })).json();
  assert.match(issued.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(issued.path, `/sign-in?enrol=${issued.code}`);

  const browser = client(base), key = new SoftKey();
  assert.equal((await browser.call("/login/enrol/options", { method: "POST", body: { code: issued.code } })).status, 401, "no password step yet");
  const pw = await browser.call("/login", { method: "POST", body: { password: PASSWORD } });
  assert.deepEqual(pw.json, { ok: true }, "no passkey yet: a password session, upgraded below");
  assert.equal((await browser.call("/login/enrol/options", { method: "POST", body: { code: "ZZZZZ-ZZZZZ" } })).status, 401, "wrong code");
  const createOpts = await browser.call("/login/enrol/options", { method: "POST", body: { code: issued.code.toLowerCase() } });
  assert.equal(createOpts.status, 200);
  assert.equal(createOpts.json.rp.id, "127.0.0.1");
  const enrolled = await browser.call("/login/enrol/verify", { method: "POST", body: { code: issued.code, name: "test key", credential: key.create(createOpts.json, origin) } });
  assert.equal(enrolled.status, 200, enrolled.text);
  assert.ok(browser.jar.has("ekip_session"));
  assert.deepEqual((await browser.call("/api/session")).json, { ok: true, passkey: true });
  const saved = JSON.parse(fs.readFileSync(path.join(data, "passkeys.json"), "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "test key");

  // the code is single use; the old password-only session is gone
  const again = client(base);
  await again.call("/login", { method: "POST", body: { password: PASSWORD } });
  assert.equal((await again.call("/login/enrol/options", { method: "POST", body: { code: issued.code } })).status, 401, "code reused");
  assert.equal((await legacy.call("/api/session")).status, 404, "password-only session ended by the first passkey");

  // password right, passkey step skipped: no session, the ticket opens nothing
  const thief = client(base);
  const half = await thief.call("/login", { method: "POST", body: { password: PASSWORD } });
  assert.deepEqual(half.json, { ok: true, next: "passkey" });
  assert.equal(thief.jar.has("ekip_session"), false);
  assert.equal((await thief.call("/api/session")).status, 404);
  assert.equal((await thief.call("/tasks")).status, 404);
  const ticket = thief.jar.get("ekip_login");
  thief.jar.set("ekip_session", ticket);
  assert.equal((await thief.call("/api/session")).status, 404, "the ticket used as a session cookie");
  thief.jar.delete("ekip_session");
  const getOpts = await thief.call("/login/passkey/options", { method: "POST", body: {} });
  assert.equal(getOpts.status, 200);
  const otherKey = new SoftKey();
  assert.equal((await thief.call("/login/passkey/verify", { method: "POST", body: { credential: { ...otherKey.get(getOpts.json, origin), id: b64u(key.id) } } })).status, 401, "a different key under the right id");
  assert.equal(thief.jar.has("ekip_session"), false);

  // the real owner signs in with the passkey
  const owner = client(base);
  await owner.call("/login", { method: "POST", body: { password: PASSWORD } });
  const opts = await owner.call("/login/passkey/options", { method: "POST", body: {} });
  assert.deepEqual(opts.json.allowCredentials.map((c) => c.id), [b64u(key.id)]);
  const replayed = key.get(opts.json, origin);
  const signedIn = await owner.call("/login/passkey/verify", { method: "POST", body: { credential: replayed } });
  assert.equal(signedIn.status, 200, signedIn.text);
  assert.equal((await owner.call("/api/session")).json.passkey, true);
  assert.equal((await owner.call("/tasks")).status === 200 || !fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html")), true);

  // a replayed assertion does not open a second session
  const replay = client(base);
  await replay.call("/login", { method: "POST", body: { password: PASSWORD } });
  await replay.call("/login/passkey/options", { method: "POST", body: {} });
  assert.equal((await replay.call("/login/passkey/verify", { method: "POST", body: { credential: replayed } })).status, 401);

  // a passkey session adds a second passkey without a code
  const key2 = new SoftKey("Ed25519");
  const o2 = await owner.call("/api/passkeys/register/options", { method: "POST", body: {} });
  assert.equal(o2.status, 200);
  assert.deepEqual(o2.json.excludeCredentials.map((c) => c.id), [b64u(key.id)]);
  assert.equal((await owner.call("/api/passkeys/register/verify", { method: "POST", body: { name: "second", credential: key2.create(o2.json, origin) } })).status, 201);

  // ekip hub passkey list / remove, with the token
  const list = await (await machine("/api/passkeys")).json();
  assert.equal(list.required, true);
  assert.deepEqual(list.passkeys.map((p) => p.name), ["test key", "second"]);
  assert.equal(JSON.stringify(list).includes("jwk"), false, "public keys are not listed");
  const removed = await machine(`/api/passkeys/${b64u(key.id).slice(0, 8)}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal((await owner.call("/api/session")).status, 404, "removing the passkey ended its session");
  assert.equal((await machine("/api/session")).status, 200, "the token is unaffected");
  assert.equal((await machine("/api/passkeys/code", { method: "POST", body: "{}" })).status, 201);
});

test("hub: EKIP_HUB_REQUIRE_PASSKEY=1 with no passkey: the password opens nothing", async (t) => {
  const { base } = await startHub(t, { EKIP_HUB_REQUIRE_PASSKEY: "1", EKIP_HUB_ORIGIN: "https://hub.example.com" });
  const c = client(base);
  const r = await c.call("/login", { method: "POST", body: { password: PASSWORD } });
  assert.deepEqual(r.json, { ok: true, next: "enrol" });
  assert.equal(c.jar.has("ekip_session"), false);
  assert.equal((await c.call("/api/session")).status, 404);
  assert.equal((await c.call("/login/passkey/options", { method: "POST", body: {} })).status, 409);
  // the origin is pinned: a ceremony signed for the request's own origin is refused
  const { code } = await (await bearer(base)("/api/passkeys/code", { method: "POST", body: "{}" })).json();
  const o = await c.call("/login/enrol/options", { method: "POST", body: { code } });
  assert.equal(o.json.rp.id, "hub.example.com");
  const bad = await c.call("/login/enrol/verify", { method: "POST", body: { code, credential: new SoftKey().create(o.json, base) } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /origin/);
  assert.equal(c.jar.has("ekip_session"), false);
});

test("hub: the Mac inbox (phone messages) answers the hub token only, not a panel session", async (t) => {
  const { base } = await startHub(t);
  const panel = client(base);
  assert.equal((await panel.call("/login", { method: "POST", body: { password: PASSWORD } })).json.ok, true);
  assert.equal((await panel.call("/api/session")).status, 200, "a signed-in panel session");
  for (const [method, p] of [["GET", "/api/inbox"], ["POST", "/api/inbox/ack"], ["POST", "/api/inbox/sync"], ["GET", "/api/inbox/files/0123456789ab"]]) {
    assert.equal((await panel.call(p, { method, ...(method === "POST" ? { body: {} } : {}) })).status, 403, `${method} ${p} with a panel session`);
  }
  assert.equal((await fetch(`${base}/api/inbox`)).status, 404, "no credentials: a bare 404");
  const r = await bearer(base)("/api/inbox");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { items: [] });
});
