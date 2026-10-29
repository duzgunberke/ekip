import { useEffect } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'
import { LanguageSwitcher, useT } from '@/lib/i18n'
import { Header } from './header'

/** Shared top bar: command palette trigger, live-refresh indicator, theme switch. */
export function AppHeader() {
  const fetching = useIsFetching()
  const t = useT()
  return (
    <Header fixed>
      <Search placeholder={t('Ara veya komut çalıştır…')} />
      <div className='ms-auto flex items-center gap-1 sm:gap-2'>
        <span
          className='hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex'
          aria-live='polite'
        >
          <RefreshCw className={cn('size-3.5', fetching > 0 && 'animate-spin')} aria-hidden='true' />
          {fetching > 0 ? t('Güncelleniyor') : t('Canlı')}
        </span>
        <LanguageSwitcher />
        <ThemeSwitch />
      </div>
    </Header>
  )
}

export function PageTitle({
  title,
  description,
  actions,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  const t = useT()
  useEffect(() => {
    if (typeof title === 'string') document.title = `${title} · ekip`
  }, [title, t])
  return (
    <div className='mb-7 flex flex-wrap items-end justify-between gap-x-4 gap-y-3'>
      <div className='min-w-0'>
        <h1 className='text-[1.7rem] leading-tight font-semibold tracking-[-0.04em] sm:text-3xl'>{title}</h1>
        {description && <p className='mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-[0.9375rem]'>{description}</p>}
      </div>
      {actions && <div className='flex flex-wrap items-center gap-2'>{actions}</div>}
    </div>
  )
}
