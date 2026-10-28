import { Link } from '@tanstack/react-router'
import { useStatus } from '@/hooks/queries'
import { useLayout } from '@/context/layout-provider'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { Logo } from '@/assets/logo'
import { navGroups } from './nav'
import { NavGroup } from './nav-group'
import { NavUser } from './nav-user'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  const { setOpenMobile } = useSidebar()
  const { data: status } = useStatus()
  const active = status ? (status.queue.running ?? 0) + (status.queue.queued ?? 0) : 0

  const groups = navGroups.map((g) => ({
    ...g,
    items: g.items.map((it) =>
      it.url === '/isler' && active > 0 ? { ...it, badge: String(active) } : it
    ),
  }))

  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size='lg' asChild tooltip='ekip hub'>
              <Link to='/' onClick={() => setOpenMobile(false)}>
                <Logo className='size-8 rounded-lg' />
                <div className='grid flex-1 text-start text-sm leading-tight'>
                  <span className='truncate font-semibold'>ekip hub</span>
                  <span className='truncate text-xs text-muted-foreground'>
                    iş koşucu ve kontrol paneli
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groups.map((props) => (
          <NavGroup key={props.title} {...props} />
        ))}
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
