import { getRouteApi } from '@tanstack/react-router'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AuthLayout } from '../auth-layout'
import { UserAuthForm } from './components/user-auth-form'

const route = getRouteApi('/login')

export function SignIn() {
  const { redirect } = route.useSearch()
  return (
    <AuthLayout>
      <Card className='gap-4'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>Giriş yap</CardTitle>
          <CardDescription>Panele erişmek için hub parolasını girin.</CardDescription>
        </CardHeader>
        <CardContent>
          <UserAuthForm redirectTo={redirect} />
        </CardContent>
      </Card>
      <p className='text-center text-xs text-muted-foreground'>
        Oturum, tarayıcıda yalnızca HttpOnly bir çerezde tutulur.
      </p>
    </AuthLayout>
  )
}
