import { createFileRoute, redirect } from '@tanstack/react-router'
import { api, isUnauthorized } from '@/lib/api'
import { qk } from '@/hooks/queries'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData({
        queryKey: qk.session,
        queryFn: () => api('/api/session'),
        staleTime: 60_000,
        retry: false,
      })
    } catch (e) {
      if (isUnauthorized(e)) throw redirect({ to: '/sign-in', search: { redirect: location.href } })
      // Network/server trouble: render the app; each page shows its own error state.
    }
  },
  component: AuthenticatedLayout,
})
