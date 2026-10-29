// ekip limits: one screen for "what am I limited on, and where would work go now".
// Worker pools: readiness (agents.js) plus the last quota error in their run logs (e.g. agy's
// "Individual quota reached … Resets in 140h45m"). Free pool: freellmapi's own provider status,
// per-model availability and this month's usage. The same snapshot is sent to the hub so the
// web panel shows it too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, autoOrder, lastQuotaHit, poolScore } from "./agents.js";
import { spawnSync } from "node:child_process";
import { REMOTE, ROOT, RUNS, SETTINGS, URL_ROOT, has, unifiedKey, FREE_CONTAINER_SH } from "./core.js";
import { c, dot, title, fit } from "./ui.js";
import { t, lang } from "./i18n.js";

const state = () => SETTINGS.agents ?? {};

export function workerPools() {
  const st = state();
  return Object.entries(AGENTS).filter(([, a]) => !a.hidden?.()).map(([name, a]) => {
    const installed = has(a.bin);
    const s = st[name];
    const quota = installed ? lastQuotaHit(name) : null;
    const sc = poolScore(name);
    const status = !installed ? "off" : quota ? "limited" : s?.ok ? "ready" : s ? "login" : "untested";
    return { name, quota: a.quota, status, limit: quota, runs: sc.runs, successRate: sc.runs ? Math.round(sc.rate * 100) : null, cooling: !!sc.cooling };
  });
}

