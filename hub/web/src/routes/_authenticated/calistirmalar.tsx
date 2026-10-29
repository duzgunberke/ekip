import { createFileRoute, redirect } from '@tanstack/react-router'
import { legacyRouteHref } from '@/lib/legacy-route'

export const Route = createFileRoute('/_authenticated/calistirmalar')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: legacyRouteHref(location, '/runs') })
  },
})
