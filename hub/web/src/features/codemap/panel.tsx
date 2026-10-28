import {
  ArrowLeft,
  Code2,
  ExternalLink,
  FileCode2,
  Folder,
  GitBranch,
  GitPullRequest,
  Layers,
  Loader2,
  Lock,
  TriangleAlert,
} from 'lucide-react'
import { errorMessage } from '@/lib/api'
import type { RepoMeta } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useSymbols } from '@/hooks/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TimeAgo } from '@/components/ekip/time-ago'
import { type GraphState, type Selection, findDir, treeOf } from './flow'
import { type DirNode, compact, langColor, topLangs } from './tree'

type Props = {
  project: string
  repos: RepoMeta[]
  graphs: Record<string, GraphState>
  selection: Selection
  onSelect: (sel: Selection) => void
}

export function DetailPanel({ project, repos, graphs, selection, onSelect }: Props) {
  if (selection.kind === 'project') return <ProjectOverview repos={repos} onSelect={onSelect} />
  const repo = repos.find((r) => r.url === selection.repo)
  if (!repo) return <ProjectOverview repos={repos} onSelect={onSelect} />
  const g = graphs[repo.url]
  if (selection.kind === 'repo') return <RepoDetail repo={repo} graph={g} onSelect={onSelect} />
  if (!g?.data) return <GraphPending graph={g} repo={repo} onSelect={onSelect} />
  const tree = treeOf(g.data)
  if (selection.kind === 'dir') {
    const dir = findDir(tree, selection.path)
    if (!dir) return <RepoDetail repo={repo} graph={g} onSelect={onSelect} />
    return <DirDetail repo={repo} dir={dir} branch={g.data.branch} onSelect={onSelect} />
  }
  const file = g.data.files.find((f) => f.p === selection.path)
  return (
    <FileDetail
      project={project}
      repo={repo}
      path={selection.path}
      lang={file?.l ?? null}
      symbolCount={file?.s ?? null}
      size={file?.b ?? null}
      branch={g.data.branch}
      indexed={!!g.data.codeGraph?.ok}
      onSelect={onSelect}
    />
  )
}

function Section({ title, children, className }: { title: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('border-t px-4 py-4', className)}>
      <h3 className='mb-2.5 text-xs font-medium tracking-wide text-muted-foreground uppercase'>{title}</h3>
      {children}
    </section>
  )
}

function Head({
  back,
  icon: Icon,
  title,
  sub,
  actions,
}: {
  back?: { label: string; onClick: () => void }
  icon: React.ElementType
  title: React.ReactNode
  sub?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className='px-4 pt-4 pb-3'>
      {back && (
        <Button variant='ghost' size='sm' className='-ms-2 mb-1 h-7 max-w-full text-muted-foreground' onClick={back.onClick}>
          <ArrowLeft /> <span className='truncate'>{back.label}</span>
        </Button>
      )}
      <div className='flex items-start gap-2.5'>
        <div className='mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/50'>
          <Icon className='size-4' aria-hidden='true' />
        </div>
        <div className='min-w-0 flex-1'>
          <h2 className='font-semibold break-words'>{title}</h2>
          {sub && <div className='mt-0.5 text-xs text-muted-foreground'>{sub}</div>}
        </div>
        {actions}
      </div>
    </div>
  )
}

