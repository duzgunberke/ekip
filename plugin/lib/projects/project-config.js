// <project>/.ekip/: the project's own ekip settings, committed with the project so everyone who
// works on it shares them. ekip reads it first and falls back to its private data/ folder.
//
//   rules.md    project rules: added to every worker brief and to the lead's context
//   lessons.md  mistakes the user corrected: added to every worker brief, whatever the brief is about
//   review.md   review profile for `ekip review` (shared instead of data/projects/<name>.review.md)
//   checks/     extra check scripts `ekip review` runs (the project's own, so they are trusted)
//   dev.json    development environment mapping (database name, redis index; never secrets)
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/core.js";

export const dirOf = (p) => (p?.path ? path.join(p.path, ".ekip") : null);
const read = (f, max = 4000) => { try { return fs.readFileSync(f, "utf8").slice(0, max); } catch { return ""; } };

/** The project's rules (.ekip/rules.md), trimmed for a brief or a prompt. */
export function rules(p, max = 2000) {
  const d = dirOf(p);
  return d ? read(path.join(d, "rules.md"), max).trim() : "";
}

/**
 * The project's lessons file: "lessons" in the registry (a path, relative to the project), else
 * .ekip/lessons.md when the project has a .ekip folder, else the private data/projects/<name>.lessons.md.
 */
export function lessonsFile(p) {
  if (p?.lessons) return path.resolve(p.path ?? "", p.lessons);
  const d = dirOf(p);
  if (d && fs.existsSync(d)) return path.join(d, "lessons.md");
  return path.join(HOME, "projects", `${p.name}.lessons.md`);
}

/**
 * Lessons for a brief: the list items of the lessons file (and of the private file, when both
 * exist), newest last, cut to max characters from the newest end so the latest corrections stay.
 */
export function lessons(p, max = 1200) {
  if (!p?.name) return "";
  const files = [...new Set([lessonsFile(p), path.join(HOME, "projects", `${p.name}.lessons.md`)])];
  const items = files.flatMap((f) => read(f, 40_000).replace(/<!--[\s\S]*?-->/g, "").split("\n").map((l) => l.trim()).filter((l) => /^[-*]\s+\S/.test(l)));
  const out = [];
  let size = 0;
  for (const l of [...new Set(items)].reverse()) {
    const line = l.length > 300 ? `${l.slice(0, 297)}...` : l;
    if (size + line.length + 1 > max) break;
    out.unshift(line); size += line.length + 1;
  }
  return out.join("\n");
}

/** Adds one lesson ("- YYYY-MM-DD text") to the project's lessons file; returns the file. */
export function addLesson(p, text) {
  const line = String(text).replace(/\s+/g, " ").trim();
  if (!line) throw new Error("empty lesson");
  const f = lessonsFile(p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, "# Lessons\n\nMistakes the user corrected; ekip adds this list to every worker brief.\n\n");
  fs.appendFileSync(f, `- ${new Date().toISOString().slice(0, 10)} ${line}\n`);
  return f;
}

/** Where the review profile lives: the project's .ekip/review.md when it exists, else data/. */
export function reviewProfileFile(p) {
  const d = dirOf(p);
  if (d && fs.existsSync(path.join(d, "review.md"))) return path.join(d, "review.md");
  return path.join(HOME, "projects", `${p.name}.review.md`);
}

/** Executable check scripts in .ekip/checks (sh, mjs, js, py), run from the project root. */
export function extraChecks(p) {
  const d = dirOf(p);
  if (!d) return [];
  const dir = path.join(d, "checks");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.(sh|mjs|js|py)$/.test(n)).sort(); } catch { return []; }
  return names.map((n) => {
    const file = path.join(dir, n);
    const cmd = n.endsWith(".sh") ? ["bash", file] : n.endsWith(".py") ? ["python3", file] : ["node", file];
    return { name: `.ekip/checks/${n}`, cmd, cwd: p.path };
  });
}

/** Development mapping from .ekip/dev.json ({ db, redisDb }), or null. */
export function devMapping(p) {
  const d = dirOf(p);
  try { return d ? JSON.parse(fs.readFileSync(path.join(d, "dev.json"), "utf8")) : null; } catch { return null; }
}

const README = `# .ekip

This project's own [ekip](https://github.com/duzgunberke/ekip) settings. Commit this folder: everyone
who works on the project with ekip shares it.

- \`rules.md\`: project rules every agent must follow. ekip adds them to each worker's brief and to
  the lead's context.
- \`lessons.md\`: mistakes the user corrected, one list item each (\`ekip project lesson <name> "..."\`).
  ekip adds them to every worker's brief, whatever the brief is about.
- \`review.md\`: the review profile \`ekip review\` reads the changes through (lenses, rules, the
  checks behind them). \`ekip review profile <name> --refresh\` regenerates it.
- \`checks/\`: extra check scripts (\`.sh\`, \`.mjs\`, \`.js\`, \`.py\`) that \`ekip review\` runs from the
  project root. Exit code 0 means pass. Keep them read-only: no writes to live services.
- \`dev.json\`: the development database mapping (\`{ "db": "<name>_dev", "redisDb": 3 }\`), never
  passwords.

Process skills stay in \`.claude/skills/\`, where Claude Code reads them.
`;

const RULES = `# Rules for agents working on this project

<!-- ekip adds this file to every worker's brief and to the lead's context. Keep it short and
     concrete: the things a new teammate gets wrong in the first week. Examples:
- Never run migrations against production; use the development environment.
- Run \`npm run typecheck\` and \`npm run lint\` before reporting a change as done.
- Generated files under \`shared/\` are never edited by hand.
-->
`;

/**
 * ekip project config <name>: create .ekip/ with a README and a rules template, and move the
 * private review profile into it when there is one. Existing files are never overwritten.
 */
export function initConfig(p) {
  const d = dirOf(p);
  if (!d) throw new Error("project has no path");
  fs.mkdirSync(path.join(d, "checks"), { recursive: true });
  const made = [];
  const put = (name, text) => { const f = path.join(d, name); if (!fs.existsSync(f)) { fs.writeFileSync(f, text); made.push(name); } };
  put("README.md", README);
  put("rules.md", RULES);
  const priv = path.join(HOME, "projects", `${p.name}.review.md`);
  if (fs.existsSync(priv) && !fs.existsSync(path.join(d, "review.md"))) { fs.copyFileSync(priv, path.join(d, "review.md")); made.push("review.md"); }
  const gitkeep = path.join(d, "checks/.gitkeep");
  if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, "");
  return { dir: d, made };
}
