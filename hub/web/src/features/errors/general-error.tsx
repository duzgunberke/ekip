import { useNavigate, useRouter } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'

type GeneralErrorProps = React.HTMLAttributes<HTMLDivElement> & {
  minimal?: boolean
}

export function GeneralError({ className, minimal = false }: GeneralErrorProps) {
  const navigate = useNavigate()
  const t = useT()
  const { history } = useRouter()
  return (
    <div className={cn('h-svh w-full', className)}>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2 px-4'>
        {!minimal && <h1 className='text-[7rem] leading-tight font-bold'>500</h1>}
        <span className='font-medium'>{t('Bir şeyler ters gitti')}</span>
        <p className='text-center text-muted-foreground'>{t('Sayfayı yenileyin ya da biraz sonra tekrar deneyin.')}</p>
        {!minimal && (
          <div className='mt-6 flex gap-4'>
            <Button variant='outline' onClick={() => history.go(-1)}>
              {t('Geri dön')}
            </Button>
            <Button onClick={() => navigate({ to: '/' })}>{t('Ana sayfaya git')}</Button>
          </div>
        )}
      </div>
    </div>
  )
}
