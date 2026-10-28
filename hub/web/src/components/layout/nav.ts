import {
  FolderGit2,
  History,
  LayoutDashboard,
  ListChecks,
  Network,
  PanelsTopLeft,
  ServerCog,
} from 'lucide-react'
import { type NavGroup } from './types'

export const navGroups: NavGroup[] = [
  {
    title: 'Genel',
    items: [
      { title: 'Genel bakış', url: '/', icon: LayoutDashboard },
      { title: 'Projeler', url: '/projeler', icon: FolderGit2 },
      { title: 'Kod haritası', url: '/kod-haritasi', icon: Network },
      { title: 'İşler', url: '/isler', icon: ListChecks },
      { title: 'Çalıştırmalar', url: '/calistirmalar', icon: History },
    ],
  },
  {
    title: 'Altyapı',
    items: [
      { title: 'Havuzlar', url: '/havuzlar', icon: ServerCog },
      { title: 'Paneller', url: '/paneller', icon: PanelsTopLeft },
    ],
  },
]
