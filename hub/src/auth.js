// Bearer token for machines, password -> signed session cookie for the panel, login rate limit.
import crypto from "node:crypto";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
// Constant-time string compare (hashing first makes the lengths equal).
export const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && crypto.timingSafeEqual(sha(a), sha(b));

export const COOKIE = "ekip_session";

export class Auth {
  constructor({ token, password, secret, sessionHours }) {
    this.token = token;
    this.password = password;
    // Bound to the password: changing it invalidates every session.
    this.key = crypto.createHmac("sha256", secret).update(`session:${password}`).digest();
    this.ttl = sessionHours * 3600_000;
    this.failures = new Map(); // ip -> { count, first, lockedUntil }
  }

  passwordOk(pw) { return safeEqual(pw, this.password); }

  bearerOk(req) {
    const h = req.headers.authorization ?? "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    return !!m && safeEqual(m[1].trim(), this.token);
  }

  sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = crypto.createHmac("sha256", this.key).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  newSession() {
    return this.sign({ exp: Date.now() + this.ttl, n: crypto.randomBytes(9).toString("base64url") });
  }

  sessionOk(req) {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return false;
    const [body, mac] = raw.split(".");
    if (!body || !mac) return false;
    const want = crypto.createHmac("sha256", this.key).update(body).digest("base64url");
    if (!safeEqual(mac, want)) return false;
    try { return JSON.parse(Buffer.from(body, "base64url").toString()).exp > Date.now(); } catch { return false; }
  }

  cookie(value, maxAgeSec) {
    // a panel on this computer (ekip hub local) is plain http on loopback, where Safari drops Secure cookies
    return `${COOKIE}=${value}; Path=/; HttpOnly;${process.env.EKIP_LOCAL_PANEL === "1" ? "" : " Secure;"} SameSite=Strict; Max-Age=${maxAgeSec}`;
  }

  // Login throttle: 5 failures per IP within 15 min lock that IP for 15 min; a global cap of 30
  // failures per 15 min across all IPs guards against distributed guessing.
  loginAllowed(ip) {
    const now = Date.now();
    this.gc(now);
    const f = this.failures.get(ip);
    if (f?.lockedUntil > now) return { ok: false, retryAfter: Math.ceil((f.lockedUntil - now) / 1000) };
    const g = this.failures.get("*");
    if (g?.lockedUntil > now) return { ok: false, retryAfter: Math.ceil((g.lockedUntil - now) / 1000) };
    return { ok: true };
  }

  loginFailed(ip) {
    const now = Date.now();
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
