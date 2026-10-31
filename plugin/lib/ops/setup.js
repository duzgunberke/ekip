// ekip setup (ekip kurulum): one model of what a working ekip needs, step by step. Each step has an id,
// a title, one sentence on why it matters, the command that completes it, a level (required,
// recommended, optional) and a check. The checks reuse onboarding.js (the same gaps the lead start and
// the SessionStart hook show) and run in about a second; their result is cached in
// data/setup-state.json, which the task pane, WezTerm's status bar, `ekip durum` and the hub read
// without checking again.
//
//   ekip setup              guided: "Kurulum 5/9", and per missing step: now / later / skip
//   ekip setup --list       the list (also what a non-interactive run prints); --json for scripts
//   ekip setup snooze ID [days] | unsnooze ID
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HOME, REMOTE, ROOT, SETTINGS, KEYLESS, ask, askSecret, has, healthy, keyCounts, openUrl, saveSettings, tdaiUp } from "../core/core.js";
import { c, mark } from "../core/ui.js";
import { lang, t } from "../core/i18n.js";
import { snooze, snoozed, unsnooze } from "./snooze.js";

export const STATE_FILE = () => path.join(HOME, "setup-state.json");
const TTL = 10 * 60_000;
const EKIP = path.join(ROOT, "plugin/bin/ekip.js");
const run = (cmd, args, timeout = 3000) => spawnSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
// "skip" in the wizard: the reminder stays off for good (unsnooze brings it back)
const SKIP_DAYS = 3650;

// ---- the facts every check reads, gathered once --------------------------------------------------

/** Everything the checks need, in one pass (two probes with a one-second limit, the rest local). */
export async function facts({ cwd = process.cwd() } = {}) {
  const onboarding = await import("../projects/onboarding.js");
  let keys = [];
  try { keys = keyCounts({ timeout: 800 }); } catch { /* service or database unavailable */ }
  const [freeUp, memUp] = await Promise.all([healthy(2000).catch(() => false), tdaiUp(1500).catch(() => false)]);
  let projects = [];
  try { projects = JSON.parse(fs.readFileSync(path.join(HOME, "projects.json"), "utf8")).filter((p) => p?.name); } catch { /* none */ }
  let vectors = null;
  try { vectors = JSON.parse(fs.readFileSync(path.join(HOME, "vectors-status.json"), "utf8")); } catch { /* not measured yet */ }
  const docker = REMOTE ? { ok: true } : (() => { const r = run("docker", ["info", "--format", "{{.ServerVersion}}"], 4000); return { installed: !r.error || r.error.code !== "ENOENT", ok: r.status === 0 }; })();
  const { weztermInstalled } = await import("./terminal.js");
  const agents = await import("../workers/agents.js");
  const logged = Object.entries(SETTINGS.agents ?? {}).filter(([n, a]) => a?.ok && agents.AGENTS[n] && !agents.AGENTS[n].hidden?.() && has(agents.AGENTS[n].bin)).map(([n]) => n);
  return {
    platform: process.platform, node: Number(process.versions.node.split(".")[0]), git: has("git"), claude: has("claude"), docker,
    env: onboarding.envChecks(), onPath: has("ekip") || fs.existsSync(path.join(os.homedir(), ".local/bin/ekip")),
    freeUp, memUp, keys: keys.filter(([p]) => !KEYLESS.includes(p)), embeddings: onboarding.embeddingsReady(keys), logged,
    projects, projectGaps: projects.filter((p) => p.path).map((p) => ({ name: p.name, gaps: onboarding.projectGaps(p) })), vectors,
    wezterm: weztermInstalled(), terminal: SETTINGS.terminal ?? null, notifier: has("terminal-notifier"), hub: !!(SETTINGS.hubUrl && SETTINGS.hubToken), cwd,
  };
}

// ---- the steps ------------------------------------------------------------------------------------

const projectCmd = (f) => (fs.existsSync(path.join(f.cwd, ".git")) ? "ekip project add ." : `ekip project scan ${SETTINGS.projectsRoot ?? "~/Projects"}`);

/**
 * The steps in the order the wizard walks them. check(facts) → { done, detail?, command? } (command
 * when the way to finish it depends on what is missing).
 */
