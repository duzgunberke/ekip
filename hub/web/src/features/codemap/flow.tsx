import { memo, useEffect, useMemo, useRef } from 'react'
import dagre from '@dagrejs/dagre'
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Layers,
  Loader2,
  MoreHorizontal,
  Network,
  TriangleAlert,
} from 'lucide-react'
import type { RepoGraph, RepoMeta } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-provider'
import { type DirNode, buildTree, compact, findDir, langColor, topLangs } from './tree'

export type Selection =
  | { kind: 'project' }
  | { kind: 'repo'; repo: string }
  | { kind: 'dir'; repo: string; path: string }
  | { kind: 'file'; repo: string; path: string }

export type GraphState = { data?: RepoGraph; loading: boolean; error?: unknown }

type ProjectData = { label: string; repos: number }
type RepoData = { label: string; repo: RepoMeta; expanded: boolean; loading: boolean; failed: boolean; selected: boolean }
type DirData = { dir: DirNode; label: string; repo: string; expanded: boolean; selected: boolean }
type MoreData = { repo: string; path: string; hidden: number }

const SIZES = { project: [200, 64], repo: [250, 92], dir: [210, 54], more: [150, 40] } as const
const MAX_CHILDREN = 12

const treeCache = new WeakMap<RepoGraph, DirNode>()
export function treeOf(g: RepoGraph) {
  let t = treeCache.get(g)
  if (!t) treeCache.set(g, (t = buildTree(g.files)))
  return t
}

export const repoId = (url: string) => `r:${url}`
export const dirId = (url: string, path: string) => `d:${url}:${path}`

function layout(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', ranksep: 56, nodesep: 12, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  return nodes.map((n) => {
    const p = g.node(n.id)
    return { ...n, position: { x: p.x - (n.width ?? 0) / 2, y: p.y - (n.height ?? 0) / 2 } }
  })
}

type Props = {
  projectName: string
  repos: RepoMeta[]
  graphs: Record<string, GraphState>
  expanded: Set<string>
  selection: Selection
  focus: { id: string; seq: number } | null
  onNodeClick: (sel: Selection) => void
  onToggle: (key: string) => void
}

export function CodeFlow(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  )
}

