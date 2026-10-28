import { Logo } from '@/assets/logo'

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className='relative grid min-h-svh place-items-center overflow-hidden bg-background px-4'>
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 max-w-2xl rounded-full bg-[radial-gradient(closest-side,--theme(--color-blue-500/0.18),transparent)] blur-2xl'
      />
      <div className='relative flex w-full max-w-sm flex-col gap-6 py-10'>
        <div className='flex items-center justify-center gap-2.5'>
          <Logo className='size-9 rounded-lg' />
          <div className='leading-tight'>
            <p className='text-lg font-semibold'>ekip hub</p>
            <p className='text-xs text-muted-foreground'>iş koşucu ve kontrol paneli</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