export const STEPS = [
  { id: "prereqs", level: "required", title: "Önkoşullar", short: "önkoşullar", why: "ekip Node 22+, git, Claude Code ve (servisler bu Mac'te çalışıyorsa) Docker ile çalışır", command: "brew install node git && open -a Docker",
    check: (f) => {
      const miss = [...(f.node < 22 ? ["Node 22+"] : []), ...(!f.git ? ["git"] : []), ...(!f.claude ? ["Claude Code"] : []), ...(!f.docker.ok ? [f.docker.installed === false ? "Docker" : t("Docker çalışmıyor")] : []), ...(!f.env.gitIdentity ? [t("git kimliği")] : [])];
      const command = !f.env.gitIdentity && miss.length === 1 ? 'git config --global user.name "Ad Soyad" && git config --global user.email you@example.com' : !f.docker.ok && f.docker.installed !== false && miss.length === 1 ? "open -a Docker" : null;
      return { done: !miss.length, detail: miss.length ? `${t("eksik")}: ${miss.join(", ")}` : null, command };
    } },
  { id: "services", level: "required", title: "ekip servisleri (ekip init)", short: "servisler", why: "ücretsiz model havuzu ve hafıza servisi olmadan işçiler ve proje hafızası çalışmaz", command: "ekip init",
    check: (f) => {
      const miss = [...(!f.onPath ? ["ekip PATH"] : []), ...(!f.freeUp ? ["freellmapi"] : []), ...(!f.memUp ? [t("hafıza servisi")] : [])];
      const command = !f.onPath ? "ekip init" : !f.freeUp ? "ekip up" : !f.memUp ? "ekip memory up" : null;
      return { done: !miss.length, detail: miss.length ? `${t("kapalı")}: ${miss.join(", ")}` : null, command };
    } },
  { id: "keys", level: "required", title: "Ücretsiz model anahtarları", short: "model anahtarları", why: "ücretsiz model havuzu küçük işleri, hafıza çıkarımını ve wiki'yi Claude kotan dışında yapar", command: "ekip keys",
    check: (f) => ({ done: f.keys.length > 0, detail: f.keys.length ? t("{n} sağlayıcı: {list}", { n: f.keys.length, list: f.keys.map(([p]) => p).join(", ") }) : t("anahtar yok") }) },
  { id: "embeddings", level: "required", title: "Vektör sağlayıcı (embedding)", short: "vektör sağlayıcı", why: "vektör yoksa hafıza ve wiki araması anahtar kelimeye düşer, anlamca yakın kayıtlar bulunmaz", command: "ekip key add nvidia <anahtar>",
    check: (f) => ({ done: f.embeddings, detail: f.embeddings ? (process.env.MEMORY_EMBEDDING_BASE_URL ? "MEMORY_EMBEDDING_BASE_URL" : f.keys.filter(([p]) => ["nvidia", "openrouter"].includes(p)).map(([p]) => p).join(", ")) : t("NVIDIA ya da OpenRouter anahtarı yok (build.nvidia.com, ücretsiz)") }) },
  { id: "agents", level: "required", title: "İşçi CLI girişleri", short: "işçi girişleri", why: "iş, Claude kotan dışındaki en az iki havuza dağıtılabilsin", command: "ekip agents login",
    check: (f) => { const n = f.logged.length + (f.keys.length ? 1 : 0); return { done: n >= 2, detail: t("{n} havuz hazır{list}", { n, list: n ? `: ${[...f.logged, ...(f.keys.length ? ["free"] : [])].join(", ")}` : "" }) }; } },
  { id: "project", level: "required", title: "En az bir proje kaydı", short: "proje kaydı", why: "projenin kartı, hafızası, wiki'si ve kod grafiği olmadan işçiler her işe sıfırdan başlar", command: "ekip project add <klasör>",
    check: (f) => ({ done: f.projects.length > 0, detail: f.projects.length ? t("{n} proje kayıtlı", { n: f.projects.length }) : null, command: f.projects.length ? null : projectCmd(f) }) },
  { id: "index", level: "required", title: "Proje hafızası, wiki, kod grafiği ve vektör indeksi", short: "hafıza indeksi", why: "eksik ya da bayat indeksle işçiler kodu, belgeleri ve eski kararları bulamaz", command: "ekip project sync <proje>",
    check: (f) => {
      if (!f.projects.length) return { done: false, detail: t("önce bir proje kaydedin"), command: projectCmd(f) };
      const open = f.projectGaps.filter((x) => x.gaps.length);
      const vec = f.vectors?.never ? t("vektörler hiç oluşturulmamış") : f.vectors?.missing > 0 ? t("{n} kayıt vektörsüz", { n: f.vectors.missing }) : null;
      const parts = [...open.slice(0, 3).map((x) => `${x.name}: ${[...new Set(x.gaps.map((g) => g.title))].join(", ")}`), ...(open.length > 3 ? [t("+{n} proje", { n: open.length - 3 })] : []), ...(vec ? [vec] : [])];
      const first = open[0]?.gaps[0]?.command ?? (vec ? "ekip memory reindex" : null);
      return { done: !parts.length, detail: parts.join(" · ") || null, command: first };
    } },
  { id: "terminal", level: "recommended", only: "darwin", title: "ekip'in kendi terminali (WezTerm)", short: "terminal", why: "görev bölmesi, proje sekmeleri ve durum çubuğu en net WezTerm'de görünür", command: "ekip terminal install",
    check: (f) => ({ done: f.wezterm && f.terminal === "wezterm", detail: !f.wezterm ? t("WezTerm kurulu değil") : f.terminal !== "wezterm" ? t("varsayılan değil") : null, command: f.wezterm ? "ekip terminal default wezterm" : null }) },
  { id: "notify", level: "recommended", only: "darwin", title: "Bildirimler (terminal-notifier)", short: "bildirimler", why: "biten ve takılan işler ekip logosuyla macOS bildirimi olarak gelir", command: "brew install terminal-notifier",
    check: (f) => ({ done: f.notifier }) },
  { id: "hub", level: "optional", title: "Hub (web paneli, Mac kapalıyken iş kuyruğu)", short: "hub", why: "web paneli ve Mac kapalıyken çalışan hafıza, ücretsiz havuz ve iş kuyruğu", command: "ekip hub local",
    check: (f) => ({ done: f.hub }) },
];