function LangBar({ items }: { items: { name: string; share: number; color?: string | null }[] }) {
  if (!items.length) return <p className='text-sm text-muted-foreground'>Dil bilgisi yok.</p>
  return (
    <div>
      <div className='flex h-2 overflow-hidden rounded-full bg-muted' role='img' aria-label={items.map((l) => `${l.name} %${Math.round(l.share * 100)}`).join(', ')}>
        {items.map((l) => (
          <span key={l.name} style={{ width: `${Math.max(l.share * 100, 1)}%`, backgroundColor: langColor(l.name, l.color) }} />
        ))}
      </div>
      <ul className='mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs'>
        {items.map((l) => (
          <li key={l.name} className='flex items-center gap-1.5'>
            <span className='size-2 rounded-full' style={{ backgroundColor: langColor(l.name, l.color) }} aria-hidden='true' />
            {l.name} <span className='text-muted-foreground tabular-nums'>%{(l.share * 100).toFixed(l.share < 0.1 ? 1 : 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ProjectOverview({ repos, onSelect }: { repos: RepoMeta[]; onSelect: (s: Selection) => void }) {
  return (
    <div>
      <Head icon={Layers} title='Depolar' sub='Bir depoya tıklayın: dalları ve klasör yapısı açılır.' />
      <ul className='border-t'>
        {repos.map((r) => (
          <li key={r.url} className='border-b last:border-b-0'>
            <button
              type='button'
              onClick={() => onSelect({ kind: 'repo', repo: r.url })}
              className='flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none'
            >
              <span className='size-2.5 shrink-0 rounded-full' style={{ backgroundColor: langColor(r.language, r.languages?.[0]?.color) }} aria-hidden='true' />
              <div className='min-w-0 flex-1'>
                <p className='truncate text-sm font-medium'>{r.name}</p>
                <p className='truncate text-xs text-muted-foreground'>
                  {r.error ?? [r.language, r.owner].filter(Boolean).join(' · ')}
                </p>
              </div>
              {!r.error && (
                <span className='flex shrink-0 items-center gap-2.5 text-xs text-muted-foreground tabular-nums'>
                  <span className='flex items-center gap-1' title='Dal'>
                    <GitBranch className='size-3' aria-hidden='true' />
                    {r.branchCount ?? 0}
                  </span>
                  <span className='flex items-center gap-1' title='Açık PR'>
                    <GitPullRequest className='size-3' aria-hidden='true' />
                    {r.openPrs ?? 0}
                  </span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RepoDetail({ repo: r, graph: g, onSelect }: { repo: RepoMeta; graph?: GraphState; onSelect: (s: Selection) => void }) {
  const tree = g?.data ? treeOf(g.data) : null
  return (
    <div>
      <Head
        back={{ label: 'Tüm depolar', onClick: () => onSelect({ kind: 'project' }) }}
        icon={Code2}
        title={r.fullName ?? r.name}
        sub={r.description ?? r.url}
        actions={
          (r.htmlUrl ?? r.url) && (
            <Button variant='outline' size='icon' className='size-8 shrink-0' asChild>
              <a href={r.htmlUrl ?? r.url} target='_blank' rel='noopener noreferrer' aria-label='Depoyu GitHub’da aç'>
                <ExternalLink />
              </a>
            </Button>
          )
        }
      />
      <div className='flex flex-wrap gap-1.5 px-4 pb-4'>
        {r.private && (
          <Badge variant='secondary'>
            <Lock /> özel
          </Badge>
        )}
        {r.archived && <Badge variant='secondary'>arşiv</Badge>}
        {r.fork && <Badge variant='secondary'>fork</Badge>}
        {r.defaultBranch && (
          <Badge variant='outline' className='font-mono'>
            <GitBranch /> {r.defaultBranch}
          </Badge>
        )}
        {r.codeGraph && (
          <Badge variant='outline' className='border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300'>
            <Layers /> kod grafiği
          </Badge>
        )}
        {r.pushedAt && (
          <Badge variant='outline' className='font-normal text-muted-foreground'>
            push <TimeAgo iso={r.pushedAt} />
          </Badge>
        )}
      </div>
      {r.error && (
        <p role='alert' className='mx-4 mb-4 flex gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm'>
          <TriangleAlert className='mt-0.5 size-4 shrink-0 text-warning' aria-hidden='true' /> {r.error}
        </p>
      )}
      {!r.error && (
        <>
          <Section title='Diller'>
            <LangBar items={r.languages ?? []} />
          </Section>
          <Section
            title={
              <span className='flex items-center justify-between'>
                <span>Dallar ({r.branchCount ?? 0})</span>
                <span className='flex items-center gap-1 normal-case'>
                  <GitPullRequest className='size-3' aria-hidden='true' /> {r.openPrs ?? 0} açık PR
                </span>
              </span>
            }
          >
            <ul className='-mx-1 flex flex-col gap-0.5'>
              {(r.branches ?? []).map((b) => (
                <li key={b.name} className='min-w-0 rounded-md px-1 py-1.5 hover:bg-muted/40'>
                  <div className='flex items-center gap-2'>
                    <GitBranch className='size-3.5 shrink-0 text-muted-foreground' aria-hidden='true' />
                    <a
                      href={`${r.htmlUrl}/tree/${b.name.split('/').map(encodeURIComponent).join('/')}`}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='min-w-0 flex-1 truncate font-mono text-xs hover:underline'
                    >
                      {b.name}
                    </a>
                    {b.name === r.defaultBranch && (
                      <Badge variant='secondary' className='px-1.5 py-0 text-[10px]'>
                        varsayılan
                      </Badge>
                    )}
                    <span className='shrink-0 text-[11px] text-muted-foreground'>
                      <TimeAgo iso={b.date} />
                    </span>
                  </div>
                  <p className='ms-5.5 truncate text-[11px] text-muted-foreground' title={b.message ?? undefined}>
                    {b.author && <span className='text-foreground/80'>{b.author}</span>}
                    {b.message && ` · ${b.message}`}
                  </p>
                </li>
              ))}
            </ul>
            {(r.branchCount ?? 0) > (r.branches?.length ?? 0) && (
              <p className='mt-2 text-xs text-muted-foreground'>İlk {r.branches?.length} dal gösteriliyor.</p>
            )}
          </Section>
        </>
      )}
      <Section title='Yapı'>
        {!g || g.loading ? (
          <div className='grid gap-2'>
            <Skeleton className='h-4 w-2/3' />
            <Skeleton className='h-4 w-1/2' />
            <Skeleton className='h-4 w-3/5' />
          </div>
        ) : g.error ? (
          <p className='text-sm text-destructive'>{errorMessage(g.error)}</p>
        ) : tree && g.data ? (
          <>
            <GraphSource graph={g} />
            <DirList dir={tree} repo={r.url} onSelect={onSelect} />
          </>
        ) : null}
      </Section>
    </div>
  )
}

function GraphSource({ graph }: { graph: GraphState }) {
  const d = graph.data!
  return (
    <div className='mb-3 grid gap-1 text-xs text-muted-foreground'>
      <p>
        {d.files.length} dosya
        {d.indexed > 0 && ` · ${d.indexed} dosya kod grafiğinde`}
        {d.branch && (
          <>
            {' · '}
            <span className='font-mono'>{d.branch}</span>
          </>
        )}
      </p>
      <p>
        Kaynak:{' '}
        {d.source === 'codegraph+github' ? 'kod grafiği + GitHub ağacı' : d.source === 'codegraph' ? 'kod grafiği' : 'GitHub ağacı'}
        {d.truncated && ' (kısaltılmış)'}
      </p>
      {d.notes.map((n) => (
        <p key={n} className='text-warning'>
          {n}
        </p>
      ))}
    </div>
  )
}

function DirList({ dir, repo, onSelect }: { dir: DirNode; repo: string; onSelect: (s: Selection) => void }) {
  return (
    <ul className='-mx-1 flex flex-col gap-0.5'>
      {dir.dirs.map(compact).map(({ dir: d, label }) => (
        <li key={d.path} className='min-w-0'>
          <button
            type='button'
            onClick={() => onSelect({ kind: 'dir', repo, path: d.path })}
            className='flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-start text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none'
          >
            <Folder className='size-3.5 shrink-0 text-muted-foreground' aria-hidden='true' />
            <span className='min-w-0 flex-1 truncate'>{label}</span>
            <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{d.count}</span>
          </button>
        </li>
      ))}
      {dir.files.map((f) => (
        <li key={f.p} className='min-w-0'>
          <button
            type='button'
            onClick={() => onSelect({ kind: 'file', repo, path: f.p })}
            className='flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-start text-sm hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none'
          >
            <span className='flex size-3.5 shrink-0 items-center justify-center' aria-hidden='true'>
              <span className='size-2 rounded-full' style={{ backgroundColor: langColor(f.l) }} />
            </span>
            <span className='min-w-0 flex-1 truncate font-mono text-xs'>{f.p.split('/').pop()}</span>
            {f.s != null && <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{f.s} sembol</span>}
          </button>
        </li>
      ))}
      {!dir.dirs.length && !dir.files.length && <li className='px-1 text-sm text-muted-foreground'>Boş.</li>}
    </ul>
  )
}

function parentSel(repo: string, path: string): Selection {
  const i = path.lastIndexOf('/')
  return i < 0 ? { kind: 'repo', repo } : { kind: 'dir', repo, path: path.slice(0, i) }
}

function DirDetail({ repo, dir, branch, onSelect }: { repo: RepoMeta; dir: DirNode; branch: string | null; onSelect: (s: Selection) => void }) {
  const parent = dir.path.includes('/') ? dir.path.slice(0, dir.path.lastIndexOf('/')) : null
  return (
    <div>
      <Head
        back={{ label: parent ?? repo.name, onClick: () => onSelect(parentSel(repo.url, dir.path)) }}
        icon={Folder}
        title={dir.name}
        sub={
          <>
            <span className='font-mono'>{repo.name}/{dir.path}</span>
          </>
        }
        actions={
          repo.htmlUrl && branch && (
            <Button variant='outline' size='icon' className='size-8 shrink-0' asChild>
              <a href={`${repo.htmlUrl}/tree/${encodeURIComponent(branch)}/${dir.path}`} target='_blank' rel='noopener noreferrer' aria-label='Klasörü GitHub’da aç'>
                <ExternalLink />
              </a>
            </Button>
          )
        }
      />
      <div className='grid grid-cols-3 gap-2 px-4 pb-4 text-center'>
        <Stat label='dosya' value={dir.count} />
        <Stat label='klasör' value={dir.dirs.length} />
        <Stat label='sembol' value={dir.symbols || '—'} />
      </div>
      <Section title='Diller'>
        <LangBar items={topLangs(dir.langs, 6)} />
      </Section>
      <Section title='İçerik'>
        <DirList dir={dir} repo={repo.url} onSelect={onSelect} />
      </Section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='rounded-lg border bg-muted/30 px-2 py-2'>
      <p className='text-lg font-semibold tabular-nums'>{value}</p>
      <p className='text-[11px] text-muted-foreground'>{label}</p>
    </div>
  )
}

function FileDetail(props: {
  project: string
  repo: RepoMeta
  path: string
  lang: string | null
  symbolCount: number | null
  size: number | null
  branch: string | null
  indexed: boolean
  onSelect: (s: Selection) => void
}) {
  const { project, repo, path, lang, symbolCount, size, branch, indexed, onSelect } = props
  const sym = useSymbols(project, indexed ? repo.url : undefined, indexed ? path : undefined)
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  return (
    <div>
      <Head
        back={{ label: dir ?? repo.name, onClick: () => onSelect(parentSel(repo.url, path)) }}
        icon={FileCode2}
        title={path.split('/').pop()}
        sub={
          <span className='flex flex-wrap items-center gap-x-2'>
            {lang && (
              <span className='flex items-center gap-1'>
                <span className='size-2 rounded-full' style={{ backgroundColor: langColor(lang) }} aria-hidden='true' />
                {lang}
              </span>
            )}
            {symbolCount != null && <span>{symbolCount} sembol</span>}
            {size != null && <span>{size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`}</span>}
          </span>
        }
        actions={
          repo.htmlUrl && branch && (
            <Button variant='outline' size='icon' className='size-8 shrink-0' asChild>
              <a href={`${repo.htmlUrl}/blob/${encodeURIComponent(branch)}/${path}`} target='_blank' rel='noopener noreferrer' aria-label='Dosyayı GitHub’da aç'>
                <ExternalLink />
              </a>
            </Button>
          )
        }
      />
      <Section title='Öne çıkan semboller'>
        {!indexed ? (
          <p className='text-sm text-muted-foreground'>Bu dosya kod grafiğinde yok; sembol bilgisi alınamıyor.</p>
        ) : sym.isLoading ? (
          <p className='flex items-center gap-2 text-sm text-muted-foreground'>
            <Loader2 className='size-4 animate-spin' aria-hidden='true' /> Kod grafiği sorgulanıyor…
          </p>
        ) : sym.isError ? (
          <p className='text-sm text-destructive'>{errorMessage(sym.error)}</p>
        ) : !sym.data?.symbols.length ? (
          <p className='text-sm text-muted-foreground'>Sembol bulunamadı.</p>
        ) : (
          <ul className='flex flex-col gap-1'>
            {sym.data.symbols.map((s) => (
              <li key={`${s.name}:${s.line}`} className='rounded-md border bg-muted/20 px-2.5 py-1.5'>
                <div className='flex items-center gap-2'>
                  <Badge variant='outline' className='px-1.5 py-0 text-[10px] font-normal'>
                    {s.kind}
                  </Badge>
                  <span className='min-w-0 flex-1 truncate font-mono text-xs font-medium'>{s.name}</span>
                  {repo.htmlUrl && branch ? (
                    <a
                      href={`${repo.htmlUrl}/blob/${encodeURIComponent(branch)}/${path}#L${s.line}`}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='shrink-0 text-[11px] text-muted-foreground tabular-nums hover:text-foreground hover:underline'
                    >
                      :{s.line}
                    </a>
                  ) : (
                    <span className='shrink-0 text-[11px] text-muted-foreground tabular-nums'>:{s.line}</span>
                  )}
                </div>
                {s.sig && <p className='mt-0.5 truncate font-mono text-[11px] text-muted-foreground' title={s.sig}>{s.sig}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function GraphPending({ graph, repo, onSelect }: { graph?: GraphState; repo: RepoMeta; onSelect: (s: Selection) => void }) {
  return (
    <div>
      <Head back={{ label: repo.name, onClick: () => onSelect({ kind: 'repo', repo: repo.url }) }} icon={Folder} title='Yapı yükleniyor' />
      <div className='px-4 pb-4 text-sm text-muted-foreground'>
        {graph?.error ? errorMessage(graph.error) : 'Klasör yapısı alınıyor…'}
      </div>
    </div>
  )
}
