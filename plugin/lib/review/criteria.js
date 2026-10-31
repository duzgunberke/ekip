// Acceptance criteria: what a worker's delivery must satisfy before it reaches the lead and the user.
// The automatic review (review/auto.js) checks every result against four sources:
//   1. ekip's base criteria (below): checks ran and passed, touched files build, no personal data, no
//      stray files, evidence for every claim, images looked at, every brief item met or explained
//   2. the project's own checks: check:/test:/verify: scripts, typecheck and lint in package.json, the
//      test and smoke commands of the project card, .ekip/checks/*
//   3. the project's acceptance file (acceptance.md, found like lessons.md): written by the user
//      (`ekip project criterion`) and grown by reviews, when the same kind of failure comes back
//   4. the project's lessons: every mistake the user corrected is also something a delivery is
//      checked against ("lesson" = do not do this, "criterion" = this was checked at delivery)
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/core.js";
import { t } from "../core/i18n.js";
import { dirOf, extraChecks, lessons } from "../projects/project-config.js";

// The file stays small enough to read: past this, the oldest review-made criteria are merged.
export const MAX_ITEMS = 40;
const SECTIONS = { project: "Project", reviews: "From reviews" };
const UNSAFE = /(?:format|prettier\s+--write|eslint\s+--fix|\beas\b|update:|deploy|publish|release|\bpush\b|migrate|seed|db\s+reset|e2e)/i;
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const today = () => new Date().toISOString().slice(0, 10);

/** ekip's own criteria, the same for every project. */
export const base = () => [
  t("Brief'teki her madde karşılandı ya da gerekçesiyle açık bırakıldı"),
  t("Projenin testleri ve kontrolleri çalıştırıldı ve geçti (inceleyen kendisi çalıştırdı)"),
  t("Dokunulan her dosya derleniyor ya da sözdizimi geçerli"),
  t("Kişisel veri, sır ya da anahtar eklenmedi (ana makine, alan adı, kimlik, token)"),
  t("İstenmeyen dosya yok (geçici dosya, log, derleme çıktısı, ilgisiz değişiklik)"),
  t("Raporda iddia edilen her şeyin kanıtı var (komut çıktısı, ekran görüntüsü yolu)"),
  t("Görsel işte görsellere (ekran görüntüsü, kare, sayfa) gerçekten bakıldı"),
];

/**
 * The project's acceptance file: "acceptance" in the registry (a path, relative to the project),
 * else .ekip/acceptance.md when the project has a .ekip folder, else data/projects/<name>.acceptance.md.
 */
export function criteriaFile(p) {
  if (p?.acceptance) return path.resolve(p.path ?? "", p.acceptance);
  const d = dirOf(p);
  if (d && fs.existsSync(d)) return path.join(d, "acceptance.md");
  return path.join(HOME, "projects", `${p.name}.acceptance.md`);
}

const TEMPLATE = `# Acceptance criteria

<!-- ekip reviews every worker result against this list, plus its base criteria, the project's
     checks and its lessons (ekip project criteria NAME shows them all). One line each, written as
     what was checked at delivery. \`ekip project criterion NAME "..."\` adds to "Project"; the
     automatic review adds to "From reviews" when the same kind of failure is found twice.
     Keep it under ${MAX_ITEMS} items: ekip merges the oldest review-made ones past that. -->

## ${SECTIONS.project}

## ${SECTIONS.reviews}
`;

/** The file as sections: [{ title, items: [text] }], in file order. */
export function parse(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = { title: h[1], items: [] }; out.push(cur); continue; }
    const m = line.match(/^\s*[-*]\s+(\S.*)$/);
    if (m) { if (!cur) { cur = { title: SECTIONS.project, items: [] }; out.push(cur); } cur.items.push(m[1].trim()); }
  }
  return out;
}

function write(file, sections) {
  const head = read(file).split(/^##\s/m)[0] || TEMPLATE.split(/^##\s/m)[0];
  const body = sections.map((s) => `## ${s.title}\n${s.items.map((i) => `- ${i}\n`).join("")}`).join("\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${head.trimEnd()}\n\n${body}`);
}

const sectionsOf = (file) => {
  const s = parse(read(file));
  for (const title of Object.values(SECTIONS)) if (!s.some((x) => x.title === title)) s.push({ title, items: [] });
  return s;
};

// Words of a criterion, for "is this the same thing again": lower case, no punctuation, no short words.
const words = (s) => new Set(String(s).toLocaleLowerCase("tr").replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 2));
export function similar(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}

/**
 * Adds one criterion to a section of the file (created from the template the first time). Nothing
 * is added when the file already has the same criterion in other words. Past MAX_ITEMS the two
 * most alike review-made criteria (else the two oldest) are merged into one line.
 */
export function addCriterion(p, text, { section = "project", note = "" } = {}) {
  const line = String(text).replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "");
  if (!line) throw new Error("empty criterion");
  const file = criteriaFile(p);
  const sections = sectionsOf(file);
  const dup = sections.flatMap((s) => s.items).find((i) => similar(i, line) >= 0.6);
  if (dup) return { file, added: false, existing: dup };
  sections.find((s) => s.title === SECTIONS[section]).items.push(`${line}${note ? ` (${note})` : ""}`);
  const merged = shrink(sections);
  write(file, sections);
  return { file, added: true, merged };
}

