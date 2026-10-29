// Fast, cached checks that show the next useful ekip setup steps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, SETTINGS, healthy, keyCounts, tdaiUp } from "./core.js";
import { findProject } from "./projects.js";
import { t } from "./i18n.js";

const CACHE = path.join(HOME, "onboarding-cache.json");
const TTL = 10 * 60_000;
const gap = (id, title, why, command, severity = "warn") => ({ id, title: t(title), why: t(why), command, severity });

export async function setupGaps({ cwd = process.cwd(), refresh = false } = {}) {
  let real = path.resolve(cwd);
  try { real = fs.realpathSync(real); } catch { /* keep resolved cwd */ }
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (!refresh && Date.now() - cache.at < TTL && cache.cwd === real) return cache.gaps;
  } catch { /* no cache */ }
  const gaps = [];
  const p = findProject(real);
  if (!p) gaps.push(gap("project", "Bu klasör ekip'e kayıtlı değil", "projenin hafızası, wiki'si ve kod grafiği olmadan işçiler her işe sıfırdan başlar", "ekip project add ."));
  else {
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
    const u = (await import("./update.js")).checkUpdate();
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
  if (logged < 2) gaps.push(gap("agents", "İki işçi havuzu henüz giriş yapmamış", "işler Claude kotan dışındaki havuzlara dağıtılamıyor", "ekip agents login"));
  let keys = [];
  try { keys = keyCounts({ timeout: 500 }); } catch { /* service or database is unavailable */ }
  if (!keys.length) gaps.push(gap("keys", "Ücretsiz havuz anahtarı yok", "ücretsiz model havuzu ek işler alamıyor", "ekip keys"));
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) gaps.push(gap("hub", "Hub bağlı değil", "web paneli ve Mac kapalıyken çalışan iş kuyruğu kullanılamıyor", "ekip hub link", "info"));
  if (process.platform === "darwin" && process.env.TERM_PROGRAM !== "iTerm.app") gaps.push(gap("pane", "Görev bölmesi bu terminalde açılamıyor", "görevleri terminalin altında canlı izleyemezsiniz", "ekip status", "info"));
  try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), cwd: real, gaps })); } catch { /* cache is best effort */ }
  return gaps;
}

export function printGaps(gaps, { heading = false, limit = Infinity } = {}) {
  if (heading) console.log(`\n› ${t("Kurulum")}`);
  for (const g of gaps.slice(0, limit)) console.log(`  eksik: ${g.title} → ${g.command}`);
}
