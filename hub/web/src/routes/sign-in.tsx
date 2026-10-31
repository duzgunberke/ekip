import { z } from 'zod'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { api, safeRedirect } from '@/lib/api'
import { qk } from '@/hooks/queries'
import { SignIn } from '@/features/auth/sign-in'

export const Route = createFileRoute('/sign-in')({
  validateSearch: z.object({ redirect: z.string().optional(), enrol: z.string().optional() }),
  beforeLoad: async ({ context, search }) => {
    const ok = await context.queryClient
      .fetchQuery({ queryKey: qk.session, queryFn: () => api('/api/session'), staleTime: 0, retry: false })
      .then(() => true, () => false)
    // with an enrolment code a signed-in user still gets the form, to register the passkey
    if (ok && !search.enrol) throw redirect({ to: safeRedirect(search.redirect) })
  },
  component: SignIn,
})
