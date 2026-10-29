import {
  FolderGit2,
  History,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  Network,
  PanelsTopLeft,
  ServerCog,
} from 'lucide-react'
import { type NavGroup } from './types'

export const navGroups: NavGroup[] = [
  {
    title: 'Genel',
    items: [
      { title: 'Görevler', url: '/tasks', icon: ListTodo },
      { title: 'Genel bakış', url: '/overview', icon: LayoutDashboard },
      { title: 'Projeler', url: '/projects', icon: FolderGit2 },
      { title: 'Kod haritası', url: '/code-map', icon: Network },
      { title: 'İşler', url: '/jobs', icon: ListChecks },
      { title: 'Çalıştırmalar', url: '/runs', icon: History },
    ],
  },
  {
    title: 'Altyapı',
    items: [
      { title: 'Havuzlar', url: '/pools', icon: ServerCog },
      { title: 'Paneller', url: '/panels', icon: PanelsTopLeft },
    ],
  },
]
