import { useCallback, useMemo, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { GitBranch, GitPullRequest, Layers, Network, RefreshCw } from 'lucide-react'
import type { RepoGraph } from '@/lib/types'
import { useProjectRepos, useProjects, repoGraphQuery } from '@/hooks/queries'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { AppHeader, PageTitle } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { EmptyState, QueryError } from '@/components/ekip/states'
import { CodeFlow, type GraphState, type Selection, dirId, repoId } from './flow'
import { DetailPanel } from './panel'

const route = getRouteApi('/_authenticated/kod-haritasi')

export function CodeMap() {
  const projects = useProjects()
  const { proje } = route.useSearch()
  const navigate = route.useNavigate()
  const list = useMemo(() => projects.data ?? [], [projects.data])
  // Default: the project with the most repos (the interesting map).
  const fallback = useMemo(
    () => [...list].sort((a, b) => (b.repos?.length ?? 0) + (b.repo ? 1 : 0) - ((a.repos?.length ?? 0) + (a.repo ? 1 : 0)))[0]?.name,
    [list]
  )
  const name = proje && list.some((p) => p.name === proje) ? proje : fallback

  return (
    <>
      <AppHeader />
      <Main fluid className='flex flex-col'>
        <PageTitle
          title='Kod haritası'
          description='Projenin depoları, dalları ve klasör yapısı. Depoya tıklayın; klasörleri açın, dosyaları inceleyin.'
          actions={
            <Select value={name ?? ''} onValueChange={(v) => navigate({ search: { proje: v } })} disabled={!list.length}>
              <SelectTrigger className='w-56' aria-label='Proje'>
                <SelectValue placeholder={projects.isLoading ? 'Yükleniyor…' : 'Proje seçin'} />
              </SelectTrigger>
              <SelectContent>
                {list.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {projects.isError ? (
          <QueryError error={projects.error} onRetry={() => projects.refetch()} />
        ) : projects.isLoading ? (
          <Skeleton className='h-[60svh] rounded-xl' />
        ) : !name ? (
          <EmptyState icon={Network} title='Kayıtlı proje yok' description='Önce Mac tarafı projeleri hub’a göndermeli.' />
        ) : (
          <ProjectMap key={name} name={name} />
        )}
      </Main>
    </>
  )
}

function ProjectMap({ name }: { name: string }) {
  const qc = useQueryClient()
  const repos = useProjectRepos(name)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selection, setSelection] = useState<Selection>({ kind: 'project' })
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null)

  const list = useMemo(() => repos.data?.repos ?? [], [repos.data])
  const openRepos = list.filter((r) => expanded.has(repoId(r.url)) || (selection.kind !== 'project' && selection.repo === r.url))
  const results = useQueries({ queries: openRepos.map((r) => repoGraphQuery(name, r.url)) })
  const graphs: Record<string, GraphState> = {}
  openRepos.forEach((r, i) => {
    const q = results[i]
    graphs[r.url] = { data: q.data as RepoGraph | undefined, loading: q.isLoading, error: q.error ?? undefined }
  })

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
        // collapsing also collapses everything underneath
        const prefix = key.startsWith('r:') ? `d:${key.slice(2)}:` : `${key}/`
        for (const k of next) if (k.startsWith(prefix)) next.delete(k)
      } else {
        next.add(key)
        setFocus((f) => ({ id: key, seq: (f?.seq ?? 0) + 1 }))
      }
      return next
    })
  }, [])

  // Selecting a repo/dir also opens it on the map (and every ancestor directory).
  const select = useCallback((sel: Selection) => {
    setSelection(sel)
    if (sel.kind === 'project') return
    setExpanded((prev) => {
      const next = new Set(prev)
      const rid = repoId(sel.repo)
      next.add(rid)
      let target = rid
      const segs =
        sel.kind === 'repo' ? [] : sel.kind === 'file' ? sel.path.split('/').slice(0, -1) : sel.path.split('/')
      for (let i = 1; i <= segs.length; i++) {
        target = dirId(sel.repo, segs.slice(0, i).join('/'))
        next.add(target)
      }
      if (!prev.has(target) || sel.kind !== 'file') setFocus((f) => ({ id: target, seq: (f?.seq ?? 0) + 1 }))
      return next
    })
  }, [])

  const totals = useMemo(() => {
    const ok = list.filter((r) => !r.error)
    return {
      repos: list.length,
      branches: ok.reduce((n, r) => n + (r.branchCount ?? 0), 0),
      prs: ok.reduce((n, r) => n + (r.openPrs ?? 0), 0),
      graphs: list.filter((r) => r.codeGraph).length,
    }
  }, [list])

  if (repos.isError) return <QueryError error={repos.error} onRetry={() => repos.refetch()} />
  if (!repos.isLoading && list.length === 0)
    return <EmptyState icon={Network} title='Bu projenin deposu yok' description='Proje kaydında repo ya da repos alanı boş.' />

  return (
    <div className='flex flex-1 flex-col gap-4'>
      <div className='flex flex-wrap items-center gap-x-5 gap-y-2 text-sm'>
        {repos.isLoading ? (
          <Skeleton className='h-5 w-80' />
        ) : (
          <>
            <Metric icon={Layers} value={totals.repos} label='depo' />
            <Metric icon={GitBranch} value={totals.branches} label='dal' />
            <Metric icon={GitPullRequest} value={totals.prs} label='açık PR' />
            <Metric icon={Network} value={`${totals.graphs}/${totals.repos}`} label='kod grafiği' />
          </>
        )}
        <Button
          variant='ghost'
          size='sm'
          className='ms-auto text-muted-foreground'
          disabled={repos.isFetching}
          onClick={() => qc.invalidateQueries({ queryKey: ['codemap', name] })}
        >
          <RefreshCw className={repos.isFetching ? 'animate-spin' : undefined} /> Yenile
        </Button>
      </div>
      <div className='grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]'>
        <Card className='relative h-[60svh] min-h-[420px] overflow-hidden p-0 lg:h-[calc(100svh-15rem)] lg:min-h-[560px]'>
          {repos.isLoading ? (
            <div className='flex h-full items-center justify-center text-sm text-muted-foreground'>
              GitHub’dan depo bilgileri alınıyor…
            </div>
          ) : (
            <CodeFlow
              projectName={name}
              repos={list}
              graphs={graphs}
              expanded={expanded}
              selection={selection}
              focus={focus}
              onNodeClick={select}
              onToggle={toggle}
            />
          )}
        </Card>
        <Card className='gap-0 overflow-hidden p-0 lg:h-[calc(100svh-15rem)] lg:min-h-[560px]'>
          <div className='h-full overflow-y-auto'>
            {repos.isLoading ? (
              <div className='grid gap-3 p-4'>
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className='h-9' />
                ))}
              </div>
            ) : (
              <DetailPanel project={name} repos={list} graphs={graphs} selection={selection} onSelect={select} />
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Metric({ icon: Icon, value, label }: { icon: React.ElementType; value: React.ReactNode; label: string }) {
  return (
    <span className='flex items-center gap-1.5'>
      <Icon className='size-4 text-muted-foreground' aria-hidden='true' />
      <span className='font-semibold tabular-nums'>{value}</span>
      <span className='text-muted-foreground'>{label}</span>
    </span>
  )
}
