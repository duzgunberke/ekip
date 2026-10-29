import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { translate } from '@/lib/i18n'
import { logout } from '@/lib/api'

export function useSignOut() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  return async () => {
    try {
      await logout()
    } catch {
      /* the cookie is cleared server-side; nothing else to do */
    }
    qc.clear()
    toast.success(translate('Çıkış yapıldı.'))
    navigate({ to: '/sign-in', search: {}, replace: true })
  }
}
