import { useNavigate, useRouter } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'

export function NotFoundError() {
  const navigate = useNavigate()
  const t = useT()
  const { history } = useRouter()
  return (
    <div className='h-svh'>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2 px-4'>
        <h1 className='text-[7rem] leading-tight font-bold'>404</h1>
        <span className='font-medium'>{t('Sayfa bulunamadı')}</span>
        <p className='text-center text-muted-foreground'>{t('Aradığınız sayfa yok ya da taşınmış olabilir.')}</p>
        <div className='mt-6 flex gap-4'>
          <Button variant='outline' onClick={() => history.go(-1)}>
            {t('Geri dön')}
          </Button>
          <Button onClick={() => navigate({ to: '/' })}>{t('Ana sayfaya git')}</Button>
        </div>
      </div>
    </div>
  )
}
