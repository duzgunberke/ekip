import { Link } from '@tanstack/react-router'
import { ArrowRight, BookOpen } from 'lucide-react'
import type { ProjectUsage, UsageKind, UsageSource, UsageSummary } from '@/lib/types'
import { formatNumber, formatPercent, useT } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ekip/states'

const KINDS: UsageKind[] = ['memory', 'wiki', 'skill', 'local-skill', 'codegraph', 'card']
const SOURCES: UsageSource[] = ['prompt-hook', 'worker-brief', 'mcp-lead', 'mcp-worker', 'review']
const KIND_LABEL: Record<UsageKind, string> = {
  memory: 'Hafıza',
  wiki: 'Wiki',
  skill: 'Beceri',
  'local-skill': 'Yerel beceri',
  codegraph: 'Kod grafiği',
  card: 'Kart',
}
const SOURCE_LABEL: Record<UsageSource, string> = {
  'prompt-hook': 'Lead hook',
  'worker-brief': 'İşçi brifi',
  'mcp-lead': 'MCP (lead)',
  'mcp-worker': 'MCP (işçi)',
  review: 'İnceleme',
}

const rate = (value: number | null | undefined) => (value == null ? '–' : formatPercent(value))

// Compact block inside a project card: lookups per kind, hit rate and the most used skills.
export function ProjectUsageSummary({ usage }: { usage?: ProjectUsage }) {
  const t = useT()
  if (!usage?.lookups) return null
  const kinds = KINDS.filter((k) => usage.kinds[k]?.n)
  return (
    <div className='grid gap-1.5 border-t pt-3 text-xs'>
      <p className='flex items-center gap-1.5 font-medium'>
        <BookOpen className='size-3.5 text-muted-foreground' aria-hidden='true' />
        {t('Bilgi kullanımı')}
        <span className='ms-auto font-normal text-muted-foreground tabular-nums'>
          {t('{count} arama · isabet {rate}', { count: formatNumber(usage.lookups), rate: rate(usage.hitRate) })}
        </span>
      </p>
      <div className='flex flex-wrap gap-1'>
        {kinds.map((k) => (
          <Badge key={k} variant='secondary' className='font-normal tabular-nums'>
            {t(KIND_LABEL[k])} {formatNumber(usage.kinds[k]!.n)}
          </Badge>
        ))}
      </div>
      {usage.skills.length > 0 && (
        <p className='truncate text-muted-foreground'>
          {usage.skills.slice(0, 3).map((s) => `${s.name} ×${formatNumber(s.calls)}`).join(' · ')}
        </p>
      )}
    </div>
  )
}

