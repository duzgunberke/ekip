// Bearer token for machines; for the panel, password -> passkey (WebAuthn) -> signed session cookie;
// one-time enrolment codes for the first passkey; login rate limit.
import crypto from "node:crypto";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
// Constant-time string compare (hashing first makes the lengths equal).
export const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && crypto.timingSafeEqual(sha(a), sha(b));

export const COOKIE = "ekip_session";
// Between a correct password and the passkey: proves the password step, never grants access.
export const PENDING = "ekip_login";
const PENDING_TTL = 5 * 60_000;
const CHALLENGE_TTL = 5 * 60_000;
export const ENROL_TTL = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const normCode = (c) => (typeof c === "string" ? c.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32) : "");

export class Auth {
  // passkeys: a store Collection holding the registered credentials (an array).
  // requirePasskey: EKIP_HUB_REQUIRE_PASSKEY=1; without it a passkey is required once one exists.
  constructor({ token, password, secret, sessionHours, passkeys = { data: [], flush() {} }, requirePasskey = false, now = Date.now }) {
    this.token = token;
    this.password = password;
    // Bound to the password: changing it invalidates every session.
    this.key = crypto.createHmac("sha256", secret).update(`session:${password}`).digest();
    this.userId = crypto.createHmac("sha256", secret).update("webauthn-user").digest().subarray(0, 16).toString("base64url");
    this.ttl = sessionHours * 3600_000;
    this.passkeys = passkeys;
    this.requireEnv = requirePasskey;
    this.now = now;
    this.failures = new Map(); // ip -> { count, first, lockedUntil }
    this.codes = new Map(); // sha256(code) -> expiry; in memory only, so a restart voids them
    this.challenges = new Map(); // binding nonce -> { challenge, kind, exp, code? }
  }

  get credentials() { return Array.isArray(this.passkeys.data) ? this.passkeys.data : (this.passkeys.data = []); }
  passkeyRequired() { return this.requireEnv || this.credentials.length > 0; }

  passwordOk(pw) { return safeEqual(pw, this.password); }

  bearerOk(req) {
    const h = req.headers.authorization ?? "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    return !!m && safeEqual(m[1].trim(), this.token);
  }

  verify(raw) {
    if (!raw) return null;
    const [body, mac, extra] = raw.split(".");
    if (!body || !mac || extra !== undefined) return null;
    const want = crypto.createHmac("sha256", this.key).update(body).digest("base64url");
    if (!safeEqual(mac, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString());
      return p && typeof p === "object" && p.exp > this.now() ? p : null;
    } catch { return null; }
  }

  sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = crypto.createHmac("sha256", this.key).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  // pk: the id of the passkey that completed the login (null when no passkey is required yet).
  newSession(pk = null) {
    return this.sign({ exp: this.now() + this.ttl, n: crypto.randomBytes(9).toString("base64url"), ...(pk ? { pk } : {}) });
  }

  // The session payload, or null. Once passkeys are required, a session counts only when it was
  // opened with a passkey that is still registered: removing a passkey ends its sessions, and
  // password-only sessions from before the first passkey end with its enrolment.
  session(req) {
    const p = this.verify(parseCookies(req.headers.cookie)[COOKIE]);
    if (!p || p.typ) return null;
    const known = typeof p.pk === "string" && this.credentials.some((c) => c.id === p.pk);
    if (p.pk !== undefined ? !known : this.passkeyRequired()) return null;
    return p;
  }

  sessionOk(req) { return !!this.session(req); }

  newPending() { return this.sign({ typ: "pw", exp: this.now() + PENDING_TTL, n: crypto.randomBytes(9).toString("base64url") }); }

  // The password step of a login in progress: { n } or null.
  pending(req) {
    const p = this.verify(parseCookies(req.headers.cookie)[PENDING]);
    return p?.typ === "pw" && typeof p.n === "string" ? p : null;
  }

  cookie(value, maxAgeSec, name = COOKIE) {
    // a panel on this computer (ekip hub local) is plain http on loopback, where Safari drops Secure cookies
    return `${name}=${value}; Path=/; HttpOnly;${process.env.EKIP_LOCAL_PANEL === "1" ? "" : " Secure;"} SameSite=Strict; Max-Age=${maxAgeSec}`;
  }

