import { useT } from '@/lib/i18n'
import type { BackgroundJob } from '@/lib/types'

// The work behind the tasks, as `ekip durum` lists it: embeddings (provider, queue, last success),
// the vector backfill, the history import and wiki / code graph indexing.
export function BackgroundList({ jobs }: { jobs: BackgroundJob[] }) {
  const t = useT()
  if (!jobs.length) return <p className='text-sm text-muted-foreground'>{t('arka planda iş yok')}</p>
  return (
    <ul className='grid gap-2'>
      {jobs.map((j) => (
        <li key={j.id} className='flex items-start gap-2 text-sm'>
          <span className={`mt-1.5 size-2 shrink-0 rounded-full ${j.state === 'error' ? 'bg-red-500' : j.state === 'running' ? 'bg-teal-500' : 'bg-emerald-500'}`} aria-hidden />
          <div className='min-w-0'>
            <p className='font-medium'>{t(j.label)}</p>
            {j.detail ? <p className='break-words text-xs text-muted-foreground'>{j.detail}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  )
}