// a fake result for a step, for tests and demos: EKIP_SETUP_FAKE="keys=done,agents=missing"
function fakes(env = process.env) {
  return Object.fromEntries(String(env.EKIP_SETUP_FAKE ?? "").split(",").map((x) => x.trim().split("=")).filter(([k]) => k).map(([k, v]) => [k, v !== "missing"]));
}

/** Runs every check: [{ id, level, title, short, why, command, done, detail, snoozed }]. */
export function evaluate(f, { steps = STEPS, overrides = {}, env = process.env } = {}) {
  const fake = fakes(env);
  return steps.filter((s) => !s.only || s.only === f.platform).map((s) => {
    let r;
    try { r = overrides[s.id] ? overrides[s.id](f) : s.check(f); } catch (e) { r = { done: false, detail: e.message }; }
    if (s.id in fake) r = { ...r, done: fake[s.id] };
    return { id: s.id, level: s.level, title: t(s.title), short: t(s.short), why: t(s.why), command: r.command ?? s.command, done: !!r.done, detail: r.detail ?? null, snoozed: !r.done && snoozed(s.id) };
  });
}

/** Counts: done/total over required and recommended steps; what is missing, by level. */
export function summary(steps) {
  const counted = steps.filter((s) => s.level !== "optional");
  const open = (lvl) => steps.filter((s) => s.level === lvl && !s.done);
  return {
    done: counted.filter((s) => s.done).length, total: counted.length,
    required: open("required"), recommended: open("recommended"), optional: open("optional"),
    // what the reminders name: missing required steps the user did not silence
    remind: open("required").filter((s) => !s.snoozed),
  };
}

/** Checks now (or reads the fresh cache) and writes data/setup-state.json. */
export async function checkSetup({ refresh = false, cwd = process.cwd(), overrides = {}, env = process.env } = {}) {
  if (!refresh && !Object.keys(overrides).length && !env.EKIP_SETUP_FAKE) {
    const c = cachedSetup({ maxAge: TTL });
    if (c) return c.steps;
  }
  const steps = evaluate(await facts({ cwd }), { overrides, env });
  try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(`${STATE_FILE()}.${process.pid}.tmp`, JSON.stringify({ at: Date.now(), lang, steps })); fs.renameSync(`${STATE_FILE()}.${process.pid}.tmp`, STATE_FILE()); } catch { /* cache is best effort */ }
  return steps;
}

