// ekip mesai: the work shift. While it is on, the lead splits each request into as many
// independent parts as the pools can take and keeps every ready pool busy at once; `--via auto`
// already skips pools at capacity (agents.js), so parallel runs spread over them by themselves.
// `ekip mesai all "task"` (in ekip.js) races one task on every pool with a free slot.
import { SETTINGS, die, saveSettings } from "../core/core.js";
import { c, dot, fit, title } from "../core/ui.js";
import { t } from "../core/i18n.js";
import { freePools, poolCapacity, poolLoad, poolScore } from "./agents.js";
import { workerPools } from "./limits.js";

const STATUS = { ready: ["ok", "hazır"], limited: ["bad", "limitte"], login: ["warn", "giriş gerekiyor"], untested: ["warn", "denenmedi"], off: ["off", "kurulu değil"] };

/** Every pool with its state, running/capacity and success rate (the claude pool only when mesai includes it). */
export function poolRows() {
  const load = poolLoad();
  const rows = workerPools().map((w) => ({ name: w.name, status: w.status, ...load[w.name], successRate: w.successRate }));
  const sc = poolScore("free");
  rows.push({ name: "free", status: "ready", ...load.free, successRate: sc.runs ? Math.round(sc.rate * 100) : null });
  if (poolCapacity("claude") > 0) {
    const cl = poolScore("claude");
    rows.push({ name: "claude", status: "ready", ...load.claude, successRate: cl.runs ? Math.round(cl.rate * 100) : null });
  }
  return rows;
}

function status() {
  const on = !!SETTINGS.mesai;
  console.log(title(`${on ? c.green(t("Mesai modu: açık")) : c.gray(t("Mesai modu: kapalı"))}${on && SETTINGS.mesaiClaude ? c.gray(` (${t("claude dahil")})`) : ""}`));
  let busy = 0, cap = 0;
  for (const r of poolRows()) {
    const [tone, label] = STATUS[r.status] ?? ["off", r.status];
    const usable = r.status === "ready";
    if (usable) { busy += r.running; cap += r.capacity; }
    const full = usable && r.running >= r.capacity;
    const load = `${r.running}/${r.capacity}`;
    const rate = r.successRate == null ? t("başarı oranı yok") : `${r.successRate}% ${t("success rate")}`;
    console.log(fit(`  ${dot(tone)} ${r.name.padEnd(9)} ${(usable ? c.green : tone === "bad" ? c.red : c.yellow)(t(label))}${" ".repeat(Math.max(1, 16 - t(label).length))}${full ? c.yellow(load) : c.cyan(load)} ${c.gray(t("çalışıyor"))}  ${c.gray(`· ${rate}`)}`));
  }
  console.log(fit(`\n  ${c.gray(t("boş kapasite:"))} ${c.bold(String(Math.max(0, cap - busy)))} ${c.gray(`/ ${cap}`)}`));
  console.log(fit(`  ${c.gray(t("boş havuzlar:"))} ${freePools().map((x) => c.cyan(x)).join(c.gray(", ")) || c.gray("-")}`));
  if (!on) console.log(fit(`  ${c.gray(t("açmak için: ekip mesai on [--include-claude]"))}`));
}

export async function main([sub = "status", ...args]) {
  if (sub === "on") {
    saveSettings({ mesai: true, mesaiClaude: args.includes("--include-claude") });
    console.log(`${dot("ok")} ${t("mesai modu açık: lead işleri tüm hazır havuzlara paralel dağıtacak (yeni ekip oturumlarında)")}`);
    status();
  } else if (sub === "off") {
    saveSettings({ mesai: false, mesaiClaude: false });
    console.log(`${dot("off")} ${t("mesai modu kapalı")}`);
  } else if (sub === "status" || sub === "ls") status();
  else die('usage: ekip mesai on [--include-claude] | off | status | all "task"');
}
