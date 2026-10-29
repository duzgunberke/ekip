import type { LimitsSnapshot, PoolProvider, Provider } from '@/lib/types'

export function poolProviders(limits: LimitsSnapshot | null | undefined, fallback: Provider[] | undefined): PoolProvider[] {
  if (!Array.isArray(limits?.free)) return fallback ?? []
  const previous = new Map((fallback ?? []).map((provider) => [provider.platform, provider]))
  return limits.free.map((provider) => ({ ...previous.get(provider.platform), ...provider }))
}
