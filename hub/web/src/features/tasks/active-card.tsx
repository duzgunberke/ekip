import { Clock, Laptop, MessageSquareText, Timer } from 'lucide-react'
import type { Task } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { ProviderLogo } from '@/components/provider-logo'
import { RunLogButton } from '@/components/run-log-button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { StatusDot } from '@/components/ekip/status-badge'
import { TimeAgo } from '@/components/ekip/time-ago'
import { ProgressBar, StepList, currentStep, elapsed, etaText, taskState } from './parts'
import { formatNumber, formatPercent, useT } from '@/lib/i18n'

const WORKER_STATUS: Record<string, string> = {
  running: 'çalışıyor',
  done: 'bitti',
  failed: 'başarısız',
  cancelled: 'iptal',
  queued: 'sırada',
  waiting: 'koşul bekleniyor',
  killed: 'öldü',
}

export function ActiveTaskCard({ task: t, now }: { task: Task; now: number }) {
  const translate = useT()
  const cur = currentStep(t)
  const eta = etaText(t, now)
  // every worker the task has had: running ones first, then finished ones with their end state, so
  // a worker that just finished does not vanish and make it look as if there never was one
  const isRunning = (w: Task['workers'][number]) => w.status === 'running' || (!w.endedAt && !['done', 'failed', 'killed', 'cancelled', 'queued', 'waiting'].includes(w.status ?? ''))
  const workers = [...t.workers.filter(isRunning), ...t.workers.filter((w) => !isRunning(w)).reverse()].slice(0, 6)
  const runningCount = t.workers.filter(isRunning).length
  const lastEnded = t.workers.filter((w) => !isRunning(w)).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0]
  const note = t.notes[t.notes.length - 1]
  const state = taskState(t)
  return (
    <Card className='min-w-0 gap-5 border-status-running/30'>
      <CardHeader className='grid-cols-[minmax(0,1fr)] gap-3'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0 flex-[1_1_16rem]'>
            <div className='mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
              <span className={`flex items-center gap-1.5 font-medium ${state.cls}`}>
                <StatusDot status={t.hold ? 'queued' : t.paused ? 'failed' : 'running'} /> {translate(state.label)}
                {state.reason && <span className='font-normal'>· {state.reason}</span>}
              </span>
              {t.project && <Badge variant='secondary'>{t.project}</Badge>}
              {t.host && (
                <span className='flex items-center gap-1'>
                  <Laptop className='size-3' aria-hidden='true' /> {t.host}
                </span>
              )}
            </div>
            <h2 className='text-lg leading-snug font-semibold break-words'>{t.title}</h2>
          </div>
          <div className='text-end'>
            <p className='text-4xl font-semibold tracking-tight tabular-nums'>
              {formatPercent(Math.round(t.pct))}
            </p>
            {cur && (
              <p className='text-xs text-muted-foreground'>
                {translate('Adım {current}/{total}', { current: cur.index + 1, total: t.steps.length })}
              </p>
            )}
          </div>
        </div>
        <ProgressBar value={t.pct} className='h-3' label={translate('{name} ilerlemesi', { name: t.title })} />
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground'>
          {cur && (
            <span className='min-w-0 truncate'>
              {translate('Şu an:')} <span className='font-medium text-foreground'>{cur.step.title}</span>
            </span>
          )}
          <span className='flex items-center gap-1.5 tabular-nums'>
            <Clock className='size-3.5' aria-hidden='true' /> {elapsed(t.createdAt, null, now)} {translate('geçti')}
          </span>
          {eta ? (
            <span className='flex items-center gap-1.5 tabular-nums'>
              <Timer className='size-3.5' aria-hidden='true' /> {eta}
            </span>
          ) : (
            <span className='flex items-center gap-1.5'>
              <Timer className='size-3.5' aria-hidden='true' /> {translate('tahmin yok')}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className='grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
        <section aria-label={translate('Adımlar')}>
          <h3 className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>{translate('Adımlar')}</h3>
          <StepList task={t} now={now} />
        </section>
        <div className='grid content-start gap-5'>
          <section aria-label={translate('Çalışan ajanlar')}>
            <h3 className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>
              {translate('Ajanlar')} ({formatNumber(runningCount)} {translate('çalışıyor')}{t.workers.length > runningCount ? ` · ${formatNumber(t.workers.length - runningCount)} ${translate('bitti')}` : ''})
            </h3>
            {runningCount === 0 && lastEnded && t.status === 'running' && (
              <p className='mb-2 text-sm text-muted-foreground'>
                {translate('{worker} bitirdi; lead (Claude) sonucu inceliyor.', { worker: lastEnded.via ?? lastEnded.label ?? 'işçi' })}
              </p>
            )}
            {workers.length === 0 ? (
              <p className='text-sm text-muted-foreground'>{translate('İşçi yok: bu görevi lead (Claude) kendisi yürütüyor.')}</p>
            ) : (
              <ul className='grid gap-1.5'>
                {workers.map((w, i) => (
                  <li key={w.runId ?? i} className='flex items-center gap-2.5 rounded-lg bg-muted/35 px-2.5 py-2'>
                    <ProviderLogo id={w.via ?? 'unknown'} className='size-4 shrink-0' />
                    <div className='min-w-0 flex-1'>
                      <p className='truncate text-sm font-medium'>{w.label ?? w.runId ?? translate('ajan')}</p>
                      {/* pool, then the model it ran with (its own logo), then the state */}
                      <p className='flex min-w-0 items-center gap-1 text-xs text-muted-foreground' title={w.model ?? undefined}>
                        {w.via && <span>{translate(w.via)}</span>}
                        {w.model && (
                          <>
                            <span>·</span>
                            <ProviderLogo id={w.via ?? 'unknown'} modelId={w.model} className='size-3 shrink-0' />
                            <span className='truncate'>{w.model.split('/').pop()}</span>
                          </>
                        )}
                        {w.status && (
                          <span className='shrink-0'>
                            · {w.status === 'queued' && w.queue ? translate('kuyrukta (sıra {n})', { n: w.queue }) : translate(WORKER_STATUS[w.status] ?? w.status)}
                            {w.why ? ` · ${w.why}` : ''}
                          </span>
                        )}
                      </p>
                    </div>
                    {w.runId && <RunLogButton id={w.runId} failed={w.status === 'failed'} />}
                    <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{elapsed(w.startedAt, w.endedAt, now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {note && (
            <section aria-label={translate('Son not')}>
              <h3 className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>{translate('Son not')}</h3>
              <div className='flex gap-2.5 rounded-lg bg-muted/45 px-3 py-2.5'>
                <MessageSquareText className='mt-0.5 size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
                <div className='min-w-0'>
                  <p className='text-sm break-words whitespace-pre-line'>{note.text}</p>
                  {note.at && (
                    <p className='mt-1 text-xs text-muted-foreground'>
                      <TimeAgo iso={note.at} />
                    </p>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
