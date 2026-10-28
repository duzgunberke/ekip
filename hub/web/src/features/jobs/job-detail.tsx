import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, getRouteApi } from '@tanstack/react-router'
import {
  ArrowLeft,
  Ban,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  Loader2,
  ScrollText,
  SearchX,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/lib/api'
import { VIA_LABEL, dateTime, duration, firstLine } from '@/lib/format'
import { compareUrl } from '@/lib/repo'
import { cn } from '@/lib/utils'
import { useCancelJob, useJob, useProjects } from '@/hooks/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { Md } from '@/components/ekip/markdown'
import { StatusBadge } from '@/components/ekip/status-badge'
import { EmptyState, QueryError } from '@/components/ekip/states'
import { TimeAgo } from '@/components/ekip/time-ago'

const route = getRouteApi('/_authenticated/isler/$id')

export function JobDetail() {
  const { id } = route.useParams()
  const job = useJob(id)
  const projects = useProjects()
  const cancel = useCancelJob()
  const [confirm, setConfirm] = useState(false)
  const [tab, setTab] = useState<string | null>(null)

  const j = job.data
  const active = j?.status === 'running' || j?.status === 'queued'
  const project = projects.data?.find((p) => p.name === j?.project)
  const compare = j?.pushed ? compareUrl(project?.repo, j.baseBranch, j.branch) : null
  const currentTab = tab ?? (j && !active && j.report ? 'report' : 'log')

  return (
    <>
      <AppHeader />
      <Main>
        <Button variant='ghost' size='sm' className='-ms-2 mb-3 text-muted-foreground' asChild>
          <Link to='/isler'>
            <ArrowLeft /> İşler
          </Link>
        </Button>

        {job.isLoading ? (
          <DetailSkeleton />
        ) : job.isError ? (
          job.error instanceof ApiError && job.error.status === 404 ? (
            <EmptyState
              icon={SearchX}
              title='İş bulunamadı'
              description={`"${id}" kimlikli bir iş yok; silinmiş olabilir.`}
              action={
                <Button variant='outline' asChild>
                  <Link to='/isler'>İşlere dön</Link>
                </Button>
              }
            />
          ) : (
            <QueryError error={job.error} onRetry={() => job.refetch()} />
          )
        ) : j ? (
          <>
            <div className='mb-6 flex flex-wrap items-start justify-between gap-4'>
              <div className='min-w-0 flex-1'>
                <div className='mb-2 flex flex-wrap items-center gap-2'>
                  <StatusBadge status={j.status} />
                  <Badge variant='secondary' className='font-mono font-normal'>
                    {j.id}
                  </Badge>
                  {active && (
                    <span className='flex items-center gap-1 text-xs text-muted-foreground'>
                      <Loader2 className='size-3 animate-spin' aria-hidden='true' /> 3 sn'de bir güncelleniyor
                    </span>
                  )}
                </div>
                <h1 className='text-xl font-bold tracking-tight break-words sm:text-2xl'>
                  {firstLine(j.task) || j.id}
                </h1>
                <p className='mt-1 text-sm text-muted-foreground'>
                  <Link to='/projeler' search={{ p: j.project }} className='font-medium text-foreground hover:underline'>
                    {j.project}
                  </Link>{' '}
                  · <TimeAgo iso={j.createdAt} /> oluşturuldu
                </p>
              </div>
              <div className='flex flex-wrap gap-2'>
                {compare && (
                  <Button variant='outline' asChild>
                    <a href={compare} target='_blank' rel='noopener noreferrer'>
                      <GitBranch /> GitHub'da karşılaştır <ExternalLink className='opacity-60' />
                    </a>
                  </Button>
                )}
                {active && (
                  <Button variant='destructive' onClick={() => setConfirm(true)} disabled={cancel.isPending}>
                    {cancel.isPending ? <Loader2 className='animate-spin' /> : <Ban />}
                    İptal et
                  </Button>
                )}
              </div>
            </div>

            {j.error && (
              <div role='alert' className='mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive'>
                <span className='font-medium'>Hata: </span>
                {j.error}
              </div>
            )}

            <div className='grid gap-4 lg:grid-cols-3'>
              <div className='order-2 min-w-0 lg:order-1 lg:col-span-2'>
                <Tabs value={currentTab} onValueChange={setTab}>
                  <TabsList className='w-full sm:w-auto'>
                    <TabsTrigger value='log'>
                      <ScrollText /> Günlük
                    </TabsTrigger>
                    <TabsTrigger value='report'>
                      <FileText /> Rapor
                    </TabsTrigger>
                    <TabsTrigger value='diff'>
                      <FileDiff /> Değişiklikler
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value='log' className='mt-2'>
                    <LogTail text={j.log ?? ''} live={active} />
                  </TabsContent>
                  <TabsContent value='report' className='mt-2'>
                    <Card>
                      <CardContent>
                        {j.report?.trim() ? (
                          <Md>{j.report}</Md>
                        ) : (
                          <EmptyState
                            icon={FileText}
                            title={active ? 'Rapor bekleniyor' : 'Rapor yok'}
                            description={active ? 'İş bittiğinde ajanın raporu burada görünür.' : 'Bu iş rapor üretmedi.'}
                            className='border-0 py-8'
                          />
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>
                  <TabsContent value='diff' className='mt-2'>
                    <Card>
                      <CardContent>
                        {j.diffstat?.trim() ? (
                          <DiffStat text={j.diffstat} />
                        ) : (
                          <EmptyState
                            icon={FileDiff}
                            title={active ? 'Henüz değişiklik yok' : 'Değişiklik yok'}
                            description={active ? 'İş bitince değişen dosyalar listelenir.' : 'Bu iş dosya değiştirmedi.'}
                            className='border-0 py-8'
                          />
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>
                </Tabs>
              </div>

              <div className='order-1 grid content-start gap-4 lg:order-2'>
                <Card className='gap-4'>
                  <CardHeader>
                    <CardTitle className='text-base'>Ayrıntılar</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm'>
                      <Row k='Model yolu'>
                        {VIA_LABEL[j.via] ?? j.via}
                        {j.ranVia && j.ranVia !== j.via && (
                          <span className='text-muted-foreground'> → {VIA_LABEL[j.ranVia] ?? j.ranVia}</span>
                        )}
                      </Row>
                      <Row k='Havuz'>
                        {j.pool ? (j.pool === 'tdai' ? 'TDAI proxy (hafızalı)' : 'freellmapi (doğrudan)') : '—'}
                      </Row>
                      {j.model && <Row k='Model'><span className='font-mono text-xs'>{j.model}</span></Row>}
                      <Row k='Dal'>
                        {j.branch ? (
                          <span className='font-mono text-xs break-all'>
                            {j.branch}
                            {j.baseBranch && <span className='text-muted-foreground'> ← {j.baseBranch}</span>}
                          </span>
                        ) : (
                          '—'
                        )}
                      </Row>
                      <Row k='Push'>
                        {!j.push ? 'kapalı' : j.pushed ? 'gönderildi' : j.pushed === false ? 'başarısız' : 'bekliyor'}
                      </Row>
                      <Row k='Süre'>
                        <span className='tabular-nums'>
                          {j.startedAt ? duration(j.startedAt, j.finishedAt) : 'başlamadı'}
                        </span>
                      </Row>
                      {j.worker != null && <Row k='İşçi'>Slot #{j.worker}</Row>}
                      <Row k='Oluşturuldu'>{dateTime(j.createdAt)}</Row>
                      {j.startedAt && <Row k='Başladı'>{dateTime(j.startedAt)}</Row>}
                      {j.finishedAt && <Row k='Bitti'>{dateTime(j.finishedAt)}</Row>}
                    </dl>
                  </CardContent>
                </Card>
                <Card className='gap-3'>
                  <CardHeader>
                    <CardTitle className='text-base'>Görev</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className='max-h-72 overflow-auto font-sans text-sm whitespace-pre-wrap text-muted-foreground'>
                      {j.task}
                    </pre>
                  </CardContent>
                </Card>
              </div>
            </div>

            <ConfirmDialog
              open={confirm}
              onOpenChange={setConfirm}
              title='İş iptal edilsin mi?'
              desc={
                j.status === 'running'
                  ? 'Çalışan ajan durdurulur ve çalışma dalı silinir. Bu geri alınamaz.'
                  : 'İş kuyruktan çıkarılır.'
              }
              confirmText='İptal et'
              cancelBtnText='Vazgeç'
              destructive
              isLoading={cancel.isPending}
              handleConfirm={() =>
                cancel.mutate(j.id, {
                  onSuccess: () => {
                    setConfirm(false)
                    toast.success('İş iptal edildi.')
                  },
                  onError: (e) => {
                    setConfirm(false)
                    toast.error(errorMessage(e))
                  },
                })
              }
            />
          </>
        ) : null}
      </Main>
    </>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className='text-muted-foreground'>{k}</dt>
      <dd className='min-w-0 text-end sm:text-start'>{children}</dd>
    </>
  )
}

function LogTail({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null)
  const [follow, setFollow] = useState(true)

  useLayoutEffect(() => {
    const el = ref.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [text, follow])

  // Scrolling up by hand pauses auto-scroll; back at the bottom resumes it.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
      setFollow((f) => (f === atBottom ? f : atBottom))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <Card className='gap-0 overflow-hidden py-0'>
      <div className='flex items-center justify-between gap-3 border-b px-4 py-2.5'>
        <span className='flex items-center gap-2 text-sm font-medium'>
          Günlük (son kısım)
          {live && (
            <span className='flex items-center gap-1.5 text-xs font-normal text-status-running'>
              <span className='size-1.5 animate-pulse rounded-full bg-status-running' aria-hidden='true' /> canlı
            </span>
          )}
        </span>
        <div className='flex items-center gap-2'>
          <Label htmlFor='follow' className='text-xs font-normal text-muted-foreground'>
            Otomatik kaydır
          </Label>
          <Switch id='follow' checked={follow} onCheckedChange={setFollow} />
        </div>
      </div>
      <pre
        ref={ref}
        tabIndex={0}
        aria-label='İş günlüğü'
        className={cn(
          'log-view h-[min(32rem,60svh)] overflow-auto bg-muted/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all',
          !text && 'flex items-center justify-center text-muted-foreground'
        )}
      >
        {text || (live ? 'Günlük bekleniyor…' : 'Günlük boş.')}
      </pre>
    </Card>
  )
}

function DiffStat({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre className='overflow-x-auto font-mono text-xs leading-relaxed'>
      {lines.map((line, i) => {
        const m = line.match(/^(.*\|\s*\d+\s)(\+*)(-*)\s*$/)
        if (!m) return <div key={i} className={i === lines.length - 1 ? 'mt-1 text-muted-foreground' : undefined}>{line}</div>
        return (
          <div key={i}>
            {m[1]}
            <span className='text-status-done'>{m[2]}</span>
            <span className='text-status-failed'>{m[3]}</span>
          </div>
        )
      })}
    </pre>
  )
}

function DetailSkeleton() {
  return (
    <div className='grid gap-4'>
      <Skeleton className='h-5 w-40' />
      <Skeleton className='h-8 w-2/3' />
      <div className='grid gap-4 lg:grid-cols-3'>
        <Skeleton className='h-96 lg:col-span-2' />
        <Skeleton className='h-96' />
      </div>
    </div>
  )
}
