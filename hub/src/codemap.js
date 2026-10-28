// Code map data for the panel: GitHub metadata per project repo (GraphQL, one batched call) and
// repo structure from the TencentDB code graph (knowledge service), falling back to GitHub's git
// tree API. The GitHub token stays on the server; results are cached in memory for 10 minutes.

const TTL = 10 * 60_000;
const ERR_TTL = 60_000;
const MAX_FILES = 20_000;

const EXT_LANG = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", go: "go", kt: "kotlin", kts: "kotlin", java: "java", swift: "swift", m: "objective-c", mm: "objective-c",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cu: "cuda", cs: "csharp", rb: "ruby", php: "php", dart: "dart", lua: "lua",
  css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte", md: "markdown", mdx: "markdown", json: "json", yml: "yaml", yaml: "yaml",
  toml: "toml", sql: "sql", sh: "shell", glsl: "glsl", wgsl: "wgsl", metal: "metal", gradle: "gradle", xml: "xml", proto: "protobuf",
};

/** Normalised identity of a repo URL: { key, owner, name, url, host }; key is "github.com/owner/name" lowercased. */
export function repoRef(raw) {
  const s = String(raw ?? "").trim();
  const gh = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
    ?? s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
    ?? s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (gh) return { key: `github.com/${gh[1]}/${gh[2]}`.toLowerCase(), owner: gh[1], name: gh[2], url: `https://github.com/${gh[1]}/${gh[2]}`, host: "github.com", github: true };
  try {
    const u = new URL(s);
    const p = u.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
    return { key: `${u.host}${p}`.toLowerCase(), owner: null, name: p.split("/").pop() || u.host, url: `${u.protocol}//${u.host}${p}`, host: u.host, github: false };
  } catch {
    return { key: s.toLowerCase(), owner: null, name: s, url: null, host: null, github: false };
  }
}

export function projectRepoList(project) {
  const seen = new Set();
  const out = [];
  for (const r of [project.repo, ...(project.repos ?? [])]) {
    if (!r) continue;
    const ref = repoRef(r);
    if (seen.has(ref.key)) continue;
    seen.add(ref.key);
    out.push({ raw: r, ...ref });
  }
  return out;
}

const langOf = (path) => {
  const base = path.split("/").pop() ?? "";
  if (base === "Dockerfile") return "docker";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  return EXT_LANG[ext] ?? null;
};

export class CodeMap {
  constructor({ githubToken, knowledgeUrl, serviceId = "default" }) {
    this.token = githubToken;
    this.knowledgeUrl = knowledgeUrl;
    this.serviceId = serviceId;
    this.cache = new Map(); // key -> { exp, promise }
  }

  cached(key, fn, { fresh = false } = {}) {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (!fresh && hit && hit.exp > now) return hit.promise;
    if (this.cache.size > 500) for (const [k, v] of this.cache) if (v.exp <= now) this.cache.delete(k);
    const entry = { exp: now + TTL, promise: null };
    entry.promise = Promise.resolve().then(fn).catch((e) => { entry.exp = Date.now() + ERR_TTL; throw e; });
    this.cache.set(key, entry);
    return entry.promise;
  }

  // ---- GitHub ---------------------------------------------------------------------------------

