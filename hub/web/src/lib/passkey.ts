// Passkeys (WebAuthn) in the browser: the hub sends options with base64url fields, the browser API
// wants ArrayBuffers; the answer goes back as JSON with base64url fields. No library needed.
import { api } from '@/lib/api'

type Json = Record<string, unknown>
type Desc = { type: 'public-key'; id: string; transports?: string[] }

const fromB64u = (s: string): ArrayBuffer => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}
const toB64u = (b: ArrayBuffer): string => {
  let s = ''
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const descs = (list: Desc[] = []) =>
  list.map((d) => ({ type: d.type, id: fromB64u(d.id), transports: d.transports as AuthenticatorTransport[] }))

export const passkeysSupported = () =>
  typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials

async function create(o: Json): Promise<Json> {
  const user = o.user as { id: string; name: string; displayName: string }
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...(o as unknown as PublicKeyCredentialCreationOptions),
      challenge: fromB64u(o.challenge as string),
      user: { ...user, id: fromB64u(user.id) },
      excludeCredentials: descs(o.excludeCredentials as Desc[]),
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('cancelled')
  const r = cred.response as AuthenticatorAttestationResponse
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      attestationObject: toB64u(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
    },
  }
}

async function get(o: Json): Promise<Json> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      ...(o as unknown as PublicKeyCredentialRequestOptions),
      challenge: fromB64u(o.challenge as string),
      allowCredentials: descs(o.allowCredentials as Desc[]),
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('cancelled')
  const r = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
      userHandle: r.userHandle ? toB64u(r.userHandle) : null,
    },
  }
}

const deviceName = () => {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : 'passkey'
  return `${os} ${new Date().toISOString().slice(0, 10)}`
}

/** After the password: sign in with a registered passkey. */
export async function signInWithPasskey() {
  const o = await api<Json>('/login/passkey/options', { method: 'POST', body: {} })
  return api<{ ok: true }>('/login/passkey/verify', { method: 'POST', body: { credential: await get(o) } })
}

/** After the password: register a passkey with a one-time code from `ekip hub passkey add`. */
export async function enrolWithCode(code: string) {
  const o = await api<Json>('/login/enrol/options', { method: 'POST', body: { code } })
  return api<{ ok: true }>('/login/enrol/verify', {
    method: 'POST',
    body: { code, name: deviceName(), credential: await create(o) },
  })
}

/** From a passkey session: register one more passkey (another device). */
export async function addPasskey() {
  const o = await api<Json>('/api/passkeys/register/options', { method: 'POST', body: {} })
  return api<{ ok: true }>('/api/passkeys/register/verify', {
    method: 'POST',
    body: { name: deviceName(), credential: await create(o) },
  })
}
