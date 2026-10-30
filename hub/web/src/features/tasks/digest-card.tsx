import { useState } from 'react'
import { AlertTriangle, Check, CircleHelp, ExternalLink, FileText, Play, Rocket } from 'lucide-react'
import type { ReleaseInfo, Task } from '@/lib/types'
import { cn } from '@/lib/utils'
import { span } from '@/lib/format'
import { useRelease } from '@/hooks/queries'
import { Card } from '@/components/ui/card'
import { TimeAgo } from '@/components/ekip/time-ago'
import { formatPercent, useT } from '@/lib/i18n'
import { etaText } from './parts'

const DAY = 24 * 3600_000
const STALL_MS = 15 * 60_000

// The same split as `ekip status`: what waits for the user, what is stuck, what runs, what finished.
export function digestOf(list: Task[], now: number) {
  const recent = (t: Task) => now - Date.parse(t.endedAt ?? t.updatedAt ?? t.receivedAt) < DAY
  const stalled = (t: Task) =>
    !(t.workers ?? []).some((w) => w.status === 'running') &&
    t.steps.some((s) => s.status === 'running' && s.progressAt && now - Date.parse(s.progressAt) > STALL_MS)
  const open = list.filter((t) => t.status === 'running')
  const waiting = open.filter((t) => t.hold?.kind === 'waiting-user')
  const stuck = [
    ...open.filter((t) => t.hold?.kind !== 'waiting-user' && (t.hold?.kind === 'blocked' || t.paused || stalled(t))),
    ...list.filter((t) => t.status === 'failed' && recent(t)),
  ]
  const running = open.filter((t) => !waiting.includes(t) && !stuck.includes(t))
  const done = list
    .filter((t) => t.status === 'done' && recent(t))
    .sort((a, b) => String(b.endedAt ?? b.updatedAt).localeCompare(String(a.endedAt ?? a.updatedAt)))
  return { waiting, stuck, running, done }
}