async function freeJson(p) {
  const r = await fetch(`${URL_ROOT}${p}`, { headers: { authorization: `Bearer ${unifiedKey()}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${p} HTTP ${r.status}`);
  return r.json();
}

// freellmapi's routing state comes from its own DB (hub/tools/freellmapi-limits.cjs), read where it runs.
function routingState() {
  const script = fs.readFileSync(path.join(ROOT, "hub/tools/freellmapi-limits.cjs"), "utf8");
  const r = REMOTE ? spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", REMOTE.ssh, `docker exec -i $(${FREE_CONTAINER_SH}) node -`], { input: script, encoding: "utf8", timeout: 40000 })
    : spawnSync("sh", ["-c", `docker exec -i $(${FREE_CONTAINER_SH}) node -`], { input: script, encoding: "utf8", timeout: 40000 });
  try { return JSON.parse(r.stdout); } catch { return { platforms: {}, profiles: {} }; }
}

export async function freePool(rs) {
  const [prov, usage] = await Promise.all([freeJson("/v1/providers"), freeJson("/v1/usage").catch(() => null)]);
  const used = Object.fromEntries((usage?.byPlatform ?? []).map((u) => [u.platform, u]));
  return (prov.providers ?? []).map((p) => {
    const m = rs.platforms[p.platform] ?? { models: 0, cooling: 0, ok24: 0, fail24: 0, lastError: null };
    // a valid key with nothing to serve (no catalog models, or HuggingFace out of credits)
    const status = p.status === "healthy" && !m.models ? "no_models" : p.status;
    return { platform: p.platform, name: p.name, status, keys: p.keys, resumeAt: p.resume_at ?? null,
      models: m.models, cooling: m.cooling, ok24: m.ok24, fail24: m.fail24, lastError: m.lastError,
      monthRequests: used[p.platform]?.requests ?? 0, monthTokens: used[p.platform]?.tokens ?? 0 };
  });
}

// Where a new task would go: the worker pool --via auto picks first (limited pools skipped), and
// for the free pool the first open models of each routing profile.
export function routing(pools, rs) {
  const limited = new Set(pools.filter((p) => p.status === "limited").map((p) => p.name));
  const order = autoOrder();
  const worker = order.find((n) => !limited.has(n)) ?? "free";
  return { order, worker, skipped: order.filter((n) => limited.has(n)), profiles: rs.profiles };
}

const ago = (iso) => {
  const ms = Date.parse(iso) - Date.now();
  const h = Math.floor(Math.abs(ms) / 3600000), m = Math.round((Math.abs(ms) % 3600000) / 60000);
  const d = Math.floor(h / 24);
  return d ? (lang === "en" ? `${d} day${d === 1 ? "" : "s"} ${h % 24} hr` : `${d} gün ${h % 24} sa`) : h ? t("{n} sa {m} dk", { n: h, m }) : t("{n} dk", { n: m });
};

export async function snapshot() {
  const workers = workerPools();
  const rs = routingState();
  const free = await freePool(rs).catch((e) => ({ error: e.message }));
  const route = routing(workers, rs);
  return { at: new Date().toISOString(), host: os.hostname(), workers, free, route };
}

export async function push(s) {
  s ??= await snapshot();
  if (!SETTINGS.hubUrl || !SETTINGS.hubToken) return;
  await fetch(`${SETTINGS.hubUrl}/api/limits`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${SETTINGS.hubToken}` },
    body: JSON.stringify(s), signal: AbortSignal.timeout(8000) }).catch(() => {});
}

export function render(s, args = []) {
  console.log(title(t("İşçi havuzları (kendi kotaları)")));
  const label = { ready: c.green(t("hazır")), limited: c.red(t("limitte")), login: c.yellow(t("giriş gerekiyor")), untested: c.gray(t("denenmedi")), off: c.gray(t("kurulu değil")) };
  for (const w of s.workers) {
    const tone = w.status === "ready" ? "ok" : w.status === "limited" ? "bad" : w.status === "off" ? "off" : "warn";
    const lim = w.limit ? c.gray(` · ${w.limit.resetAt ? `${t("resets in")} ${ago(w.limit.resetAt)}` : w.limit.message}`) : "";
    const perf = w.runs ? c.gray(` · ${w.runs} ${t("runs")}, ${w.successRate}% ${t("success rate")}`) : "";
    console.log(fit(`  ${dot(tone)} ${w.name.padEnd(9)} ${label[w.status]}${lim}${perf}  ${c.gray(t(w.quota))}`));
  }
  console.log(title(t("Ücretsiz havuz (freellmapi)")));
  if (s.free.error) console.log(`  ${dot("bad")} ${c.red(s.free.error)}`);
  else for (const p of s.free) {
    const tone = p.status === "healthy" ? "ok" : p.status === "rate_limited" ? "warn" : "bad";
    const st = p.status === "healthy" ? c.green(t("sağlıklı")) : p.status === "rate_limited" ? c.yellow(`${t("limited")}${p.resumeAt ? ` · ${ago(p.resumeAt)} ${t("later")}` : ""}`) : p.status === "no_models" ? c.red("no models available") : c.red(p.status);
    const day = p.ok24 + p.fail24 ? c.gray(` · ${t("24 sa")}: ${p.ok24} ${t("başarılı")}, ${p.fail24} ${t("hata")}`) : "";
    const models = p.models ? c.gray(`${p.models - p.cooling}/${p.models} ${t("model açık")}`) : "";
    console.log(fit(`  ${dot(tone)} ${p.name.padEnd(18)} ${st}  ${models}${day}`));
  }
  console.log(title(t("Şimdi bir iş gelse")));
  console.log(fit(`  ${c.gray(t("işçi (--via auto):"))} ${c.bold(c.cyan(s.route.worker))}${s.route.skipped.length ? c.gray(`  (${t("limited, skipped: ")}${s.route.skipped.join(", ")})`) : ""}`));
  console.log(fit(`  ${c.gray(t("sıra:"))} ${s.route.order.map((n) => (s.route.skipped.includes(n) ? c.gray(n) : c.cyan(n))).join(c.gray(" → "))}`));
  for (const [prof, r] of Object.entries(s.route.profiles ?? {}))
    console.log(fit(`  ${c.gray(`${prof.padEnd(15)}›`)} ${r.next[0] ?? c.red(t("açık model yok"))}${r.next.length > 1 ? c.gray(`, ${t("sonra ")}${r.next.slice(1).join(", ")}`) : ""}${r.cooling ? c.gray(`  (${r.cooling}/${r.models} ${t("cooling down")})`) : ""}`));
  // hub copy for the web panel
  console.log("");
}

export async function main(args = []) {
  const demoAt = args.indexOf("--demo");
  if (demoAt >= 0) {
    const file = args[demoAt + 1];
    if (!file) throw new Error("usage: limits --demo snapshot.json");
    render(JSON.parse(fs.readFileSync(file, "utf8")), ["--local"]);
    return;
  }
  const s = await snapshot();
  render(s, args);
  if (!args.includes("--local")) await push(s);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
