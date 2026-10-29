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
import { poolProviders } from '@/lib/pools'
import { cn } from '@/lib/utils'
import { useJobs, useLimits, useProjects, useRuns, useSavings, useStatus, useUsage } from '@/hooks/queries'
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
import { formatNumber, useT } from '@/lib/i18n'
import { ActiveTasksMini } from '@/features/tasks/mini'
import { JobsChart } from './jobs-chart'
import { SavingsChart } from './savings-chart'
import { UsageOverviewCard } from '@/features/projects/knowledge-usage'
import { ProviderLogo } from '@/components/provider-logo'
import { useNow } from '@/hooks/use-now'

export function Overview() {
  const t = useT()
  const status = useStatus()
  const projects = useProjects()
  const jobs = useJobs()
  const runs = useRuns()
  const limits = useLimits()
  const savings = useSavings()
  const usage = useUsage()
  const { openNewJob } = useNewJob()
  const now = useNow(30_000)

  const s = status.data
  const providers = poolProviders(limits.data, s?.freellmapi.providers)
  const healthy = providers.filter((p) => p.status === 'healthy' || (p.status === 'rate_limited' && !!p.resumeAt && Date.parse(p.resumeAt) < now)).length
  const lastClient = s?.clients[0]
  const memoryLinked = projects.data?.filter((p) => p.tdai?.teamId).length ?? 0

  return (
    <>
      <AppHeader />
      <Main>
        <PageTitle
          title={t('Genel bakış')}
          description={t('Hub, iş kuyruğu ve model havuzlarının anlık durumu.')}
          actions={
            <Button onClick={() => openNewJob()}>
              <Plus /> {t('Yeni iş')}
            </Button>
          }
        />

        <ActiveTasksMini />

        <Card className='mb-5'>
          <CardHeader>
            <CardTitle>{t('Claude vs diğer kotalar')}</CardTitle>
            <CardDescription>{t('Son 14 gün · girdi eşdeğeri token')}</CardDescription>
          </CardHeader>
          <CardContent>
            {savings.isLoading ? <Skeleton className='h-64' /> : <SavingsChart snapshot={savings.data} />}
          </CardContent>
        </Card>

        {status.isError && (
          <QueryError className='mb-4' error={status.error} onRetry={() => status.refetch()} />
        )}
        {limits.isError && (
          <QueryError className='mb-4' error={limits.error} onRetry={() => limits.refetch()} />
        )}

        <div className='grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <Kpi
            title={t('Kayıtlı proje')}
            icon={FolderGit2}
            loading={projects.isLoading}
            value={projects.data ? formatNumber(projects.data.length) : t('Yok')}
            hint={t('{count} tanesi hafızaya bağlı', { count: memoryLinked })}
            to='/projects'
          />
          <Kpi
            title={t('Çalışan / kuyrukta iş')}
            icon={ListChecks}
            loading={status.isLoading}
            value={
              s ? (
                <>
                  {formatNumber(s.queue.running ?? 0)}
                  <span className='text-muted-foreground'> / {formatNumber(s.queue.queued ?? 0)}</span>
                </>
              ) : (
                '-'
              )
            }
            hint={s ? t('{count} işçi slotu · {done} bitti', { count: s.workers.length, done: s.queue.done ?? 0 }) : undefined}
            to='/jobs'
          />
          <Kpi
            title={t('Ücretsiz havuz')}
            icon={ServerCog}
            loading={status.isLoading && limits.isLoading}
            value={
              s || limits.data ? (
                <span className='text-[1.25rem] font-semibold'>{t('{open}/{total} sağlayıcı açık', { open: formatNumber(healthy), total: formatNumber(providers.length) })}</span>
              ) : (
                '-'
              )
            }
            hint={
              !s
                ? undefined
                : !s.freellmapi.configured
                  ? t('freellmapi ayarlı değil')
                  : s.freellmapi.ready
                    ? t('freellmapi çalışıyor')
                    : s.freellmapi.slow
                      ? t('freellmapi yavaş yanıt veriyor')
                      : s.freellmapi.up
                      ? t('freellmapi hazır değil')
                      : t('freellmapi kapalı')
            }
            to='/pools'
          />
          <Kpi
            title={t('Mac son görülme')}
            icon={Laptop}
            loading={status.isLoading}
            value={lastClient ? <span className='text-[1.15rem]'>{<TimeAgo iso={lastClient.lastSeen} />}{lastClient.host ? ` · ${lastClient.host}` : ''}</span> : t('Henüz sinyal yok')}
            valueClassName='text-xl'
            hint={lastClient ? undefined : t("Mac'te ekip ya da ekip doctor çalışınca görünür")}
          />
        </div>

        <div className='mt-5 grid min-w-0 gap-4 lg:grid-cols-7'>
          <Card className='lg:col-span-4'>
            <CardHeader>
              <CardTitle>{t('Günlük işler')}</CardTitle>
              <CardDescription>{t('VPS + Mac işleri · son 14 gün, duruma göre')}</CardDescription>
            </CardHeader>
            <CardContent className='flex flex-1 flex-col ps-2'>
              {jobs.isLoading || runs.isLoading ? (
                <Skeleton className='ms-4 h-64' />
              ) : jobs.isError || runs.isError ? (
                <QueryError
                  className='ms-4 w-auto'
                  error={jobs.error ?? runs.error}
                  onRetry={() => {
                    jobs.refetch()
                    runs.refetch()
                  }}
                />
              ) : (
                <JobsChart jobs={jobs.data ?? []} runs={runs.data ?? []} />
              )}
            </CardContent>
          </Card>

          <Card className='lg:col-span-3'>
            <CardHeader>
              <CardTitle>{t('Havuz sağlığı')}</CardTitle>
              <CardDescription>{t('freellmapi sağlayıcıları ve hafıza')}</CardDescription>
              <CardAction>
                <Button variant='ghost' size='sm' asChild>
                  <Link to='/pools'>
                    {t('Tümü')} <ArrowRight />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {status.isLoading && limits.isLoading ? (
                <ListSkeleton rows={5} />
              ) : !s && !limits.data ? null : providers.length === 0 ? (
                <EmptyState
                  icon={ServerCog}
                  title={t('Sağlayıcı yok')}
                  description={s?.freellmapi.authError ?? s?.freellmapi.reason ?? t('freellmapi sağlayıcı bildirmedi.')}
                  className='py-8'
                />
              ) : (
                <ul className='divide-y'>
                  {providers.slice(0, 6).map((p) => (
                    <li key={`${p.platform}-${p.name}`} className='flex items-center justify-between gap-3 py-2.5'>
                      <div className='min-w-0'>
                        <p className='flex items-center gap-2 truncate text-sm font-medium'><ProviderLogo id={p.platform} />{p.name}</p>
                        <p className='text-xs text-muted-foreground'>
                          {p.platform} · {formatNumber(p.keys)} {t('anahtar')}
                        </p>
                      </div>
                      {p.status === 'rate_limited' && p.resumeAt && Date.parse(p.resumeAt) < now ? <ToneBadge tone='ok'>{t('açılmış olmalı')}</ToneBadge> : <PoolBadge status={p.status} />}
                    </li>
                  ))}
                  {providers.length > 6 && (
                    <li className='pt-2.5 text-xs text-muted-foreground'>
                      {t('+{count} sağlayıcı daha', { count: providers.length - 6 })}
                    </li>
                  )}
                </ul>
              )}
              {s && (
                <div className='mt-4 flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5'>
                  <span className='flex items-center gap-2 text-sm'>
                    <Brain className='size-4 text-muted-foreground' aria-hidden='true' />
                    {t('Hafıza (TDAI)')}
                  </span>
                  <ToneBadge tone={!s.tdai.configured ? 'off' : s.tdai.up ? 'ok' : 'bad'}>
                    {!s.tdai.configured ? t('ayarlı değil') : s.tdai.up ? t('açık') : t('kapalı')}
                  </ToneBadge>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className='mt-5 grid min-w-0 gap-4 lg:grid-cols-7'>
          <RecentJobs className='lg:col-span-4' />
          <div className='grid min-w-0 content-start gap-4 lg:col-span-3'>
          <Card>
            <CardHeader>
              <CardTitle>{t('İşçi slotları')}</CardTitle>
              <CardDescription>
                {s ? t('{count} / {total} meşgul', { count: s.workers.filter((w) => w.jobId).length, total: s.workers.length }) : t('Yükleniyor…')}
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
          <UsageOverviewCard summary={usage.data} />
          </div>
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
  to?: '/projects' | '/jobs' | '/pools'
  valueClassName?: string
}) {
  const body = (
    <Card
      className={cn(
        'h-full gap-2 py-5 transition-colors duration-200',
        to && 'group-hover:border-primary/40 group-focus-visible:border-ring'
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
  const t = useT()
  const jobs = useJobs()
  const job = jobId ? jobs.data?.find((j) => j.id === jobId) : undefined
  return (
    <li className='flex min-w-0 items-center gap-3 rounded-lg bg-muted/35 px-3 py-2.5'>
      <div className='flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-primary'>
        <Cpu className='size-4' aria-hidden='true' />
      </div>
      <div className='min-w-0 flex-1'>
        <p className='text-sm font-medium'>Slot #{formatNumber(slot)}</p>
        {jobId ? (
          <Link
            to='/jobs/$id'
            params={{ id: jobId }}
            className='block truncate text-xs text-muted-foreground hover:text-foreground hover:underline'
          >
            {job ? `${job.project} · ${firstLine(job.task)}` : jobId}
          </Link>
        ) : (
          <p className='text-xs text-muted-foreground'>{t('boşta')}</p>
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
  const t = useT()
  const jobs = useJobs()
  const navigate = useNavigate()
  const { openNewJob } = useNewJob()
  const list = (jobs.data ?? []).slice(0, 6)
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{t('Son işler')}</CardTitle>
        <CardDescription>{t("Hub'da çalışan son görevler")}</CardDescription>
        <CardAction>
          <Button variant='ghost' size='sm' asChild>
            <Link to='/jobs'>
              {t('Tümü')} <ArrowRight />
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
            title={t('Henüz iş yok')}
            description={t('Bir projeye görev verin; hub ayrı bir dalda çalıştırsın.')}
            action={
              <Button size='sm' onClick={() => openNewJob()}>
                <Plus /> {t('Yeni iş')}
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
                  onClick={() => navigate({ to: '/jobs/$id', params: { id: j.id } })}
                  className='flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2.5 text-start transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none'
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
