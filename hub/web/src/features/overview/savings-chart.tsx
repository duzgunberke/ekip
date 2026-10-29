import { useMemo } from 'react'
import { format, parseISO } from 'date-fns'
import { enUS, tr } from 'date-fns/locale'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { SavingsSnapshot } from '@/lib/types'
import { formatNumber, useLanguage, useT } from '@/lib/i18n'

export function SavingsChart({ snapshot }: { snapshot: SavingsSnapshot | null | undefined }) {
  const t = useT(); const lang = useLanguage()
  const data = useMemo(() => (snapshot?.rows ?? []).map((r) => ({ ...r, label: format(parseISO(r.day), 'd MMM', { locale: lang === 'tr' ? tr : enUS }) })), [snapshot, lang])
  if (!data.length) return <div className='flex h-64 items-center justify-center text-sm text-muted-foreground'>{t('Henüz tasarruf verisi yok.')}</div>
  return <div className='relative h-64 w-full' role='img' aria-label={t('Son 14 gün Claude ve diğer kota kullanımı')}>
    <div className='absolute right-4 top-0 z-10 text-sm font-semibold'>{formatNumber(snapshot?.totals.outsidePercent ?? 0)}% {t('iş dışarıda')}</div>
    <ResponsiveContainer width='100%' height='100%' initialDimension={{ width: 600, height: 256 }}>
      <BarChart data={data} margin={{ top: 24, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke='var(--border)' />
        <XAxis dataKey='label' stroke='var(--muted-foreground)' fontSize={11} tickLine={false} axisLine={false} interval='preserveStartEnd' />
        <YAxis stroke='var(--muted-foreground)' fontSize={11} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => formatNumber(v)} />
        <Tooltip formatter={(v) => formatNumber(Math.round(Number(v) || 0))} />
        <Legend verticalAlign='top' align='left' height={28} iconType='circle' iconSize={8} />
        <Bar dataKey='claude' name={t('Claude')} stackId='tokens' fill='var(--brand-lead)' maxBarSize={28} isAnimationActive={false} />
        <Bar dataKey='other' name={t('Diğer kotalar')} stackId='tokens' fill='var(--brand-team)' radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  </div>
}