  async ghFetch(url, init = {}) {
    if (!this.token) throw new Error("GITHUB_TOKEN is not set on the hub");
    const r = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "user-agent": "ekip-hub", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${body?.message ?? r.statusText}`);
    return body;
  }

  async gql(query) {
    const b = await this.ghFetch("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query }), headers: { "content-type": "application/json" } });
    return b; // { data, errors? } — partial data is normal when one repo is inaccessible
  }

  /** GitHub metadata for every repo of a project (one GraphQL request, cached). */
  async repos(project, { fresh = false } = {}) {
    const list = projectRepoList(project);
    const graphs = project.tdai?.codeGraphs ?? [];
    const cgFor = (ref) => graphs.find((g) => repoRef(g.repo).key === ref.key) ?? null;
    const gh = list.filter((r) => r.github);
    let meta = {};
    let ghError = null;
    if (gh.length) {
      try {
        meta = await this.cached(`repos:${gh.map((r) => r.key).sort().join(",")}`, () => this.fetchRepoMeta(gh), { fresh });
      } catch (e) { ghError = e.message; }
    }
    return {
      project: project.name,
      fetchedAt: new Date().toISOString(),
      repos: list.map((r) => {
        const cg = cgFor(r);
        const base = {
          url: r.url ?? r.raw, key: r.key, host: r.host, owner: r.owner, name: r.name, github: r.github,
          codeGraph: cg ? { id: cg.id, branch: cg.branch ?? null, status: cg.status ?? null } : null,
        };
        if (!r.github) return { ...base, error: "GitHub dışı depo; meta veri yok" };
        if (ghError) return { ...base, error: ghError };
        const m = meta[r.key];
        return m?.error ? { ...base, error: m.error } : { ...base, ...m };
      }),
    };
  }

  async fetchRepoMeta(refs) {
    const q = refs.map((r, i) => `r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { ...R }`).join("\n");
    const query = `query {\n${q}\n}
fragment R on Repository {
  nameWithOwner url description isPrivate isArchived isFork pushedAt
  defaultBranchRef { name }
  primaryLanguage { name color }
  languages(first: 8, orderBy: { field: SIZE, direction: DESC }) { totalSize edges { size node { name color } } }
  pullRequests(states: OPEN) { totalCount }
  refs(refPrefix: "refs/heads/", first: 30, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
    totalCount
    nodes { name target { ... on Commit { oid committedDate messageHeadline author { name user { login } } } } }
  }
}`;
    const res = await this.gql(query);
    if (!res?.data && res?.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors[0].message}`);
    const out = {};
    refs.forEach((r, i) => {
      const d = res.data?.[`r${i}`];
      if (!d) {
        const err = res.errors?.find((e) => e.path?.[0] === `r${i}`);
        out[r.key] = { error: err?.type === "NOT_FOUND" ? "Depo bulunamadı ya da token erişemiyor" : err?.message ?? "GitHub verisi yok" };
        return;
      }
      const branches = (d.refs?.nodes ?? []).map((n) => ({
        name: n.name,
        sha: n.target?.oid ?? null,
        date: n.target?.committedDate ?? null,
        author: n.target?.author?.user?.login ?? n.target?.author?.name ?? null,
        message: n.target?.messageHeadline ?? null,
      })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const total = d.languages?.totalSize || 0;
      out[r.key] = {
        fullName: d.nameWithOwner,
        htmlUrl: d.url,
        description: d.description,
        private: d.isPrivate,
        archived: d.isArchived,
        fork: d.isFork,
        pushedAt: d.pushedAt,
        defaultBranch: d.defaultBranchRef?.name ?? null,
        language: d.primaryLanguage?.name ?? null,
        languages: (d.languages?.edges ?? []).map((e) => ({ name: e.node.name, color: e.node.color, share: total ? e.size / total : 0 })),
        openPrs: d.pullRequests?.totalCount ?? 0,
        branchCount: d.refs?.totalCount ?? branches.length,
        branches,
      };
    });
    return out;
  }

  // ---- knowledge service (TencentDB code graph) ---------------------------------------------

  async tool(knowledgeId, toolName, params = {}) {
    if (!this.knowledgeUrl) throw new Error("KNOWLEDGE_URL is not set");
    const r = await fetch(`${this.knowledgeUrl}/v3/tools/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tdai-service-id": this.serviceId },
      body: JSON.stringify({ knowledge_id: knowledgeId, tool_name: toolName, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const b = await r.json().catch(() => null);
    if (!r.ok || !b || b.code !== 0) throw new Error(`code graph ${toolName}: ${b?.message ?? `HTTP ${r.status}`}`);
    if (b.data?.isError) throw new Error(`code graph ${toolName}: ${String(b.data.text ?? "").slice(0, 200)}`);
    return String(b.data?.text ?? "");
  }

  /**
   * All indexed files of a code graph as [{p, l, s}]. The `files` tool truncates long outputs
   * (~200 entries), so truncated directories are paged by their child directories; `dirHint`
   * (directory paths from GitHub's tree) finds children that the truncated output never showed.
   */
  async codeGraphFiles(id, dirHint = new Set()) {
    const out = new Map();
    let calls = 0;
    let truncated = false;
    const parse = (text) => {
      for (const line of text.split("\n")) {
        const m = line.match(/^- (.+?) \(([^,()]+), (\d+) symbols?\)\s*$/) ?? line.match(/^- (.+?) \(([^,()]+)\)\s*$/);
        if (m && out.size < MAX_FILES) out.set(m[1], { p: m[1], l: m[2], s: m[3] ? Number(m[3]) : null });
      }
    };
    const children = (prefix) => {
      const kids = new Set();
      const add = (path) => {
        if (prefix && !path.startsWith(`${prefix}/`)) return;
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const seg = rest.split("/");
        if (seg.length > 1) kids.add(prefix ? `${prefix}/${seg[0]}` : seg[0]);
      };
      for (const d of dirHint) add(`${d}/x`);
      for (const k of out.keys()) add(k);
      return [...kids];
    };
    const run = async (prefix, depth) => {
      if (++calls > 80) { truncated = true; return; }
      const text = await this.tool(id, "files", { format: "flat", ...(prefix ? { path: prefix } : {}) });
      parse(text);
      if (!/output truncated/.test(text)) return;
      if (depth >= 5) { truncated = true; return; }
      const kids = children(prefix);
      if (!kids.length) { truncated = true; return; }
      for (let k = 0; k < kids.length; k += 4) await Promise.all(kids.slice(k, k + 4).map((c) => run(c, depth + 1)));
    };
    await run("", 0);
    if (!out.size) throw new Error("code graph has no indexed files (not ready?)");
    return { files: [...out.values()], truncated: truncated || out.size >= MAX_FILES };
  }

  async githubTree(repo) {
    const info = await this.ghFetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`);
    const branch = info.default_branch;
    const t = await this.ghFetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const blobs = (t.tree ?? []).filter((x) => x.type === "blob").slice(0, MAX_FILES);
    const dirs = new Set((t.tree ?? []).filter((x) => x.type === "tree").map((x) => x.path));
    return { branch, truncated: !!t.truncated || blobs.length >= MAX_FILES, dirs, files: blobs.map((x) => ({ p: x.path, l: langOf(x.path), s: null, b: x.size ?? null })) };
  }

