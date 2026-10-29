import { Brain, GitPullRequest, KeyRound, ServerCog } from 'lucide-react'
import { POOL_LABEL, shortTime } from '@/lib/format'
import { poolProviders } from '@/lib/pools'
import { useLimits, useStatus } from '@/hooks/queries'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AppHeader, PageTitle } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PoolBadge, ToneBadge } from '@/components/ekip/status-badge'
import { EmptyState, QueryError } from '@/components/ekip/states'
import { TimeAgo } from '@/components/ekip/time-ago'

const ORDER: Record<string, number> = { healthy: 0, rate_limited: 1, no_models: 2, unknown: 3, invalid: 4 }
const WORKER_LABEL: Record<string, string> = {
  ready: 'hazır',
  limited: 'limitte',
  login: 'giriş gerekiyor',
  untested: 'denenmedi',
  off: 'kurulu değil',
}
const WORKER_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'off'> = {
  ready: 'ok',
  limited: 'warn',
  login: 'bad',
  untested: 'off',
  off: 'off',
}

function resetCountdown(iso: string | null | undefined) {
  if (!iso) return null
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return null
  const hours = Math.max(0, Math.ceil((timestamp - Date.now()) / 3_600_000))
  return `${Math.floor(hours / 24)} gün ${hours % 24} sa sonra açılır`
}

