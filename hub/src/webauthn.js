// WebAuthn (passkeys) relying-party checks on node:crypto alone: the hub ships without npm
// dependencies, and a second factor needs only "none" attestation, so the job is small: decode CBOR,
// read authenticator data, turn the COSE key into a JWK, verify one signature.
// Supported keys: ES256 (-7, P-256), EdDSA (-8, Ed25519), RS256 (-257).
import crypto from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s, field) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.length > 100_000) throw new WebAuthnError(`${field} must be base64url`);
  return Buffer.from(s, "base64url");
};
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

export class WebAuthnError extends Error {}
const fail = (msg) => { throw new WebAuthnError(msg); };

// ---- CBOR (RFC 8949): just what attestation objects and COSE keys use -------------------------

export function cborDecode(buf, start = 0) {
  let pos = start;
  const need = (n) => { if (pos + n > buf.length) fail("truncated CBOR"); };
  const uint = (info) => {
    if (info < 24) return info;
    const n = { 24: 1, 25: 2, 26: 4, 27: 8 }[info] ?? fail("unsupported CBOR length");
    need(n);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[pos + i];
    pos += n;
    if (!Number.isSafeInteger(v)) fail("CBOR integer too large");
    return v;
  };
  const item = (depth) => {
    if (depth > 16) fail("CBOR nested too deep");
    need(1);
    const b = buf[pos++], major = b >> 5, info = b & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      fail("unsupported CBOR simple value");
    }
    if (info === 31) fail("indefinite CBOR lengths are not supported");
    const v = uint(info);
    switch (major) {
      case 0: return v;
      case 1: return -1 - v;
      case 2: { need(v); const out = buf.subarray(pos, pos + v); pos += v; return Buffer.from(out); }
      case 3: { need(v); const out = buf.subarray(pos, pos + v).toString("utf8"); pos += v; return out; }
      case 4: { if (v > 1000) fail("CBOR array too long"); return Array.from({ length: v }, () => item(depth + 1)); }
      case 5: {
        if (v > 1000) fail("CBOR map too long");
        const m = new Map();
        for (let i = 0; i < v; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); }
        return m;
      }
      case 6: return item(depth + 1); // tags carry no meaning here
      default: return fail("bad CBOR");
    }
  };
  const value = item(0);
  return { value, end: pos };
}

// ---- COSE key -> JWK ----------------------------------------------------------------------------

function coseToJwk(m) {
  if (!(m instanceof Map)) fail("credential public key is not a map");
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) return { alg: -7, jwk: { kty: "EC", crv: "P-256", x: b64u(m.get(-2)), y: b64u(m.get(-3)) } };
  if (kty === 1 && alg === -8 && m.get(-1) === 6) return { alg: -8, jwk: { kty: "OKP", crv: "Ed25519", x: b64u(m.get(-2)) } };
  if (kty === 3 && alg === -257) return { alg: -257, jwk: { kty: "RSA", n: b64u(m.get(-1)), e: b64u(m.get(-2)) } };
  return fail(`unsupported credential key (kty ${kty}, alg ${alg})`);
}

function verifySig(alg, jwk, data, sig) {
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  if (alg === -8) return crypto.verify(null, data, key, sig);
  return crypto.verify("sha256", data, key, sig); // ES256 signatures are DER, Node's default
}

// ---- authenticator data -------------------------------------------------------------------------

export function parseAuthData(buf) {
  if (buf.length < 37) fail("authenticator data too short");
  const flags = buf[32];
  const out = {
    rpIdHash: buf.subarray(0, 32),
    up: !!(flags & 0x01),
    uv: !!(flags & 0x04),
    at: !!(flags & 0x40),
    signCount: buf.readUInt32BE(33),
  };
  if (out.at) {
    if (buf.length < 55) fail("attested credential data too short");
    const len = buf.readUInt16BE(53);
    if (len < 16 || len > 1023 || buf.length < 55 + len) fail("bad credential id");
    out.credentialId = Buffer.from(buf.subarray(55, 55 + len));
    out.publicKey = cborDecode(buf, 55 + len).value;
  }
  return out;
}

