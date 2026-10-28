// Thin fetch wrapper for the hub API. Session = HttpOnly cookie set by POST /login; every write
// carries `X-Ekip-Csrf: 1` (the server rejects cookie-authenticated writes without it).

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type ApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') headers['x-ekip-csrf'] = '1'
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    throw new ApiError(0, 'Sunucuya ulaşılamadı')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && 'error' in data && String(data.error)) ||
      `HTTP ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401

export async function login(password: string) {
  return api<{ ok: true }>('/login', { method: 'POST', body: { password } })
}

export async function logout() {
  return api<{ ok: true }>('/logout', { method: 'POST', body: {} })
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.'
    if (e.status === 429) return 'Çok fazla deneme. Biraz sonra tekrar deneyin.'
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}

/** Post-login redirect target: same-origin, path-absolute, never back to /login. */
export function safeRedirect(r: string | undefined) {
  return r && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/login') ? r : '/'
}
