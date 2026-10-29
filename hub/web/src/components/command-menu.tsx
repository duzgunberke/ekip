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
import { useT } from '@/lib/i18n'

export function CommandMenu() {
  const t = useT()
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
      title={t('Komut paleti')}
      description={t('Sayfaya git, iş başlat veya tema değiştir')}
    >
      <CommandInput placeholder={t('Komut yazın veya arayın…')} />
      <CommandList className='max-h-[min(24rem,70svh)]'>
        <CommandEmpty>{t('Sonuç yok.')}</CommandEmpty>
        <CommandGroup heading={t('Eylemler')}>
          <CommandItem value={t('yeni iş başlat')} onSelect={() => run(() => openNewJob())}>
            <Plus />
            {t('Yeni iş')}
          </CommandItem>
          <CommandItem
            value={t('verileri yenile')}
            onSelect={() => run(() => qc.invalidateQueries())}
          >
            <RefreshCw />
            {t('Verileri yenile')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        {navGroups.map((group) => (
          <CommandGroup key={group.title} heading={t(group.title)}>
            {group.items.map((item) =>
              item.url ? (
                <CommandItem
                  key={String(item.url)}
                  value={`${t('git')} ${t(item.title)}`}
                  onSelect={() => run(() => navigate({ to: item.url }))}
                >
                  {item.icon ? <item.icon /> : <ArrowRight />}
                  {t(item.title)}
                </CommandItem>
              ) : null
            )}
          </CommandGroup>
        ))}
        {!!projects.data?.length && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('Projeler')}>
              {projects.data.map((p) => (
                <CommandItem
                  key={p.name}
                  value={`${t('proje')} ${p.name}`}
                  onSelect={() => run(() => navigate({ to: '/projeler', search: { p: p.name } }))}
                >
                  <FolderGit2 />
                  {p.name}
                  <CommandShortcut className='tracking-normal'>{t('kartı aç')}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        {!!status.data?.links.length && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('Paneller')}>
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
        <CommandGroup heading={t('Tema')}>
          <CommandItem value={t('tema açık')} onSelect={() => run(() => setTheme('light'))}>
            <Sun /> {t('Açık')}
          </CommandItem>
          <CommandItem value={t('tema koyu')} onSelect={() => run(() => setTheme('dark'))}>
            <Moon /> {t('Koyu')}
          </CommandItem>
          <CommandItem value={t('tema sistem')} onSelect={() => run(() => setTheme('system'))}>
            <Laptop /> {t('Sistem')}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t('Oturum')}>
          <CommandItem value={t('çıkış yap')} onSelect={() => run(signOut)}>
            <LogOut /> {t('Çıkış yap')}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