function checkClientData(raw, { type, challenge, origin }) {
  let cd;
  try { cd = JSON.parse(raw.toString("utf8")); } catch { fail("clientDataJSON is not JSON"); }
  if (cd.type !== type) fail(`clientData type is not ${type}`);
  if (typeof cd.challenge !== "string" || cd.challenge !== challenge) fail("challenge mismatch");
  if (cd.origin !== origin) fail(`origin mismatch (${String(cd.origin).slice(0, 100)})`);
  if (cd.crossOrigin === true) fail("cross-origin ceremonies are not accepted");
}

function checkRp(auth, rpId) {
  if (!crypto.timingSafeEqual(auth.rpIdHash, sha256(rpId))) fail("rpId mismatch");
  if (!auth.up) fail("user presence flag missing");
}

// ---- ceremonies ---------------------------------------------------------------------------------

export const newChallenge = () => b64u(crypto.randomBytes(32));

export function creationOptions({ challenge, rpId, rpName = "ekip hub", userId, exclude = [] }) {
  return {
    challenge,
    rp: { id: rpId, name: rpName },
    user: { id: userId, name: "ekip", displayName: "ekip" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }],
    timeout: 120_000,
    attestation: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    excludeCredentials: exclude.map((c) => ({ type: "public-key", id: c.id, transports: c.transports ?? [] })),
  };
}

export function requestOptions({ challenge, rpId, allow }) {
  return {
    challenge,
    rpId,
    timeout: 120_000,
    userVerification: "preferred",
    allowCredentials: allow.map((c) => ({ type: "public-key", id: c.id, transports: c.transports ?? [] })),
  };
}

// cred: the browser's PublicKeyCredential serialised as JSON (base64url fields), as the panel sends it.
export function verifyRegistration(cred, { challenge, origin, rpId }) {
  if (!cred || typeof cred !== "object" || !cred.response || typeof cred.response !== "object") fail("credential missing");
  const clientData = unb64u(cred.response.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, { type: "webauthn.create", challenge, origin });
  const att = cborDecode(unb64u(cred.response.attestationObject, "attestationObject")).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get("authData"))) fail("bad attestation object");
  const auth = parseAuthData(att.get("authData"));
  checkRp(auth, rpId);
  if (!auth.at) fail("no attested credential data");
  const { alg, jwk } = coseToJwk(auth.publicKey);
  crypto.createPublicKey({ key: jwk, format: "jwk" }); // the key must load
  const id = b64u(auth.credentialId);
  if (cred.id && cred.id !== id) fail("credential id mismatch");
  const transports = Array.isArray(cred.response.transports) ? cred.response.transports.filter((x) => typeof x === "string" && x.length < 20).slice(0, 8) : [];
  return { id, alg, jwk, signCount: auth.signCount, transports, uv: auth.uv };
}

// stored: { id, alg, jwk, signCount }. Returns the new sign counter.
export function verifyAuthentication(cred, stored, { challenge, origin, rpId }) {
  if (!cred || typeof cred !== "object" || !cred.response || typeof cred.response !== "object") fail("credential missing");
  if (cred.id !== stored.id) fail("credential id mismatch");
  const clientData = unb64u(cred.response.clientDataJSON, "clientDataJSON");
  checkClientData(clientData, { type: "webauthn.get", challenge, origin });
  const authData = unb64u(cred.response.authenticatorData, "authenticatorData");
  const auth = parseAuthData(authData);
  checkRp(auth, rpId);
  const sig = unb64u(cred.response.signature, "signature");
  const signed = Buffer.concat([authData, sha256(clientData)]);
  let ok = false;
  try { ok = verifySig(stored.alg, stored.jwk, signed, sig); } catch { ok = false; }
  if (!ok) fail("signature does not verify");
  // A counter that does not move forward means a cloned authenticator (synced passkeys stay at 0).
  if ((auth.signCount || stored.signCount) && auth.signCount <= stored.signCount) fail("sign counter went backwards");
  return { signCount: auth.signCount, uv: auth.uv };
}