  pendingCookie(value, maxAgeSec = PENDING_TTL / 1000) { return this.cookie(value, maxAgeSec, PENDING); }

  // ---- one-time enrolment codes (ekip hub passkey add) ----

  newEnrolCode(ttl = ENROL_TTL) {
    this.gcCodes();
    if (this.codes.size >= 20) this.codes.delete(this.codes.keys().next().value);
    const code = Array.from(crypto.randomBytes(10), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const expiresAt = this.now() + ttl;
    this.codes.set(sha(code).toString("hex"), expiresAt);
    return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  enrolCodeValid(code) {
    const k = sha(normCode(code)).toString("hex");
    const exp = this.codes.get(k);
    if (!exp) return false;
    if (exp <= this.now()) { this.codes.delete(k); return false; }
    return true;
  }

  // Single use: true once, then the code is gone.
  consumeEnrolCode(code) {
    const ok = this.enrolCodeValid(code);
    this.codes.delete(sha(normCode(code)).toString("hex"));
    return ok;
  }

  gcCodes() { const now = this.now(); for (const [k, exp] of this.codes) if (exp <= now) this.codes.delete(k); }

  // ---- WebAuthn challenges: one per login (or session) nonce, single use ----

  putChallenge(bind, kind, challenge, extra = {}) {
    const now = this.now();
    if (this.challenges.size > 500) for (const [k, c] of this.challenges) if (c.exp <= now) this.challenges.delete(k);
    if (this.challenges.size > 1000) this.challenges.delete(this.challenges.keys().next().value);
    this.challenges.set(bind, { challenge, kind, exp: now + CHALLENGE_TTL, ...extra });
  }

  takeChallenge(bind, kind) {
    const c = this.challenges.get(bind);
    this.challenges.delete(bind);
    return c && c.kind === kind && c.exp > this.now() ? c : null;
  }

  // ---- registered passkeys ----

  addCredential(c) {
    if (this.credentials.some((x) => x.id === c.id)) return false;
    this.credentials.push(c);
    this.passkeys.flush();
    return true;
  }

  removeCredential(id) {
    const i = this.credentials.findIndex((c) => c.id === id || c.id.startsWith(id));
    if (i < 0 || this.credentials.filter((c) => c.id.startsWith(id)).length > 1) return null;
    const [gone] = this.credentials.splice(i, 1);
    this.passkeys.flush();
    return gone;
  }

  touchCredential(id, signCount) {
    const c = this.credentials.find((x) => x.id === id);
    if (!c) return;
    c.signCount = signCount;
    c.lastUsedAt = new Date(this.now()).toISOString();
    this.passkeys.flush();
  }

  publicList() {
    return this.credentials.map(({ id, name, createdAt, lastUsedAt, transports, via }) => ({ id, name, createdAt, lastUsedAt: lastUsedAt ?? null, transports: transports ?? [], via: via ?? null }));
  }

  // Login throttle: 5 failures per IP within 15 min lock that IP for 15 min; a global cap of 30
  // failures per 15 min across all IPs guards against distributed guessing.
  loginAllowed(ip) {
    const now = this.now();
    this.gc(now);
    const f = this.failures.get(ip);
    if (f?.lockedUntil > now) return { ok: false, retryAfter: Math.ceil((f.lockedUntil - now) / 1000) };
    const g = this.failures.get("*");
    if (g?.lockedUntil > now) return { ok: false, retryAfter: Math.ceil((g.lockedUntil - now) / 1000) };
    return { ok: true };
  }

  loginFailed(ip) {
    const now = this.now();
    for (const [k, limit] of [[ip, 5], ["*", 30]]) {
      const f = this.failures.get(k) ?? { count: 0, first: now, lockedUntil: 0 };
      if (now - f.first > 15 * 60_000) Object.assign(f, { count: 0, first: now });
      f.count++;
      if (f.count >= limit) f.lockedUntil = now + 15 * 60_000;
      this.failures.set(k, f);
    }
  }

  loginSucceeded(ip) { this.failures.delete(ip); }

  gc(now) {
    if (this.failures.size < 1000) return;
    for (const [k, f] of this.failures) if (now - f.first > 15 * 60_000 && !(f.lockedUntil > now)) this.failures.delete(k);
  }
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
