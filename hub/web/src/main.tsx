import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ApiError, errorMessage, isUnauthorized } from '@/lib/api'
import { translate } from '@/lib/i18n'
import { ThemeProvider } from './context/theme-provider'
// Generated Routes
import { routeTree } from './routeTree.gen'
// Sonner's CSS is shipped as a file, see vite.config.ts.
import 'sonner/dist/styles.css'
import './styles/index.css'

// Any 401 from the API means the session cookie is gone or expired: back to /login.
let redirecting = false
function onUnauthorized() {
  if (redirecting) return
  const { pathname, search } = router.history.location
  if (pathname === '/login') return
  redirecting = true
  queryClient.clear()
  toast.error(translate('Oturum sona erdi, tekrar giriş yapın.'))
  router
    .navigate({ to: '/login', search: { redirect: `${pathname}${search}` }, replace: true })
    .finally(() => {
      redirecting = false
    })
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !(error instanceof ApiError && [401, 403, 404].includes(error.status)) && failureCount < 2,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) onUnauthorized()
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (isUnauthorized(error)) return onUnauthorized()
      if (!mutation.options.onError) toast.error(errorMessage(error))
    },
  }),
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  ReactDOM.createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
