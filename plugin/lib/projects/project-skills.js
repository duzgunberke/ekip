// A project's own process skills: <project>/.claude/skills and one level of sub-repos. Used to tell
// the lead (prompt hook) and every worker (ekip run) which of them fit the request.
import fs from "node:fs";
import path from "node:path";

// folded (case, Turkish ı/i, accents) so "Klibi" meets "klip", "takvime" meets "takvim"
const fold = (x) => String(x).toLocaleLowerCase("tr").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i");
const stem = (w) => w.slice(0, Math.max(4, Math.min(5, w.length - 1)));

export function projectSkills(root, query) {
  if (!root) return [];
  const words = [...new Set(fold(query).match(/[\p{L}\p{N}]{4,}/gu) ?? [])].map(stem);
  const dirs = [path.join(root, ".claude/skills")];
  try { for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) dirs.push(path.join(root, d.name, ".claude/skills")); } catch { /* unreadable root */ }
  const seen = new Set(), all = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const file = path.join(dir, n, "SKILL.md");
      if (seen.has(n) || !fs.existsSync(file)) continue;
      seen.add(n);
      const text = fs.readFileSync(file, "utf8").slice(0, 2000);
      const description = text.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
      const hay = fold(`${n.replace(/[-_]/g, " ")} ${description}`);
      all.push({ name: n, description, file, score: words.filter((w) => hay.includes(w)).length });
    }
  }
  // a project with a handful of skills: those are its processes, always listed (best match first);
  // a large set: only the ones the request touches
  const out = all.length <= 3 ? all : all.filter((x) => x.score > 0);
  return out.sort((a, b) => b.score - a.score);
}
