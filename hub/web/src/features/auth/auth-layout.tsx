import { Logo } from '@/assets/logo'
import { useT } from '@/lib/i18n'

export function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = useT()
  return (
    <div className='relative grid min-h-svh place-items-center overflow-hidden bg-background px-4 py-10'>
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_18%_8%,color-mix(in_srgb,var(--primary)_13%,transparent),transparent_38%)]'
      />
      <div className='relative flex w-full max-w-[26rem] flex-col gap-8'>
        <div className='flex items-center gap-3'>
          <span className='flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary'>
            <Logo className='size-9' />
          </span>
          <div className='leading-tight'>
            <p className='text-2xl font-semibold tracking-tight'>ekip</p>
            <p className='mt-1 text-sm text-muted-foreground'>{t('Bir lider. Koca bir ekip.')}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
