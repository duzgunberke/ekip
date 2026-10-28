import { Link } from '@tanstack/react-router'
import { ArrowRight, ListTodo } from 'lucide-react'
import { useTasks } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ProgressBar, currentStep, etaText } from './parts'

/** "Aktif görevler" card for Genel bakış. */
export function ActiveTasksMini() {
  const tasks = useTasks()
  const now = useNow(5000)
  const active = (tasks.data ?? []).filter((t) => t.status === 'running')
  return (
    <Card className='mb-4 gap-4'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'>
          <ListTodo className='size-4 text-muted-foreground' aria-hidden='true' /> Aktif görevler
          <span className='rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums'>
            {tasks.isLoading ? '…' : active.length}
          </span>
        </CardTitle>
        <CardDescription>Mac'teki isteklerin canlı ilerlemesi</CardDescription>
        <CardAction>
          <Button variant='ghost' size='sm' asChild>
            <Link to='/'>
              Görevler <ArrowRight />
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {tasks.isLoading ? (
          <Skeleton className='h-10' />
        ) : active.length === 0 ? (
          <p className='text-sm text-muted-foreground'>Şu an çalışan görev yok.</p>
        ) : (
          <ul className='grid gap-3 md:grid-cols-2'>
            {active.slice(0, 4).map((t) => {
              const cur = currentStep(t)
              const eta = etaText(t, now)
              return (
                <li key={t.id}>
                  <Link to='/' className='block rounded-lg border px-3 py-2.5 hover:bg-muted/40'>
                    <div className='flex items-baseline justify-between gap-3'>
                      <p className='min-w-0 truncate text-sm font-medium'>{t.title}</p>
                      <span className='shrink-0 text-sm font-semibold tabular-nums'>%{Math.round(t.pct)}</span>
                    </div>
                    <ProgressBar value={t.pct} className='my-2 h-1.5' label={`${t.title} ilerlemesi`} />
                    <p className='truncate text-xs text-muted-foreground'>
                      {[cur?.step.title, eta].filter(Boolean).join(' · ') || t.project}
                    </p>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
