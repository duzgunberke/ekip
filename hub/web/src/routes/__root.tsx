import { type QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import { NavigationProgress } from '@/components/navigation-progress'
import { GeneralError } from '@/features/errors/general-error'
import { NotFoundError } from '@/features/errors/not-found-error'
import { LanguageSync } from '@/lib/i18n'

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  component: () => (
    <>
      <LanguageSync />
      <NavigationProgress />
      <Outlet />
      <Toaster duration={5000} position='bottom-right' />
    </>
  ),
  notFoundComponent: NotFoundError,
  errorComponent: GeneralError,
})
