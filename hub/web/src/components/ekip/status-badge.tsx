import { cn } from '@/lib/utils'
import { POOL_LABEL, STATUS_LABEL } from '@/lib/format'
import { Badge } from '@/components/ui/badge'

const STATUS_CLS: Record<string, string> = {
  queued: 'border-status-queued/30 bg-status-queued/10 text-muted-foreground',
  running: 'border-status-running/30 bg-status-running/12 text-status-running',
  done: 'border-status-done/30 bg-status-done/12 text-status-done',
  failed: 'border-status-failed/30 bg-status-failed/12 text-status-failed',
  cancelled: 'border-status-cancelled/30 bg-status-cancelled/12 text-status-cancelled',
}

const DOT_CLS: Record<string, string> = {
  queued: 'bg-status-queued',
  running: 'bg-status-running',
  done: 'bg-status-done',
  failed: 'bg-status-failed',
  cancelled: 'bg-status-cancelled',
}

export function StatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn('relative flex size-2 shrink-0', className)} aria-hidden='true'>
      {status === 'running' && (
        <span className='absolute inline-flex size-full animate-ping rounded-full bg-status-running opacity-60 motion-reduce:hidden' />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', DOT_CLS[status] ?? 'bg-muted-foreground')} />
    </span>
  )
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant='outline' className={cn('gap-1.5 font-medium', STATUS_CLS[status], className)}>
      <StatusDot status={status} />
      {STATUS_LABEL[status] ?? status}
    </Badge>
  )
}

const POOL_CLS: Record<string, string> = {
  healthy: 'border-success/30 bg-success/12 text-success',
  rate_limited: 'border-warning/30 bg-warning/12 text-warning',
  invalid: 'border-destructive/30 bg-destructive/12 text-destructive',
  unknown: 'text-muted-foreground',
}
const POOL_DOT: Record<string, string> = {
  healthy: 'bg-success',
  rate_limited: 'bg-warning',
  invalid: 'bg-destructive',
  unknown: 'bg-muted-foreground/60',
}

export function PoolBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant='outline' className={cn('gap-1.5', POOL_CLS[status] ?? POOL_CLS.unknown, className)}>
      <span className={cn('size-1.5 rounded-full', POOL_DOT[status] ?? POOL_DOT.unknown)} aria-hidden='true' />
      {POOL_LABEL[status] ?? status}
    </Badge>
  )
}

type Tone = 'ok' | 'warn' | 'bad' | 'off'
const TONE_CLS: Record<Tone, string> = {
  ok: 'border-success/30 bg-success/12 text-success',
  warn: 'border-warning/30 bg-warning/12 text-warning',
  bad: 'border-destructive/30 bg-destructive/12 text-destructive',
  off: 'text-muted-foreground',
}
const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-destructive',
  off: 'bg-muted-foreground/60',
}

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant='outline' className={cn('gap-1.5', TONE_CLS[tone], className)}>
      <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} aria-hidden='true' />
      {children}
    </Badge>
  )
}