/** The last checked state, without checking: { at, steps } or null (older than maxAge, or none). */
export function cachedSetup({ maxAge = Infinity } = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    if (!Array.isArray(s.steps) || Date.now() - s.at > maxAge) return null;
    // a snooze set after the check still counts
    return { ...s, steps: s.steps.map((x) => ({ ...x, snoozed: !x.done && snoozed(x.id) })) };
  } catch { return null; }
}

/** For the pane and the status bar: the cached state, refreshed in the background when it is old. */
export function setupBadge({ refreshAfter = TTL, spawnRefresh = true } = {}) {
  const c = cachedSetup();
  if (spawnRefresh && (!c || Date.now() - c.at > refreshAfter)) refreshInBackground();
  if (!c) return null;
  const s = summary(c.steps);
  return { done: s.done, total: s.total, missing: s.remind.map((x) => x.short), at: c.at };
}

let refreshing = 0;
function refreshInBackground() {
  if (Date.now() - refreshing < 60_000) return;
  refreshing = Date.now();
  try { spawn(process.execPath, [EKIP, "setup", "--refresh", "--quiet"], { detached: true, stdio: "ignore" }).unref(); } catch { /* next time */ }
}

// ---- the one-line reminder ------------------------------------------------------------------------

/**
 * "kurulum 5/9 · eksik: model anahtarları, vektör sağlayıcı → ekip setup" in at most `width` columns:
 * missing names drop from the end ("+2"), then the list, then the command; never a cut word.
 * measure: a column counter (the pane's, for wide glyphs).
 */
export function stripText(badge, width, measure = (s) => [...s].length) {
  if (!badge || !badge.missing?.length) return "";
  const head = `${t("kurulum")} ${badge.done}/${badge.total}`, cmd = "→ ekip setup";
  const names = badge.missing;
  for (let n = names.length; n >= 1; n--) {
    const more = names.length - n;
    const s = `${head} · ${t("eksik")}: ${names.slice(0, n).join(", ")}${more ? ` +${more}` : ""} ${cmd}`;
    if (measure(s) <= width) return s;
  }
  for (const s of [`${head} ${cmd}`, head]) if (measure(s) <= width) return s;
  return "";
}

// ---- output ---------------------------------------------------------------------------------------

const progress = (s, cells = 18) => { const n = Math.round((s.done / Math.max(1, s.total)) * cells); return `${c.green("━".repeat(n))}${c.gray("━".repeat(cells - n))}`; };
const levelLabel = (l) => (l === "required" ? t("zorunlu") : l === "recommended" ? t("önerilen") : t("isteğe bağlı"));

export function printList(steps, { out = console.log, heading = true } = {}) {
  const s = summary(steps);
  if (heading) out(`${mark()}  ${c.bold(`${t("Kurulum")} ${s.done}/${s.total}`)}  ${progress(s)}`);
  for (const x of steps) {
    const sym = x.done ? c.green("✓") : x.level === "required" ? c.yellow("●") : c.gray("○");
    const tag = x.done ? "" : c.gray(` · ${levelLabel(x.level)}${x.snoozed ? ` · ${t("susturuldu")}` : ""}`);
    out(`  ${sym} ${x.done ? x.title : c.bold(x.title)}${tag}${x.detail ? c.gray(` · ${x.detail}`) : ""}`);
    if (!x.done) out(`      ${c.gray(x.why)}\n      ${c.cyan(x.command)}`);
  }
  if (!s.required.length && !s.recommended.length) out(`\n  ${c.green(t("kurulum tamam"))}`);
}

/** The "Kurulum" section at the bottom of `ekip durum`: only what is missing, with its command. */
export function statusSection(steps) {
  const s = summary(steps);
  const open = [...s.required, ...s.recommended];
  const lines = [`\n${c.bold(`${t("Kurulum")} ${s.done}/${s.total}`)}`];
  if (!open.length) lines.push(c.gray(`  ${t("kurulum tamam")}`));
  for (const x of open) lines.push(`  ${x.level === "required" ? c.yellow("●") : c.gray("○")} ${x.title}${x.detail ? c.gray(` · ${x.detail}`) : ""}  ${c.cyan(x.command)}`);
  if (open.length) lines.push(c.gray(`  ${t("adım adım: ekip setup")}`));
  return lines.join("\n");
}

// ---- the wizard -----------------------------------------------------------------------------------

