import { Brain, GitPullRequest, KeyRound, ServerCog } from 'lucide-react'
import { poolLabel, shortTime } from '@/lib/format'
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
import { formatNumber, formatPercent, translate, useT } from '@/lib/i18n'
import { ProviderLogo } from '@/components/provider-logo'
import { useNow } from '@/hooks/use-now'

const ORDER: Record<string, number> = { healthy: 0, degraded: 1, rate_limited: 2, idle: 3, no_models: 4, unknown: 5, invalid: 6 }
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
  return translate('{days} gün {hours} sa sonra açılır', {
    days: Math.floor(hours / 24),
    hours: hours % 24,
  })
}

export function Pools() {
  const t = useT()
  const status = useStatus()
  const limits = useLimits()
  const now = useNow(30_000)
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
        <PageTitle title={t('Havuzlar')} description={t('Model sağlayıcıları, hafıza proxysi ve GitHub erişimi.')} />
        {status.isError && <QueryError className='mb-4' error={status.error} onRetry={() => status.refetch()} />}
        {limits.isError && <QueryError className='mb-4' error={limits.error} onRetry={() => limits.refetch()} />}

        <div className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle>{t('İşçi havuzları')}</CardTitle>
              <CardDescription>{t("Mac'te kurulu çalışanlar ve kotaları")}</CardDescription>
            </CardHeader>
            <CardContent>
              {limits.isLoading && !snapshot ? (
                <div className='grid gap-2'>
                  {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className='h-12' />)}
                </div>
              ) : workers.length === 0 ? (
                <EmptyState icon={ServerCog} title={t('İşçi bilgisi yok')} description={t('Henüz limit anlık görüntüsü alınmadı.')} className='py-6' />
              ) : (
                <ul className='divide-y'>
                  {workers.map((worker) => (
                    <li key={worker.name} className='flex items-start justify-between gap-3 py-3'>
                      <div className='min-w-0'>
                        <p className='flex items-center gap-2 font-medium'><ProviderLogo id={worker.name} />{worker.name}</p>
                        <p className='text-xs text-muted-foreground'>{worker.quota}</p>
                        {worker.status === 'limited' && worker.limit?.resetAt && Date.parse(worker.limit.resetAt) >= now && (
                          <p className='mt-1 text-xs text-muted-foreground'>{resetCountdown(worker.limit.resetAt) ?? shortTime(worker.limit.resetAt)}</p>
                        )}
                      </div>
                      <div className='shrink-0 text-end'>
                        {worker.status === 'limited' && worker.limit?.resetAt && Date.parse(worker.limit.resetAt) < now ? (
                          <ToneBadge tone='ok'>{t('açılmış olmalı')}</ToneBadge>
                        ) : <ToneBadge tone={WORKER_TONE[worker.status] ?? 'off'}>{t(WORKER_LABEL[worker.status] ?? worker.status)}</ToneBadge>}
                        {worker.status === 'ready' && worker.capacity != null && (
                          <p className={`mt-1 text-xs tabular-nums ${(worker.running ?? 0) >= worker.capacity ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
                            {t('{running}/{capacity} çalışıyor', { running: worker.running ?? 0, capacity: worker.capacity })}
                          </p>
                        )}
                        <p className='mt-1 text-xs tabular-nums text-muted-foreground'>
                          {t('{count} iş', { count: worker.runs })} · {worker.successRate == null ? t('başarı oranı yok') : `${formatPercent(worker.successRate)} ${t('başarı')}`}
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
              <CardTitle>{t('Şimdi bir iş gelse')}</CardTitle>
              <CardDescription>{t('Çalışan seçimi ve profil başına ilk modeller')}</CardDescription>
            </CardHeader>
            <CardContent>
              {!route ? (
                <EmptyState icon={ServerCog} title={t('Yönlendirme bilgisi yok')} description={t('Henüz limit anlık görüntüsü alınmadı.')} className='py-6' />
              ) : (
                <div className='grid min-w-0 gap-4'>
                  <div>
                    <p className='text-xs text-muted-foreground'>{t('İşçi')}</p>
                    <p className='text-2xl font-semibold'>{route.worker || t('Yok')}</p>
                  </div>
                  <div>
                    <p className='mb-2 text-sm font-medium'>{t('Sıra')}</p>
                    <ol className='flex min-w-0 flex-wrap gap-x-2 gap-y-1'>
                      {route.order.map((name, i) => {
                        const limited = workers.some((worker) => worker.name === name && worker.status === 'limited' && (!worker.limit?.resetAt || Date.parse(worker.limit.resetAt) >= now))
                        const skipped = limited && route.skipped.includes(name)
                        return (
                          <li key={`${name}-${i}`} className={limited || skipped ? 'text-sm text-muted-foreground line-through' : 'text-sm'}>
                            <span className='inline-flex items-center gap-1'><ProviderLogo id={name} />{name}</span>{i < route.order.length - 1 ? ' →' : ''}
                          </li>
                        )
                      })}
                    </ol>
                  </div>
                  <div className='grid gap-3'>
                    {Object.entries(route.profiles).map(([name, profile]) => (
                      <div key={name} className='border-t pt-3'>
                        <p className='flex items-center gap-2 text-sm font-medium'><ProviderLogo id={name} />{name}</p>
                        <p className='mt-1 break-all text-xs text-muted-foreground'>
                          {profile.next.length ? profile.next.map((model, i) => <span key={model} className='inline-flex items-center gap-1'><ProviderLogo id='free' modelId={model} className='size-3.5' />{model}{i < profile.next.length - 1 ? ' → ' : ''}</span>) : t('Model yok')}
                        </p>
                        <p className='mt-1 text-xs text-muted-foreground'>
                          {t('Soğumada {current}/{total}', { current: profile.cooling, total: profile.models })}
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
                <ServerCog className='size-4 text-muted-foreground' aria-hidden='true' /> {t('Ücretsiz havuz (freellmapi)')}
              </CardTitle>
              <CardDescription>
                {!f
                  ? t('Yükleniyor…')
                  : !f.configured
                    ? t('FREELLMAPI_URL ayarlı değil.')
                    : `${t('{count} sağlayıcı', { count: providers.length })} · ${Object.entries(counts)
                        .map(([k, n]) => `${n} ${poolLabel(k)}`)
                        .join(', ') || t('durum yok')}`}
              </CardDescription>
              {f && (
                <CardAction>
                  <ToneBadge tone={!f.configured ? 'off' : f.ready ? 'ok' : f.up ? 'warn' : 'bad'}>
                    {!f.configured ? t('ayarlı değil') : f.ready ? t('çalışıyor') : f.slow ? t('yavaş yanıt veriyor') : f.up ? t('hazır değil') : t('çevrimdışı')}
                  </ToneBadge>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              {freeError && (
                <p role='alert' className='mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
                  {t('Ücretsiz havuz durumu alınamadı: {error}', { error: freeError })}
                </p>
              )}
              {f?.authError && (
                <p role='alert' className='mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
                  {t('FREELLMAPI_KEY reddedildi; sağlayıcı listesi alınamıyor.')}
                </p>
              )}
              {f && !f.ready && f.reason && (
                <p className='mb-3 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground'>
                  {f.slow
                    ? t('Sunucu yoğun; sağlık kontrolü 8 sn içinde yanıt alamadı. Havuz çalışıyor, istekler gecikmeli.')
                    : <>{t('Neden:')} <span className='font-mono text-xs'>{f.reason}</span></>}
                </p>
              )}
              {status.isLoading && limits.isLoading ? (
                <div className='grid gap-2'>
                  {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className='h-9' />)}
                </div>
              ) : providers.length === 0 ? (
                <EmptyState icon={ServerCog} title={t('Sağlayıcı yok')} description={t('freellmapi sağlayıcı bildirmedi.')} className='py-8' />
              ) : (
                <div className='overflow-x-auto rounded-md border'>
                  <Table>
                    <TableHeader>
                      <TableRow className='hover:bg-transparent'>
                        <TableHead>{t('Sağlayıcı')}</TableHead>
                        <TableHead>{t('Durum')}</TableHead>
                        <TableHead className='text-end'>{t('Anahtar')}</TableHead>
                        <TableHead>{t('Modeller')}</TableHead>
                        <TableHead>{t('24 sa')}</TableHead>
                        <TableHead className='hidden sm:table-cell'>{t('Devam')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {providers.map((p) => (
                        <TableRow key={`${p.platform}-${p.name}`}>
                          <TableCell>
                            <div className='grid'>
                              <span className='flex items-center gap-2 font-medium'><ProviderLogo id={p.platform} />{p.name}</span>
                              <span className='font-mono text-[11px] text-muted-foreground'>{p.platform}</span>
                            </div>
                          </TableCell>
                        <TableCell>{p.status === 'rate_limited' && p.resumeAt && Date.parse(p.resumeAt) < now ? <ToneBadge tone='ok'>{t('açılmış olmalı')}</ToneBadge> : <PoolBadge status={p.status} />}</TableCell>
                          <TableCell className='text-end tabular-nums'>{formatNumber(p.keys)}</TableCell>
                          <TableCell className='text-xs tabular-nums'>
                            {typeof p.models === 'number' ? t('{count} açık', { count: formatNumber(Math.max(0, p.models - (p.cooling ?? 0))) }) : t('Veri yok')}
                          </TableCell>
                          <TableCell className='text-xs tabular-nums'>
                            {typeof p.ok24 === 'number' ? t('{ok} başarılı, {fail} hata', { ok: p.ok24, fail: p.fail24 ?? 0 }) : t('Veri yok')}
                          </TableCell>
                          <TableCell className='hidden text-muted-foreground sm:table-cell'>
                            {p.resumeAt && Date.parse(p.resumeAt) < now ? (
                              <span className='text-emerald-700 dark:text-emerald-400'>{t('açılmış olmalı')}</span>
                            ) : p.resumeAt ? (
                              <span title={shortTime(p.resumeAt)}>
                                <TimeAgo iso={p.resumeAt} />
                              </span>
                            ) : (
                              t('Yok')
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
                  <Brain className='size-4 text-muted-foreground' aria-hidden='true' /> {t('Hafıza (TDAI proxy)')}
                </CardTitle>
                <CardDescription>
                  {s?.tdai.up ? t('İşler proje hafızasıyla çalışır.') : t("Kapalıyken işler doğrudan freellmapi'ye gider.")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!s ? (
                  <Skeleton className='h-20' />
                ) : (
                  <dl className='grid grid-cols-[1fr_auto] items-center gap-y-3 text-sm'>
                    <dt className='text-muted-foreground'>{t('Durum')}</dt>
                    <dd>
                      <ToneBadge tone={!s.tdai.configured ? 'off' : s.tdai.up ? 'ok' : 'bad'}>
                        {!s.tdai.configured ? t('ayarlı değil') : s.tdai.up ? t('açık') : t('kapalı')}
                      </ToneBadge>
                    </dd>
                    <dt className='text-muted-foreground'>{t('Sürüm')}</dt>
                    <dd className='font-mono text-xs'>{s.tdai.version ?? t('Yok')}</dd>
                    <dt className='text-muted-foreground'>{t('Kullanıcı anahtarı')}</dt>
                    <dd>
                      <ToneBadge tone={s.tdai.memory ? 'ok' : 'off'}>{s.tdai.memory ? t('var') : t('yok')}</ToneBadge>
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
                <CardDescription>{t('Repo erişimi ve Copilot CLI')}</CardDescription>
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
                      <ToneBadge tone={s.github.token ? 'ok' : 'warn'}>{s.github.token ? t('var') : t('yok')}</ToneBadge>
                    </dd>
                    <dt className='flex items-center gap-2 text-muted-foreground'>
                      <KeyRound className='size-3.5' aria-hidden='true' /> COPILOT_GITHUB_TOKEN
                    </dt>
                    <dd>
                      <ToneBadge tone={s.github.copilot ? 'ok' : 'off'}>{s.github.copilot ? t('var') : t('yok')}</ToneBadge>
                    </dd>
                  </dl>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
        {snapshot?.at && (
          <p className='mt-3 text-xs text-muted-foreground'>
            <span className={now - Date.parse(snapshot.receivedAt ?? snapshot.at) > 35 * 60_000 ? 'text-amber-700 dark:text-amber-400' : ''}>
              {t('Güncellendi:')} <TimeAgo iso={snapshot.receivedAt ?? snapshot.at} /> · {snapshot.host || t('Host bilgisi yok')}
              {now - Date.parse(snapshot.receivedAt ?? snapshot.at) > 35 * 60_000 && <span className='ms-2'>{t("Mac'ten güncelleme gelmiyor")}</span>}
            </span>
          </p>
        )}
      </Main>
    </>
  )
}
