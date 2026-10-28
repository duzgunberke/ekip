// Repo strings accepted by the hub: owner/name, github.com/owner/name,
// https://github.com/owner/name(.git), git@github.com:owner/name.git — plus any other https URL.

export type RepoRef = { label: string; url: string | null; github: { owner: string; name: string } | null }

export function parseRepo(raw: string): RepoRef {
  const s = raw.trim()
  const gh =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i) ??
    s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i) ??
    s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  if (gh) {
    const [, owner, name] = gh
    return { label: `${owner}/${name}`, url: `https://github.com/${owner}/${name}`, github: { owner, name } }
  }
  if (/^https:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      return { label: `${u.host}${u.pathname.replace(/\.git$/, '')}`, url: s.replace(/\.git$/, ''), github: null }
    } catch {
      /* fall through */
    }
  }
  return { label: s, url: null, github: null }
}

export function projectRepos(p: { repo: string | null; repos?: string[] }): RepoRef[] {
  const list = [...(p.repo ? [p.repo] : []), ...(p.repos ?? [])]
  const seen = new Set<string>()
  return list.map(parseRepo).filter((r) => (seen.has(r.label) ? false : (seen.add(r.label), true)))
}

export function compareUrl(repo: string | null | undefined, base: string | undefined, branch: string | null) {
  if (!repo || !base || !branch) return null
  const r = parseRepo(repo)
  if (!r.github) return null
  return `https://github.com/${r.github.owner}/${r.github.name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`
}
