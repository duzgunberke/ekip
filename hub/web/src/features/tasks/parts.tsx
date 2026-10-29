import { Check, Circle, Minus, Play, X } from 'lucide-react'
import { clock, span } from '@/lib/format'
import type { Task } from '@/lib/types'
import { cn } from '@/lib/utils'

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

export function etaText(t: Task, now: number) {
  if (!t.eta) return null
  const ms = Date.parse(t.eta) - now
  if (Number.isNaN(ms)) return null
  return ms > 0
    ? `tahmini bitiş ${clock(t.eta)} · ${ms < 60_000 ? '1 dk’dan az' : span(Math.ceil(ms / 60_000) * 60_000)} kaldı` : `tahmini bitiş ${clock(t.eta)} · süre aşıldı`
}

export const elapsed = (from: string | null | undefined, to: string | null | undefined, now: number) =>
  from ? span((to ? Date.parse(to) : now) - Date.parse(from)) : '—'

const STEP_ICON = {
  done: { icon: Check, cls: 'bg-status-done/15 text-status-done', label: 'tamamlandı' },
  running: { icon: Play, cls: 'bg-status-running/15 text-status-running', label: 'çalışıyor' },
  pending: { icon: Circle, cls: 'text-muted-foreground/60', label: 'bekliyor' },
  failed: { icon: X, cls: 'bg-status-failed/15 text-status-failed', label: 'başarısız' },
  skipped: { icon: Minus, cls: 'text-muted-foreground/60', label: 'atlandı' },
} as const

export function StepList({ task, now, compact }: { task: Task; now: number; compact?: boolean }) {
  if (!task.steps.length) return <p className='text-sm text-muted-foreground'>Adım bilgisi yok.</p>
  return (
    <ol className='grid gap-1'>
      {task.steps.map((s, i) => {
        const m = STEP_ICON[s.status] ?? STEP_ICON.pending
        const Icon = m.icon
        const running = s.status === 'running'
        return (
          <li
            key={i}
            className={cn(
              'flex items-start gap-2.5 rounded-lg px-2 py-1.5',
              running && 'bg-status-running/8 ring-1 ring-status-running/25'
            )}
          >
            <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', m.cls)}>
              <Icon className={cn('size-3', s.status === 'pending' && 'size-3.5', running && 'fill-current')} aria-hidden='true' />
              <span className='sr-only'>{m.label}</span>
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
                    {running && s.pct != null ? `%${Math.round(s.pct)} · ` : ''}
                    {elapsed(s.startedAt, s.endedAt, now)}
                  </span>
                )}
              </div>
              {running && s.progressAt && now - Date.parse(s.progressAt) > 15 * 60 * 1000 && (
                <p className='mt-1 text-xs font-medium text-destructive'>
                  {elapsed(s.progressAt, null, now)}dır ilerleme yok
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
