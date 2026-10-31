import { Check, Circle, Hourglass, Minus, Pause, Play, X } from 'lucide-react'
import { clock, span } from '@/lib/format'
import type { Task } from '@/lib/types'
import { cn } from '@/lib/utils'
import { formatPercent, translate, useT } from '@/lib/i18n'

export function ProgressBar({
  value,
  className,
  barClassName,
  label,
}: {
  value: number
  className?: string
  barClassName?: string
  label: string
}) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div
      role='progressbar'
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        className={cn('h-full rounded-full bg-status-running transition-[width] duration-700 ease-out motion-reduce:transition-none', barClassName)}
        style={{ width: `${v}%` }}
      />
    </div>
  )
}

export const currentStep = (t: Task) => {
  const i = t.steps.findIndex((s) => s.status === 'running')
  const j = i >= 0 ? i : t.steps.findIndex((s) => s.status === 'pending')
  return j >= 0 ? { index: j, step: t.steps[j] } : null
}

// What really holds a running task: blocked, waiting for the user, or paused with no live worker.
export function taskState(t: Task): { label: string; cls: string; reason?: string } {
  if (t.hold?.kind === 'waiting-user') return { label: 'Kullanıcı bekleniyor', cls: 'text-primary', reason: t.hold.reason }
  if (t.hold) return { label: 'Engellendi', cls: 'text-status-cancelled', reason: t.hold.reason }
  if (t.paused) return { label: 'Duraklamış: çalışan ajan yok', cls: 'text-status-failed' }
  return { label: 'Çalışıyor', cls: 'text-status-running' }
}

// The automatic review as one line, the same words as the pane and `ekip status` on the Mac.
export function reviewLine(t: Task): { text: string; cls: string } | null {
  const r = t.review
  if (!r?.state) return null
  const round = r.round ? translate('düzeltme turu {n}/{max}', { n: r.round, max: r.max ?? 2 }) : ''
  const join = (...xs: string[]) => xs.filter(Boolean).join(' · ')
  if (r.state === 'pending') return { text: translate('incelemeye gidiyor'), cls: 'text-status-running' }
  if (r.state === 'reviewing') return { text: join(translate('inceleniyor (reviewer: {pool})', { pool: r.reviewer ?? '?' }), round), cls: 'text-status-running' }
  if (r.state === 'fixing') return { text: join(round, translate('düzeltiyor: {pool}', { pool: r.author ?? '?' }), r.findings ? translate('{n} bulgu', { n: r.findings }) : ''), cls: 'text-status-running' }
  if (r.state === 'passed') return { text: translate('review: geçti (kriter {met}/{total})', { met: r.met ?? '?', total: r.total ?? '?' }), cls: 'text-status-done' }
  if (r.state === 'failed') return { text: translate('review: düştü ({n} bulgu)', { n: r.findings ?? 0 }), cls: 'text-status-failed' }
  return { text: translate('review: yapılamadı'), cls: 'text-status-cancelled' }
}

export function etaText(t: Task, now: number) {
  // no estimate while the task waits on something outside it
  if (!t.eta || t.hold || t.paused) return null
  const ms = Date.parse(t.eta) - now
  if (Number.isNaN(ms)) return null
  return ms > 0
    ? translate('tahmini bitiş {time} · {remaining} kaldı', {
        time: clock(t.eta),
        remaining: ms < 60_000 ? translate('1 dk’dan az') : span(Math.ceil(ms / 60_000) * 60_000),
      })
    : translate('tahmini bitiş {time} · süre aşıldı', { time: clock(t.eta) })
}

export const elapsed = (from: string | null | undefined, to: string | null | undefined, now: number) =>
  from ? span((to ? Date.parse(to) : now) - Date.parse(from)) : translate('Yok')

const STEP_ICON = {
  done: { icon: Check, cls: 'bg-status-done/15 text-status-done', label: 'tamamlandı' },
  running: { icon: Play, cls: 'bg-status-running/15 text-status-running', label: 'çalışıyor' },
  pending: { icon: Circle, cls: 'text-muted-foreground/60', label: 'bekliyor' },
  failed: { icon: X, cls: 'bg-status-failed/15 text-status-failed', label: 'başarısız' },
  skipped: { icon: Minus, cls: 'text-muted-foreground/60', label: 'atlandı' },
  blocked: { icon: Pause, cls: 'bg-status-cancelled/15 text-status-cancelled', label: 'engellendi' },
  'waiting-user': { icon: Hourglass, cls: 'bg-primary/15 text-primary', label: 'kullanıcı bekleniyor' },
} as const

export function StepList({ task, now, compact }: { task: Task; now: number; compact?: boolean }) {
  const t = useT()
  if (!task.steps.length) return <p className='text-sm text-muted-foreground'>{t('Adım bilgisi yok.')}</p>
  return (
    <ol className='grid gap-1'>
      {task.steps.map((s, i) => {
        // a long worker step only reports at its end: a running worker is not a stall
        const workerRunning = (task.workers ?? []).some((w) => w.status === 'running')
        const m = STEP_ICON[s.status] ?? STEP_ICON.pending
        const Icon = m.icon
        const running = s.status === 'running'
        const held = s.status === 'blocked' || s.status === 'waiting-user'
        return (
          <li
            key={i}
            className={cn(
              'flex items-start gap-2.5 rounded-lg px-2 py-1.5',
              running && 'bg-status-running/8 ring-1 ring-status-running/25',
              held && 'bg-muted/50 ring-1 ring-border'
            )}
          >
            <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', m.cls)}>
              <Icon className={cn('size-3', s.status === 'pending' && 'size-3.5', running && 'fill-current')} aria-hidden='true' />
              <span className='sr-only'>{t(m.label)}</span>
            </span>
            <div className='min-w-0 flex-1'>
              <div className='flex items-baseline justify-between gap-3'>
                <span
                  className={cn(
                    'text-sm',
                    running && 'font-medium',
                    (s.status === 'pending' || s.status === 'skipped') && 'text-muted-foreground',
                    s.status === 'skipped' && 'line-through'
                  )}
                >
                  {s.title}
                </span>
                {!compact && (s.startedAt || running) && (
                  <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>
                    {running && s.pct != null ? `${formatPercent(Math.round(s.pct))} · ` : ''}
                    {elapsed(s.startedAt, s.endedAt, now)}
                  </span>
                )}
              </div>
              {held && (
                <p className={cn('mt-1 text-xs font-medium', s.status === 'blocked' ? 'text-status-cancelled' : 'text-primary')}>
                  {t(m.label)}
                  {s.reason ? `: ${s.reason}` : ''}
                </p>
              )}
              {running && s.progressAt && now - Date.parse(s.progressAt) > 15 * 60 * 1000 && !workerRunning && !task.paused && (
                <p className='mt-1 text-xs font-medium text-destructive'>
                  {t('{duration} boyunca ilerleme yok', { duration: elapsed(s.progressAt, null, now) })}
                </p>
              )}
              {running && s.detail && <p className='mt-0.5 text-xs text-muted-foreground'>{s.detail}</p>}
              {running && s.pct != null && (
                <ProgressBar value={s.pct} className='mt-1.5 h-1' label={`${s.title} ilerlemesi`} />
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
