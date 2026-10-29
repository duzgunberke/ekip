import { useMemo } from 'react'
import { format, parseISO } from 'date-fns'
import { enUS, tr } from 'date-fns/locale'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatNumber, formatPercent, useLanguage, useT } from '@/lib/i18n'
import type { SavingsSnapshot } from '@/lib/types'

const SERIES = {
  claude: 'var(--brand-lead)',
  other: 'var(--brand-team)',
}

export function SavingsChart({
  snapshot,
}: {
  snapshot: SavingsSnapshot | null | undefined
}) {
  const t = useT()
  const lang = useLanguage()
  const locale = lang === 'tr' ? tr : enUS
  const data = useMemo(
    () =>
      (snapshot?.rows ?? []).map((row) => ({
        ...row,
        label: format(parseISO(row.day), 'd MMM', { locale }),
      })),
    [snapshot, locale]
  )

  if (!data.length) {
    return (
      <div className='flex h-64 items-center justify-center text-sm text-muted-foreground'>
        {t('Henüz tasarruf verisi yok.')}
      </div>
    )
  }

  const total = (snapshot?.totals.claude ?? 0) + (snapshot?.totals.other ?? 0)
  const outsidePercent =
    snapshot?.totals.outsidePercent ??
    (total > 0 ? ((snapshot?.totals.other ?? 0) / total) * 100 : 0)
  const latest = data[data.length - 1]
  const latestTotal = latest.claude + latest.other
  const todayPercent = latestTotal > 0 ? (latest.other / latestTotal) * 100 : 0
  const firstEkipDay = data.find((row) => row.other > 0)

  return (
    <div>
      <div className='mb-5 grid grid-cols-2 gap-4 sm:gap-8'>
        <Metric label={t('Son 14 gün')} value={outsidePercent} />
        <Metric label={t('Bugün')} value={todayPercent} />
      </div>

      <div className='mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground'>
        <LegendItem color={SERIES.claude} label={t('Claude')} />
        <LegendItem color={SERIES.other} label={t('Diğer kotalar')} />
      </div>

      <div
        className='h-64 w-full'
        role='img'
        aria-label={t('Son 14 gün Claude ve diğer kota kullanımı')}
      >
        <ResponsiveContainer
          width='100%'
          height='100%'
          initialDimension={{ width: 600, height: 256 }}
        >
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              vertical={false}
              stroke='var(--border)'
              strokeDasharray='3 3'
            />
            <XAxis
              dataKey='label'
              stroke='var(--muted-foreground)'
              fontSize={11}
              tickLine={false}
              axisLine={false}
              interval='preserveStartEnd'
              minTickGap={12}
            />
            <YAxis
              stroke='var(--muted-foreground)'
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={58}
              tickFormatter={(value: number) =>
                formatCompactNumber(value, lang)
              }
            />
            <Tooltip
              cursor={{ fill: 'var(--muted)', opacity: 0.45 }}
              content={<ChartTooltip />}
            />
            {firstEkipDay && (
              <ReferenceLine
                x={firstEkipDay.label}
                stroke='var(--muted-foreground)'
                strokeDasharray='3 3'
                strokeWidth={1}
                label={{
                  value: t('ekip'),
                  position: 'insideTopLeft',
                  fill: 'var(--muted-foreground)',
                  fontSize: 10,
                }}
              />
            )}
            <Bar
              dataKey='claude'
              name={t('Claude')}
              stackId='tokens'
              fill={SERIES.claude}
              radius={[0, 0, 4, 4]}
              maxBarSize={28}
              isAnimationActive={false}
            />
            <Bar
              dataKey='other'
              name={t('Diğer kotalar')}
              stackId='tokens'
              fill={SERIES.other}
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  const t = useT()
  return (
    <div className='min-w-0'>
      <p className='text-xs font-medium text-muted-foreground'>{label}</p>
      <p className='mt-1 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl'>
        {formatPercent(Math.round(value))}
      </p>
      <p className='mt-1 text-xs leading-relaxed text-muted-foreground'>
        {t('işin bu kadarı Claude dışında yürüdü')}
      </p>
    </div>
  )
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className='inline-flex items-center gap-2'>
      <span
        className='size-2.5 rounded-sm'
        style={{ backgroundColor: color }}
        aria-hidden='true'
      />
      {label}
    </span>
  )
}

type TooltipPayload = {
  dataKey: string
  value: number
  payload: SavingsSnapshot['rows'][number] & { label: string }
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: TooltipPayload[]
}) {
  const t = useT()
  const row = payload?.[0]?.payload
  if (!active || !row) return null

  const total = row.claude + row.other
  const outsidePercent = total > 0 ? (row.other / total) * 100 : 0
  const pools = Object.entries(row.pools ?? {}).filter(([, value]) => value > 0)

  return (
    <div className='min-w-44 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md'>
      <p className='mb-1.5 font-medium'>{row.label}</p>
      <TooltipRow
        color={SERIES.claude}
        label={t('Claude')}
        value={row.claude}
      />
      <TooltipRow
        color={SERIES.other}
        label={t('Diğer kotalar')}
        value={row.other}
      />
      {pools.length > 0 && (
        <div className='my-1.5 border-t pt-1.5'>
          {pools.map(([name, value]) => (
            <TooltipRow key={name} label={poolLabel(name, t)} value={value} />
          ))}
        </div>
      )}
      <p className='mt-1.5 border-t pt-1.5 text-muted-foreground'>
        {t('Claude dışında')}:{' '}
        <span className='font-medium text-foreground'>
          {formatPercent(Math.round(outsidePercent))}
        </span>
      </p>
    </div>
  )
}

function TooltipRow({
  color,
  label,
  value,
}: {
  color?: string
  label: string
  value: number
}) {
  return (
    <p className='flex items-center gap-2'>
      {color && (
        <span
          className='size-2 shrink-0 rounded-sm'
          style={{ backgroundColor: color }}
          aria-hidden='true'
        />
      )}
      <span className='text-muted-foreground'>{label}</span>
      <span className='ms-auto ps-4 font-medium tabular-nums'>
        {formatNumber(value)}
      </span>
    </p>
  )
}

function poolLabel(name: string, t: ReturnType<typeof useT>) {
  const labels: Record<string, string> = {
    copilot: t('Copilot'),
    codex: t('Codex'),
    free: t('Ücretsiz'),
    agy: t('AGY'),
  }
  return labels[name.toLowerCase()] ?? name
}

function formatCompactNumber(value: number, lang: 'en' | 'tr') {
  const magnitude = Math.abs(value)
  const locale = lang === 'tr' ? 'tr-TR' : 'en-US'
  const unit =
    magnitude >= 1_000_000_000
      ? { divisor: 1_000_000_000, suffix: 'B' }
      : magnitude >= 1_000_000
        ? { divisor: 1_000_000, suffix: 'M' }
        : magnitude >= 1_000
          ? { divisor: 1_000, suffix: 'K' }
          : null
  if (!unit) return new Intl.NumberFormat(locale).format(value)
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / unit.divisor)}${unit.suffix}`
}
