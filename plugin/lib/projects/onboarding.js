// Fast, cached checks that show the next useful ekip setup steps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME, SETTINGS, healthy, keyCounts, tdaiUp } from "../core/core.js";
import { findProject } from "./projects.js";
import { detect } from "../core/terminal.js";
import { t } from "../core/i18n.js";

const CACHE = path.join(HOME, "onboarding-cache.json");
const TTL = 10 * 60_000;
const gap = (id, title, why, command, severity = "warn") => ({ id, title: t(title), why: t(why), command, severity });

const run = (cmd, args, timeout = 1000) => spawnSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] });

// Machine checks the workers depend on; each is local and bounded (gh: one second).
export function envChecks() {
  const git = (k) => (run("git", ["config", "--global", "--get", k], 500).stdout ?? "").trim();
  // `gh auth token` reads the stored login locally (40 ms); `gh auth status` asks GitHub and can pass
  // the time limit on a slow network, which reported a logged-in user as logged out
  const gh = run("gh", ["auth", "token"], 2000);
  return { gitIdentity: !!(git("user.name") && git("user.email")), ghInstalled: !gh.error || gh.error.code !== "ENOENT", ghAuth: gh.status === 0 || gh.error?.code === "ETIMEDOUT" };
}

export async function setupGaps({ cwd = process.cwd(), refresh = false } = {}) {
  let real = path.resolve(cwd);
  try { real = fs.realpathSync(real); } catch { /* keep resolved cwd */ }
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (!refresh && Date.now() - cache.at < TTL && cache.cwd === real) return cache.gaps;
  } catch { /* no cache */ }
  const gaps = [];
  const p = findProject(real);
  // only a code folder is worth registering: not the home folder or a folder outside any git repo
  const inRepo = (() => { for (let d = real; d !== path.dirname(d); d = path.dirname(d)) { if (d === os.homedir()) return false; if (fs.existsSync(path.join(d, ".git"))) return true; } return false; })();
  if (!p && inRepo) gaps.push(gap("project", "Bu klasör ekip'e kayıtlı değil", "projenin hafızası, wiki'si ve kod grafiği olmadan işçiler her işe sıfırdan başlar", "ekip project add ."));
  else if (p) {
    if (!p.card || !fs.existsSync(p.card)) gaps.push(gap("card", "Proje kartı eksik", "işçiler projenin yapısını ve komutlarını göremiyor", `ekip project card ${p.name}`));
    if ((p.repo || p.repos?.length) && !fs.existsSync(path.join(p.path, ".codegraph"))) gaps.push(gap("local-graph", "Yerel kod grafiği eksik", "işçiler kodun yerel sembol ve çağrı dizininde arama yapamıyor", `ekip project sync ${p.name}`));
    const repos = p.repos?.length ?? (p.repo ? 1 : 0);
    if (repos && !(p.tdai?.codeGraphs ?? []).some((g) => g.id)) gaps.push(gap("graph", "Kod grafiği eksik", "işçiler kodun yapısını ve ilişkilerini keşfedemiyor", `ekip project sync ${p.name}`));
    if (!p.tdai?.wikiId) gaps.push(gap("wiki", "Proje wiki'si eksik", "işçiler proje belgelerinde arama yapamıyor", `ekip project sync ${p.name}`));
    const base = path.join(os.homedir(), ".claude/projects");
    const stateFile = path.join(HOME, "memory-state/asset-import.json");
    const done = (() => { try { return new Set(JSON.parse(fs.readFileSync(stateFile, "utf8")).done ?? []); } catch { return new Set(); } })();
    let dirs = [];
    try { dirs = fs.readdirSync(base).filter((d) => d.endsWith(`-Projects-${p.name}`) || d.includes(`-Projects-${p.name}-`)); } catch { /* Claude not used here yet */ }
    // done keys are "<agent>::session:claude-code:<file path>"; a project dir counts as imported when
    // any of its session files is in there
    const keys = [...done].join("\n");
    if (dirs.some((d) => !keys.includes(`/.claude/projects/${d}/`))) gaps.push(gap("history", "Claude geçmişi hafızaya aktarılmamış", "önceki oturumlardaki kararlar ve çözümler işçilere ulaşmıyor", "ekip memory import-history"));
  }
  // A newer release than this checkout (cached remote check, see update.js).
  try {
    const u = (await import("../ops/update.js")).checkUpdate();
    if (u.behind) gaps.unshift(gap("update", `Yeni ekip sürümü var: ${u.latest} (sizdeki ${u.local})`, "düzeltmeler ve yeni özellikler bu kurulumda yok", "ekip update"));
  } catch { /* offline */ }
  // Vectors: memories without embeddings are not found by search. The doctor measures it and
  // leaves the count in data/vectors-status.json; a missing or stale backfill is a gap.
  try {
    const v = JSON.parse(fs.readFileSync(path.join(HOME, "vectors-status.json"), "utf8"));
    if (v.never) gaps.push(gap("vectors", "Hafıza vektörleri hiç oluşturulmamış", "vektörü olmayan kayıtlar aramada bulunmuyor", "ekip memory reindex"));
    else if (v.missing > 0) gaps.push(gap("vectors", `${v.missing} hafıza kaydı vektörsüz`, "vektörü olmayan kayıtlar aramada bulunmuyor", "ekip memory reindex"));
  } catch { /* not measured yet */ }
  // Both probes have a hard one-second timeout; all other checks are local.
  const [memUp, freeUp] = await Promise.all([
    tdaiUp(1000).catch(() => false), healthy(1000).catch(() => false),
  ]);
  if (!memUp) gaps.push(gap("memory", "Hafıza servisi çalışmıyor", "proje hafızası ve wiki şu an kullanılamıyor", "ekip memory up"));
  const logged = Object.values(SETTINGS.agents ?? {}).filter((a) => a?.ok).length;
  let keys = [];
  try { keys = keyCounts({ timeout: 500 }); } catch { /* service or database is unavailable */ }
  // No free keys and under two pools: one combined gap, since Claude would do everything itself.
  if (!keys.length && logged < 2) gaps.push(gap("no-workers", "Ücretsiz anahtar ve ikinci işçi havuzu yok: Claude işin hepsini kendisi yapar", "tasarruf olmaz; en hızlı kazanç: ekip keys (Google AI Studio, Groq, NVIDIA ücretsiz anahtarları) ve ekip agents login (Copilot ücretsiz katman, Codex)", "ekip keys"));
  else {
    if (logged < 2) gaps.push(gap("agents", "İki işçi havuzu henüz giriş yapmamış", "işler Claude kotan dışındaki havuzlara dağıtılamıyor", "ekip agents login"));
    if (!keys.length) gaps.push(gap("keys", "Ücretsiz havuz anahtarı yok", "ücretsiz model havuzu ek işler alamıyor", "ekip keys"));
  }
  if (!process.env.MEMORY_EMBEDDING_BASE_URL && !keys.some(([p]) => p === "nvidia")) gaps.push(gap("embeddings", "Hafıza vektörü sağlayıcısı yok, arama anahtar kelimeye düşer", "ücretsiz bir NVIDIA NIM anahtarı (build.nvidia.com) vektörleri açar; OpenAI uyumlu herhangi bir embedding uç noktası MEMORY_EMBEDDING_BASE_URL / MEMORY_EMBEDDING_MODEL ile verilebilir; ek vektör veritabanı (Qdrant, Pinecone) gerekmez", "ekip keys"));
  const env = envChecks();
  if (!env.gitIdentity) gaps.push(gap("git-identity", "Git kimliği tanımlı değil", "işçiler commit atamaz; user.name ve user.email boş", 'git config --global user.name "Ad Soyad" && git config --global user.email you@example.com'));
  if (!env.ghInstalled) gaps.push(gap("gh", "GitHub CLI (gh) kurulu değil", "hub işleri ve özel depoların kod grafiği GitHub girişi ister", "brew install gh && gh auth login", "info"));
  else if (!env.ghAuth) gaps.push(gap("gh-auth", "gh oturumu açık değil", "hub işleri ve özel depoların kod grafiği GitHub girişi ister", "gh auth login"));
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) gaps.push(gap("hub", "Hub bağlı değil", "web paneli ve Mac kapalıyken çalışan iş kuyruğu kullanılamıyor", "ekip hub local (bu bilgisayarda) ya da ekip hub link <url> <token> (VPS)", "info"));
  // panes open in iTerm2, WezTerm and kitty; elsewhere ekip's own terminal is the fix. In iTerm2 it
  // is only offered once (optional: iTerm2 keeps working), never when WezTerm is already in use.
  const term = detect();
  if (process.platform === "darwin" && term === "none") gaps.push(gap("pane", "Görev bölmesi bu terminalde açılamıyor", "görevleri terminalin altında canlı izleyemezsiniz; ekip'in kendi terminali (WezTerm) bunu açar", "ekip terminal install", "info"));
  else if (term === "iterm" && !SETTINGS.terminal) {
    const offered = path.join(HOME, "terminal-offered");
    if (!fs.existsSync(offered)) {
      gaps.push(gap("terminal", "İsteğe bağlı: ekip'in kendi terminali (WezTerm)", "renkli durumlar ve AppleScript'siz, hızlı görev bölmeleri; iTerm2 aynen çalışmaya devam eder", "ekip terminal install", "info"));
      try { fs.writeFileSync(offered, new Date().toISOString()); } catch { /* shown again next time */ }
    }
  }
  try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), cwd: real, gaps })); } catch { /* cache is best effort */ }
  return gaps;
}

export function printGaps(gaps, { heading = false, limit = Infinity } = {}) {
  if (heading) console.log(`\n› ${t("Kurulum")}`);
  // most serious first, so a short list never hides a broken part behind a hint
  const rank = { bad: 0, warn: 1, info: 2 };
  for (const g of [...gaps].sort((a, b) => (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1)).slice(0, limit)) console.log(`  eksik: ${g.title} → ${g.command}`);
}
