import { useState } from 'react'
import { ChevronRight, ListTodo, Loader2 } from 'lucide-react'
import type { Task } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useTasks } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AppHeader, PageTitle } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { StatusBadge } from '@/components/ekip/status-badge'
import { EmptyState, QueryError } from '@/components/ekip/states'
import { TimeAgo } from '@/components/ekip/time-ago'
import { ActiveTaskCard } from './active-card'
import { StepList, elapsed } from './parts'

export function Tasks() {
  const tasks = useTasks()
  const now = useNow(1000)
  const list = tasks.data ?? []
  const active = list.filter((t) => t.status === 'running')
  const finished = list.filter((t) => t.status !== 'running')

  return (
    <>
      <AppHeader />
      <Main>
        <PageTitle
          title='Görevler'
          description="Mac'teki ekip'e verdiğiniz isteklerin canlı ilerlemesi."
          actions={
            active.length > 0 && (
              <span className='flex items-center gap-2 text-sm text-muted-foreground'>
                <Loader2 className='size-4 animate-spin text-status-running motion-reduce:animate-none' aria-hidden='true' />
                {active.length} görev çalışıyor
              </span>
            )
          }
        />
        {tasks.isError ? (
          <QueryError error={tasks.error} onRetry={() => tasks.refetch()} />
        ) : tasks.isLoading ? (
          <div className='grid gap-4'>
            <Skeleton className='h-72 rounded-xl' />
            <Skeleton className='h-14 rounded-xl' />
            <Skeleton className='h-14 rounded-xl' />
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={ListTodo}
            title='Henüz görev yok'
            description="Mac'teki ekip bir isteği işlemeye başladığında ilerlemesi burada canlı görünür."
          />
        ) : (
          <div className='grid gap-8'>
            <section aria-labelledby='active-h' aria-live='polite'>
              <h2 id='active-h' className='sr-only'>
                Aktif görevler
              </h2>
              {active.length === 0 ? (
                <div className='rounded-xl border border-dashed px-6 py-8 text-center text-sm text-muted-foreground'>
                  Şu an çalışan görev yok.
                </div>
              ) : (
                <div className='grid gap-4'>
                  {active.map((t) => (
                    <ActiveTaskCard key={t.id} task={t} now={now} />
                  ))}
                </div>
              )}
            </section>
            {finished.length > 0 && (
              <section aria-labelledby='done-h'>
                <h2 id='done-h' className='mb-3 text-sm font-medium text-muted-foreground'>
                  Biten görevler ({finished.length})
                </h2>
                <Card className='gap-0 divide-y p-0'>
                  {finished.map((t) => (
                    <FinishedRow key={t.id} task={t} now={now} />
                  ))}
                </Card>
              </section>
            )}
          </div>
        )}
      </Main>
    </>
  )
}

function FinishedRow({ task: t, now }: { task: Task; now: number }) {
  const [open, setOpen] = useState(false)
  const result = t.notes[t.notes.length - 1]?.text
  const panelId = `task-${t.id}`
  return (
    <div>
      <button
        type='button'
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className='flex w-full items-start gap-3 px-4 py-3 text-start hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none'
      >
        <ChevronRight
          className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          aria-hidden='true'
        />
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <StatusBadge status={t.status} />
            <span className='min-w-0 truncate font-medium'>{t.title}</span>
          </div>
          {result && <p className='mt-1 line-clamp-2 text-sm text-muted-foreground'>{result}</p>}
        </div>
        <div className='hidden shrink-0 text-end text-xs text-muted-foreground sm:block'>
          <p className='tabular-nums'>{elapsed(t.createdAt, t.endedAt ?? t.updatedAt, now)}</p>
          <p>
            <TimeAgo iso={t.endedAt ?? t.updatedAt} />
          </p>
        </div>
      </button>
      {open && (
        <div id={panelId} className='grid gap-5 border-t bg-muted/15 px-4 py-4 sm:px-11 lg:grid-cols-2'>
          <section>
            <h3 className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>Adımlar</h3>
            <StepList task={t} now={now} />
          </section>
          <section className='min-w-0'>
            <div className='mb-3 flex flex-wrap gap-1.5 text-xs'>
              {t.project && <Badge variant='secondary'>{t.project}</Badge>}
              {t.host && <Badge variant='outline'>{t.host}</Badge>}
              <Badge variant='outline' className='sm:hidden'>
                {elapsed(t.createdAt, t.endedAt ?? t.updatedAt, now)}
              </Badge>
              {t.workers.length > 0 && <Badge variant='outline'>{t.workers.length} ajan</Badge>}
            </div>
            <h3 className='mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase'>Notlar</h3>
            {t.notes.length === 0 ? (
              <p className='text-sm text-muted-foreground'>Not yok.</p>
            ) : (
              <ol className='grid gap-2 border-s ps-3'>
                {t.notes.map((n, i) => (
                  <li key={i} className='text-sm'>
                    <p className='break-words whitespace-pre-line'>{n.text}</p>
                    {n.at && (
                      <p className='text-xs text-muted-foreground'>
                        <TimeAgo iso={n.at} />
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
