import { useSignOut } from '@/hooks/use-sign-out'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const signOut = useSignOut()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='Çıkış yap'
      desc='Oturum kapatılsın mı? Panele tekrar erişmek için parola gerekecek.'
      confirmText='Çıkış yap'
      destructive
      handleConfirm={signOut}
      className='sm:max-w-sm'
    />
  )
}
