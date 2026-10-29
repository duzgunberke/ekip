import { useMemo } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import { Brain, FolderGit2, GitBranch, Search as SearchIcon, X } from 'lucide-react'
import { stripMd } from '@/lib/format'
import { projectRepos } from '@/lib/repo'
import type { Project } from '@/lib/types'
import { useProjects } from '@/hooks/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { AppHeader, PageTitle } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { EmptyState, QueryError } from '@/components/ekip/states'
import { TimeAgo } from '@/components/ekip/time-ago'
import { ProjectSheet } from './project-sheet'
import { formatNumber, useLanguage, useT } from '@/lib/i18n'

const route = getRouteApi('/_authenticated/projects')

export function Projects() {
  const t = useT()
  const language = useLanguage()
  const projects = useProjects()
  const { p: openName, q = '' } = route.useSearch()
  const navigate = route.useNavigate()

  const filtered = useMemo(() => {
    const locale = language === 'tr' ? 'tr-TR' : 'en-US'
    const needle = q.trim().toLocaleLowerCase(locale)
    const list = projects.data ?? []
    if (!needle) return list
    return list.filter((p) =>
      [p.name, p.summary, p.repo ?? '', ...(p.repos ?? [])].some((x) => x.toLocaleLowerCase(locale).includes(needle))
    )
  }, [language, projects.data, q])

  const open = openName ? projects.data?.find((p) => p.name === openName) : undefined
  const setSearch = (next: { p?: string; q?: string }) =>
    navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })

  return (
    <>
      <AppHeader />
      <Main>
        <PageTitle
          title={t('Projeler')}
          description={t("Mac'teki ekip'in hub'a kaydettiği projeler ve proje kartları.")}
        />

        <div className='mb-4 flex items-center gap-2'>
          <div className='relative w-full sm:max-w-xs'>
            <SearchIcon className='absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' aria-hidden='true' />
            <Input
              type='search'
              value={q}
              onChange={(e) => setSearch({ q: e.target.value || undefined })}
              placeholder={t('Proje, özet veya repo ara…')}
              aria-label={t('Projelerde ara')}
              className='h-9 ps-8'
            />
          </div>
          {q && (
            <Button variant='ghost' size='sm' onClick={() => setSearch({ q: undefined })}>
              {t('Temizle')} <X />
            </Button>
          )}
          {projects.data && (
            <span className='ms-auto text-sm text-muted-foreground tabular-nums'>
              {formatNumber(filtered.length)} / {formatNumber(projects.data.length)}
            </span>
          )}
        </div>

        {projects.isLoading ? (
          <Grid>
            {Array.from({ length: 6 }, (_, i) => (
              <Card key={i} className='gap-3'>
                <CardHeader>
                  <Skeleton className='h-5 w-32' />
                  <Skeleton className='mt-2 h-3.5 w-full' />
                  <Skeleton className='h-3.5 w-4/5' />
                </CardHeader>
                <CardFooter className='gap-2'>
                  <Skeleton className='h-5 w-24' />
                  <Skeleton className='h-5 w-16' />
                </CardFooter>
              </Card>
            ))}
          </Grid>
        ) : projects.isError ? (
          <QueryError error={projects.error} onRetry={() => projects.refetch()} />
        ) : !projects.data?.length ? (
          <EmptyState
            icon={FolderGit2}
            title={t('Kayıtlı proje yok')}
            description={t("Mac'teki ekip projeleri PUT /api/projects ile buraya gönderir.")}
          />
        ) : filtered.length === 0 ? (
          <EmptyState icon={SearchIcon} title={t('Eşleşen proje yok')} description={t('"{query}" için sonuç bulunamadı.', { query: q })} />
        ) : (
          <Grid>
            {filtered.map((p) => (
              <ProjectCard key={p.name} project={p} onOpen={() => setSearch({ p: p.name })} />
            ))}
          </Grid>
        )}
      </Main>
      <ProjectSheet
        project={open}
        open={!!open}
        onOpenChange={(o) => !o && setSearch({ p: undefined })}
      />
    </>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>{children}</div>
}

function ProjectCard({ project: p, onOpen }: { project: Project; onOpen: () => void }) {
  const t = useT()
  const repos = projectRepos(p)
  const shown = repos.slice(0, 3)
  const memory = !!p.tdai?.teamId
  return (
    <Card
      role='button'
      tabIndex={0}
      aria-label={t('{name} projesini aç', { name: p.name })}
      onClick={(event) => {
        if (event.target instanceof Element) {
          const interactiveTarget = event.target.closest(
            'a, button, input, select, textarea, [role="button"]'
          )
          if (interactiveTarget && interactiveTarget !== event.currentTarget) return
        }
        onOpen()
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className='group relative cursor-pointer gap-3 outline-none transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-primary/40 active:translate-y-0 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'
    >
      <CardHeader>
        <div className='flex items-start justify-between gap-2'>
          <CardTitle className='text-base'>
            {p.name}
          </CardTitle>
          {memory && (
            <Badge variant='outline' className='border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300'>
              <Brain /> {t('hafıza bağlı')}
            </Badge>
          )}
        </div>
        <CardDescription className='line-clamp-3 min-h-[3lh]'>
          {stripMd(p.summary) || t('Özet yok.')}
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-wrap gap-1.5'>
        {repos.length === 0 ? (
          <Badge variant='secondary' className='font-normal text-muted-foreground'>
            {t('repo yok')}
          </Badge>
        ) : (
          <>
            {shown.map((r) => (
              <Badge key={r.label} variant='secondary' className='max-w-full font-mono text-[11px] font-normal'>
                <GitBranch />
                <span className='truncate'>{r.label}</span>
              </Badge>
            ))}
            {repos.length > shown.length && (
              <Badge variant='secondary' className='font-normal'>
                {t('+{count} repo', { count: repos.length - shown.length })}
              </Badge>
            )}
          </>
        )}
      </CardContent>
      <CardFooter className='mt-auto text-xs text-muted-foreground'>
        {t('güncellendi')}&nbsp;<TimeAgo iso={p.updatedAt} />
      </CardFooter>
    </Card>
  )
}
