import { createFileRoute, redirect } from '@tanstack/react-router'
import { legacyRouteHref } from '@/lib/legacy-route'

export const Route = createFileRoute('/_authenticated/kod-haritasi')({
  beforeLoad: ({ location }) => {
    throw redirect({ href: legacyRouteHref(location, '/code-map') })
  },
})
