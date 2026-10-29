// A project's own process skills: <project>/.claude/skills and one level of sub-repos. Used to tell
// the lead (prompt hook) and every worker (ekip run) which of them fit the request.
import fs from "node:fs";
import path from "node:path";

export function projectSkills(root, query) {
  if (!root) return [];
  const words = new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const dirs = [path.join(root, ".claude/skills")];
  try { for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) dirs.push(path.join(root, d.name, ".claude/skills")); } catch { /* unreadable root */ }
  const seen = new Set(), out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const file = path.join(dir, n, "SKILL.md");
      if (seen.has(n) || !fs.existsSync(file)) continue;
      seen.add(n);
      const text = fs.readFileSync(file, "utf8").slice(0, 2000);
      const description = text.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
      const hay = `${n} ${description}`.toLowerCase();
      const score = [...words].filter((w) => hay.includes(w)).length;
      if (score) out.push({ name: n, description, file, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
