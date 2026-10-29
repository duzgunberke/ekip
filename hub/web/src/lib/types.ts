export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type Via = 'auto' | 'free' | 'copilot'

export type SavingsSnapshot = { days: number; rows: { day: string; claude: number; other: number; pools: Record<string, number>; unmeasured: number }[]; totals: { claude: number; other: number; outsidePercent: number; unmeasured: number }; claudeWithoutOtherWouldBe: number; note: string }

export type Project = {
  name: string
  repo: string | null
  repos?: string[]
  summary: string
  card: string
  tdai?: {
    teamId?: string
    agentId?: string
    wikiId?: string
    codeGraphId?: string
    codeGraphs?: CodeGraphRef[]
  }
  updatedAt?: string
}

export type Job = {
  id: string
  project: string
  task: string
  via: Via
  model: string | null
  push: boolean
  status: JobStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  branch: string | null
  baseBranch?: string
  baseSha?: string
  headSha?: string
  report?: string | null
  reportPreview?: string | null
  diffstat: string | null
  error: string | null
  pool?: 'tdai' | 'free'
  ranVia?: string
  pushed?: boolean
  changed?: boolean
  worker?: number
  log?: string
}

export type Run = {
  id: string
  via: string | null
  model?: string | null
  project: string | null
  task: string
  status: string | null
  report: string
  host?: string | null
  startedAt: string | null
  finishedAt: string | null
  receivedAt: string
}

export type ProviderStatus = 'healthy' | 'rate_limited' | 'no_models' | 'invalid' | 'unknown' | (string & {})

export type Provider = {
  platform: string
  name: string
  status: ProviderStatus
  keys: number
  resumeAt: string | null
}

export type LimitsWorker = {
  name: string
  quota: string
  status: 'ready' | 'limited' | 'login' | 'untested' | 'off'
  limit: { message: string; at: string; resetAt: string } | null
  runs: number
  successRate: number | null
  cooling: boolean
  /** workers on this pool right now and how many it takes at once (older snapshots lack them) */
  running?: number
  capacity?: number
}

export type LimitsProvider = Provider & {
  status: ProviderStatus | 'no_models'
  models: number
  cooling: number
  ok24: number
  fail24: number
  lastError: string | null
  monthRequests: number
  monthTokens: number
}

export type LimitsProfile = {
  next: string[]
  models: number
  cooling: number
}

export type LimitsSnapshot = {
  at: string
  host: string
  receivedAt: string
  workers?: LimitsWorker[]
  free?: LimitsProvider[] | { error: string }
  route?: {
    order: string[]
    worker: string | null
    skipped: string[]
    profiles: Record<string, LimitsProfile>
  }
}

export type PoolProvider = Provider & Partial<LimitsProvider>

export type Client = {
  client: string
  host: string | null
  agents: unknown[]
  lastSeen: string
  ip?: string
}

export type WorkerSlot = { slot: number; jobId: string | null; since: string | null }

export type Status = {
  time: string
  freellmapi: {
    configured: boolean
    up: boolean
    ready: boolean
    slow?: boolean
    reason: string | null
    providers: Provider[]
    providerCount: number
    counts: Record<string, number> | null
    authError: string | null
  }
  tdai: { configured: boolean; up: boolean; version: string | null; memory: boolean }
  github: { token: boolean; copilot: boolean }
  queue: Record<JobStatus, number>
  workers: WorkerSlot[]
  links: { name: string; url: string }[]
  clients: Client[]
}

export type CodeGraphRef = { repo: string; id: string; branch?: string | null; private?: boolean | null; status?: string | null }

export type Branch = { name: string; sha: string | null; date: string | null; author: string | null; message: string | null }

export type RepoMeta = {
  url: string
  key: string
  host: string | null
  owner: string | null
  name: string
  github: boolean
  codeGraph: { id: string; branch: string | null; status: string | null } | null
  error?: string
  fullName?: string
  htmlUrl?: string
  description?: string | null
  private?: boolean
  archived?: boolean
  fork?: boolean
  pushedAt?: string | null
  defaultBranch?: string | null
  language?: string | null
  languages?: { name: string; color: string | null; share: number }[]
  openPrs?: number
  branchCount?: number
  branches?: Branch[]
}

export type ProjectRepos = { project: string; fetchedAt: string; repos: RepoMeta[] }

export type GraphFile = { p: string; l: string | null; s: number | null; b?: number | null }

export type RepoGraph = {
  source: 'codegraph' | 'github' | 'codegraph+github'
  codeGraph: { id: string; branch: string | null; ok: boolean; error: string | null } | null
  repo: string
  branch: string | null
  indexed: number
  truncated: boolean
  notes: string[]
  files: GraphFile[]
}

export type SymbolInfo = { name: string; kind: string; line: number; sig: string | null }

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type Task = {
  id: string
  title: string
  project: string | null
  status: TaskStatus
  createdAt: string | null
  updatedAt: string | null
  endedAt: string | null
  steps: { title: string; status: StepStatus; pct: number | null; startedAt: string | null; endedAt: string | null; progressAt?: string | null; detail?: string | null }[]
  workers: { runId: string | null; via: string | null; model?: string | null; label: string | null; status: string | null; startedAt: string | null; endedAt: string | null }[]
  notes: { at: string | null; text: string }[]
  pct: number
  eta: string | null
  host: string | null
  receivedAt: string
}
