import { CheckCircle2, Circle, CircleDot } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useT } from '@/lib/i18n'
import type { LimitsSnapshot, Status } from '@/lib/types'

// The same setup checklist as `ekip setup` on the Mac (sent with its limits snapshot), and under it the
// hub's own gaps (CI folder, the commit it was built from, its free pool and memory).
export function SetupChecklist({ limits, status }: { limits: LimitsSnapshot | null | undefined; status: Status | undefined }) {
  const t = useT()
  const steps = limits?.setup ?? []
  const hub = status?.setup ?? []
  if (!steps.length && !hub.length) return null
  const counted = steps.filter((s) => s.level !== 'optional')
  const done = counted.filter((s) => s.done).length
  const open = steps.filter((s) => !s.done)
  const hubOpen = hub.filter((s) => !s.done)
  if (!open.length && !hubOpen.length) return null
  return (
    <Card className='mb-5'>
      <CardHeader>
        <CardTitle>{t('Kurulum')} {counted.length ? `${done}/${counted.length}` : ''}</CardTitle>
        <CardDescription>{t('Mac’te adım adım: ekip setup')}</CardDescription>
      </CardHeader>
      <CardContent className='grid gap-4'>
        {counted.length > 0 && (
          <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
            <div className='h-full rounded-full bg-emerald-500' style={{ width: `${Math.round((done / counted.length) * 100)}%` }} />
          </div>
        )}
        <ul className='grid gap-2'>
          {steps.map((s) => (
            <li key={s.id} className='flex items-start gap-2 text-sm'>
              {s.done ? <CheckCircle2 className='mt-0.5 size-4 shrink-0 text-emerald-500' /> : s.level === 'required' ? <CircleDot className='mt-0.5 size-4 shrink-0 text-amber-500' /> : <Circle className='mt-0.5 size-4 shrink-0 text-muted-foreground' />}
              <div className='min-w-0'>
                <p className={s.done ? 'text-muted-foreground' : 'font-medium'}>{t(s.title)}{!s.done && s.level !== 'required' ? <span className='ms-2 text-xs font-normal text-muted-foreground'>{t(s.level === 'recommended' ? 'önerilen' : 'isteğe bağlı')}</span> : null}</p>
                {!s.done && (
                  <>
                    <p className='text-xs text-muted-foreground'>{s.detail ? `${s.detail} · ` : ''}{t(s.why)}</p>
                    <code className='mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-xs'>{s.command}</code>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {hubOpen.length > 0 && (
          <div>
            <p className='mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground'>{t('Hub')}</p>
            <ul className='grid gap-2'>
              {hubOpen.map((s) => (
                <li key={s.id} className='flex items-start gap-2 text-sm'>
                  <CircleDot className='mt-0.5 size-4 shrink-0 text-amber-500' />
                  <div className='min-w-0'>
                    <p className='font-medium'>{t(s.title)}</p>
                    <p className='text-xs text-muted-foreground'>{t(s.why)}</p>
                    <code className='mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-xs'>{s.command}</code>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
