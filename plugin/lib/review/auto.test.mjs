// Automatic review, end to end with fake worker CLIs on PATH and a throwaway EKIP_HOME: codex writes,
// a pool of another family (copilot) reviews. A passing review, a failing one with a fix round that
// then passes, three failures that end in a question to the user, criteria that grow (a lesson is a
// criterion; the same failure class twice adds one), the reviewer's pool family, and the status texts
// in both languages.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const EKIP = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../bin/ekip.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-review-test-"));
const home = path.join(tmp, "home"), bin = path.join(tmp, "bin"), state = path.join(tmp, "state"), proj = path.join(tmp, "demo");
for (const d of [home, bin, state, proj]) fs.mkdirSync(d, { recursive: true });

// one fake CLI for every pool: a reviewer brief pops the next verdict, anything else writes a file
const FAKE = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2), name = path.basename(process.argv[1]);
const prompt = args.reduce((a, b) => (b.length > a.length ? b : a), "");
const st = process.env.FAKE_STATE;
const reviewer = prompt.includes("You are the REVIEWER"), fix = prompt.includes("REVIEW FIX ROUND");
fs.appendFileSync(path.join(st, "calls.log"), JSON.stringify({ name, reviewer, fix }) + "\\n");
if (reviewer) {
  const q = JSON.parse(fs.readFileSync(path.join(st, "verdicts.json"), "utf8"));
  const v = q.shift();
  fs.writeFileSync(path.join(st, "verdicts.json"), JSON.stringify(q));
  fs.writeFileSync(path.join(st, "review-brief.txt"), prompt);
  console.log("I ran npm run check:demo myself: exit 0. I read the diff of out.txt.\\n\\nREVIEW-RESULT\\n" + v + "\\nEND-REVIEW");
} else {
  if (fix) fs.writeFileSync(path.join(st, "fix-brief.txt"), prompt);
  fs.appendFileSync(path.join(process.cwd(), "out.txt"), "line\\n");
  console.log("Done. Changed out.txt (appended one line) and verified it with cat out.txt; the new line is there. Nothing left open.");
}
`;
for (const b of ["codex", "copilot", "agy"]) { fs.writeFileSync(path.join(bin, b), FAKE); fs.chmodSync(path.join(bin, b), 0o755); }

// a registered project in its own git repository, with a check script and a card with a smoke command
const git = (...a) => spawnSync("git", ["-C", proj, "-c", "user.name=t", "-c", "user.email=t@localhost", ...a], { encoding: "utf8" });
fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "demo", scripts: { "check:demo": "node -e 0", deploy: "echo no" } }));
git("init", "-q"); git("add", "-A"); git("commit", "-qm", "init");
fs.mkdirSync(path.join(home, "projects"), { recursive: true });
fs.writeFileSync(path.join(home, "projects", "demo.md"), "# demo\n\n## Run / test / build\n- Smoke test: `bash scripts/smoke.sh`; deploy: `npm run deploy`\n");
fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify([{ name: "demo", path: proj }]));
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
  autoOrder: ["codex", "copilot", "agy"], agents: { codex: { ok: true }, copilot: { ok: true }, agy: { ok: true } }, watch: false,
}));

const env = (lang = "tr", extra = {}) => ({ ...process.env, EKIP_HOME: home, EKIP_LANG: lang, FAKE_STATE: state, PATH: `${bin}:/usr/bin:/bin`, EKIP_RUN_DEPTH: "0", EKIP_PARENT_RUN: "", EKIP_REVIEW_ROLE: "", ...extra });
const ekip = (args, { input, lang } = {}) => spawnSync(process.execPath, [EKIP, ...args], { env: env(lang), input, encoding: "utf8", timeout: 120_000 });
const verdicts = (list) => { fs.writeFileSync(path.join(state, "verdicts.json"), JSON.stringify(list)); fs.writeFileSync(path.join(state, "calls.log"), ""); };
const calls = () => fs.readFileSync(path.join(state, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const task = (id) => JSON.parse(fs.readFileSync(path.join(home, "tasks.json"), "utf8")).find((x) => x.id === id);
const newTask = (title) => ekip(["task", "new", title, "--project", "demo"]).stdout.split("\n")[0].trim();
const PASS = "VERDICT: PASS\nCRITERIA: {n}/{n}";
const FAIL = (cls) => `VERDICT: FAIL\nCRITERIA: 8/10\nFINDING: HIGH | out.txt:1 | C2 | the check was never run\nNEW-CRITERION: ${cls} | Generated fixtures are refreshed with the project script before delivery`;

try {
  // ---- criteria: base, project checks (unsafe scripts left out), the file, lessons -------------------
  process.env.EKIP_HOME = home;
  process.env.EKIP_LANG = "tr";
  const crit = await import("./criteria.js");
  const p = { name: "demo", path: proj };
  let rows = crit.all(p);
  assert.ok(rows.some((r) => r.source === "checks" && r.text.includes("npm run check:demo")));
  assert.ok(rows.some((r) => r.source === "checks" && r.text.includes("bash scripts/smoke.sh")), "the card's smoke command is a criterion");
  assert.ok(!rows.some((r) => /deploy/.test(r.text)), "deploy scripts are never criteria");
  assert.equal(rows.filter((r) => r.source === "base").length, 7);
  let out = ekip(["project", "criterion", "demo", "Every public page has an English and a Turkish version"]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(crit.criteriaFile(p), path.join(home, "projects", "demo.acceptance.md"), "no .ekip folder: the private file");
  out = ekip(["project", "criterion", "demo", "every public page has a Turkish and an English version"]);
  assert.match(out.stdout, /zaten var/, "the same criterion in other words is not added twice");
  out = ekip(["project", "lesson", "demo", "Run the tests with an English locale too"]);
  assert.match(out.stdout, /kabul kriteri olarak da sayılır/);
  out = ekip(["project", "criteria", "demo"]);
  assert.match(out.stdout, /Ders çiğnenmedi: Run the tests with an English locale too/, "a lesson is a criterion");
  assert.match(out.stdout, /English and a Turkish version/);
  rows = crit.all(p);
  const total = rows.length;
  console.log(`criteria: ok (${total})`);

  // ---- the reviewer's family ----------------------------------------------------------------------
  const { reviewerPool, family } = await import("../workers/agents.js");
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  assert.equal(family("agy"), "google"); assert.equal(family("codex"), "openai"); assert.equal(family("free"), "free");
  assert.equal(reviewerPool("codex"), "copilot", "codex's work goes to another family");
  assert.equal(reviewerPool("copilot"), "codex");
  assert.equal(reviewerPool("codex", { exclude: ["copilot"] }), "agy");
  assert.equal(reviewerPool("agy", { exclude: ["codex", "copilot"], minTier: "strong" }), null, "no strong pool of another family left");
  console.log("reviewer pool: ok");

  // ---- parsing the reviewer's block ---------------------------------------------------------------
  const { parseVerdict, wanted } = await import("./auto.js");
  const v = parseVerdict("text\n**REVIEW-RESULT**\n**VERDICT:** PASS\nCRITERIA: 9/10\nFINDING: HIGH | a.js:3 | C4 | broken\nEND-REVIEW");
  assert.equal(v.verdict, "fail", "a HIGH finding fails whatever the verdict line says");
  assert.deepEqual(v.findings[0], { severity: "HIGH", where: "a.js:3", criterion: "C4", problem: "broken" });
  assert.equal(parseVerdict("no block here"), null);
  assert.equal(wanted({}, { mesai: true }), true, "on by default in mesai mode");
  assert.equal(wanted({ review: false }, { mesai: true }), false);
  assert.equal(wanted({}, {}), false);
  assert.equal(wanted({ review: true, label: "review-1: x" }, {}), false, "a review is never reviewed");
  console.log("parse and switches: ok");

  // ---- 1. a passing review --------------------------------------------------------------------------
  verdicts([PASS.replaceAll("{n}", String(total))]);
  let id = newTask("Geçen iş");
  out = ekip(["run", "--review", "--via", "codex", "--project", "demo", "--task", id, "--label", "pass", "Add a line to out.txt"]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, new RegExp(`review: geçti \\(kriter ${total}/${total}\\) · reviewer copilot`));
  assert.deepEqual(calls().map((c) => [c.name, c.reviewer]), [["codex", false], ["copilot", true]], "codex wrote, copilot reviewed");
  let x = task(id);
  assert.equal(x.review.state, "passed"); assert.equal(x.status, "done", "a passed review lets the task close");
  assert.match(x.result.text, /review: geçti/);
  assert.ok(x.result.links.some((l) => l.includes(path.join(home, "reviews"))), "the review file is a result link");
  const brief = fs.readFileSync(path.join(state, "review-brief.txt"), "utf8");
  for (const part of ["Add a line to out.txt", "out.txt", "Ders çiğnenmedi", "npm run check:demo", "git diff", "REVIEW-RESULT"]) assert.ok(brief.includes(part), `the reviewer brief has ${part}`);
  for (const L of ["tr", "en"]) {
    const s = ekip(["status", "--offline"], { lang: L }).stdout;
    assert.match(s, L === "tr" ? new RegExp(`review: geçti \\(kriter ${total}/${total}\\)`) : new RegExp(`review: passed \\(criteria ${total}/${total}\\)`), `status in ${L}`);
  }
  console.log("passing review: ok");

  // ---- 2. a failing review, one fix round, then a pass --------------------------------------------
  verdicts([FAIL("fixtures-stale"), PASS.replaceAll("{n}", String(total))]);
  id = newTask("Düzeltilen iş");
  out = ekip(["run", "--review", "--via", "codex", "--project", "demo", "--task", id, "--label", "fix", "Add a line to out.txt"]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.deepEqual(calls().map((c) => [c.name, c.reviewer, c.fix]), [["codex", false, false], ["copilot", true, false], ["codex", false, true], ["copilot", true, false]]);
  assert.match(fs.readFileSync(path.join(state, "fix-brief.txt"), "utf8"), /REVIEW FIX ROUND 1\/2[\s\S]*HIGH \| out\.txt:1 \| C2 \| the check was never run[\s\S]*Add a line to out.txt/);
  x = task(id);
  assert.equal(x.review.state, "passed"); assert.equal(x.review.round, 1);
  assert.ok(x.notes.some((n) => /düzeltme turu 1\/2/.test(n.text)), "the fix round is on the task");
  assert.equal(crit.candidates(p).length, 1, "a new failure class is a candidate first");
  assert.ok(!crit.all(p).some((r) => r.source === "reviews"));
  console.log("fail, fix, pass: ok");

  // ---- 3. three failures: the task waits for the user; the same class a second time is a criterion --
  // (in English: what the run writes on the task is in the language it ran in)
  verdicts([FAIL("fixtures-stale"), FAIL("fixtures-stale"), FAIL("fixtures-stale")]);
  id = newTask("Failing work");
  out = ekip(["run", "--review", "--via", "codex", "--project", "demo", "--task", id, "--label", "blocked", "Add a line to out.txt"], { lang: "en" });
  assert.equal(out.status, 1, "a review that still fails is not a success");
  assert.match(out.stdout, /review: failed \(findings: 1\)/);
  assert.equal(calls().filter((c) => c.fix).length, 2, "at most two fix rounds");
  x = task(id);
  assert.equal(x.status, "running"); assert.equal(x.review.state, "failed");
  assert.equal(x.hold?.kind, "waiting-user"); assert.match(x.ask.question, /still fails after 2 fix rounds/);
  assert.equal(x.ask.options.length, 3);
  const learned = crit.all(p).filter((r) => r.source === "reviews");
  assert.equal(learned.length, 1, "the same failure class twice adds one criterion");
  assert.match(learned[0].text, /Generated fixtures are refreshed/);
  assert.equal(crit.candidates(p).length, 0);
  assert.ok(x.notes.some((n) => /new acceptance criterion/.test(n.text)));
  const en = ekip(["status", "--offline"], { lang: "en" }).stdout;
  assert.match(en, /Waiting for you \(1\)/); assert.match(en, /The review still fails after 2 fix rounds/);
  assert.ok(!/düzeltme turu|bulgu|inceleme/.test(en), "no Turkish review text in the English status");
  assert.match(ekip(["tasks"], { lang: "en" }).stdout, /review: failed \(findings: 1\)/);
  assert.match(ekip(["tasks"], { lang: "tr" }).stdout, /review: düştü \(1 bulgu\)/);
  console.log("two rounds, then a question: ok");

  // ---- the pane card and the label in both languages ---------------------------------------------
  for (const [L, re] of [["tr", /inceleniyor \(reviewer: claude\) · düzeltme turu 1\/2/], ["en", /in review \(reviewer: claude\) · fix round 1\/2/]]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const t = await import(${JSON.stringify(path.resolve(path.dirname(EKIP), "../lib/tasks/tasks.js"))}); const p = await import(${JSON.stringify(path.resolve(path.dirname(EKIP), "../lib/tasks/pane.js"))});
      const c = t.cardOf({ id: "g1", title: "x", status: "running", createdAt: new Date().toISOString(), steps: [], workers: [], notes: [], review: { state: "reviewing", reviewer: "claude", round: 1, max: 2 } });
      console.log(p.strip(p.card(c, 90, p.styleFor({ isTTY: false }, { NO_COLOR: "1" })).join("\\n")));`], { env: env(L), encoding: "utf8" });
    assert.match(r.stdout, re, `${L}: ${r.stdout}${r.stderr}`);
  }
  console.log("pane and labels: ok");

  // ---- the criteria file stays small: past the limit the oldest review-made ones are merged ---------
  const word = (i) => `${"bcdfghjklmnpqrstvwxz"[i % 20]}${"aeiou"[Math.floor(i / 20) % 5]}${"bcdfghjklmnpqrstvwxz"[(i * 7) % 20]}${"aeiou"[i % 5]}`;
  for (let i = 0; i < crit.MAX_ITEMS + 3; i++) crit.addCriterion(p, `${word(i)} ${word(i + 50)} ${word(i + 100)} checked`, { section: "reviews" });
  const items = crit.parse(fs.readFileSync(crit.criteriaFile(p), "utf8")).flatMap((s) => s.items);
  assert.ok(items.length <= crit.MAX_ITEMS, `at most ${crit.MAX_ITEMS} items, got ${items.length}`);
  assert.ok(items.some((i) => /merged/.test(i)));
  console.log("criteria cap: ok");
  console.log("auto review tests passed");
} finally {
  if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
}
