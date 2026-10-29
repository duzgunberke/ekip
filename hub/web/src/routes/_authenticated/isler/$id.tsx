import { createFileRoute, redirect } from '@tanstack/react-router'
import { legacyRouteHref } from '@/lib/legacy-route'

export const Route = createFileRoute('/_authenticated/isler/$id')({
  beforeLoad: ({ location, params }) => {
    throw redirect({
      href: legacyRouteHref(location, `/jobs/${encodeURIComponent(params.id)}`),
    })
  },
})
