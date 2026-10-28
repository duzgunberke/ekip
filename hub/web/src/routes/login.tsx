import { z } from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { api, safeRedirect } from '@/lib/api'
import { qk } from '@/hooks/queries'
import { SignIn } from '@/features/auth/sign-in'

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  // Already signed in (valid cookie)? Skip the form.
  beforeLoad: async ({ context, search }) => {
    const ok = await context.queryClient
      .fetchQuery({ queryKey: qk.session, queryFn: () => api('/api/session'), staleTime: 0, retry: false })
      .then(() => true, () => false)
    if (ok) throw redirect({ to: safeRedirect(search.redirect) })
  },
  component: SignIn,
})