const ekip = (args) => [process.execPath, [EKIP, ...args]];
const tracked = (label, args) => ekip(["track", "--label", label, "--", process.execPath, EKIP, ...args]);

/**
 * What "now" runs for a step: a list of [cmd, args] (interactive ones inherit the terminal), or a
 * function for the steps that ask first. Long indexing runs detached under `ekip track`.
 */
export function actions(step, f, { ask: prompt = ask, secret = askSecret, open = openUrl } = {}) {
  switch (step.id) {
    case "keys": return [ekip(["keys"])];
    case "agents": return [ekip(["agents", "install"]), ekip(["agents", "login"])];
    case "embeddings": return async () => {
      console.log(`  ${t("NVIDIA'nın anahtar sayfası açılıyor; ücretsiz bir anahtar oluşturup buraya yapıştırın (Enter: atla).")}`);
      open("https://build.nvidia.com/settings/api-keys");
      const k = await secret(`  ${t("anahtar")}: `).catch(() => "");
      return k ? [ekip(["key", "add", "nvidia", k])] : [];
    };
    case "project": return async () => {
      const def = fs.existsSync(path.join(f.cwd, ".git")) ? f.cwd : SETTINGS.projectsRoot ?? path.join(os.homedir(), "Projects");
      const dir = (await prompt(`  ${t("klasör (tek proje ya da projelerin üst klasörü)")} [${def}]: `)).trim() || def;
      const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
      return [fs.existsSync(path.join(abs, ".git")) ? ekip(["project", "add", abs]) : ekip(["project", "scan", abs, "--days", "30", "--yes"])];
    };
    case "index": {
      const cmds = [];
      for (const p of f.projectGaps.filter((x) => x.gaps.length)) {
        if (p.gaps.some((g) => g.id !== "history" && g.id !== "card")) cmds.push(tracked(`${p.name}: ${t("wiki ve kod grafiği")}`, ["project", "sync", p.name]));
        if (p.gaps.some((g) => g.id === "card")) cmds.push(ekip(["project", "card", p.name]));
      }
      if (f.projectGaps.some((x) => x.gaps.some((g) => g.id === "history"))) cmds.push(tracked(t("Claude geçmişi hafızaya"), ["memory", "import-history"]));
      if (f.vectors?.never || f.vectors?.missing > 0) cmds.push(ekip(["memory", "reindex"]));
      return cmds;
    }
    case "services": return [f.onPath ? (f.freeUp ? ekip(["memory", "up"]) : ekip(["up"])) : ekip(["init", "--no-keys"])];
    case "terminal": return [...(f.wezterm ? [] : [ekip(["terminal", "install"])]), ekip(["terminal", "default", "wezterm"])];
    case "notify": return has("brew") ? [["brew", ["install", "terminal-notifier"]]] : [];
    case "hub": return [ekip(["hub", "local"])];
    default: return []; // prereqs: printed, the user installs them
  }
}

async function chooseLanguage({ prompt = ask } = {}) {
  const current = lang;
  const answer = (await prompt(`  ${current === "tr" ? "Dil / Language" : "Language / Dil"} [tr/en] (${current}): `)).trim().toLowerCase();
  const chosen = ["tr", "en"].includes(answer) ? answer : current;
  saveSettings({ lang: chosen });
  return chosen;
}

