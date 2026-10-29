import { useEffect, useState } from 'react'
import { ago, dateTime } from '@/lib/format'
import { useT } from '@/lib/i18n'

/** Relative time that stays fresh; the absolute time is in the tooltip. */
export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const t = useT()
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  if (!iso) return <span className={className}>{t('Yok')}</span>
  return (
    <time dateTime={iso} title={dateTime(iso)} className={className}>
      {ago(iso)}
    </time>
  )
}
