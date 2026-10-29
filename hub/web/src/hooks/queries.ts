import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type {
  Job,
  LimitsSnapshot,
  Project,
  ProjectRepos,
  RepoGraph,
  Run,
  Status,
  SymbolInfo,
  Task,
  Via,
} from '@/lib/types'

export const qk = {
  session: ['session'] as const,
  status: ['status'] as const,
  limits: ['limits'] as const,
  projects: ['projects'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['jobs', id] as const,
  runs: ['runs'] as const,
  tasks: ['tasks'] as const,
}

export const useStatus = () =>
  useQuery({
    queryKey: qk.status,
    queryFn: ({ signal }) => api<Status>('/api/status', { signal }),
    refetchInterval: 10_000,
  })

export const useLimits = () =>
  useQuery({
    queryKey: qk.limits,
    queryFn: ({ signal }) => api<LimitsSnapshot | null>('/api/limits', { signal }),
    refetchInterval: 30_000,
  })

export const useProjects = () =>
  useQuery({
    queryKey: qk.projects,
    queryFn: ({ signal }) => api<Project[]>('/api/projects', { signal }),
    refetchInterval: 60_000,
  })

export const useJobs = () =>
  useQuery({
    queryKey: qk.jobs,
    queryFn: ({ signal }) => api<Job[]>('/api/jobs?limit=1000', { signal }),
    refetchInterval: (q) =>
      q.state.data?.some((j) => j.status === 'running' || j.status === 'queued') ? 3_000 : 10_000,
  })

export const useJob = (id: string) =>
  useQuery({
    queryKey: qk.job(id),
    queryFn: ({ signal }) => api<Job>(`/api/jobs/${encodeURIComponent(id)}?tail=60000`, { signal }),
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === 'running' || s === 'queued' ? 3_000 : false
    },
  })

export const useRuns = () =>
  useQuery({
    queryKey: qk.runs,
    queryFn: ({ signal }) => api<Run[]>('/api/runs?limit=500', { signal }),
    refetchInterval: 30_000,
  })

export type NewJob = { project: string; task: string; via: Via; push: boolean }

export function useCreateJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: NewJob) => api<Job>('/api/jobs', { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.jobs })
      qc.invalidateQueries({ queryKey: qk.status })
    },
  })
}

export function useCancelJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true; status: string }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: qk.jobs })
      qc.invalidateQueries({ queryKey: qk.job(id) })
      qc.invalidateQueries({ queryKey: qk.status })
    },
  })
}

const enc = encodeURIComponent

export const useProjectRepos = (project: string | undefined) =>
  useQuery({
    queryKey: ['codemap', project, 'repos'],
    queryFn: ({ signal }) => api<ProjectRepos>(`/api/projects/${enc(project!)}/repos`, { signal }),
    enabled: !!project,
    staleTime: 5 * 60_000,
  })

export const repoGraphQuery = (project: string, repo: string) => ({
  queryKey: ['codemap', project, 'graph', repo],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<RepoGraph>(`/api/projects/${enc(project)}/graph?repo=${enc(repo)}`, { signal }),
  staleTime: 10 * 60_000,
  retry: 1,
})

export const useSymbols = (project: string, repo: string | undefined, file: string | undefined) =>
  useQuery({
    queryKey: ['codemap', project, 'symbols', repo, file],
    queryFn: ({ signal }) =>
      api<{ available: boolean; symbols: SymbolInfo[] }>(
        `/api/projects/${enc(project)}/symbols?repo=${enc(repo!)}&file=${enc(file!)}`,
        { signal }
      ),
    enabled: !!repo && !!file,
    staleTime: 10 * 60_000,
  })

export const useTasks = () =>
  useQuery({
    queryKey: qk.tasks,
    queryFn: ({ signal }) => api<Task[]>('/api/tasks?limit=200', { signal }),
    refetchInterval: (q) => (q.state.data?.some((t) => t.status === 'running') ? 2_500 : 10_000),
    refetchIntervalInBackground: false,
  })
