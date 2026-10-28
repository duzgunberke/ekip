import type { GraphFile } from '@/lib/types'

export type DirNode = {
  name: string
  path: string // '' for the repo root
  dirs: DirNode[]
  files: GraphFile[] // direct children
  count: number // files, recursive
  symbols: number // indexed symbols, recursive
  langs: Map<string, number> // language -> file count, recursive
}

/** Flat file list -> directory tree with recursive counts; dirs sorted by size. */
export function buildTree(files: GraphFile[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [], count: 0, symbols: 0, langs: new Map() }
  const index = new Map<string, DirNode>([['', root]])
  const dirFor = (path: string): DirNode => {
    const hit = index.get(path)
    if (hit) return hit
    const i = path.lastIndexOf('/')
    const parent = dirFor(i < 0 ? '' : path.slice(0, i))
    const d: DirNode = { name: path.slice(i + 1), path, dirs: [], files: [], count: 0, symbols: 0, langs: new Map() }
    parent.dirs.push(d)
    index.set(path, d)
    return d
  }
  for (const f of files) {
    const i = f.p.lastIndexOf('/')
    const dir = dirFor(i < 0 ? '' : f.p.slice(0, i))
    dir.files.push(f)
    // walk up for recursive totals
    let path: string | null = dir.path
    while (path !== null) {
      const d = index.get(path)!
      d.count += 1
      d.symbols += f.s ?? 0
      if (f.l) d.langs.set(f.l, (d.langs.get(f.l) ?? 0) + 1)
      path = path === '' ? null : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    }
  }
  const sort = (d: DirNode) => {
    d.dirs.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    d.files.sort((a, b) => (b.s ?? -1) - (a.s ?? -1) || a.p.localeCompare(b.p))
    d.dirs.forEach(sort)
  }
  sort(root)
  return root
}

export function findDir(root: DirNode, path: string): DirNode | undefined {
  if (!path) return root
  let d: DirNode | undefined = root
  for (const seg of path.split('/')) {
    d = d?.dirs.find((x) => x.name === seg)
    if (!d) return undefined
  }
  return d
}

export function topLangs(langs: Map<string, number>, n = 3) {
  const total = [...langs.values()].reduce((a, b) => a + b, 0) || 1
  return [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count, share: count / total }))
}

/** Stable colours for code-graph language ids (GitHub-ish palette). */
const LANG_COLORS: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#f1e05a',
  python: '#3572A5',
  rust: '#dea584',
  go: '#00ADD8',
  kotlin: '#A97BFF',
  java: '#b07219',
  swift: '#F05138',
  'objective-c': '#438eff',
  c: '#555555',
  cpp: '#f34b7d',
  'c++': '#f34b7d',
  cuda: '#3A4E3A',
  csharp: '#178600',
  ruby: '#701516',
  php: '#4F5D95',
  dart: '#00B4AB',
  css: '#663399',
  scss: '#c6538c',
  html: '#e34c26',
  vue: '#41b883',
  svelte: '#ff3e00',
  shell: '#89e051',
  glsl: '#5686a5',
  wgsl: '#1a5e9a',
  metal: '#8f14e9',
  markdown: '#083fa1',
  json: '#292929',
  yaml: '#cb171e',
  sql: '#e38c00',
  tsx: '#3178c6',
}
export const langColor = (name: string | null | undefined, fallback?: string | null) =>
  (name && (LANG_COLORS[name.toLowerCase()] ?? fallback)) || fallback || '#8b949e'

/** GitHub-style compaction: a directory with exactly one subdirectory and no files is shown merged
 * with it ("src/main/kotlin"). Returns the deepest directory and the merged label. */
export function compact(d: DirNode): { dir: DirNode; label: string } {
  let dir = d
  let label = d.name
  while (dir.dirs.length === 1 && dir.files.length === 0) {
    dir = dir.dirs[0]
    label += `/${dir.name}`
  }
  return { dir, label }
}
