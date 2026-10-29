import { AlertTriangle, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { errorMessage } from '@/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: React.ElementType
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 bg-muted/20 px-6 py-12 text-center',
        className
      )}
    >
      <div className='mb-4 flex size-11 items-center justify-center rounded-xl bg-primary/10'>
        <Icon className='size-5 text-primary' aria-hidden='true' />
      </div>
      <p className='font-medium'>{title}</p>
      {description && <p className='mt-1 max-w-sm text-sm text-muted-foreground'>{description}</p>}
      {action && <div className='mt-4'>{action}</div>}
    </div>
  )
}

export function QueryError({
  error,
  onRetry,
  title = 'Veri alınamadı',
  className,
}: {
  error: unknown
  onRetry?: () => void
  title?: string
  className?: string
}) {
  return (
    <Alert variant='destructive' className={cn('items-start', className)}>
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{errorMessage(error)}</p>
        {onRetry && (
          <Button variant='outline' size='sm' className='mt-2 text-foreground' onClick={onRetry}>
            <RotateCw /> Tekrar dene
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
