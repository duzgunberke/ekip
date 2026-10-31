import { useEffect } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useT } from '@/lib/i18n'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

const route = getRouteApi('/sign-in')

export function SignIn() {
  const { redirect, enrol } = route.useSearch()
  const t = useT()
  useEffect(() => {
    document.title = `${t('Giriş yap')} · ekip`
  }, [t])
  return (
    <AuthLayout>
      <Card className='gap-4'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>{t('Giriş yap')}</CardTitle>
          <CardDescription>{t('Panele erişmek için hub parolasını girin; ardından passkey istenir.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <UserAuthForm redirectTo={redirect} enrolCode={enrol} />
        </CardContent>
      </Card>
      <p className='text-center text-xs text-muted-foreground'>
        {t('Oturum, tarayıcıda yalnızca HttpOnly bir çerezde tutulur.')}
      </p>
    </AuthLayout>
  )
}
