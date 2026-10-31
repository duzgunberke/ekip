// Work that runs behind the user's tasks: the memory service embedding records (which provider, how
// many waiting, the last success, the last error), the vector backfill, the Claude history import and
// wiki / code graph reindexing. Read from small files only, so the task pane can show it every two
// seconds: freellmapi's routing snapshot (data/freellmapi-routing-last.json, `ekip limits`), the
// doctor's vector and index readings (data/vectors-status.json, data/index-status.json) and the
// import lock. One line in the pane (only when something runs or failed), a section in `ekip durum`,
// and the same list in the limits snapshot for the hub panel.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/core.js";
import { c } from "../core/ui.js";
import { t, lang } from "../core/i18n.js";
import { PROVIDER_NAMES } from "../workers/pool-view.js";

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(HOME, f), "utf8")); } catch { return null; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const minsAgo = (iso, at) => Math.max(0, Math.round((at - Date.parse(iso)) / 60000));
const agoText = (iso, at) => { const m = minsAgo(iso, at); return m < 1 ? t("az önce") : m < 60 ? t("{n} dk önce", { n: m }) : m < 2880 ? t("{n} sa önce", { n: Math.round(m / 60) }) : t("{n} gün önce", { n: Math.round(m / 1440) }); };

/**
 * [{ id, label, state: "running" | "error" | "ok", detail }]. Inputs default to the files; tests pass them.
 */
export function backgroundJobs({ routing = readJson("freellmapi-routing-last.json")?.rs, vectors = readJson("vectors-status.json"), index = readJson("index-status.json"), importPid = undefined, at = Date.now() } = {}) {
  const out = [];
  // embeddings through freellmapi: the provider that served most in the last day, and the last error
  const emb = Object.entries(routing?.embeddings ?? {});
  if (emb.length) {
    const [id, best] = emb.sort((a, b) => (b[1].ok24 ?? 0) - (a[1].ok24 ?? 0))[0];
    const recent = emb.map(([, e]) => e.lastAt).filter(Boolean).sort().at(-1);
    const failing = emb.every(([, e]) => (e.ok24 ?? 0) === 0 && (e.fail24 ?? 0) > 0) || (best.lastStatus && best.lastStatus !== "success" && (best.fail24 ?? 0) > (best.ok24 ?? 0));
    const running = recent && at - Date.parse(recent) < 5 * 60_000;
    const name = PROVIDER_NAMES[id] ?? id;
    const parts = [name, ...(vectors?.queue > 0 ? [t("kuyrukta {n}", { n: vectors.queue })] : []), ...(best.lastOkAt ? [`${t("son başarı")} ${agoText(best.lastOkAt, at)}`] : []), ...(failing && best.lastError ? [String(best.lastError).slice(0, 80)] : [])];
    out.push({ id: "embeddings", label: t("vektörleme"), state: failing ? "error" : running ? "running" : "ok", detail: parts.join(" · ") });
  }
  // the backfill the doctor measured (layer done/total, running or stopped)
  if (vectors?.layer && vectors.layer !== "done") {
    const pct = vectors.total ? Math.round((vectors.done / vectors.total) * 100) : null;
    out.push({ id: "backfill", label: t("vektör doldurma"), state: vectors.running ? "running" : "error", detail: `${vectors.done ?? 0}/${vectors.total ?? "?"}${pct != null ? ` (${lang === "en" ? `${pct}%` : `%${pct}`})` : ""}${vectors.running ? "" : ` · ${t("durdu")} → ekip memory reindex`}` });
  }
  // the Claude history import holds a lock with its pid while it runs
  let pid = importPid;
  if (pid === undefined) { try { pid = Number(fs.readFileSync(path.join(HOME, "import-history.lock"), "utf8")); } catch { pid = 0; } }
  if (alive(pid)) out.push({ id: "import", label: t("konuşma içe aktarma"), state: "running", detail: t("Claude geçmişi hafızaya aktarılıyor") });
  // wiki and code graph ingests the doctor saw in progress or failed (index-status.json)
  for (const p of (index?.projects ?? []).filter((x) => x.busy || x.failed)) {
    out.push({ id: `index:${p.name}`, label: t("indeksleme"), state: p.failed ? "error" : "running", detail: `${p.name}: ${[...(p.wiki ? [`wiki ${p.wiki}`] : []), ...(p.graphs ? [t("{n} kod grafiği", { n: p.graphs })] : [])].join(", ")}${p.failed ? ` · ${t("hatalı")} → ekip doctor --fix` : ""}` });
  }
  return out;
}

/** Only what is worth a glance: running or failed. */
export const notable = (jobs) => jobs.filter((j) => j.state !== "ok");

/** The pane's single line: "arka plan  ● vektörleme NVIDIA · kuyrukta 120  ● içe aktarma"; [] when quiet. */
export function backgroundLine(jobs, width, st) {
  const list = notable(jobs);
  if (!list.length) return [];
  const label = t("arka plan");
  let line = ` ${st.muted(label)}`, used = 1 + [...label].length;
  for (const j of list) {
    const state = j.state === "error" ? "failed" : "running";
    const sym = st.ascii ? (j.state === "error" ? "x" : "*") : j.state === "error" ? "✗" : "●";
    const room = width - 1 - used - 3 - 2 - [...j.label].length - 1;
    if (room < 4) break;
    const detail = j.detail ? clipWords(j.detail, room) : "";
    line += `   ${st.state(state, sym)} ${j.label}${detail ? ` ${st.muted(detail)}` : ""}`;
    used += 3 + 2 + [...j.label].length + (detail ? 1 + [...detail].length : 0);
  }
  return [line];
}

// whole words and "…", as the pane's clip does (kept local so this module needs no pane import)
function clipWords(s, n) {
  if ([...s].length <= n) return s;
  let out = "";
  for (const w of s.split(" ")) { const next = out ? `${out} ${w}` : w; if ([...next].length > n - 1) break; out = next; }
  return out ? `${out.replace(/[\s,.;:·-]+$/, "")}…` : "";
}

/** The "Arka plan" section of `ekip durum` (every job, the quiet ones too). */
export function statusSection(jobs) {
  const lines = [`\n${c.bold(t("Arka plan"))}`];
  if (!jobs.length) lines.push(c.gray(`  ${t("arka planda iş yok")}`));
  for (const j of jobs) lines.push(`  ${j.state === "error" ? c.red("✗") : j.state === "running" ? c.cyan("●") : c.green("✓")} ${j.label}${j.detail ? c.gray(` · ${j.detail}`) : ""}`);
  return lines.join("\n");
}
