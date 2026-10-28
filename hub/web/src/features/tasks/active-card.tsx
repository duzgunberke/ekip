import { Bot, Clock, Laptop, MessageSquareText, Timer } from 'lucide-react'
import type { Task } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { StatusDot } from '@/components/ekip/status-badge'
import { TimeAgo } from '@/components/ekip/time-ago'
import { ProgressBar, StepList, currentStep, elapsed, etaText } from './parts'

const WORKER_STATUS: Record<string, string> = {
  running: 'çalışıyor',
  done: 'bitti',
  failed: 'başarısız',
  cancelled: 'iptal',
  queued: 'sırada',
}

export function ActiveTaskCard({ task: t, now }: { task: Task; now: number }) {
  const cur = currentStep(t)
  const eta = etaText(t, now)
  const workers = t.workers.filter((w) => w.status === 'running' || (!w.endedAt && w.status !== 'done' && w.status !== 'failed'))
  const note = t.notes[t.notes.length - 1]
  return (
    <Card className='min-w-0 gap-5 border-status-running/30'>
      <CardHeader className='grid-cols-[minmax(0,1fr)] gap-3'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0 flex-[1_1_16rem]'>
            <div className='mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
              <span className='flex items-center gap-1.5 font-medium text-status-running'>
                <StatusDot status='running' /> Çalışıyor
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
              %{Math.round(t.pct)}
            </p>
            {cur && (
              <p className='text-xs text-muted-foreground'>
                Adım {cur.index + 1}/{t.steps.length}
              </p>
            )}
          </div>
        </div>
        <ProgressBar value={t.pct} className='h-3' label={`${t.title} ilerlemesi`} />
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground'>
          {cur && (
            <span className='min-w-0 truncate'>
              Şu an: <span className='font-medium text-foreground'>{cur.step.title}</span>
            </span>
          )}
          <span className='flex items-center gap-1.5 tabular-nums'>
            <Clock className='size-3.5' aria-hidden='true' /> {elapsed(t.createdAt, null, now)} geçti
          </span>
          {eta ? (
            <span className='flex items-center gap-1.5 tabular-nums'>
              <Timer className='size-3.5' aria-hidden='true' /> {eta}
            </span>
          ) : (
            <span className='flex items-center gap-1.5'>
              <Timer className='size-3.5' aria-hidden='true' /> tahmin yok
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className='grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
        <section aria-label='Adımlar'>
          <h3 className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>Adımlar</h3>
          <StepList task={t} now={now} />
        </section>
        <div className='grid content-start gap-5'>
          <section aria-label='Çalışan ajanlar'>
            <h3 className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>
              Çalışan ajanlar ({workers.length})
            </h3>
            {workers.length === 0 ? (
              <p className='text-sm text-muted-foreground'>Şu an çalışan ajan yok.</p>
            ) : (
              <ul className='grid gap-1.5'>
                {workers.map((w, i) => (
                  <li key={w.runId ?? i} className='flex items-center gap-2.5 rounded-lg border px-2.5 py-2'>
                    <Bot className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
                    <div className='min-w-0 flex-1'>
                      <p className='truncate text-sm font-medium'>{w.label ?? w.runId ?? 'ajan'}</p>
                      <p className='truncate text-xs text-muted-foreground'>
                        {[w.via, w.status && (WORKER_STATUS[w.status] ?? w.status)].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{elapsed(w.startedAt, w.endedAt, now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {note && (
            <section aria-label='Son not'>
              <h3 className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>Son not</h3>
              <div className='flex gap-2.5 rounded-lg border bg-muted/30 px-3 py-2.5'>
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