export function Pools() {
  const status = useStatus()
  const limits = useLimits()
  const s = status.data
  const f = s?.freellmapi
  const snapshot = limits.data
  const freeError = snapshot?.free && !Array.isArray(snapshot.free) ? snapshot.free.error : null
  const providers = poolProviders(snapshot, f?.providers).sort(
    (a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name)
  )
  const counts = providers.reduce<Record<string, number>>((m, p) => ((m[p.status] = (m[p.status] ?? 0) + 1), m), {})
  const workers = snapshot?.workers ?? []
  const route = snapshot?.route

  return (
    <>
      <AppHeader />
      <Main>
        <PageTitle title='Havuzlar' description='Model sağlayıcıları, hafıza proxysi ve GitHub erişimi.' />
        {status.isError && <QueryError className='mb-4' error={status.error} onRetry={() => status.refetch()} />}
        {limits.isError && <QueryError className='mb-4' error={limits.error} onRetry={() => limits.refetch()} />}

        <div className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle>İşçi havuzları</CardTitle>
              <CardDescription>Mac'te kurulu çalışanlar ve kotaları</CardDescription>
            </CardHeader>
            <CardContent>
              {limits.isLoading && !snapshot ? (
                <div className='grid gap-2'>
                  {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className='h-12' />)}
                </div>
              ) : workers.length === 0 ? (
                <EmptyState icon={ServerCog} title='İşçi bilgisi yok' description='Henüz limit anlık görüntüsü alınmadı.' className='py-6' />
              ) : (
                <ul className='divide-y'>
                  {workers.map((worker) => (
                    <li key={worker.name} className='flex items-start justify-between gap-3 py-3'>
                      <div className='min-w-0'>
                        <p className='font-medium'>{worker.name}</p>
                        <p className='text-xs text-muted-foreground'>{worker.quota}</p>
                        {worker.status === 'limited' && worker.limit?.resetAt && (
                          <p className='mt-1 text-xs text-muted-foreground'>{resetCountdown(worker.limit.resetAt) ?? shortTime(worker.limit.resetAt)}</p>
                        )}
                      </div>
                      <div className='shrink-0 text-end'>
                        <ToneBadge tone={WORKER_TONE[worker.status] ?? 'off'}>{WORKER_LABEL[worker.status] ?? worker.status}</ToneBadge>
                        <p className='mt-1 text-xs tabular-nums text-muted-foreground'>
                          {worker.runs} iş · {worker.successRate == null ? 'başarı oranı yok' : `%${worker.successRate} başarı`}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Şimdi bir iş gelse</CardTitle>
              <CardDescription>Çalışan seçimi ve profil başına ilk modeller</CardDescription>
            </CardHeader>
            <CardContent>
              {!route ? (
                <EmptyState icon={ServerCog} title='Yönlendirme bilgisi yok' description='Henüz limit anlık görüntüsü alınmadı.' className='py-6' />
              ) : (
                <div className='grid min-w-0 gap-4'>
                  <div>
                    <p className='text-xs text-muted-foreground'>İşçi</p>
                    <p className='text-2xl font-semibold'>{route.worker || 'Yok'}</p>
                  </div>
                  <div>
                    <p className='mb-2 text-sm font-medium'>Sıra</p>
                    <ol className='flex min-w-0 flex-wrap gap-x-2 gap-y-1'>
                      {route.order.map((name, i) => {
                        const limited = workers.some((worker) => worker.name === name && worker.status === 'limited')
                        const skipped = route.skipped.includes(name)
                        return (
                          <li key={`${name}-${i}`} className={limited || skipped ? 'text-sm text-muted-foreground line-through' : 'text-sm'}>
                            {name}{i < route.order.length - 1 ? ' →' : ''}
                          </li>
                        )
                      })}
                    </ol>
                  </div>
                  <div className='grid gap-3'>
                    {Object.entries(route.profiles).map(([name, profile]) => (
                      <div key={name} className='border-t pt-3'>
                        <p className='text-sm font-medium'>{name}</p>
                        <p className='mt-1 break-all text-xs text-muted-foreground'>
                          {profile.next.length ? profile.next.join(' → ') : 'Model yok'}
                        </p>
                        <p className='mt-1 text-xs text-muted-foreground'>
                          Soğumada {profile.cooling}/{profile.models}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className='mt-4 grid gap-4 lg:grid-cols-3'>
          <Card className='lg:col-span-2'>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <ServerCog className='size-4 text-muted-foreground' aria-hidden='true' /> Ücretsiz havuz (freellmapi)
              </CardTitle>
              <CardDescription>
                {!f
                  ? 'Yükleniyor…'
                  : !f.configured
                    ? 'FREELLMAPI_URL ayarlı değil.'
                    : `${providers.length} sağlayıcı · ${Object.entries(counts)
                        .map(([k, n]) => `${n} ${POOL_LABEL[k] ?? k}`)
                        .join(', ') || 'durum yok'}`}
              </CardDescription>
              {f && (
                <CardAction>
                  <ToneBadge tone={!f.configured ? 'off' : f.ready ? 'ok' : f.up ? 'warn' : 'bad'}>
                    {!f.configured ? 'ayarlı değil' : f.ready ? 'hazır' : f.up ? 'hazır değil' : 'kapalı'}
                  </ToneBadge>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              {freeError && (
                <p role='alert' className='mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
                  Ücretsiz havuz durumu alınamadı: {freeError}
                </p>
              )}
              {f?.authError && (
                <p role='alert' className='mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
                  FREELLMAPI_KEY reddedildi; sağlayıcı listesi alınamıyor.
                </p>
              )}
              {f && !f.ready && f.reason && (
                <p className='mb-3 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground'>
                  Neden: <span className='font-mono text-xs'>{f.reason}</span>
                </p>
              )}
              {status.isLoading && limits.isLoading ? (
                <div className='grid gap-2'>
                  {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className='h-9' />)}
                </div>
              ) : providers.length === 0 ? (
                <EmptyState icon={ServerCog} title='Sağlayıcı yok' description='freellmapi sağlayıcı bildirmedi.' className='py-8' />
              ) : (
                <div className='overflow-x-auto rounded-md border'>
                  <Table>
                    <TableHeader>
                      <TableRow className='hover:bg-transparent'>
                        <TableHead>Sağlayıcı</TableHead>
                        <TableHead>Durum</TableHead>
                        <TableHead className='text-end'>Anahtar</TableHead>
                        <TableHead>Modeller</TableHead>
                        <TableHead>24 sa</TableHead>
                        <TableHead className='hidden sm:table-cell'>Devam</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {providers.map((p) => (
                        <TableRow key={`${p.platform}-${p.name}`}>
                          <TableCell>
                            <div className='grid'>
                              <span className='font-medium'>{p.name}</span>
                              <span className='font-mono text-[11px] text-muted-foreground'>{p.platform}</span>
                            </div>
                          </TableCell>
                          <TableCell><PoolBadge status={p.status} /></TableCell>
                          <TableCell className='text-end tabular-nums'>{p.keys}</TableCell>
                          <TableCell className='text-xs tabular-nums'>
                            {typeof p.models === 'number' ? `${Math.max(0, p.models - (p.cooling ?? 0))}/${p.models} açık` : 'Veri yok'}
                          </TableCell>
                          <TableCell className='text-xs tabular-nums'>
                            {typeof p.ok24 === 'number' ? `${p.ok24} başarılı, ${p.fail24} hata` : 'Veri yok'}
                          </TableCell>
                          <TableCell className='hidden text-muted-foreground sm:table-cell'>
                            {p.resumeAt ? (
                              <span title={shortTime(p.resumeAt)}>
                                <TimeAgo iso={p.resumeAt} />
                              </span>
                            ) : (
                              'Yok'
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className='grid content-start gap-4'>
            <Card>
              <CardHeader>
                <CardTitle className='flex items-center gap-2'>
                  <Brain className='size-4 text-muted-foreground' aria-hidden='true' /> Hafıza (TDAI proxy)
                </CardTitle>
                <CardDescription>
                  {s?.tdai.up ? 'İşler proje hafızasıyla çalışır.' : "Kapalıyken işler doğrudan freellmapi'ye gider."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!s ? (
                  <Skeleton className='h-20' />
                ) : (
                  <dl className='grid grid-cols-[1fr_auto] items-center gap-y-3 text-sm'>
                    <dt className='text-muted-foreground'>Durum</dt>
                    <dd>
                      <ToneBadge tone={!s.tdai.configured ? 'off' : s.tdai.up ? 'ok' : 'bad'}>
                        {!s.tdai.configured ? 'ayarlı değil' : s.tdai.up ? 'açık' : 'kapalı'}
                      </ToneBadge>
                    </dd>
                    <dt className='text-muted-foreground'>Sürüm</dt>
                    <dd className='font-mono text-xs'>{s.tdai.version ?? 'Yok'}</dd>
                    <dt className='text-muted-foreground'>Kullanıcı anahtarı</dt>
                    <dd>
                      <ToneBadge tone={s.tdai.memory ? 'ok' : 'off'}>{s.tdai.memory ? 'var' : 'yok'}</ToneBadge>
                    </dd>
                  </dl>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className='flex items-center gap-2'>
                  <GitPullRequest className='size-4 text-muted-foreground' aria-hidden='true' /> GitHub
                </CardTitle>
                <CardDescription>Repo erişimi ve Copilot CLI</CardDescription>
              </CardHeader>
              <CardContent>
                {!s ? (
                  <Skeleton className='h-16' />
                ) : (
                  <dl className='grid grid-cols-[1fr_auto] items-center gap-y-3 text-sm'>
                    <dt className='flex items-center gap-2 text-muted-foreground'>
                      <KeyRound className='size-3.5' aria-hidden='true' /> GITHUB_TOKEN
                    </dt>
                    <dd>
                      <ToneBadge tone={s.github.token ? 'ok' : 'warn'}>{s.github.token ? 'var' : 'yok'}</ToneBadge>
                    </dd>
                    <dt className='flex items-center gap-2 text-muted-foreground'>
                      <KeyRound className='size-3.5' aria-hidden='true' /> COPILOT_GITHUB_TOKEN
                    </dt>
                    <dd>
                      <ToneBadge tone={s.github.copilot ? 'ok' : 'off'}>{s.github.copilot ? 'var' : 'yok'}</ToneBadge>
                    </dd>
                  </dl>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
        {snapshot?.at && (
          <p className='mt-3 text-xs text-muted-foreground'>
            Güncellendi: <TimeAgo iso={snapshot.at} /> · {snapshot.host || 'Host bilgisi yok'}
          </p>
        )}
      </Main>
    </>
  )
}
