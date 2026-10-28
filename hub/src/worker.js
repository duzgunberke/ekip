// Job worker: clone/fetch the project's repo, run a headless Claude Code worker in a fresh git
// worktree on branch ekip/job-<id>, commit and (optionally) push what it changed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Same brief as `ekip run` (plugin/bin/ekip.js WORKER_BRIEF), plus the hub's repo context.
export const WORKER_BRIEF = [
  "You are a worker agent dispatched by a lead agent. Do the task below completely and autonomously in the current directory; do not ask questions, make reasonable assumptions and state them.",
  "Finish with a short report: what you changed (files), what you verified and how, and anything left open.",
  "",
  "TASK:",
].join("\n");

// A run that "succeeded" but only reports a quota or auth failure counts as failed (as in ekip.js).
const LIMIT_RE = /quota|rate.?limit|resource.?exhausted|usage limit|limit reached|too many requests|\b429\b|not logged in|unauthori[sz]ed|overloaded_error|no_providers_configured|invalid api key/i;

const AUTHOR = { name: "ekip-hub", email: "ekip@sazora.io" };
const GIT_TIMEOUT = 10 * 60_000;

// Accepted repo spellings: owner/name, github.com/owner/name, https://github.com/owner/name(.git).
// Local paths / file:// only when EKIP_ALLOW_LOCAL_REPOS=1 (tests).
export function resolveRepo(repo, { allowLocal = false } = {}) {
  if (typeof repo !== "string" || !repo.trim()) throw new Error("project has no repo");
  const r = repo.trim();
  const gh = r.match(/^(?:https:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
    ?? r.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (gh && !r.startsWith("/") && !r.startsWith("file:")) return { url: `https://github.com/${gh[1]}/${gh[2]}.git`, github: true };
  if (allowLocal && (r.startsWith("/") || r.startsWith("file:///"))) return { url: r, github: false };
  throw new Error(`unsupported repo "${r}" (use owner/name or https://github.com/owner/name)`);
}

export class Worker {
  constructor({ cfg, store }) {
    this.cfg = cfg;
    this.store = store;
    this.slots = Array.from({ length: cfg.workers }, (_, i) => ({ slot: i + 1, jobId: null, since: null }));
    this.locks = new Map(); // project -> promise chain (serialises git ops on the shared clone)
    this.children = new Map(); // jobId -> running child process
    this.secrets = [cfg.githubToken, cfg.freellmapiKey, cfg.tdaiUserKey, cfg.hubToken, cfg.hubPassword, cfg.copilotToken].filter((s) => s && s.length >= 6);
    if (cfg.githubToken) this.secrets.push(Buffer.from(`x-access-token:${cfg.githubToken}`).toString("base64"));
    fs.mkdirSync(cfg.jobsDir, { recursive: true });
    fs.mkdirSync(cfg.workDir, { recursive: true });
    this.seedClaudeConfig();
  }

  redact(s) {
    let out = String(s);
    for (const x of this.secrets) out = out.split(x).join("***");
    return out;
  }

  seedClaudeConfig() {
    fs.mkdirSync(this.cfg.claudeDir, { recursive: true });
    const f = path.join(this.cfg.claudeDir, ".claude.json");
    let d = {};
    try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* new */ }
    if (!d.hasCompletedOnboarding) {
      d.hasCompletedOnboarding = true;
      fs.writeFileSync(f, JSON.stringify(d, null, 2));
    }
  }

  logFile(id) { return path.join(this.cfg.jobsDir, `${id}.log`); }

  tail(id, bytes = 12_000) {
    try {
      const f = this.logFile(id);
      const { size } = fs.statSync(f);
      const fd = fs.openSync(f, "r");
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      let t = buf.toString("utf8");
      if (size > len) t = `…${t.slice(t.indexOf("\n") + 1)}`;
      return this.redact(t);
    } catch { return ""; }
  }

  // ---- scheduling --------------------------------------------------------------------------------

  start() {
    // A job that was running when the hub stopped starts over.
    for (const j of this.store.jobs.data) {
      if (j.status === "running") {
        Object.assign(j, { status: "queued", startedAt: null, worker: null });
        this.append(j.id, "\n[hub restarted; job re-queued]\n");
      }
    }
    this.store.jobs.save();
    this.tick();
    this.interval = setInterval(() => this.tick(), 3000);
  }

  tick() {
    for (const s of this.slots) {
      if (s.jobId) continue;
      const job = this.store.jobs.data.find((j) => j.status === "queued");
      if (!job) return;
      s.jobId = job.id;
      s.since = new Date().toISOString();
      Object.assign(job, { status: "running", startedAt: s.since, worker: s.slot });
      this.store.jobs.save();
      this.runJob(job)
        .catch((e) => {
          this.append(job.id, `\n[hub error] ${e?.stack ?? e}\n`);
          if (job.status === "running") Object.assign(job, { status: "failed", error: this.redact(e?.message ?? e) });
        })
        .finally(() => {
          job.finishedAt = new Date().toISOString();
          this.children.delete(job.id);
          s.jobId = null;
          s.since = null;
          this.store.jobs.save();
          setImmediate(() => this.tick());
        });
    }
  }

  cancel(job) {
    if (job.status === "queued") {
      Object.assign(job, { status: "cancelled", finishedAt: new Date().toISOString() });
      this.store.jobs.save();
      return true;
    }
    if (job.status !== "running") return false;
    job.cancelRequested = true;
    const child = this.children.get(job.id);
    if (child) killTree(child);
    this.store.jobs.save();
    return true;
  }

  status() { return this.slots.map((s) => ({ ...s })); }

  stopAll() { for (const c of this.children.values()) killTree(c); }

  // ---- helpers -----------------------------------------------------------------------------------

  append(id, text) { fs.appendFileSync(this.logFile(id), this.redact(text)); }

  lock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next.catch(() => {}));
    return next;
  }

  gitEnv() {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" };
    if (this.cfg.githubToken) {
      // Auth through an env-only extra header (as actions/checkout does): the token never lands in a
      // remote URL, .git/config, argv or the log.
      const basic = Buffer.from(`x-access-token:${this.cfg.githubToken}`).toString("base64");
      Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
    }
    return env;
  }

  // Runs a command, streaming its output into the job log. Never throws on a non-zero exit.
  exec(job, cmd, argv, { cwd, env, timeoutMs = GIT_TIMEOUT, quiet = false, track = false } = {}) {
    return new Promise((resolve) => {
      if (!quiet) this.append(job.id, `$ ${cmd} ${argv.map((a) => (a.length > 100 ? `${a.slice(0, 97)}...` : a)).join(" ")}\n`);
      let child;
      try {
        child = spawn(cmd, argv, { cwd, env: env ?? this.gitEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
      } catch (e) { resolve({ code: 127, stdout: "", out: String(e.message) }); return; }
      if (track) this.children.set(job.id, child);
      let stdout = "", out = "";
      const timer = setTimeout(() => { this.append(job.id, `\n[timeout after ${Math.round(timeoutMs / 60000)} min]\n`); killTree(child); }, timeoutMs);
      child.stdout.on("data", (d) => { stdout += d; out += d; if (!quiet) this.append(job.id, d.toString()); });
      child.stderr.on("data", (d) => { out += d; if (!quiet) this.append(job.id, d.toString()); });
      child.on("error", (e) => { out += String(e.message); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (track) this.children.delete(job.id);
        resolve({ code: code ?? (signal ? 128 : 1), stdout, out });
      });
    });
  }

  async git(job, cwd, args, opts = {}) {
    const r = await this.exec(job, "git", args, { cwd, ...opts });
    if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args[0]} failed (exit ${r.code}): ${this.redact(r.out.trim().split("\n").slice(-2).join(" | "))}`);
    return r;
  }

  async tdaiHealthy() {
    if (!this.cfg.tdaiUrl) return false;
    try { return (await fetch(`${this.cfg.tdaiUrl}/health`, { signal: AbortSignal.timeout(3000) })).status < 500; } catch { return false; }
  }

  // ---- one job -----------------------------------------------------------------------------------

  async runJob(job) {
    const { cfg } = this;
    this.append(job.id, `${fs.existsSync(this.logFile(job.id)) ? "\n==========\n" : ""}job ${job.id}  project: ${job.project}  push: ${job.push}\nstarted: ${job.startedAt}\ntask:\n${job.task}\n\n`);
    const project = this.store.projects.data.find((p) => p.name === job.project);
    if (!project) throw new Error(`unknown project ${job.project}`);
    const remote = resolveRepo(project.repo, { allowLocal: cfg.allowLocalRepos });
    const pdir = path.join(cfg.workDir, project.name);
    const clone = path.join(pdir, "repo");
    const wt = path.join(pdir, "jobs", job.id);
    const branch = `ekip/job-${job.id}`;

    // 1. clone / fetch and create the worktree (serialised per project).
    const base = await this.lock(project.name, async () => {
      if (!fs.existsSync(path.join(clone, ".git"))) {
        fs.mkdirSync(pdir, { recursive: true });
        fs.rmSync(clone, { recursive: true, force: true });
        await this.git(job, pdir, ["clone", "--no-checkout", remote.url, clone]);
      } else {
        await this.git(job, clone, ["remote", "set-url", "origin", remote.url]);
        await this.git(job, clone, ["fetch", "--prune", "origin"]);
        await this.git(job, clone, ["remote", "set-head", "origin", "--auto"], { allowFail: true });
      }
      let def = (await this.git(job, clone, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true, quiet: true })).stdout.trim();
      if (!def) {
        for (const b of ["origin/main", "origin/master"]) {
          if ((await this.git(job, clone, ["rev-parse", "--verify", "-q", b], { allowFail: true, quiet: true })).code === 0) { def = b; break; }
        }
      }
      if (!def) throw new Error("could not find the default branch (empty repository?)");
      // Leftovers of an interrupted earlier attempt of this job.
      if (fs.existsSync(wt)) await this.git(job, clone, ["worktree", "remove", "--force", wt], { allowFail: true });
      await this.git(job, clone, ["worktree", "prune"], { allowFail: true, quiet: true });
      await this.git(job, clone, ["branch", "-D", branch], { allowFail: true, quiet: true });
      await this.git(job, clone, ["worktree", "add", "--no-track", "-b", branch, wt, def]);
      const sha = (await this.git(job, wt, ["rev-parse", "HEAD"], { quiet: true })).stdout.trim();
      Object.assign(job, { branch, baseBranch: def.replace(/^origin\//, ""), baseSha: sha });
      this.store.jobs.save();
      return sha;
    });
    if (job.cancelRequested) return this.finishCancelled(job, clone, wt, branch);

    // 2. the worker
    const prompt = `${WORKER_BRIEF}\n${job.task}`;
    // copilot: GitHub Copilot CLI on the user's Copilot quota (strong models, needs
    // COPILOT_GITHUB_TOKEN). free: claude --bare on freellmapi through the memory proxy.
    // auto: copilot when configured, falling back to free if it fails.
    const pools = job.via === "copilot" ? ["copilot"] : job.via === "free" ? ["free"] : [cfg.copilotToken ? "copilot" : null, "free"].filter(Boolean);
    let r;
    for (const pool of pools) {
      if (pool === "copilot") {
        this.append(job.id, "\n--- worker via copilot ---\n");
        r = await this.exec(job, "copilot", ["-p", prompt, "--allow-all-tools", "--allow-all-paths", ...(job.model ? ["--model", job.model] : [])], {
          cwd: wt, env: this.copilotEnv(), timeoutMs: cfg.jobTimeoutMin * 60_000, track: true,
        });
      } else {
        const env = await this.claudeEnv(job, project);
        this.append(job.id, `\n--- claude worker via ${job.pool} (model ${env.ANTHROPIC_MODEL}) ---\n`);
        r = await this.exec(job, "claude", ["--bare", "-p", prompt, "--permission-mode", "bypassPermissions"], {
          cwd: wt, env, timeoutMs: cfg.jobTimeoutMin * 60_000, track: true,
        });
      }
      this.append(job.id, `\n[${pool} exit ${r.code}]\n`);
      job.ranVia = pool;
      if (r.code === 0 && r.stdout.trim() && !(r.stdout.length < 600 && LIMIT_RE.test(r.stdout))) break;
      if (job.cancelRequested) break;
    }
    if (job.cancelRequested) return this.finishCancelled(job, clone, wt, branch);
    const report = r.stdout.trim();
    job.report = this.redact(report.slice(-20_000));
    const workerFailed = r.code !== 0 || !report || (report.length < 600 && LIMIT_RE.test(report));

    // 3. commit, diffstat, push
    await this.git(job, wt, ["add", "-A"]);
    const dirty = (await this.git(job, wt, ["diff", "--cached", "--quiet"], { allowFail: true, quiet: true })).code !== 0;
    if (dirty) {
      const subject = `ekip job ${job.id}: ${job.task.split("\n")[0].slice(0, 60)}`;
      await this.git(job, wt, ["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`, "commit", "-q", "--author", `${AUTHOR.name} <${AUTHOR.email}>`, "-m", subject, "-m", `Task:\n${job.task}`.slice(0, 4000)]);
    }
    const head = (await this.git(job, wt, ["rev-parse", "HEAD"], { quiet: true })).stdout.trim();
    const changed = head !== base;
    job.changed = changed;
    job.diffstat = changed ? (await this.git(job, wt, ["diff", "--stat", base, head], { quiet: true })).stdout.trim() : "";
    job.headSha = head;
    if (changed && job.push && !workerFailed) {
      const pr = await this.lock(project.name, () => this.git(job, wt, ["push", "-u", "origin", `${branch}:${branch}`], { allowFail: true }));
      job.pushed = pr.code === 0;
      if (!job.pushed) job.error = `push failed: ${this.redact(pr.out.trim().split("\n").slice(-2).join(" | "))}`;
    }

    // 4. clean up the worktree; keep the branch in the clone only when it has commits.
    await this.lock(project.name, async () => {
      await this.git(job, clone, ["worktree", "remove", "--force", wt], { allowFail: true, quiet: true });
      if (!changed) await this.git(job, clone, ["branch", "-D", branch], { allowFail: true, quiet: true });
    });
    if (!changed) job.branch = null;
    job.status = workerFailed || (job.push && changed && job.pushed === false) ? "failed" : "done";
    if (workerFailed && !job.error) job.error = r.code !== 0 ? `claude exited ${r.code}` : "worker reported a quota/auth failure";
    this.append(job.id, `\n[${job.status}] changed=${changed} pushed=${job.pushed ?? false}\n${job.diffstat}\n`);
  }

  async finishCancelled(job, clone, wt, branch) {
    job.status = "cancelled";
    this.append(job.id, "\n[cancelled]\n");
    await this.lock(job.project, async () => {
      await this.git(job, clone, ["worktree", "remove", "--force", wt], { allowFail: true, quiet: true });
      await this.git(job, clone, ["branch", "-D", branch], { allowFail: true, quiet: true });
    });
    job.branch = null;
  }

  // Env for the Copilot CLI: only what it needs, never the hub or git secrets.
  copilotEnv() {
    return { PATH: process.env.PATH, HOME: this.cfg.data, LANG: "C.UTF-8", COPILOT_GITHUB_TOKEN: this.cfg.copilotToken };
  }

  // Env for `claude --bare`: a clean environment (no hub/GitHub secrets), the TDAI memory proxy when
  // it is up and the project names its TDAI team/agent, else freellmapi directly.
  async claudeEnv(job, project) {
    const { cfg } = this;
    const model = job.model || "auto";
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TERM: "dumb",
      CLAUDE_CONFIG_DIR: cfg.claudeDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(cfg.compactWindow),
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email,
    };
    const t = project.tdai ?? {};
    const useTdai = cfg.tdaiUserKey && t.teamId && t.agentId && (await this.tdaiHealthy());
    if (useTdai) {
      Object.assign(env, {
        ANTHROPIC_BASE_URL: `${cfg.tdaiUrl}/claude-code/default`,
        ANTHROPIC_API_KEY: cfg.tdaiUserKey,
        ANTHROPIC_CUSTOM_HEADERS: `x-team-id: ${t.teamId}\nx-agent-id: ${t.agentId}`,
      });
      job.pool = "tdai";
    } else {
      if (!cfg.freellmapiUrl || !cfg.freellmapiKey) throw new Error("no model endpoint: TDAI unavailable and FREELLMAPI_URL/FREELLMAPI_KEY unset");
      const why = !t.teamId || !t.agentId ? "project has no tdai.teamId/agentId" : !cfg.tdaiUserKey ? "TDAI_USER_KEY unset" : "TDAI proxy down";
      this.append(job.id, `[memory proxy skipped: ${why}; using freellmapi directly]\n`);
      Object.assign(env, { ANTHROPIC_BASE_URL: cfg.freellmapiUrl, ANTHROPIC_API_KEY: cfg.freellmapiKey });
      job.pool = "free";
    }
    this.store.jobs.save();
    return env;
  }
}

function killTree(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 5000).unref();
}
