import { createFileRoute, redirect } from '@tanstack/react-router'
import { legacyRouteHref } from '@/lib/legacy-route'

export const Route = createFileRoute('/login')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: legacyRouteHref(location, '/sign-in') })
  },
})
