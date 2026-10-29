// Updates: is there a newer ekip release than this checkout? People install ekip once and never
// look at the repo again, so ekip tells them: a line when the lead starts, an offer from Claude in
// the session, and one macOS notification per new release. `ekip update` brings the checkout up.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOME, ROOT, SETTINGS, die } from "../core/core.js";
import { c } from "../core/ui.js";
import { lang } from "../core/i18n.js";

const STATE = path.join(HOME, "update-check.json");
const git = (...args) => spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 8000 });
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
const writeState = (s) => { try { fs.writeFileSync(STATE, JSON.stringify(s)); } catch { /* best effort */ } };

export function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "plugin/.claude-plugin/plugin.json"), "utf8")).version; } catch { return "0.0.0"; }
}

// "1.10.0" > "1.9.2"; a leading "v" is ignored
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map(Number), pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Newest vX.Y.Z tag on the checkout's origin (its own fork included), or null when offline. */
function latestRelease() {
  const r = spawnSync("git", ["-C", ROOT, "ls-remote", "--tags", "--refs", "origin", "v*"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  const tags = r.stdout.split("\n").map((l) => l.split("refs/tags/")[1]).filter((t) => /^v\d+\.\d+\.\d+$/.test(t ?? ""));
  return tags.sort(compareVersions).at(-1)?.slice(1) ?? null;
}

/**
 * { local, latest, behind }. The remote is asked at most every maxAgeH hours (cached), so the lead
 * start stays fast. With notify, one macOS notification is sent per new release.
 */
export function checkUpdate({ maxAgeH = 12, notify = false } = {}) {
  const s = readState();
  let latest = s.latest ?? null;
  if (!s.at || Date.now() - s.at > maxAgeH * 3600_000) {
    const fresh = latestRelease();
    if (fresh) { latest = fresh; Object.assign(s, { latest, at: Date.now() }); writeState(s); }
  }
  const local = localVersion();
  const behind = !!latest && compareVersions(latest, local) > 0;
  if (behind && notify && s.notified !== latest) {
    notifyRelease(local, latest);
    writeState({ ...s, notified: latest });
  }
  return { local, latest, behind };
}

// One notification through the shared helper (ekip icon, macOS app name "ekip").
async function notifyRelease(local, latest) {
  const { notify } = await import("../core/core.js");
  notify(lang === "en" ? `ekip ${latest} is out` : `ekip ${latest} çıktı`, lang === "en" ? `You have ${local}. Run: ekip update` : `Sizdeki ${local}. Güncellemek için: ekip update`, { subtitle: lang === "en" ? "New version" : "Yeni sürüm", group: "ekip-update" });
}

/**
 * Automatic update (on by default, "autoUpdate": false in data/config.json turns it off): when a newer
 * release is out and the checkout is clean on its usual branch, fast-forward it and say so once.
 * A dirty checkout or another branch is never touched; the user gets the notice instead.
 * Returns { updated, from, to } or { skipped: reason }.
 */
export function autoUpdate() {
  if (SETTINGS.autoUpdate === false) return { skipped: "off" };
  const u = checkUpdate();
  if (!u.behind) return { skipped: "current" };
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  const upstream = git("rev-parse", "--abbrev-ref", "@{u}").stdout.trim();
  if (git("status", "--porcelain", "--untracked-files=no").stdout.trim() || !upstream || !upstream.endsWith(`/${branch}`)) {
    checkUpdate({ notify: true });
    return { skipped: "local changes or another branch" };
  }
  const before = git("rev-parse", "HEAD").stdout.trim();
  const pull = git("pull", "--ff-only", "--tags", "--quiet");
  if (pull.status !== 0) { checkUpdate({ notify: true }); return { skipped: pull.stderr.trim().slice(0, 200) }; }
  const to = localVersion();
  writeState({ ...readState(), at: 0, notified: to });
  if (git("rev-parse", "HEAD").stdout.trim() !== before) {
    import("../core/core.js").then(({ notify }) => notify(lang === "en" ? `ekip updated to ${to}` : `ekip ${to} sürümüne güncellendi`, lang === "en" ? `from ${u.local}; restart the lead to load new hooks` : `${u.local} sürümünden; yeni hook'lar için lead'i yeniden başlatın`, { subtitle: lang === "en" ? "Automatic update" : "Otomatik güncelleme", group: "ekip-update" })).catch(() => {});
  }
  return { updated: true, from: u.local, to };
}

/** One line for the lead start, or "" when up to date. */
export function updateLine() {
  const u = checkUpdate();
  if (!u.behind) return "";
  return `        ${c.yellow(lang === "en" ? `new version ${u.latest} (you have ${u.local})` : `yeni sürüm ${u.latest} (sizdeki ${u.local})`)} ${c.gray("→")} ${c.cyan("ekip update")}`;
}

/** Context for the session start, so Claude offers the update once. */
export function updateContext() {
  const u = checkUpdate();
  if (!u.behind) return "";
  return lang === "en"
    ? `## ekip update\nekip ${u.latest} is out; this install is ${u.local}. Offer it to the user once, in one short sentence ("A new ekip version is out, shall I update it?"). If they agree, run \`ekip update\` and tell them what changed (it prints the changelog). Do not repeat the offer after a no.`
    : `## ekip güncellemesi\nekip ${u.latest} çıktı; bu kurulum ${u.local}. Kullanıcıya bir kez, tek kısa cümleyle sor ("Yeni ekip sürümü çıktı, güncelleyeyim mi?"). Kabul ederse \`ekip update\` çalıştır ve neyin değiştiğini söyle (değişiklik listesini yazdırır). Hayır derse tekrar sorma.`;
}

/** ekip update: fast-forward the checkout to origin and show what changed. */
export function update() {
  const dirty = git("status", "--porcelain", "--untracked-files=no").stdout.trim();
  if (dirty) die(lang === "en" ? `local changes in ${ROOT}; commit or stash them first:\n${dirty}` : `${ROOT} içinde yerel değişiklik var; önce commit edin ya da kenara alın:\n${dirty}`);
  const before = git("rev-parse", "HEAD").stdout.trim();
  const from = localVersion();
  const pull = git("pull", "--ff-only", "--tags", "origin", git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim() || "main");
  if (pull.status !== 0) die(`git pull: ${pull.stderr.trim()}`);
  const after = git("rev-parse", "HEAD").stdout.trim();
  const to = localVersion();
  writeState({ ...readState(), at: 0 });
  if (before === after) { console.log(lang === "en" ? `ekip is up to date (${to})` : `ekip güncel (${to})`); return 0; }
  console.log(`${c.bold("ekip")} ${from} → ${c.green(to)}\n`);
  console.log(git("log", "--no-merges", "--format=  · %s", `${before}..${after}`).stdout.split("\n").slice(0, 40).join("\n"));
  console.log(`\n${c.gray(lang === "en"
    ? "Restart the lead session (or run /reload-plugins) to load the new hooks and skills. A VPS hub updates on its next deploy."
    : "Yeni hook ve skill'ler için lead oturumunu yeniden başlatın (ya da /reload-plugins). VPS hub'ı bir sonraki deploy'da güncellenir.")}`);
  return 0;
}
