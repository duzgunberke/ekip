import { useEffect, useState } from 'react'
import { ago, dateTime } from '@/lib/format'

/** Relative time that stays fresh; the absolute time is in the tooltip. */
export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  if (!iso) return <span className={className}>—</span>
  return (
    <time dateTime={iso} title={dateTime(iso)} className={className}>
      {ago(iso)}
    </time>
  )
}
