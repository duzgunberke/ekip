import { LogOut } from 'lucide-react'
import useDialogState from '@/hooks/use-dialog-state'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { SignOutDialog } from '@/components/sign-out-dialog'

export function NavUser() {
  const [open, setOpen] = useDialogState()
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton tooltip='Çıkış yap' onClick={() => setOpen(true)}>
            <LogOut />
            <span>Çıkış yap</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