/** Links of a result: URLs open in a new tab, file paths are copied (they live on the Mac). */
export function ResultLinks({ links, className }: { links: string[]; className?: string }) {
  const t = useT()
  const [copied, setCopied] = useState<string | null>(null)
  if (!links.length) return null
  return (
    <ul className={cn('flex flex-wrap gap-x-3 gap-y-1 text-xs', className)}>
      {links.map((l) =>
        /^https?:\/\//.test(l) ? (
          <li key={l} className='min-w-0'>
            <a href={l} target='_blank' rel='noreferrer' className='inline-flex max-w-full items-center gap-1 text-primary underline-offset-2 hover:underline'>
              <ExternalLink className='size-3 shrink-0' aria-hidden='true' />
              <span className='truncate'>{l.replace(/^https?:\/\//, '')}</span>
            </a>
          </li>
        ) : (
          <li key={l} className='min-w-0'>
            <button
              type='button'
              title={t('Yolu kopyala')}
              onClick={() => {
                void navigator.clipboard?.writeText(l).then(() => setCopied(l))
              }}
              className='inline-flex max-w-full items-center gap-1 font-mono text-muted-foreground hover:text-foreground'
            >
              <FileText className='size-3 shrink-0' aria-hidden='true' />
              <span className='truncate'>{l}</span>
              {copied === l && <span className='font-sans text-status-done'>{t('kopyalandı')}</span>}
            </button>
          </li>
        )
      )}
    </ul>
  )
}

// "ekip v1.6.2 · main abc1234 test ediliyor (20 dk) · hub güncel"
function ReleaseLine({ r, now }: { r: ReleaseInfo; now: number }) {
  const t = useT()
  const sha = r.main?.sha.slice(0, 7)
  const tested = !!(r.ci?.sha && r.main?.sha.startsWith(r.ci.sha))
  const hub = r.hub.commit?.slice(0, 7)
  const parts: { text: string; cls?: string }[] = []
  if (r.version) parts.push({ text: `ekip ${r.version}` })
  if (sha) {
    if (r.testing)
      parts.push({ text: t('main {sha} test ediliyor ({duration})', { sha, duration: r.main?.at ? span(now - Date.parse(r.main.at)) : '?' }), cls: 'text-status-cancelled' })
    else if (tested && r.ci?.status === 'pass') parts.push({ text: t('main {sha} testi geçti', { sha }), cls: 'text-status-done' })
    else if (tested && r.ci?.status === 'fail') parts.push({ text: t('main {sha} testi başarısız ({step})', { sha, step: r.ci.step ?? '?' }), cls: 'text-status-failed' })
    else parts.push({ text: `main ${sha}` })
  }
  if (!hub) parts.push({ text: t('hub sürümü bilinmiyor'), cls: 'text-muted-foreground' })
  else if (r.main?.sha.startsWith(hub)) parts.push({ text: t('hub güncel'), cls: 'text-status-done' })
  else parts.push({ text: t('hub eski ({sha})', { sha: r.hub.version ?? hub }), cls: 'text-status-cancelled' })
  return (
    <p className='flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground'>
      <Rocket className='size-3.5' aria-hidden='true' />
      {parts.map((p, i) => (
        <span key={i} className={cn('tabular-nums', p.cls)}>
          {i > 0 && <span className='me-2 text-muted-foreground'>·</span>}
          {p.text}
        </span>
      ))}
    </p>
  )
}

function Section({
  title,
  count,
  icon: Icon,
  tone,
  empty,
  children,
}: {
  title: string
  count: number
  icon: typeof Check
  tone: 'red' | 'orange' | 'running' | 'done'
  empty: string
  children: React.ReactNode
}) {
  const color = { red: 'text-status-failed', orange: 'text-status-cancelled', running: 'text-status-running', done: 'text-status-done' }[tone]
  const loud = count > 0 && (tone === 'red' || tone === 'orange')
  return (
    <section
      className={cn(
        'min-w-0 rounded-lg border p-3',
        loud && tone === 'red' && 'border-status-failed/50 bg-status-failed/8',
        loud && tone === 'orange' && 'border-status-cancelled/50 bg-status-cancelled/8'
      )}
    >
      <h3 className={cn('mb-2 flex items-center gap-1.5 text-sm font-semibold', count > 0 ? color : 'text-muted-foreground')}>
        <Icon className='size-4' aria-hidden='true' />
        {title} <span className='tabular-nums'>({count})</span>
      </h3>
      {count === 0 ? <p className='text-xs text-muted-foreground'>{empty}</p> : <ul className='grid gap-2.5'>{children}</ul>}
    </section>
  )
}

/** The digest on top of the task list, so nobody has to ask what is going on. */
export function StatusDigest({ tasks, now }: { tasks: Task[]; now: number }) {
  const t = useT()
  const release = useRelease()
  const d = digestOf(tasks, now)
  const lastNote = (x: Task) => x.notes[x.notes.length - 1]?.text
  return (
    <Card className='gap-3 p-4'>
      <div className='grid gap-3 md:grid-cols-2'>
        <Section title={t('Senden beklenenler')} count={d.waiting.length} icon={CircleHelp} tone='red' empty={t('Şu an senden beklenen bir karar yok.')}>
          {d.waiting.map((x) => (
            <li key={x.id} className='min-w-0'>
              <p className='text-sm font-medium break-words'>{x.ask?.question ?? x.hold?.reason}</p>
              {(x.ask?.options.length ?? 0) > 0 && (
                <ol className='mt-1 flex flex-wrap gap-1.5'>
                  {x.ask!.options.map((o, i) => (
                    <li key={i} className='rounded-md border bg-background px-2 py-0.5 text-xs'>
                      <span className='me-1 font-semibold text-muted-foreground'>{String.fromCharCode(65 + i)})</span>
                      {o}
                    </li>
                  ))}
                </ol>
              )}
              <p className='mt-1 text-xs text-muted-foreground'>
                {x.title} · <TimeAgo iso={x.ask?.at ?? x.hold?.at} /> · {t("Cevabını lead'e yaz")}
              </p>
            </li>
          ))}
        </Section>
        <Section title={t('Takılan')} count={d.stuck.length} icon={AlertTriangle} tone='orange' empty={t('Takılan iş yok.')}>
          {d.stuck.map((x) => {
            const why =
              x.status === 'failed'
                ? lastNote(x) ?? t('başarısız bitti')
                : x.hold?.kind === 'blocked'
                  ? x.hold.reason
                  : x.paused
                    ? t('Çalışan süreç yok; adım sürüyor görünüyor')
                    : t('15 dakikadır ilerleme yok')
            const actions = x.notes.filter((n) => /havuzuna geçildi|moved to|yeniden başlat|restart|öldü|died|durduruldu|stopped|sessiz|silent|kotası|quota/i.test(n.text) && n.text !== why).slice(-2)
            return (
              <li key={x.id} className='min-w-0'>
                <p className='text-sm font-medium break-words'>
                  {x.title}
                  {x.status === 'failed' && <span className='ms-2 text-xs text-status-failed'>{t('başarısız')}</span>}
                </p>
                <p className='text-xs break-words'>{why}</p>
                {actions.map((a, i) => (
                  <p key={i} className='text-xs break-words text-muted-foreground'>
                    {t('ekip ne yaptı')}: {a.text}
                  </p>
                ))}
              </li>
            )
          })}
        </Section>
        <Section title={t('Şimdi çalışan')} count={d.running.length} icon={Play} tone='running' empty={t('Şu an çalışan iş yok.')}>
          {d.running.map((x) => {
            const step = x.steps.find((s) => s.status === 'running')
            const workers = x.workers.filter((w) => w.status === 'running')
            const eta = etaText(x, now)
            return (
              <li key={x.id} className='min-w-0'>
                <p className='flex items-baseline justify-between gap-2 text-sm'>
                  <span className='min-w-0 truncate font-medium'>{x.title}</span>
                  <span className='shrink-0 tabular-nums'>{formatPercent(Math.round(step?.pct ?? x.pct))}</span>
                </p>
                <p className='text-xs text-muted-foreground'>
                  {step ? step.title : t('adım yok')}
                  {workers.length > 0 && ` · ${workers.map((w) => w.via ?? '?').join(', ')}`}
                  {step?.rate && ` · ${step.rate}`}
                  {eta && ` · ${eta}`}
                </p>
                {step?.detail && <p className='truncate text-xs text-muted-foreground'>{step.detail}</p>}
              </li>
            )
          })}
        </Section>
        <Section title={t('Son 24 saatte biten')} count={d.done.length} icon={Check} tone='done' empty={t('Son 24 saatte biten iş yok.')}>
          {d.done.slice(0, 6).map((x) => (
            <li key={x.id} className='min-w-0'>
              <p className='flex items-baseline justify-between gap-2 text-sm'>
                <span className='min-w-0 truncate font-medium'>{x.title}</span>
                <TimeAgo iso={x.endedAt ?? x.updatedAt} className='shrink-0 text-xs text-muted-foreground' />
              </p>
              {(x.result?.text || lastNote(x)) && (
                <p className='text-xs break-words'>
                  <span className='font-medium'>{t('Sonuç')}:</span> {x.result?.text || lastNote(x)}
                </p>
              )}
              <ResultLinks links={x.result?.links ?? []} className='mt-0.5' />
            </li>
          ))}
        </Section>
      </div>
      {release.data && <ReleaseLine r={release.data} now={now} />}
    </Card>
  )
}