function FlowInner({ projectName, repos, graphs, expanded, selection, focus, onNodeClick, onToggle }: Props) {
  const { resolvedTheme } = useTheme()
  const rf = useReactFlow()

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []
    const add = (n: Node, from?: string) => {
      nodes.push(n)
      if (from) edges.push({ id: `${from}->${n.id}`, source: from, target: n.id, type: 'smoothstep' })
    }
    const sizeOf = (t: keyof typeof SIZES) => ({ width: SIZES[t][0], height: SIZES[t][1] })
    add({ id: 'p', type: 'project', position: { x: 0, y: 0 }, data: { label: projectName, repos: repos.length }, ...sizeOf('project') })

    const addDirs = (repo: string, parent: DirNode, from: string) => {
      const kids = parent.dirs.slice(0, MAX_CHILDREN)
      for (const kid of kids) {
        const { dir: d, label } = compact(kid)
        const id = dirId(repo, d.path)
        const open = expanded.has(id) && d.dirs.length > 0
        const selected = (selection.kind === 'dir' || selection.kind === 'file') && selection.repo === repo &&
          (selection.kind === 'dir' ? selection.path === d.path : selection.path.startsWith(`${d.path}/`) && !d.dirs.some((x) => selection.path.startsWith(`${x.path}/`)))
        add({ id, type: 'dir', position: { x: 0, y: 0 }, data: { dir: d, label, repo, expanded: open, selected } satisfies DirData, ...sizeOf('dir') }, from)
        if (open) addDirs(repo, d, id)
      }
      if (parent.dirs.length > kids.length) {
        add({ id: `m:${repo}:${parent.path}`, type: 'more', position: { x: 0, y: 0 }, data: { repo, path: parent.path, hidden: parent.dirs.length - kids.length } satisfies MoreData, ...sizeOf('more') }, from)
      }
    }

    const nameCount = new Map<string, number>()
    for (const r of repos) nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1)
    for (const r of repos) {
      const id = repoId(r.url)
      const g = graphs[r.url]
      const open = expanded.has(id)
      add({
        id,
        type: 'repo',
        position: { x: 0, y: 0 },
        data: {
          label: (nameCount.get(r.name) ?? 0) > 1 && r.owner ? `${r.owner}/${r.name}` : r.name,
          repo: r,
          expanded: open,
          loading: open && !!g?.loading,
          failed: open && !!g?.error,
          selected: selection.kind !== 'project' && selection.repo === r.url && selection.kind === 'repo',
        } satisfies RepoData,
        ...sizeOf('repo'),
      }, 'p')
      if (open && g?.data) addDirs(r.url, treeOf(g.data), id)
    }
    return { nodes: layout(nodes, edges), edges }
  }, [projectName, repos, graphs, expanded, selection])

  // Fit the whole map on first render / project change; afterwards zoom to what was just opened.
  const fitted = useRef<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      if (fitted.current !== projectName) {
        fitted.current = projectName
        rf.fitView({ padding: 0.08, duration: 300, minZoom: 0.55, maxZoom: 0.9 })
      } else if (focus) {
        const ids = [focus.id, ...edges.filter((e) => e.source === focus.id).map((e) => e.target)]
        rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.25, duration: 350, minZoom: 0.45, maxZoom: 0.9 })
      }
    }, 30)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, projectName, focus])

  const nodeTypes = useMemo(
    () => ({
      project: ProjectNode,
      repo: (p: NodeProps<Node<RepoData>>) => <RepoNodeView {...p} onToggle={onToggle} />,
      dir: (p: NodeProps<Node<DirData>>) => <DirNodeView {...p} onToggle={onToggle} />,
      more: MoreNode,
    }),
    [onToggle]
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={resolvedTheme}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      onlyRenderVisibleElements
      onNodeClick={(_e, n) => {
        if (n.type === 'project') onNodeClick({ kind: 'project' })
        else if (n.type === 'repo') onNodeClick({ kind: 'repo', repo: (n.data as RepoData).repo.url })
        else if (n.type === 'dir') onNodeClick({ kind: 'dir', repo: (n.data as DirData).repo, path: (n.data as DirData).dir.path })
        else if (n.type === 'more') onNodeClick({ kind: 'dir', repo: (n.data as MoreData).repo, path: (n.data as MoreData).path })
      }}
      className='ekip-flow'
      aria-label='Kod haritası'
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} position='bottom-left' />
      <MiniMap pannable zoomable className='max-md:hidden!' nodeStrokeWidth={2} nodeBorderRadius={6} />
    </ReactFlow>
  )
}

const hidden = 'opacity-0! pointer-events-none! size-1! min-w-0! min-h-0! border-0!'

const ProjectNode = memo(function ProjectNode({ data }: NodeProps<Node<ProjectData>>) {
  return (
    <div className='flex h-full w-full items-center gap-3 rounded-xl border-2 border-primary/50 bg-primary px-4 text-primary-foreground shadow-md'>
      <Network className='size-5 shrink-0' aria-hidden='true' />
      <div className='min-w-0'>
        <p className='truncate font-semibold'>{data.label}</p>
        <p className='text-xs opacity-75'>{data.repos} depo</p>
      </div>
      <Handle type='source' position={Position.Right} className={hidden} isConnectable={false} />
    </div>
  )
})

function Toggle({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type='button'
      aria-label={label}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className='nodrag nopan flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground'
    >
      <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
    </button>
  )
}

