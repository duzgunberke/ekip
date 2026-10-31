// Every user-facing string passed to t() (or the `tr` alias some modules use) has an English entry in
// i18n.js: a key that is missing there would show Turkish to an English user. Keys are read from the
// source with a small scanner (string literals as the first argument; template strings with ${…}
// are skipped, they are built at run time).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { dictionaries } = await import("./i18n.js");
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== "node_modules") walk(p); } else if (/\.(m?js)$/.test(f.name) && !f.name.endsWith(".test.mjs")) files.push(p); } })(root);

/** Keys of t("…") / tr('…') / t(`…`) calls in a source text. */
export function keysOf(src) {
  const out = [];
  const re = /(?<![\w.$])(?:t|tr)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/g;
  for (const m of src.matchAll(re)) {
    if (m[1] === "`" && m[2].includes("${")) continue;
    out.push(m[2].replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n"));
  }
  return out;
}
const missing = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  if (!/from "[./a-z]*i18n\.js"/.test(src) && !f.endsWith("i18n.js")) continue;
  for (const k of keysOf(src)) if (!(k in dictionaries.en)) missing.set(k, path.relative(root, f));
}
if (process.argv.includes("--list")) { for (const [k, f] of missing) console.log(`${f}\t${JSON.stringify(k)}`); process.exit(0); }
assert.equal(missing.size, 0, `t() keys without an English entry in plugin/lib/core/i18n.js:\n${[...missing].map(([k, f]) => `  ${f}: ${JSON.stringify(k)}`).join("\n")}`);
console.log(`i18n: ok (${files.length} files)`);
