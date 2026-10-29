// ekip doctor [--fix]: one pass over everything ekip depends on, with a verdict per part, and with
// --fix the repairs that are safe to automate (tunnel restart, re-ingesting failed wikis, re-syncing
// failed code graphs, re-running the history import).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME, REMOTE, SETTINGS, TDAI_CONTAINER_SH, TUNNEL_LABEL, healthy, keyCounts, notify, sleep, tdaiUp } from "../core/core.js";
import { c, dot, mark, title, fit } from "../core/ui.js";
import { lang, t } from "../core/i18n.js";

const line = (state, label, detail = "") => console.log(fit(`  ${dot(state)} ${label.padEnd(20)} ${detail}`));

const LABEL = "io.ekip.doctor";

// launchd runs `ekip doctor --fix` every 30 minutes, so slow or interrupted indexing finishes on its own.
function install() {
  const plist = path.join(process.env.HOME, "Library/LaunchAgents", `${LABEL}.plist`);
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "../../bin/ekip.js");
  const node = process.execPath;
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${bin}</string><string>doctor</string><string>--fix</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>EnvironmentVariables</key><dict><key>NO_COLOR</key><string>1</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>${path.join(process.env.HOME, "Library/Logs/ekip-doctor.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(process.env.HOME, "Library/Logs/ekip-doctor.log")}</string>
</dict></plist>
`);
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" });
  spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], { stdio: "inherit" });
  console.log(`ekip doctor --fix will run every 30 minutes (log: ~/Library/Logs/ekip-doctor.log)`);
}

export async function main(args = []) {
  if (args.includes("--install")) { install(); return 0; }
  if (args.includes("--uninstall")) { spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" }); console.log("periodic doctor removed"); return 0; }
  const fix = args.includes("--fix");
  console.log(`${mark()}  ${c.gray(fix ? t("doktor · onarım modu") : t("doktor · sadece kontrol (onarmak için --fix)"))}`);
  let problems = 0;
  const fixed = []; // what this run repaired, for one notification at the end

  const onboarding = await import("../projects/onboarding.js");
  onboarding.printGaps(await onboarding.setupGaps({ cwd: process.cwd() }), { heading: true });

  const env = onboarding.envChecks();
  console.log(title(t("Ortam")));
  line(env.gitIdentity ? "ok" : "bad", "git", env.gitIdentity ? t("kimlik tanımlı") : t("Git kimliği tanımlı değil"));
  line(env.ghAuth ? "ok" : "warn", "gh", env.ghAuth ? t("oturum açık") : env.ghInstalled ? t("gh oturumu açık değil") : t("GitHub CLI (gh) kurulu değil"));
  if (!env.gitIdentity) problems++;

  console.log(title(t("Bağlantı")));
  if (REMOTE) {
    const t = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${TUNNEL_LABEL}`], { encoding: "utf8" });
    const running = /state = running/.test(t.stdout ?? "");
    line(running ? "ok" : "bad", "VPS tüneli", running ? `${REMOTE.ssh} açık` : t("kapalı"));
    if (!running) { problems++; if (fix) { spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${TUNNEL_LABEL}`]); await sleep(4000); line("warn", "", t("tünel yeniden başlatıldı")); fixed.push(t("VPS tüneli yeniden başlatıldı")); } }
  }
  const t0 = Date.now(), free = await healthy(), slow = Date.now() - t0 > 1500;
  line(free ? (slow ? "warn" : "ok") : "bad", "freellmapi", free ? `${keyCounts().length} ${t("sağlayıcı")}${slow ? ` · ${t("yavaş")} (${((Date.now() - t0) / 1000).toFixed(1)} sn)` : ""}` : t("erişilemiyor"));
  if (!free) problems++;
  const embed = !!process.env.MEMORY_EMBEDDING_BASE_URL || (() => { try { return keyCounts({ timeout: 500 }).some(([p]) => p === "nvidia"); } catch { return false; } })();
  line(embed ? "ok" : "warn", t("vektör sağlayıcı"), embed ? t("vektörler açık") : t("anahtar kelimeye düşer") + " → ekip keys");
  const mem = await tdaiUp();
  line(mem ? "ok" : "bad", "TencentDB", mem ? t("açık") : t("erişilemiyor"));
  if (!mem) { problems++; console.log(`\n  ${c.red(t("Hafıza servisine ulaşılamıyor; proje kontrolleri atlandı."))}`); return 1; }

  const m = await import("../memory/memory.js");
  const { pool } = await import("../projects/projects.js");
  let projects = [];
  try { projects = JSON.parse(fs.readFileSync(path.join(HOME, "projects.json"), "utf8")); } catch { /* none */ }

  console.log(title(t("Projeler ({n})", { n: projects.length })));
  const rows = await pool(projects, 3, async (p) => {
    const graphs = await pool(p.tdai?.codeGraphs ?? [], 2, async (g) => ({ g, s: await m.codeGraphStatus(g.id).catch((e) => ({ status: "error", error: e.message })) }));
    const wiki = p.tdai?.wikiId ? await m.wikiStatus(p.tdai.wikiId).catch((e) => ({ status: "error", error: e.message })) : null;
    const hits = await m.recall(p, `${p.name} project`, 3, { timeoutMs: 20000 }).catch(() => []);
    return { p, graphs, wiki, hits: Array.isArray(hits) ? hits.length : 0 };
  });
  const repairs = [];
  for (const r of rows) {
    const ready = r.graphs.filter((x) => x.s.status === "ready").length;
    // "failed" is a real failure to repair; "error" means the status could not be read right now
    // (memory-core busy), which is not repaired and not counted.
    const badGraphs = r.graphs.filter((x) => x.s.status === "failed");
    const unknown = r.graphs.filter((x) => x.s.status === "error").length;
    const busy = r.graphs.length - ready - badGraphs.length - unknown;
    const w = r.wiki?.status ?? "-";
    const wikiBad = w === "failed";
    // A finished ingest can still have sources the model failed on; re-ingesting is incremental,
    // so it retries only those.
    const wikiFailedSources = w === "ready" ? r.wiki.progress?.failed ?? 0 : 0;
    const pct = r.wiki?.progress?.percent;
    const state = badGraphs.length || wikiBad ? "bad" : busy || unknown || !["ready", "-"].includes(w) ? "warn" : "ok";
    if (state === "bad") problems++;
    const wikiText = wikiBad ? c.red(t("başarısız")) : w === "ready" ? c.green(`${t("hazır")}${r.wiki.pages ? ` · ${r.wiki.pages} ${t("sayfa")}` : ""}`) + (wikiFailedSources ? c.yellow(` (${wikiFailedSources} ${t("dosya tekrar denenecek")})`) : "") : w === "error" ? c.gray(t("sorgulanamadı")) : c.yellow(w === "processing" ? `${t("işleniyor")}${pct != null ? ` %${pct}` : ""}` : w);
    line(state, r.p.name, `${c.gray(t("graph"))} ${ready}/${r.graphs.length}${busy ? c.yellow(` (${busy} ${t("işleniyor")})`) : ""}${badGraphs.length ? c.red(` (${badGraphs.length} ${t("hatalı")})`) : ""}${unknown ? c.gray(` (${unknown} ${t("sorgulanamadı")})`) : ""}  ${c.gray(t("wiki"))} ${wikiText}  ${c.gray(t("hafıza"))} ${r.hits ? c.green(`${r.hits}+ ${t("kayıt")}`) : c.gray(t("henüz yok"))}`);
    if (wikiBad || wikiFailedSources) repairs.push(["wiki", r.p]);
    if (badGraphs.length) repairs.push(["graph", r.p]);
  }

  console.log(title(t("Vektör indeksi")));
  const bfCmd = `C=$(${TDAI_CONTAINER_SH("tdai-memory-core")}); docker exec $C cat /data/tdai-memory/backfill.state.json 2>/dev/null; docker exec $C sh -c 'grep -qs backfill[.]mjs /proc/[0-9]*/cmdline' && echo RUNNING`;
  const st = REMOTE
    ? spawnSync("ssh", ["-o", "BatchMode=yes", REMOTE.ssh, bfCmd], { encoding: "utf8" }).stdout
    : spawnSync("sh", ["-c", bfCmd], { encoding: "utf8" }).stdout;
  let bf = null; try { bf = JSON.parse((st ?? "").replace(/RUNNING/g, "").trim().split("\n")[0]); } catch { /* none */ }
  const running = /RUNNING/.test(st ?? "");
  if (bf?.layer === "done") line("ok", t("vektörler"), t("tüm kayıtlar vektörlü"));
  else if (bf) { line(running ? "warn" : "bad", t("vektörler"), `${bf.layer} ${bf.done}/${bf.total} (%${Math.round((bf.done / Math.max(1, bf.total)) * 100)})${running ? ` · ${t("dolduruluyor")}` : ` · ${t("durdu")}`}`); if (!running) { problems++; if (fix) { spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "../../bin/ekip.js"), "memory", "reindex"], { stdio: "inherit" }); fixed.push(t("durmuş vektör doldurma yeniden başlatıldı")); } } }
  else line("warn", t("vektörler"), t("doldurma hiç çalışmadı (ekip memory reindex)"));
  // for the setup gaps shown at the lead start (onboarding.js reads it without a network call)
  try { fs.writeFileSync(path.join(HOME, "vectors-status.json"), JSON.stringify({ at: Date.now(), missing: bf?.layer === "done" ? 0 : bf ? (running ? 0 : Math.max(0, bf.total - bf.done)) : 0, never: !bf })); } catch { /* best effort */ }

  console.log(title(t("Geçmiş oturumlar")));
  let done = 0;
  try { done = JSON.parse(fs.readFileSync(path.join(HOME, "memory-state/asset-import.json"), "utf8")).done?.length ?? 0; } catch { /* none */ }
  line(done ? "ok" : "warn", t("içe aktarılan"), `${done} ${t("öğe")}`);

  if (fix && repairs.length) {
    console.log(title(t("Onarım")));
    for (const [kind, p] of repairs) {
      try {
        if (kind === "wiki") { const r = await m.ingestWiki(p); line("warn", p.name, `${t("wiki requeued")} (${r.files ?? "?"} ${t("files")})`); fixed.push(`${p.name} wiki`); }
        else { const r = await m.syncCodeGraphs(p); line("warn", p.name, `${r.length} ${t("graphs resynced")}`); fixed.push(`${p.name} ${t("kod grafiği")}`); }
      } catch (e) { line("bad", p.name, c.red(e.message.slice(0, 120))); }
    }
  }
  console.log(`\n  ${problems ? c.yellow(`${problems} ${t("sorunlar")}${fix ? ` · ${t("onarılabilenler başlatıldı, birkaç dakika sonra tekrar bak")}` : ` · ${t("onarmak için: ekip doctor --fix")}`}`) : c.green(t("her şey yolunda"))}\n`);
  // Say what was repaired without being asked, once per distinct set of repairs every 6 hours.
  if (fix && fixed.length) {
    const key = fixed.join("|"), stamp = path.join(HOME, "doctor-notified.json");
    let last = {};
    try { last = JSON.parse(fs.readFileSync(stamp, "utf8")); } catch { /* first */ }
    if (last.key !== key || Date.now() - (last.at ?? 0) > 6 * 3600_000) {
      notify(t("ekip kendini onardı"), fixed.join(" · "), { subtitle: t("Otomatik bakım"), group: "ekip-doctor" });
      try { fs.writeFileSync(stamp, JSON.stringify({ key, at: Date.now() })); } catch { /* best effort */ }
    }
  }
  void SETTINGS;
  return problems ? 1 : 0;
}