function RepoNodeView({ data, id, onToggle }: NodeProps<Node<RepoData>> & { onToggle: (k: string) => void }) {
  const r = data.repo
  const color = langColor(r.language, r.languages?.[0]?.color)
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col justify-between rounded-xl border bg-card px-3 py-2.5 text-card-foreground shadow-sm transition-colors',
        'hover:border-foreground/30',
        data.selected && 'border-ring ring-2 ring-ring/40'
      )}
    >
      <Handle type='target' position={Position.Left} className={hidden} isConnectable={false} />
      <div className='flex items-center gap-2'>
        <span className='size-2.5 shrink-0 rounded-full' style={{ backgroundColor: color }} aria-hidden='true' />
        <p className='min-w-0 flex-1 truncate text-sm font-semibold' title={r.fullName ?? r.url}>
          {data.label}
        </p>
        {data.loading ? (
          <Loader2 className='size-4 animate-spin text-muted-foreground' aria-label='yükleniyor' />
        ) : data.failed ? (
          <TriangleAlert className='size-4 text-destructive' aria-label='yapı alınamadı' />
        ) : null}
        <Toggle open={data.expanded} onClick={() => onToggle(id)} label={data.expanded ? 'Klasörleri gizle' : 'Klasörleri göster'} />
      </div>
      {r.error ? (
        <p className='truncate text-xs text-muted-foreground'>{r.error}</p>
      ) : (
        <div className='flex items-center gap-3 text-xs text-muted-foreground'>
          <span className='flex min-w-0 items-center gap-1'>
            <GitBranch className='size-3 shrink-0' aria-hidden='true' />
            <span className='truncate font-mono'>{r.defaultBranch ?? 'Yok'}</span>
            {r.branchCount != null && r.branchCount > 1 && <span>+{r.branchCount - 1}</span>}
          </span>
          <span className='flex items-center gap-1' title='Açık PR'>
            <GitPullRequest className='size-3' aria-hidden='true' />
            {r.openPrs ?? 0}
          </span>
          {r.codeGraph && (
            <span className='ms-auto flex items-center gap-1 text-violet-600 dark:text-violet-300' title='Kod grafiği bağlı'>
              <Layers className='size-3' aria-hidden='true' /> graf
            </span>
          )}
        </div>
      )}
      <Handle type='source' position={Position.Right} className={hidden} isConnectable={false} />
    </div>
  )
}

function DirNodeView({ data, id, onToggle }: NodeProps<Node<DirData>> & { onToggle: (k: string) => void }) {
  const d = data.dir
  const lang = topLangs(d.langs, 1)[0]
  const Icon = data.expanded ? FolderOpen : Folder
  return (
    <div
      className={cn(
        'flex h-full w-full items-center gap-2 rounded-lg border bg-card/95 px-2.5 text-card-foreground transition-colors hover:border-foreground/30',
        data.selected && 'border-ring ring-2 ring-ring/40'
      )}
    >
      <Handle type='target' position={Position.Left} className={hidden} isConnectable={false} />
      <Icon className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
      <div className='min-w-0 flex-1'>
        <p className='truncate text-left text-[13px] font-medium' title={d.path} dir='rtl'>
          <bdi>{data.label}</bdi>
        </p>
        <p className='flex items-center gap-1.5 truncate text-[11px] text-muted-foreground'>
          {lang && (
            <span className='size-1.5 shrink-0 rounded-full' style={{ backgroundColor: langColor(lang.name) }} aria-hidden='true' />
          )}
          {d.count} dosya{lang ? ` · ${lang.name}` : ''}
        </p>
      </div>
      {d.dirs.length > 0 && (
        <Toggle open={data.expanded} onClick={() => onToggle(id)} label={data.expanded ? 'Alt klasörleri gizle' : 'Alt klasörleri göster'} />
      )}
      <Handle type='source' position={Position.Right} className={hidden} isConnectable={false} />
    </div>
  )
}

const MoreNode = memo(function MoreNode({ data }: NodeProps<Node<MoreData>>) {
  return (
    <div className='flex h-full w-full items-center justify-center gap-1.5 rounded-lg border border-dashed bg-muted/40 text-xs text-muted-foreground hover:text-foreground'>
      <Handle type='target' position={Position.Left} className={hidden} isConnectable={false} />
      <MoreHorizontal className='size-3.5' aria-hidden='true' />+{data.hidden} klasör
    </div>
  )
})

export { findDir }
