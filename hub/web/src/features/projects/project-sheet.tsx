import { Link } from '@tanstack/react-router'
import { Brain, ExternalLink, FileText, GitBranch, Network, Send } from 'lucide-react'
import { useState } from 'react'
import { stripMd } from '@/lib/format'
import { projectRepos } from '@/lib/repo'
import type { Project } from '@/lib/types'
import { useNewJob } from '@/context/new-job-provider'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Md } from '@/components/ekip/markdown'
import { EmptyState } from '@/components/ekip/states'
import { TimeAgo } from '@/components/ekip/time-ago'
import { useT } from '@/lib/i18n'

type Props = { project?: Project; open: boolean; onOpenChange: (o: boolean) => void }

export function ProjectSheet({ project, open, onOpenChange }: Props) {
  const t = useT()
  // Keep showing the last project while the sheet animates closed.
  const [shown, setShown] = useState(project)
  if (project && project !== shown) setShown(project)
  const p = project ?? shown
  const { openNewJob } = useNewJob()
  const repos = p ? projectRepos(p) : []
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='flex w-full flex-col gap-0 p-0 sm:max-w-2xl'>
        {p && (
          <>
            <SheetHeader className='border-b px-6 py-5 text-start'>
              <SheetTitle className='flex flex-wrap items-center gap-2 pe-8 text-xl'>
                {p.name}
                {p.tdai?.teamId && (
                  <Badge variant='outline' className='border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300'>
                    <Brain /> {t('hafıza bağlı')}
                  </Badge>
                )}
              </SheetTitle>
              <SheetDescription>{stripMd(p.summary) || t('Özet yok.')}</SheetDescription>
              <p className='text-xs text-muted-foreground'>
                {t('güncellendi')} <TimeAgo iso={p.updatedAt} />
              </p>
            </SheetHeader>

            <div className='flex-1 overflow-y-auto px-6 py-5'>
              {repos.length > 0 && (
                <section aria-labelledby='repos-h' className='mb-5'>
                  <h3 id='repos-h' className='mb-2 text-sm font-medium'>
                    {t('Repolar')} <span className='text-muted-foreground'>({repos.length})</span>
                  </h3>
                  <ul className='grid gap-1.5'>
                    {repos.map((r) => (
                      <li key={r.label} className='flex items-center gap-2 text-sm'>
                        <GitBranch className='size-3.5 shrink-0 text-muted-foreground' aria-hidden='true' />
                        {r.url ? (
                          <a
                            href={r.url}
                            target='_blank'
                            rel='noopener noreferrer'
                            className='min-w-0 truncate font-mono text-xs hover:underline'
                          >
                            {r.label}
                            <ExternalLink className='ms-1 inline size-3 text-muted-foreground' aria-hidden='true' />
                          </a>
                        ) : (
                          <span className='truncate font-mono text-xs'>{r.label}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {p.tdai?.teamId && (
                <section aria-labelledby='tdai-h' className='mb-5'>
                  <h3 id='tdai-h' className='mb-2 text-sm font-medium'>{t('Hafıza kimlikleri')}</h3>
                  <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs'>
                    {(['teamId', 'agentId', 'wikiId', 'codeGraphId'] as const).map((k) =>
                      p.tdai?.[k] ? (
                        <div key={k} className='contents'>
                          <dt className='text-muted-foreground'>{k}</dt>
                          <dd className='truncate font-mono'>{p.tdai[k]}</dd>
                        </div>
                      ) : null
                    )}
                  </dl>
                </section>
              )}
              <Separator className='mb-5' />
              {p.card?.trim() ? (
                <Md>{p.card}</Md>
              ) : (
                <EmptyState icon={FileText} title={t('Proje kartı yok')} description={t('Bu proje için kart gönderilmemiş.')} />
              )}
            </div>

            <SheetFooter className='border-t px-6 py-4 sm:flex-row sm:justify-end'>
              <Button variant='outline' asChild>
                <Link to='/kod-haritasi' search={{ proje: p.name }}>
                  <Network /> {t('Kod haritası')}
                </Link>
              </Button>
              <Button
                onClick={() => {
                  onOpenChange(false)
                  openNewJob(p.name)
                }}
              >
                <Send /> {t('Bu projeye iş ver')}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
