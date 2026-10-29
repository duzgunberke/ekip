import { useSignOut } from '@/hooks/use-sign-out'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useT } from '@/lib/i18n'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const t = useT()
  const signOut = useSignOut()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('Çıkış yap')}
      desc={t('Oturum kapatılsın mı? Panele tekrar erişmek için parola gerekecek.')}
      confirmText={t('Çıkış yap')}
      destructive
      handleConfirm={signOut}
      className='sm:max-w-sm'
    />
  )
}
