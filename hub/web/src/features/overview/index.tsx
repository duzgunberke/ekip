import { Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  Brain,
  Cpu,
  FolderGit2,
  Laptop,
  ListChecks,
  Plus,
  ServerCog,
} from 'lucide-react'
import { duration, firstLine } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useJobs, useProjects, useStatus } from '@/hooks/queries'
import { useNewJob } from '@/context/new-job-provider'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AppHeader, PageTitle } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PoolBadge, StatusBadge, StatusDot, ToneBadge } from '@/components/ekip/status-badge'
import { EmptyState, QueryError } from '@/components/ekip/states'
import { TimeAgo } from '@/components/ekip/time-ago'
import { ActiveTasksMini } from '@/features/tasks/mini'
import { JobsChart } from './jobs-chart'

export function Overview() {
  const status = useStatus()
  const projects = useProjects()
  const jobs = useJobs()
  const { openNewJob } = useNewJob()

  const s = status.data
  const healthy = s?.freellmapi.providers.filter((p) => p.status === 'healthy').length ?? 0
  const lastClient = s?.clients[0]
  const memoryLinked = projects.data?.filter((p) => p.tdai?.teamId).length ?? 0

  return (
    <>
      <AppHeader />
      <Main>
        <PageTitle
          title='Genel bakış'
          description='Hub, iş kuyruğu ve model havuzlarının anlık durumu.'
          actions={
            <Button onClick={() => openNewJob()}>
              <Plus /> Yeni iş
            </Button>
          }
        />

        <ActiveTasksMini />

        {status.isError && (
          <QueryError className='mb-4' error={status.error} onRetry={() => status.refetch()} />
        )}

        <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
          <Kpi
            title='Kayıtlı proje'
            icon={FolderGit2}
            loading={projects.isLoading}
            value={projects.data?.length ?? '—'}
            hint={`${memoryLinked} tanesi hafızaya bağlı`}
            to='/projeler'
          />
          <Kpi
            title='Çalışan / kuyrukta iş'
            icon={ListChecks}
            loading={status.isLoading}
            value={
              s ? (
                <>
                  {s.queue.running ?? 0}
                  <span className='text-muted-foreground'> / {s.queue.queued ?? 0}</span>
                </>
              ) : (
                '—'
              )
            }
            hint={s ? `${s.workers.length} işçi slotu · ${s.queue.done ?? 0} bitti` : undefined}
            to='/isler'
          />
          <Kpi
            title='Sağlıklı sağlayıcı'
            icon={ServerCog}
            loading={status.isLoading}
            value={
              s ? (
                <>
                  {healthy}
                  <span className='text-muted-foreground'> / {s.freellmapi.providerCount}</span>
                </>
              ) : (
                '—'
              )
            }
            hint={
              !s
                ? undefined
                : !s.freellmapi.configured
                  ? 'freellmapi ayarlı değil'
                  : s.freellmapi.ready
                    ? 'freellmapi hazır'
                    : s.freellmapi.up
                      ? 'freellmapi hazır değil'
                      : 'freellmapi kapalı'
            }
            to='/havuzlar'
          />
          <Kpi
            title='Mac son görülme'
            icon={Laptop}
            loading={status.isLoading}
            value={lastClient ? <TimeAgo iso={lastClient.lastSeen} /> : 'sinyal yok'}
            valueClassName='text-xl'
            hint={lastClient ? [lastClient.client, lastClient.host].filter(Boolean).join(' · ') : 'Mac henüz heartbeat göndermedi'}
          />
        </div>

        <div className='mt-4 grid gap-4 lg:grid-cols-7'>
          <Card className='lg:col-span-4'>
            <CardHeader>
              <CardTitle>Günlük işler</CardTitle>
              <CardDescription>Son 14 gün, duruma göre</CardDescription>
            </CardHeader>
            <CardContent className='flex flex-1 flex-col ps-2'>
              {jobs.isLoading ? (
                <Skeleton className='ms-4 h-64' />
              ) : jobs.isError ? (
                <QueryError className='ms-4 w-auto' error={jobs.error} onRetry={() => jobs.refetch()} />
              ) : (
                <JobsChart jobs={jobs.data ?? []} />
              )}
            </CardContent>
          </Card>

          <Card className='lg:col-span-3'>
            <CardHeader>
              <CardTitle>Havuz sağlığı</CardTitle>
              <CardDescription>freellmapi sağlayıcıları ve hafıza</CardDescription>
              <CardAction>
                <Button variant='ghost' size='sm' asChild>
                  <Link to='/havuzlar'>
                    Tümü <ArrowRight />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {status.isLoading ? (
                <ListSkeleton rows={5} />
              ) : !s ? null : s.freellmapi.providers.length === 0 ? (
                <EmptyState
                  icon={ServerCog}
                  title='Sağlayıcı yok'
                  description={s.freellmapi.authError ?? s.freellmapi.reason ?? 'freellmapi sağlayıcı bildirmedi.'}
                  className='py-8'
                />
              ) : (
                <ul className='divide-y'>
                  {s.freellmapi.providers.slice(0, 6).map((p) => (
                    <li key={`${p.platform}-${p.name}`} className='flex items-center justify-between gap-3 py-2.5'>
                      <div className='min-w-0'>
                        <p className='truncate text-sm font-medium'>{p.name}</p>
                        <p className='text-xs text-muted-foreground'>
                          {p.platform} · {p.keys} anahtar
                        </p>
                      </div>
                      <PoolBadge status={p.status} />
                    </li>
                  ))}
                  {s.freellmapi.providers.length > 6 && (
                    <li className='pt-2.5 text-xs text-muted-foreground'>
                      +{s.freellmapi.providers.length - 6} sağlayıcı daha
                    </li>
                  )}
                </ul>
              )}
              {s && (
                <div className='mt-4 flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5'>
                  <span className='flex items-center gap-2 text-sm'>
                    <Brain className='size-4 text-muted-foreground' aria-hidden='true' />
                    Hafıza (TDAI)
                  </span>
                  <ToneBadge tone={!s.tdai.configured ? 'off' : s.tdai.up ? 'ok' : 'bad'}>
                    {!s.tdai.configured ? 'ayarlı değil' : s.tdai.up ? 'açık' : 'kapalı'}
                  </ToneBadge>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className='mt-4 grid gap-4 lg:grid-cols-7'>
          <RecentJobs className='lg:col-span-4' />
          <Card className='lg:col-span-3'>
            <CardHeader>
              <CardTitle>İşçi slotları</CardTitle>
              <CardDescription>
                {s ? `${s.workers.filter((w) => w.jobId).length} / ${s.workers.length} meşgul` : 'Yükleniyor…'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {status.isLoading ? (
                <ListSkeleton rows={2} />
              ) : (
                <ul className='grid gap-2'>
                  {s?.workers.map((w) => (
                    <WorkerRow key={w.slot} slot={w.slot} jobId={w.jobId} since={w.since} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </Main>
    </>
  )
}

function Kpi({
  title,
  icon: Icon,
  value,
  hint,
  loading,
  to,
  valueClassName,
}: {
  title: string
  icon: React.ElementType
  value: React.ReactNode
  hint?: React.ReactNode
  loading?: boolean
  to?: '/projeler' | '/isler' | '/havuzlar'
  valueClassName?: string
}) {
  const body = (
    <Card
      className={cn(
        'h-full gap-2 py-5 transition-colors',
        to && 'group-hover:border-foreground/20 group-focus-visible:border-ring'
      )}
    >
      <CardHeader className='flex flex-row items-center justify-between gap-2 px-5'>
        <CardTitle className='text-sm font-medium text-muted-foreground'>{title}</CardTitle>
        <Icon className='size-4 text-muted-foreground' aria-hidden='true' />
      </CardHeader>
      <CardContent className='px-5'>
        {loading ? (
          <>
            <Skeleton className='h-8 w-20' />
            <Skeleton className='mt-2 h-3.5 w-32' />
          </>
        ) : (
          <>
            <div className={cn('text-3xl font-semibold tracking-tight tabular-nums', valueClassName)}>
              {value}
            </div>
            {hint && <p className='mt-1 truncate text-xs text-muted-foreground'>{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
  return to ? (
    <Link to={to} className='group rounded-xl outline-none' aria-label={title}>
      {body}
    </Link>
  ) : (
    body
  )
}

function WorkerRow({ slot, jobId, since }: { slot: number; jobId: string | null; since: string | null }) {
  const jobs = useJobs()
  const job = jobId ? jobs.data?.find((j) => j.id === jobId) : undefined
  return (
    <li className='flex items-center gap-3 rounded-lg border px-3 py-2.5'>
      <div className='flex size-8 shrink-0 items-center justify-center rounded-md bg-muted'>
        <Cpu className='size-4 text-muted-foreground' aria-hidden='true' />
      </div>
      <div className='min-w-0 flex-1'>
        <p className='text-sm font-medium'>Slot #{slot}</p>
        {jobId ? (
          <Link
            to='/isler/$id'
            params={{ id: jobId }}
            className='block truncate text-xs text-muted-foreground hover:text-foreground hover:underline'
          >
            {job ? `${job.project} · ${firstLine(job.task)}` : jobId}
          </Link>
        ) : (
          <p className='text-xs text-muted-foreground'>boşta</p>
        )}
      </div>
      {jobId ? (
        <span className='flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums'>
          <StatusDot status='running' />
          {duration(since)}
        </span>
      ) : (
        <StatusDot status='queued' />
      )}
    </li>
  )
}

function RecentJobs({ className }: { className?: string }) {
  const jobs = useJobs()
  const navigate = useNavigate()
  const { openNewJob } = useNewJob()
  const list = (jobs.data ?? []).slice(0, 6)
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Son işler</CardTitle>
        <CardDescription>Hub'da çalışan son görevler</CardDescription>
        <CardAction>
          <Button variant='ghost' size='sm' asChild>
            <Link to='/isler'>
              Tümü <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {jobs.isLoading ? (
          <ListSkeleton rows={5} />
        ) : jobs.isError ? (
          <QueryError error={jobs.error} onRetry={() => jobs.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title='Henüz iş yok'
            description='Bir projeye görev verin; hub ayrı bir dalda çalıştırsın.'
            action={
              <Button size='sm' onClick={() => openNewJob()}>
                <Plus /> Yeni iş
              </Button>
            }
            className='py-8'
          />
        ) : (
          <ul className='-mx-2'>
            {list.map((j) => (
              <li key={j.id}>
                <button
                  type='button'
                  onClick={() => navigate({ to: '/isler/$id', params: { id: j.id } })}
                  className='flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-start hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none'
                >
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-sm font-medium'>{firstLine(j.task) || j.id}</p>
                    <p className='truncate text-xs text-muted-foreground'>
                      {j.project} · <TimeAgo iso={j.createdAt} />
                    </p>
                  </div>
                  <StatusBadge status={j.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className='grid gap-3'>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className='flex items-center justify-between gap-3'>
          <div className='grid flex-1 gap-1.5'>
            <Skeleton className='h-4 w-2/3' />
            <Skeleton className='h-3 w-1/3' />
          </div>
          <Skeleton className='h-5 w-16 rounded-md' />
        </div>
      ))}
    </div>
  )
}
