export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type Via = 'auto' | 'free' | 'copilot'

export type Project = {
  name: string
  repo: string | null
  repos?: string[]
  summary: string
  card: string
  tdai?: { teamId?: string; agentId?: string; wikiId?: string; codeGraphId?: string }
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
  project: string | null
  task: string
  status: string | null
  report: string
  host?: string | null
  startedAt: string | null
  finishedAt: string | null
  receivedAt: string
}

export type ProviderStatus = 'healthy' | 'rate_limited' | 'invalid' | 'unknown' | (string & {})

export type Provider = {
  platform: string
  name: string
  status: ProviderStatus
  keys: number
  resumeAt: string | null
}

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
