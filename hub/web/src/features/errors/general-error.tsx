import { useNavigate, useRouter } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type GeneralErrorProps = React.HTMLAttributes<HTMLDivElement> & {
  minimal?: boolean
}

export function GeneralError({ className, minimal = false }: GeneralErrorProps) {
  const navigate = useNavigate()
  const { history } = useRouter()
  return (
    <div className={cn('h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2 px-4'>
        {!minimal && <h1 className='text-[7rem] leading-tight font-bold'>500</h1>}
        <span className='font-medium'>Bir şeyler ters gitti</span>
        <p className='text-center text-muted-foreground'>Sayfayı yenileyin ya da biraz sonra tekrar deneyin.</p>
        {!minimal && (
          <div className='mt-6 flex gap-4'>
            <Button variant='outline' onClick={() => history.go(-1)}>
              Geri dön
            </Button>
            <Button onClick={() => navigate({ to: '/' })}>Genel bakışa git</Button>
          </div>
        )}
      </div>
    </div>
  )
}
