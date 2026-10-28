import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Job, Project, Run, Status, Via } from '@/lib/types'

export const qk = {
  session: ['session'] as const,
  status: ['status'] as const,
  projects: ['projects'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['jobs', id] as const,
  runs: ['runs'] as const,
}

export const useStatus = () =>
  useQuery({
    queryKey: qk.status,
    queryFn: ({ signal }) => api<Status>('/api/status', { signal }),
    refetchInterval: 10_000,
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
