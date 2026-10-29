import { format, formatDistanceToNowStrict } from 'date-fns'
import { tr } from 'date-fns/locale'

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'Yok'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Yok'
  if (Math.abs(Date.now() - d.getTime()) < 10_000) return 'şimdi'
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: tr })
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return 'Yok'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'Yok' : format(d, 'd MMM yyyy HH:mm:ss', { locale: tr })
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return 'Yok'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'Yok' : format(d, 'd MMM HH:mm', { locale: tr })
}

export function duration(from: string | null | undefined, to?: string | null): string {
  if (!from) return 'Yok'
  const s = Math.max(
    0,
    Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000)
  )
  if (s < 60) return `${s} sn`
  if (s < 3600) return `${Math.floor(s / 60)} dk ${s % 60} sn`
  return `${Math.floor(s / 3600)} sa ${Math.floor((s % 3600) / 60)} dk`
}

export const firstLine = (t: string | null | undefined) => (t ?? '').trim().split('\n')[0] ?? ''

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Sırada',
  running: 'Çalışıyor',
  done: 'Bitti',
  failed: 'Başarısız',
  cancelled: 'İptal',
}

export const POOL_LABEL: Record<string, string> = {
  healthy: 'sağlıklı',
  rate_limited: 'limitte',
  no_models: 'model yok',
  invalid: 'geçersiz',
  unknown: 'bilinmiyor',
}

export const VIA_LABEL: Record<string, string> = {
  auto: 'Otomatik',
  copilot: 'Copilot',
  free: 'Ücretsiz havuz',
}

/** Run statuses reported from the Mac are free-form; map them onto job statuses. */
export function normalizeRunStatus(s: string | null | undefined): string {
  const map: Record<string, string> = {
    ok: 'done',
    success: 'done',
    succeeded: 'done',
    done: 'done',
    failed: 'failed',
    error: 'failed',
    running: 'running',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    queued: 'queued',
  }
  return map[(s ?? '').toLowerCase()] ?? (s || 'unknown')
}

/** Summaries are markdown one-liners; show them as plain text on cards. */
export const stripMd = (s: string) =>
  s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

/** Compact duration in ms: "45 sn", "12 dk", "1 sa 5 dk". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} sn`
  if (s < 3600) return `${Math.floor(s / 60)} dk ${s % 60 ? `${s % 60} sn` : ''}`.trim()
  return `${Math.floor(s / 3600)} sa ${Math.floor((s % 3600) / 60)} dk`
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return 'Yok'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'Yok' : format(d, 'HH:mm', { locale: tr })
}
