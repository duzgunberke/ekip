// ekip doctor [--fix]: one pass over everything ekip depends on, with a verdict per part, and with
// --fix the repairs that are safe to automate (tunnel restart, re-ingesting failed wikis, re-syncing
// failed code graphs, re-running the history import).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME, REMOTE, SETTINGS, TUNNEL_LABEL, healthy, keyCounts, sleep, tdaiUp } from "./core.js";
import { c, dot, mark, title } from "./ui.js";

const line = (state, label, detail = "") => console.log(`  ${dot(state)} ${label.padEnd(26)} ${detail}`);

const LABEL = "io.ekip.doctor";

// launchd runs `ekip doctor --fix` every 30 minutes, so slow or interrupted indexing finishes on its own.
function install() {
  const plist = path.join(process.env.HOME, "Library/LaunchAgents", `${LABEL}.plist`);
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "../bin/ekip.js");
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
  console.log(`${mark()}  ${c.gray(fix ? "doktor · onarım modu" : "doktor · sadece kontrol (onarmak için --fix)")}`);
  let problems = 0;

  console.log(title("Bağlantı"));
  if (REMOTE) {
    const t = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${TUNNEL_LABEL}`], { encoding: "utf8" });
    const running = /state = running/.test(t.stdout ?? "");
    line(running ? "ok" : "bad", "VPS tüneli", running ? `${REMOTE.ssh} açık` : "kapalı");
    if (!running) { problems++; if (fix) { spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${TUNNEL_LABEL}`]); await sleep(4000); line("warn", "", "tünel yeniden başlatıldı"); } }
  }
  const free = await healthy();
  line(free ? "ok" : "bad", "freellmapi", free ? `${keyCounts().length} sağlayıcı` : "erişilemiyor");
  if (!free) problems++;
  const mem = await tdaiUp();
  line(mem ? "ok" : "bad", "TencentDB", mem ? "açık" : "erişilemiyor");
  if (!mem) { problems++; console.log(`\n  ${c.red("Hafıza servisine ulaşılamıyor; proje kontrolleri atlandı.")}`); return 1; }

  const m = await import("./memory.js");
  const { pool } = await import("./projects.js");
  let projects = [];
  try { projects = JSON.parse(fs.readFileSync(path.join(HOME, "projects.json"), "utf8")); } catch { /* none */ }

  console.log(title(`Projeler (${projects.length})`));
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
    const state = badGraphs.length || wikiBad ? "bad" : busy || unknown || !["ready", "-"].includes(w) ? "warn" : "ok";
    if (state === "bad") problems++;
    const wikiText = wikiBad ? c.red("başarısız") : w === "ready" ? c.green(`hazır${r.wiki.pages ? ` · ${r.wiki.pages} sayfa` : ""}`) : w === "error" ? c.gray("sorgulanamadı") : c.yellow(w === "processing" ? "işleniyor" : w);
    line(state, r.p.name, `${c.gray("graph")} ${ready}/${r.graphs.length}${busy ? c.yellow(` (${busy} işleniyor)`) : ""}${badGraphs.length ? c.red(` (${badGraphs.length} hatalı)`) : ""}${unknown ? c.gray(` (${unknown} sorgulanamadı)`) : ""}  ${c.gray("wiki")} ${wikiText}  ${c.gray("hafıza")} ${r.hits ? c.green(`${r.hits}+ kayıt`) : c.gray("henüz yok")}`);
    if (wikiBad) repairs.push(["wiki", r.p]);
    if (badGraphs.length) repairs.push(["graph", r.p]);
  }

  console.log(title("Vektör indeksi"));
  const st = REMOTE
    ? spawnSync("ssh", ["-o", "BatchMode=yes", REMOTE.ssh, "docker exec tdai-memory-core cat /data/tdai-memory/backfill.state.json 2>/dev/null; docker exec tdai-memory-core pgrep -f backfill.mjs >/dev/null && echo RUNNING"], { encoding: "utf8" }).stdout
    : spawnSync("sh", ["-c", "docker exec tdai-memory-core cat /data/tdai-memory/backfill.state.json 2>/dev/null; docker exec tdai-memory-core pgrep -f backfill.mjs >/dev/null && echo RUNNING"], { encoding: "utf8" }).stdout;
  let bf = null; try { bf = JSON.parse((st ?? "").split("\n")[0]); } catch { /* none */ }
  const running = /RUNNING/.test(st ?? "");
  if (bf?.layer === "done") line("ok", "vektörler", "tüm kayıtlar vektörlü");
  else if (bf) { line(running ? "warn" : "bad", "vektörler", `${bf.layer} ${bf.done}/${bf.total} (%${Math.round((bf.done / Math.max(1, bf.total)) * 100)})${running ? " · dolduruluyor" : " · durdu"}`); if (!running) { problems++; if (fix) { spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "../bin/ekip.js"), "memory", "reindex"], { stdio: "inherit" }); } } }
  else line("warn", "vektörler", "doldurma hiç çalışmadı (ekip memory reindex)");

  console.log(title("Geçmiş oturumlar"));
  let done = 0;
  try { done = JSON.parse(fs.readFileSync(path.join(HOME, "memory-state/asset-import.json"), "utf8")).done?.length ?? 0; } catch { /* none */ }
  line(done ? "ok" : "warn", "içe aktarılan", `${done} öğe`);

  if (fix && repairs.length) {
    console.log(title("Onarım"));
    for (const [kind, p] of repairs) {
      try {
        if (kind === "wiki") { const r = await m.ingestWiki(p); line("warn", p.name, `wiki yeniden kuyrukta (${r.files ?? "?"} dosya)`); }
        else { const r = await m.syncCodeGraphs(p); line("warn", p.name, `${r.length} graph yeniden senkron`); }
      } catch (e) { line("bad", p.name, c.red(e.message.slice(0, 120))); }
    }
  }
  console.log(`\n  ${problems ? c.yellow(`${problems} sorun${fix ? " · onarılabilenler başlatıldı, birkaç dakika sonra tekrar bak" : " · onarmak için: ekip doctor --fix"}`) : c.green("her şey yolunda")}\n`);
  void SETTINGS;
  return problems ? 1 : 0;
}
