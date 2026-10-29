import { LogOut } from 'lucide-react'
import useDialogState from '@/hooks/use-dialog-state'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { SignOutDialog } from '@/components/sign-out-dialog'
import { useT } from '@/lib/i18n'

export function NavUser() {
  const t = useT()
  const [open, setOpen] = useDialogState()
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip={t('Çıkış yap')} onClick={() => setOpen(true)}>
            <LogOut />
            <span>{t('Çıkış yap')}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
