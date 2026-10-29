import { useMemo } from 'react'
import { format, startOfDay, subDays } from 'date-fns'
import { tr } from 'date-fns/locale'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { normalizeRunStatus, STATUS_LABEL } from '@/lib/format'
import type { Job, Run } from '@/lib/types'

const SERIES = ['done', 'failed', 'cancelled', 'running', 'queued'] as const
const DAYS = 14
const DOT: Record<string, string> = {
  done: 'bg-status-done',
  failed: 'bg-status-failed',
  cancelled: 'bg-status-cancelled',
  running: 'bg-status-running',
  queued: 'bg-status-queued',
}

export function JobsChart({ jobs, runs }: { jobs: Job[]; runs: Run[] }) {
  const data = useMemo(() => {
    const today = startOfDay(new Date())
    const days = Array.from({ length: DAYS }, (_, i) => {
      const d = subDays(today, DAYS - 1 - i)
      return {
        key: format(d, 'yyyy-MM-dd'),
        label: format(d, 'd MMM', { locale: tr }),
        done: 0,
        failed: 0,
        cancelled: 0,
        running: 0,
        queued: 0,
      }
    })
    const idx = new Map(days.map((d, i) => [d.key, i]))
    for (const j of jobs) {
      const i = idx.get(format(new Date(j.createdAt), 'yyyy-MM-dd'))
      if (i !== undefined && j.status in days[i]) days[i][j.status] += 1
    }
    for (const r of runs) {
      const i = idx.get(format(new Date(r.startedAt ?? r.receivedAt), 'yyyy-MM-dd'))
      const status = SERIES.find((key) => key === normalizeRunStatus(r.status))
      if (i !== undefined && status) days[i][status] += 1
    }
    return days
  }, [jobs, runs])

  const total = data.reduce((n, d) => n + SERIES.reduce((m, k) => m + d[k], 0), 0)

  return (
    <div className='relative h-full min-h-64 w-full' role='img' aria-label={`Son ${DAYS} günde ${total} iş`}>
      <ResponsiveContainer width='100%' height='100%' initialDimension={{ width: 600, height: 256 }}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke='var(--border)' />
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
            allowDecimals={false}
            width={40}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
            content={<ChartTooltip />}
          />
          <Legend
            verticalAlign='top'
            align='right'
            height={28}
            iconType='circle'
            iconSize={8}
            formatter={(v: string) => (
              <span className='text-xs text-muted-foreground'>{STATUS_LABEL[v] ?? v}</span>
            )}
          />
          {SERIES.map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              stackId='jobs'
              fill={`var(--status-${k})`}
              radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0}
              maxBarSize={28}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      {total === 0 && (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <p className='rounded-md bg-card/80 px-3 py-1.5 text-sm text-muted-foreground'>
            Son {DAYS} günde iş yok
          </p>
        </div>
      )}
    </div>
  )
}

type TooltipPayload = { dataKey: string; value: number; color: string }

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload?.length) return null
  const rows = payload.filter((p) => p.value > 0)
  return (
    <div className='rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md'>
      <p className='mb-1 font-medium'>{label}</p>
      {rows.length === 0 ? (
        <p className='text-muted-foreground'>İş yok</p>
      ) : (
        rows.map((p) => (
          <p key={p.dataKey} className='flex items-center gap-2'>
            <span className={`size-2 rounded-full ${DOT[p.dataKey] ?? 'bg-muted-foreground'}`} aria-hidden='true' />
            <span className='text-muted-foreground'>{STATUS_LABEL[p.dataKey] ?? p.dataKey}</span>
            <span className='ms-auto ps-4 font-medium tabular-nums'>{p.value}</span>
          </p>
        ))
      )}
    </div>
  )
}