// Full view in the project sheet: per kind by source, skills with the "worker opened it" signal,
// and run success with and without knowledge in the brief.
export function ProjectUsageDetail({ usage }: { usage?: ProjectUsage }) {
  const t = useT()
  if (!usage?.lookups) return null
  const kinds = KINDS.filter((k) => usage.kinds[k]?.n)
  const sources = SOURCES.filter((s) => usage.sources[s])
  const runs = usage.briefs.runs
  return (
    <section aria-labelledby='usage-h' className='mb-5'>
      <h3 id='usage-h' className='mb-1 text-sm font-medium'>{t('Bilgi kullanımı')}</h3>
      <p className='mb-3 text-xs text-muted-foreground'>{t('Sinyal, kanıt değil: isabet, aramanın sonuç döndürdüğünü gösterir.')}</p>
      <div className='overflow-x-auto'>
        <table className='w-full text-xs tabular-nums'>
          <thead className='text-muted-foreground'>
            <tr className='border-b'>
              <th className='py-1.5 pe-3 text-start font-medium'>{t('Tür')}</th>
              {sources.map((s) => (
                <th key={s} className='px-2 py-1.5 text-end font-medium'>{t(SOURCE_LABEL[s])}</th>
              ))}
              <th className='ps-2 py-1.5 text-end font-medium'>{t('İsabet')}</th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k} className='border-b last:border-0'>
                <td className='py-1.5 pe-3'>{t(KIND_LABEL[k])}</td>
                {sources.map((s) => (
                  <td key={s} className='px-2 py-1.5 text-end'>{formatNumber(usage.kinds[k]?.bySource[s] ?? 0)}</td>
                ))}
                <td className='ps-2 py-1.5 text-end font-medium'>{rate(usage.kinds[k]?.hitRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {usage.skills.length > 0 && (
        <ul className='mt-3 grid gap-1 text-xs'>
          {usage.skills.map((s) => (
            <li key={s.name} className='flex items-center gap-2'>
              <span className='min-w-0 truncate font-mono'>{s.name}</span>
              <span className='ms-auto shrink-0 text-muted-foreground tabular-nums'>
                ×{formatNumber(s.calls)}
                {s.checked > 0 && ` · ${t('işçi açtı {used}/{given}', { used: formatNumber(s.used), given: formatNumber(s.checked) })}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {usage.briefs.total > 0 && (
        <p className='mt-3 text-xs text-muted-foreground'>
          {t('{total} işçi brifi, {with} tanesinde bilgi vardı. Başarı: bilgiyle {a}, bilgisiz {b}.', {
            total: formatNumber(usage.briefs.total),
            with: formatNumber(usage.briefs.withKnowledge),
            a: runs.with.n ? `${runs.with.ok}/${runs.with.n} (${rate(usage.briefs.successWith)})` : '–',
            b: runs.without.n ? `${runs.without.ok}/${runs.without.n} (${rate(usage.briefs.successWithout)})` : '–',
          })}
        </p>
      )}
    </section>
  )
}

// Overview card: how much knowledge was looked up, by whom, and how often it returned something.
export function UsageOverviewCard({ summary }: { summary: UsageSummary | null | undefined }) {
  const t = useT()
  const total = summary?.totals.lookups ?? 0
  const sources = SOURCES.filter((s) => summary?.totals.bySource[s])
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Bilgi kullanımı')}</CardTitle>
        <CardDescription>
          {t('Son {days} gün · hafıza, wiki, beceri ve kod grafiği aramaları', { days: summary?.days ?? 30 })}
        </CardDescription>
        <CardAction>
          <Button variant='ghost' size='sm' asChild>
            <Link to='/projects'>
              {t('Projeler')} <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {!total ? (
          <EmptyState
            icon={BookOpen}
            title={t('Henüz kullanım verisi yok')}
            description={t("Mac'te ekip stats ya da ekip doctor çalışınca görünür.")}
            className='py-8'
          />
        ) : (
          <div className='grid gap-4'>
            <div className='grid grid-cols-2 gap-4'>
              <div>
                <p className='text-xs font-medium text-muted-foreground'>{t('Arama')}</p>
                <p className='mt-1 text-2xl font-semibold tracking-tight tabular-nums'>{formatNumber(total)}</p>
              </div>
              <div>
                <p className='text-xs font-medium text-muted-foreground'>{t('İsabet')}</p>
                <p className='mt-1 text-2xl font-semibold tracking-tight tabular-nums'>{rate(summary?.totals.hitRate)}</p>
              </div>
            </div>
            <ul className='grid gap-2'>
              {sources.map((s) => {
                const n = summary?.totals.bySource[s] ?? 0
                return (
                  <li key={s} className='grid gap-1 text-xs'>
                    <div className='flex justify-between'>
                      <span>{t(SOURCE_LABEL[s])}</span>
                      <span className='tabular-nums text-muted-foreground'>{formatNumber(n)}</span>
                    </div>
                    <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
                      <div className='h-full rounded-full bg-primary' style={{ width: `${(n / total) * 100}%` }} />
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className='text-xs text-muted-foreground'>{t('Sinyal, kanıt değil: isabet, aramanın sonuç döndürdüğünü gösterir.')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
