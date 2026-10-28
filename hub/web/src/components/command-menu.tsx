import React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  ExternalLink,
  FolderGit2,
  Laptop,
  LogOut,
  Moon,
  Plus,
  RefreshCw,
  Sun,
} from 'lucide-react'
import { useProjects, useStatus } from '@/hooks/queries'
import { useSignOut } from '@/hooks/use-sign-out'
import { useNewJob } from '@/context/new-job-provider'
import { useSearch } from '@/context/search-provider'
import { useTheme } from '@/context/theme-provider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { navGroups } from './layout/nav'

export function CommandMenu() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { setTheme } = useTheme()
  const { open, setOpen } = useSearch()
  const { openNewJob } = useNewJob()
  const signOut = useSignOut()
  const projects = useProjects()
  const status = useStatus()

  const run = React.useCallback(
    (command: () => unknown) => {
      setOpen(false)
      command()
    },
    [setOpen]
  )

  return (
    <CommandDialog
      modal
      open={open}
      onOpenChange={setOpen}
      title='Komut paleti'
      description='Sayfaya git, iş başlat veya tema değiştir'
    >
      <CommandInput placeholder='Komut yazın veya arayın…' />
      <CommandList className='max-h-[min(24rem,70svh)]'>
        <CommandEmpty>Sonuç yok.</CommandEmpty>
        <CommandGroup heading='Eylemler'>
          <CommandItem value='yeni iş başlat' onSelect={() => run(() => openNewJob())}>
            <Plus />
            Yeni iş
          </CommandItem>
          <CommandItem
            value='verileri yenile'
            onSelect={() => run(() => qc.invalidateQueries())}
          >
            <RefreshCw />
            Verileri yenile
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        {navGroups.map((group) => (
          <CommandGroup key={group.title} heading={group.title}>
            {group.items.map((item) =>
              item.url ? (
                <CommandItem
                  key={String(item.url)}
                  value={`git ${item.title}`}
                  onSelect={() => run(() => navigate({ to: item.url }))}
                >
                  {item.icon ? <item.icon /> : <ArrowRight />}
                  {item.title}
                </CommandItem>
              ) : null
            )}
          </CommandGroup>
        ))}
        {!!projects.data?.length && (
          <>
            <CommandSeparator />
            <CommandGroup heading='Projeler'>
              {projects.data.map((p) => (
                <CommandItem
                  key={p.name}
                  value={`proje ${p.name}`}
                  onSelect={() => run(() => navigate({ to: '/projeler', search: { p: p.name } }))}
                >
                  <FolderGit2 />
                  {p.name}
                  <CommandShortcut className='tracking-normal'>kartı aç</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {!!status.data?.links.length && (
          <>
            <CommandSeparator />
            <CommandGroup heading='Paneller'>
              {status.data.links.map((l) => (
                <CommandItem
                  key={l.url}
                  value={`panel ${l.name}`}
                  onSelect={() => run(() => window.open(l.url, '_blank', 'noopener,noreferrer'))}
                >
                  <ExternalLink />
                  {l.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        <CommandSeparator />
        <CommandGroup heading='Tema'>
          <CommandItem value='tema açık' onSelect={() => run(() => setTheme('light'))}>
            <Sun /> Açık
          </CommandItem>
          <CommandItem value='tema koyu' onSelect={() => run(() => setTheme('dark'))}>
            <Moon /> Koyu
          </CommandItem>
          <CommandItem value='tema sistem' onSelect={() => run(() => setTheme('system'))}>
            <Laptop /> Sistem
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading='Oturum'>
          <CommandItem value='çıkış yap' onSelect={() => run(signOut)}>
            <LogOut /> Çıkış yap
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