  /**
   * Repo structure as a flat file list [{p, l, s, b?}] (path, language, symbol count, bytes).
   * Code graph (languages + symbol counts) merged with GitHub's tree (every file, sizes);
   * either one alone when the other is unavailable.
   */
  async graph(project, repoUrl, { fresh = false } = {}) {
    const ref = repoRef(repoUrl);
    const repo = projectRepoList(project).find((r) => r.key === ref.key);
    if (!repo) { const e = new Error("repo is not part of this project"); e.code = 404; throw e; }
    const cg = (project.tdai?.codeGraphs ?? []).find((g) => repoRef(g.repo).key === ref.key);
    return this.cached(`graph:${repo.key}:${cg?.id ?? ""}`, async () => {
      const [tree, treeErr] = repo.github ? await this.githubTree(repo).then((t) => [t, null], (e) => [null, e.message]) : [null, "GitHub dışı depo"];
      let graph = null, cgErr = cg?.id ? null : "Bu depo için kod grafiği yok";
      if (cg?.id) {
        try { graph = await this.codeGraphFiles(cg.id, tree?.dirs); } catch (e) { cgErr = e.message; }
      }
      if (!graph && !tree) throw new Error([cgErr, treeErr].filter(Boolean).join("; "));
      const files = new Map();
      for (const f of tree?.files ?? []) files.set(f.p, f);
      for (const f of graph?.files ?? []) files.set(f.p, { ...files.get(f.p), ...f, b: files.get(f.p)?.b ?? null });
      return {
        source: graph && tree ? "codegraph+github" : graph ? "codegraph" : "github",
        codeGraph: cg?.id ? { id: cg.id, branch: cg.branch ?? null, ok: !!graph, error: cgErr } : null,
        repo: repo.url,
        branch: tree?.branch ?? cg?.branch ?? null,
        indexed: graph?.files.length ?? 0,
        truncated: !!(graph?.truncated || tree?.truncated),
        notes: [cgErr && graph == null ? `Kod grafiği: ${cgErr}` : null, treeErr && tree == null ? `GitHub ağacı: ${treeErr}` : null].filter(Boolean),
        files: [...files.values()].sort((a, b) => a.p.localeCompare(b.p)),
      };
    }, { fresh });
  }

  /** Top symbols defined in one file (code graph search by the file's stem). */
  async symbols(project, repoUrl, file) {
    const ref = repoRef(repoUrl);
    if (!projectRepoList(project).some((r) => r.key === ref.key)) { const e = new Error("repo is not part of this project"); e.code = 404; throw e; }
    const cg = (project.tdai?.codeGraphs ?? []).find((g) => repoRef(g.repo).key === ref.key);
    if (!cg?.id) return { available: false, symbols: [] };
    // The code graph has no "symbols of file X" tool; search by the file's name finds the
    // symbols named after it (class Foo in Foo.kt, …) plus their members.
    const base = file.split("/").pop() ?? file;
    const queries = [...new Set([base.replace(/\.[^.]+$/, ""), base.split(".")[0]].filter((q) => q.length >= 2))];
    return this.cached(`sym:${cg.id}:${file}`, async () => {
      const seen = new Set();
      const symbols = [];
      const re = /\*\*(.+?)\*\* \((\w+)\)\n(.+?):(\d+)(?:\n`([^`]*)`)?/g;
      for (const q of queries) {
        const text = await this.tool(cg.id, "search", { query: q, limit: 60 });
        let m;
        while ((m = re.exec(text))) {
          const [, name, kind, path, line, sig] = m;
          if (path !== file || kind === "import" || kind === "file" || seen.has(`${name}:${line}`)) continue;
          seen.add(`${name}:${line}`);
          symbols.push({ name, kind, line: Number(line), sig: sig ?? null });
        }
        if (symbols.length >= 3) break;
      }
      symbols.sort((a, b) => a.line - b.line);
      return { available: true, symbols: symbols.slice(0, 40) };
    });
  }
}
