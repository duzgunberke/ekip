import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Bug,
  Database,
  Gauge,
  HeartPulse,
  Link2,
  PanelsTopLeft,
  Rocket,
  ScrollText,
} from 'lucide-react'
import { useStatus } from '@/hooks/queries'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { AppHeader, PageTitle } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { EmptyState, QueryError } from '@/components/ekip/states'

const ICONS: [RegExp, React.ElementType, string][] = [
  [/coolify/i, Rocket, 'Uygulama ve servis dağıtımı'],
  [/metri|beszel/i, Gauge, 'Sunucu kaynak metrikleri'],
  [/log|dozzle/i, ScrollText, 'Konteyner günlükleri'],
  [/durum|uptime|status/i, HeartPulse, 'Erişilebilirlik izleme'],
  [/analitik|umami|stats/i, BarChart3, 'Web analitiği'],
  [/metabase/i, Database, 'Veri sorguları ve panolar'],
  [/hata|glitch|sentry/i, Bug, 'Hata takibi'],
  [/monitor|grafana/i, Activity, 'İzleme'],
]

function meta(name: string) {
  const hit = ICONS.find(([re]) => re.test(name))
  return { icon: hit?.[1] ?? Link2, desc: hit?.[2] ?? 'Harici panel' }
}

export function Panels() {
  const status = useStatus()
  const links = status.data?.links ?? []
  return (
    <>
      <AppHeader />
      <Main>
        <PageTitle title='Paneller' description='Aynı sunucudaki diğer yönetim panelleri. Yeni sekmede açılır.' />
        {status.isError ? (
          <QueryError error={status.error} onRetry={() => status.refetch()} />
        ) : status.isLoading ? (
          <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className='h-28 rounded-xl' />
            ))}
          </div>
        ) : links.length === 0 ? (
          <EmptyState
            icon={PanelsTopLeft}
            title='Panel bağlantısı yok'
            description='Hub ortamında EKIP_LINKS="Ad|https://url,…" ayarlayın.'
          />
        ) : (
          <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
            {links.map((l) => {
              const { icon: Icon, desc } = meta(l.name)
              let host = l.url
              try {
                host = new URL(l.url).host
              } catch {
                /* keep raw */
              }
              return (
                <a
                  key={l.url}
                  href={l.url}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='group rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                >
                  <Card className='h-full gap-0 transition-colors group-hover:border-foreground/20 group-hover:bg-muted/30'>
                    <CardHeader className='grid-cols-[auto_1fr_auto] items-center gap-x-4'>
                      <div className='row-span-2 flex size-11 items-center justify-center rounded-lg border bg-muted/50'>
                        <Icon className='size-5' aria-hidden='true' />
                      </div>
                      <CardTitle className='truncate'>{l.name}</CardTitle>
                      <ArrowUpRight
                        className='row-span-2 size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground'
                        aria-hidden='true'
                      />
                      <CardDescription className='truncate'>
                        {desc} · <span className='font-mono text-xs'>{host}</span>
                      </CardDescription>
                    </CardHeader>
                    <span className='sr-only'>(yeni sekmede açılır)</span>
                  </Card>
                </a>
              )
            })}
          </div>
        )}
      </Main>
    </>
  )
}
