// ekip's own release state for `ekip status` and the panel: main's last commit as the CI poller saw
// it (scripts/ci/vps-ci-poll.sh writes last-sha, vps-fresh-install.sh writes result.json, both in
// the CI directory), whether that commit is still under test, and which commit this hub runs.
// The CI directory comes from config (EKIP_CI_DIR, default $EKIP_DATA/ci); nothing personal here.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// the poller's bare mirror of the repo knows the release tags (vX.Y.Z, scripts/ci/release.sh)
const mirrorGit = (ciDir, ...args) => {
  const dir = path.join(ciDir, "mirror.git");
  if (!fs.existsSync(dir)) return "";
  const r = spawnSync("git", ["--git-dir", dir, ...args], { encoding: "utf8", timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : "";
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

/**
 * { version, main: { sha, at }, ci: { status, step, sha, startedAt, finishedAt }, testing, hub: { commit, version, startedAt } }.
 * testing: main's last commit has no result yet (the poller took it and the fresh-install test runs).
 */
export function releaseInfo(ciDir, { commit = null, startedAt = null } = {}) {
  let main = null;
  try {
    const file = path.join(ciDir, "last-sha");
    const sha = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{7,40}$/.test(sha)) main = { sha, at: fs.statSync(file).mtime.toISOString() };
  } catch { /* the poller has not run here */ }
  const r = readJson(path.join(ciDir, "result.json"));
  const ci = r && typeof r === "object" ? { status: r.status ?? null, step: r.step ?? null, sha: typeof r.sha === "string" ? r.sha : null, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null } : null;
  const testing = !!main && !(ci?.sha && main.sha.startsWith(ci.sha));
  // the newest release, and the release the hub's own commit belongs to
  const version = mirrorGit(ciDir, "tag", "--list", "v[0-9]*", "--sort=-v:refname").split("\n")[0] || null;
  const hubVersion = commit && /^[0-9a-f]{7,40}$/.test(commit) ? mirrorGit(ciDir, "describe", "--tags", "--match", "v[0-9]*", commit) || null : null;
  return { version, main, ci, testing, hub: { commit: commit || null, version: hubVersion, startedAt } };
}
