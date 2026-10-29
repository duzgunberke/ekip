import { format, formatDistanceToNowStrict } from 'date-fns'
import { enUS, tr } from 'date-fns/locale'
import { getLanguage, translate } from '@/lib/i18n'

const locale = () => (getLanguage() === 'tr' ? tr : enUS)

export function ago(iso: string | null | undefined): string {
  if (!iso) return translate('Yok')
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return translate('Yok')
  if (Math.abs(Date.now() - d.getTime()) < 10_000) return translate('şimdi')
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: locale() })
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return translate('Yok')
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? translate('Yok') : format(d, 'd MMM yyyy HH:mm:ss', { locale: locale() })
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return translate('Yok')
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? translate('Yok') : format(d, 'd MMM HH:mm', { locale: locale() })
}

function formatSpan(seconds: number): string {
  const parts: string[] = []
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600)
    parts.push(translate('{count} sa', { count: hours }))
    seconds %= 3600
  }
  if (seconds >= 60 || parts.length) {
    const minutes = Math.floor(seconds / 60)
    if (minutes > 0) parts.push(translate('{count} dk', { count: minutes }))
    seconds %= 60
  }
  if (seconds > 0 || !parts.length) parts.push(translate('{count} sn', { count: seconds }))
  return parts.join(' ')
}

export function duration(from: string | null | undefined, to?: string | null): string {
  if (!from) return translate('Yok')
  const s = Math.max(
    0,
    Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000)
  )
  return formatSpan(s)
}

export const firstLine = (t: string | null | undefined) => (t ?? '').trim().split('\n')[0] ?? ''

const STATUS_KEY: Record<string, string> = {
  queued: 'Sırada',
  running: 'Çalışıyor',
  done: 'Bitti',
  failed: 'Başarısız',
  cancelled: 'İptal',
}

export function statusLabel(status: string): string {
  return translate(STATUS_KEY[status] ?? status)
}

const POOL_KEY: Record<string, string> = {
  healthy: 'sağlıklı',
  rate_limited: 'limitte',
  no_models: 'model yok',
  invalid: 'geçersiz',
  unknown: 'bilinmiyor',
}

export function poolLabel(status: string): string {
  return translate(POOL_KEY[status] ?? status)
}

const VIA_KEY: Record<string, string> = {
  auto: 'Otomatik',
  copilot: 'Copilot',
  free: 'Ücretsiz havuz',
}

export function viaLabel(via: string): string {
  return translate(VIA_KEY[via] ?? via)
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
  return formatSpan(s)
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return translate('Yok')
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? translate('Yok') : format(d, 'HH:mm', { locale: locale() })
}