function shrink(sections) {
  const count = () => sections.reduce((a, s) => a + s.items.length, 0);
  const rev = sections.find((s) => s.title === SECTIONS.reviews);
  let merged = 0;
  while (count() > MAX_ITEMS && rev.items.length >= 2) {
    let best = [0, 1], score = -1;
    for (let i = 0; i < rev.items.length; i++) for (let j = i + 1; j < rev.items.length; j++) {
      const s = similar(rev.items[i], rev.items[j]);
      if (s > score) { score = s; best = [i, j]; }
    }
    if (score < 0.2) best = [0, 1];
    const [i, j] = best;
    const strip = (x) => x.replace(/\s*\((?:review|inceleme)[^)]*\)\s*$/i, "");
    const line = `${strip(rev.items[i])}; ${strip(rev.items[j])}`.slice(0, 300);
    rev.items.splice(j, 1);
    rev.items[i] = `${line} (review, merged ${today()})`;
    merged++;
  }
  return merged;
}

/** The project's check commands as criteria: package.json scripts, the card's test commands, .ekip/checks. */
export function projectChecks(p) {
  if (!p?.path) return [];
  const out = [];
  try {
    const scripts = JSON.parse(read(path.join(p.path, "package.json")) || "{}").scripts ?? {};
    const names = Object.entries(scripts).filter(([n, cmd]) => /^(check|test|verify)(:|$)|^(typecheck|type-check|lint)$/i.test(n) && !UNSAFE.test(`${n} ${cmd}`)).map(([n]) => n);
    for (const n of names.slice(0, 12)) out.push(`npm run ${n}`);
  } catch { /* no or broken package.json */ }
  // the card's "Run / test / build" section: inline commands that test or check
  const card = read(p.card ?? path.join(HOME, "projects", `${p.name}.md`));
  const sec = card.split(/^##\s+/m).find((s) => /^(run|test|komut|çalıştır)/i.test(s)) ?? "";
  for (const m of sec.matchAll(/`([^`\n]{3,120})`/g)) {
    const cmd = m[1].trim();
    if (/smoke|\btest|check|lint|typecheck|--check/i.test(cmd) && !UNSAFE.test(cmd) && !out.includes(cmd)) out.push(cmd);
  }
  for (const x of extraChecks(p)) out.push(x.name);
  return out.slice(0, 16).map((cmd) => t("`{cmd}` geçti", { cmd }));
}

/**
 * Every criterion for a project, numbered in review order:
 * [{ id: "C1", source: "base"|"checks"|"project"|"reviews"|"lessons", text }].
 */
export function all(p) {
  const rows = base().map((text) => ({ source: "base", text }));
  for (const text of projectChecks(p)) rows.push({ source: "checks", text });
  if (p?.name) {
    for (const s of parse(read(criteriaFile(p)))) {
      const source = s.title === SECTIONS.reviews ? "reviews" : "project";
      for (const text of s.items) rows.push({ source, text });
    }
    for (const l of lessons(p, 2400).split("\n").filter(Boolean)) rows.push({ source: "lessons", text: t("Ders çiğnenmedi: {lesson}", { lesson: l.replace(/^[-*]\s+(\d{4}-\d\d-\d\d\s+)?/, "") }) });
  }
  return rows.map((r, i) => ({ id: `C${i + 1}`, ...r }));
}

// ---- growth from reviews -------------------------------------------------------------------------

const CANDIDATES = (p) => path.join(HOME, "projects", `${p.name}.criteria-candidates.json`);
export const candidates = (p) => { try { return JSON.parse(read(CANDIDATES(p)) || "[]"); } catch { return []; } };
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/**
 * A failed review proposes new criteria ({ class, text }) for kinds of failure the list did not
 * cover. A proposal is kept as a candidate; when the same class (or the same criterion in other
 * words) is proposed a second time, it goes into the acceptance file. Returns what was added.
 */
export function propose(p, proposals = [], { runId = null } = {}) {
  if (!p?.name || !proposals.length) return [];
  const list = candidates(p);
  const added = [];
  const existing = all(p);
  for (const pr of proposals) {
    const text = String(pr.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!text) continue;
    // already a criterion (any source): the review should have failed on it, nothing to learn
    if (existing.some((c) => similar(c.text, text) >= 0.6)) continue;
    const key = slug(pr.class) || slug(text);
    const hit = list.find((c) => c.key === key || similar(c.text, text) >= 0.5);
    if (!hit) { list.push({ key, text, count: 1, firstAt: new Date().toISOString(), runs: runId ? [runId] : [] }); continue; }
    if (runId && hit.runs?.includes(runId)) continue;
    hit.count++; hit.lastAt = new Date().toISOString();
    if (runId) (hit.runs ??= []).push(runId);
    if (text.length < hit.text.length) hit.text = text;
    if (hit.count >= 2) {
      const r = addCriterion(p, hit.text, { section: "reviews", note: `review, ${hit.count}×, ${today()}` });
      list.splice(list.indexOf(hit), 1);
      if (r.added) added.push(hit.text);
    }
  }
  fs.mkdirSync(path.dirname(CANDIDATES(p)), { recursive: true });
  fs.writeFileSync(CANDIDATES(p), JSON.stringify(list.slice(-60), null, 2));
  return added;
}

const SOURCE = { base: "ekip temel", checks: "proje kontrolü", project: "proje", reviews: "incelemeden", lessons: "ders" };

/** `ekip project criteria NAME`: every criterion with where it comes from, then the open candidates. */
export function listText(p) {
  const rows = all(p);
  const out = [t("{name}: {n} kabul kriteri · {file}", { name: p.name, n: rows.length, file: criteriaFile(p) })];
  let last = null;
  for (const r of rows) {
    if (r.source !== last) { out.push(`\n${t(SOURCE[r.source])}:`); last = r.source; }
    out.push(`  ${r.id.padEnd(4)} ${r.text}`);
  }
  const cand = candidates(p);
  if (cand.length) {
    out.push(`\n${t("aday (ikinci kez görülünce eklenir)")}:`);
    for (const c of cand) out.push(`  ${c.count}× ${c.text}`);
  }
  return out.join("\n");
}
