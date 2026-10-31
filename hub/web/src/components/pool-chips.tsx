import { ProviderLogo } from '@/components/provider-logo'
import { useLanguage, useT } from '@/lib/i18n'
import type { PoolView, PoolViewEntry } from '@/lib/types'

// The pools as the terminal shows them (plugin/lib/workers/pool-view.js): only the connected ones,
// running first, then ready, then limited; a state instead of "0/2", the free pool's providers
// behind it, and how many are hidden.
const DOT: Record<string, string> = {
  running: 'bg-teal-500', ready: 'bg-emerald-500', limited: 'bg-amber-500', resting: 'bg-amber-500', error: 'bg-red-500',
}
const TEXT: Record<string, string> = {
  running: 'text-teal-700 dark:text-teal-300', ready: 'text-muted-foreground', limited: 'text-amber-700 dark:text-amber-400', resting: 'text-amber-700 dark:text-amber-400', error: 'text-red-700 dark:text-red-400',
}

function resetLabel(iso: string, lang: 'tr' | 'en') {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const loc = lang === 'tr' ? 'tr-TR' : 'en-GB'
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return new Date().toDateString() === d.toDateString() ? time : `${d.toLocaleDateString(loc, { weekday: 'short' }).replace(/\.$/, '')} ${time}`
}

export function poolStateText(p: PoolViewEntry, t: (k: string, v?: Record<string, string | number>) => string, lang: 'tr' | 'en') {
  if (p.state === 'running') return p.full ? t('{n}/{cap} dolu', { n: p.running, cap: p.capacity }) : String(p.running)
  if (p.state === 'limited') return p.resetAt ? `${t('limitte')} · ${resetLabel(p.resetAt, lang)}` : t('limitte')
  return ''
}

function Chip({ id, name, state, words }: { id: string; name: string; state: string; words?: string }) {
  return (
    <span className='inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs'>
      <ProviderLogo id={id} className='size-3.5' />
      <span className={`size-1.5 rounded-full ${DOT[state] ?? 'bg-muted-foreground'}`} aria-hidden />
      <span className='font-medium'>{name}</span>
      {words ? <span className={TEXT[state] ?? 'text-muted-foreground'}>{words}</span> : null}
    </span>
  )
}

export function PoolChips({ view, serving }: { view: PoolView; serving?: string | null }) {
  const t = useT()
  const lang = useLanguage()
  if (!view.pools.length) return <p className='text-sm text-muted-foreground'>{t('bağlı havuz yok → ekip setup')}</p>
  return (
    <div className='flex flex-wrap items-center gap-2'>
      {view.pools.map((p) => (
        <span key={p.name} className='inline-flex flex-wrap items-center gap-1.5'>
          <Chip id={p.name} name={p.name} state={p.state} words={poolStateText(p, t, lang)} />
          {p.name === 'free' && (p.providers ?? []).map((x) => (
            <Chip key={x.id} id={x.id} name={x.name} state={x.state} words={x.state === 'resting' ? `${t('dinleniyor')}${x.minutes ? ` ~${t('{n} dk', { n: x.minutes })}` : ''}` : x.state === 'error' ? t('hata') : ''} />
          ))}
          {p.name === 'free' && p.state === 'running' && serving ? <span className='text-xs text-muted-foreground'>{serving}</span> : null}
        </span>
      ))}
      {view.hidden ? <span className='text-xs text-muted-foreground'>{t('+{n} kapalı', { n: view.hidden })}</span> : null}
    </div>
  )
}