/** The guided walk. io: { ask, secret, open, exec([cmd, args]) → exit code } (tests pass mocks). */
export async function wizard({ io = {}, cwd = process.cwd(), env = process.env, askLang = true } = {}) {
  const prompt = io.ask ?? ask;
  const exec = io.exec ?? (([cmd, args]) => spawnSync(cmd, args, { stdio: "inherit" }).status ?? 1);
  console.log(`\n${mark()}  ${c.bold(t("kurulum"))}  ${c.gray(t("eksik adımları birlikte tamamlayalım; her adımda: şimdi yap / sonra / atla"))}`);
  // the language first: everything after it (and the lead's own texts) follows it
  if (askLang && !SETTINGS.lang && !env.EKIP_LANG) {
    const chosen = await chooseLanguage({ prompt });
    if (chosen !== lang && !io.exec) return spawnSync(process.execPath, [EKIP, "setup", "--no-lang"], { stdio: "inherit", env: { ...env, EKIP_LANG: chosen } }).status ?? 0;
  }
  let f = await facts({ cwd });
  let steps = evaluate(f, { env });
  const order = { required: 0, recommended: 1, optional: 2 };
  const todo = steps.filter((s) => !s.done).sort((a, b) => order[a.level] - order[b.level]);
  for (const s0 of todo) {
    const s = steps.find((x) => x.id === s0.id);
    if (s.done) continue; // finished by an earlier step (ekip init starts the services too)
    const sum = summary(steps);
    console.log(`\n${c.bold(`${t("Kurulum")} ${sum.done}/${sum.total}`)}  ${progress(sum)}`);
    console.log(`  ${c.yellow("●")} ${c.bold(s.title)} ${c.gray(`· ${levelLabel(s.level)}`)}${s.detail ? c.gray(` · ${s.detail}`) : ""}\n    ${s.why}\n    ${c.cyan(s.command)}`);
    const a = (await prompt(`  ${t("[Ş]imdi yap / [s]onra / [a]tla")} `)).trim().toLowerCase();
    if (/^(a|atla|skip|k)$/.test(a)) { snooze(s.id, SKIP_DAYS); console.log(c.gray(`  ${t("atlandı; geri getirmek için: ekip setup unsnooze {id}", { id: s.id })}`)); continue; }
    if (/^(s|sonra|l|later|n|no|h|hayır)$/.test(a)) { console.log(c.gray(`  ${t("sonra: {cmd}", { cmd: s.command })}`)); continue; }
    let cmds = actions(s, f, io);
    if (typeof cmds === "function") cmds = await cmds();
    if (!cmds.length) console.log(`  ${t("bu adımı siz tamamlayın: {cmd}", { cmd: s.command })}`);
    for (const x of cmds) exec(x);
    // check again: the step, and every later one it may have finished too
    f = await facts({ cwd });
    steps = evaluate(f, { env });
    const now = steps.find((x) => x.id === s.id);
    console.log(now.done ? `  ${c.green("✓")} ${now.title}` : `  ${c.yellow("●")} ${t("hâlâ eksik")}${now.detail ? `: ${now.detail}` : ""}`);
  }
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify({ at: Date.now(), lang, steps })); } catch { /* best effort */ }
  console.log("");
  printList(steps);
  return 0;
}

// ---- language -------------------------------------------------------------------------------------

/** `ekip lang [tr|en]` (ekip dil): shows or sets the language in data/config.json. */
export function langMain([value] = []) {
  if (!value) { console.log(`${lang}${process.env.EKIP_LANG ? " (EKIP_LANG)" : SETTINGS.lang ? "" : ` (${t("sistem dili")})`}  ·  ekip lang tr|en`); return 0; }
  if (!["tr", "en"].includes(value)) { console.error("usage: ekip lang tr|en"); return 1; }
  saveSettings({ lang: value });
  console.log(value === "en" ? "ekip speaks English from now on (new sessions, panes and the panel)." : "ekip bundan sonra Türkçe konuşur (yeni oturumlar, bölmeler ve panel).");
  return 0;
}

// ---- command --------------------------------------------------------------------------------------

export async function main(args = []) {
  const [sub, id, days] = args;
  if (sub === "snooze") {
    if (!id || !STEPS.some((s) => s.id === id)) { console.error(`usage: ekip setup snooze ${STEPS.map((s) => s.id).join("|")} [days]`); return 1; }
    const until = snooze(id, Number(days) > 0 ? Number(days) : 7);
    console.log(t("{id} hatırlatması {until} tarihine kadar susturuldu", { id, until: new Date(until).toLocaleDateString(lang === "tr" ? "tr-TR" : "en-GB") }));
    return 0;
  }
  if (sub === "unsnooze") { console.log(unsnooze(id) ? t("{id} hatırlatması yeniden açık", { id }) : t("{id} susturulmamıştı", { id })); return 0; }
  const quiet = args.includes("--quiet");
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
  if (args.includes("--list") || args.includes("--json") || args.includes("--refresh") || !interactive) {
    const steps = await checkSetup({ refresh: args.includes("--refresh") || !args.includes("--cached") });
    if (args.includes("--json")) console.log(JSON.stringify({ ...summary(steps), steps }, null, 2));
    else if (!quiet) printList(steps);
    return 0;
  }
  return wizard({ askLang: !args.includes("--no-lang") });
}
