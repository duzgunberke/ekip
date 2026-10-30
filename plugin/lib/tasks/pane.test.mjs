// The live task pane: every width from a narrow split to a wide window, NO_COLOR, ASCII, the empty
// state, words never cut, the terminal status file and the flicker-free painter.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-pane-"));
process.env.EKIP_HOME = tmp;
process.env.EKIP_LANG = "en";
const { renderPane, clip, middle, cols, strip, header, styleFor, painter, NARROW } = await import("./pane.js");
const tasks = await import("./tasks.js");

const tty = { isTTY: true };
const truecolor = { TERM: "xterm-256color", COLORTERM: "truecolor" };
const noColor = { ...truecolor, NO_COLOR: "1" };
const xterm16 = { TERM: "xterm" };

const busy = {
  clock: "14:32", version: "1.5.0",
  counts: { waiting: 1, stuck: 1, running: 2, done: 3 },
  cards: [
    { state: "waiting-user", title: "Submit iOS v2.4 for review", project: "ios-app", pct: 50, status: "waiting for you", when: ["9 min"], step: { n: 2, total: 2, title: "Submit for review" }, workers: [], ask: { question: "Submit v2.4 for review now, or after the paywall test ends?", options: ["Submit now", "Wait for the test"] } },
    { state: "blocked", title: "Backfill the demand forecast for every region and every product line", project: "data-pipeline", pct: 0, status: "blocked: BigQuery quota resets at 18:00", when: ["6 min"], step: { n: 1, total: 1, title: "Backfill 90 days" }, workers: [] },
    { state: "running", title: "Add rate limits to the public API", project: "northwind-payments-api-with-a-long-name", pct: 43, status: "running", when: ["11 min", "finish ~14:48"], step: { n: 2, total: 4, title: "Token bucket per API key", note: "70% · go test ./src/ratelimit/... ok" }, workers: [{ state: "running", via: "codex", label: "Token bucket per API key", note: "7 min" }, { state: "queued", via: "free", label: "Backfill", note: "queued (place 2)" }] },
    { state: "done", title: "Document the rate limits", project: "docs-site", pct: 100, status: "done", when: ["20 min"], step: null, workers: [], result: "rate limit page with three examples, preview deployed" },
  ],
  loose: [{ state: "running", via: "copilot", label: "Refresh onboarding screenshots", note: "4 min" }],
  recent: [], pools: [{ name: "codex", running: 1, capacity: 2 }, { name: "copilot", running: 0, capacity: 2 }, { name: "free", running: 3, capacity: 3 }, { name: "claude", running: 0, capacity: 1 }],
};
const empty = { ...busy, counts: { waiting: 0, stuck: 0, running: 0, done: 3 }, cards: [], loose: [], recent: [
  { title: "Add rate limits to the public API", result: "token bucket per API key, 429 with Retry-After; 14 tests pass" },
  { title: "Upload the release build", result: "1.4 GB on the CDN, checksum verified" },
  { title: "Document the rate limits", result: null },
] };

// every word of the model's texts: a shortened text may only end in a whole one of these
const UI = ["calm: nothing is running", "finished lately", "details: ekip status · long jobs: ekip track ls", "+ 9 more tasks (ekip tasks)", "waiting for you", "stuck running done pools workers step Result:"];
const words = new Set(JSON.stringify([busy, empty, UI]).replace(/\\u[0-9a-f]{4}/g, " ").split(/[\s"{}[\]:,]+/).filter(Boolean));
function wholeWords(line, where) {
  for (const tok of strip(line).split(/\s+/)) {
    if (!tok.endsWith("…") || tok === "…") continue;
    const w = tok.slice(0, -1).replace(/^[(]/, "");
    if (/^\d+(\/\d+|%)?$/.test(w)) continue; // a generated number ("1/4", "70%") is whole
    assert.ok(words.has(w) || [...words].some((x) => x.startsWith(w) && x.length === w.length), `cut word "${tok}" in ${where}: ${strip(line)}`);
  }
}

// ---- shortening ------------------------------------------------------------------------------------
assert.equal(clip("Add rate limits to the public API", 100), "Add rate limits to the public API");
assert.equal(clip("Add rate limits to the public API", 20), "Add rate limits to…");
assert.equal(clip("Add rate limits to the public API", 3), "…", "a word is never cut");
assert.equal(clip("./src/ratelimit/bucket_test.go", 10), "./src/rat…", "a long token (a path) is cut");
assert.equal(clip("anything", 0), "");
for (let n = 4; n < 40; n++) { const s = clip("Backfill the demand forecast for every region", n); assert.ok(cols(s) <= n, `${n}`); wholeWords(s, `clip ${n}`); }
assert.equal(middle("northwind-payments-api", 11), "north…s-api");
assert.equal(cols(middle("northwind-payments-api", 11)), 11);
assert.equal(middle("ios-app", 20), "ios-app");
assert.equal(cols("日本"), 4, "wide characters take two columns");
assert.equal(cols("\x1b[1mab\x1b[22m"), 2);

// ---- every width, every mode: no line wider than the pane, no em dash -------------------------------
for (const [name, env, stream] of [["truecolor", truecolor, tty], ["256", { TERM: "xterm-256color" }, tty], ["no-color", noColor, tty], ["ascii", xterm16, tty], ["pipe", truecolor, { isTTY: false }]]) {
  for (const width of [24, 40, 52, 59, 60, 72, 96, 140, 220]) {
    for (const height of [8, 14, 30, 60]) {
      for (const [scene, m] of [["busy", busy], ["empty", empty]]) {
        const lines = renderPane(m, { width, height, stream, env });
        const where = `${name} ${scene} ${width}x${height}`;
        assert.ok(lines.length <= height, `${where}: ${lines.length} lines`);
        for (const l of lines) {
          assert.ok(cols(l) <= width, `${where}: ${cols(l)} > ${width}: ${strip(l)}`);
          assert.ok(!strip(l).includes("—"), `${where}: em dash`);
          wholeWords(l, where);
        }
      }
    }
  }
}

// NO_COLOR and pipes: not one escape code
for (const env of [noColor]) for (const m of [busy, empty]) assert.ok(!renderPane(m, { width: 100, height: 40, stream: tty, env }).join("\n").includes("\x1b"));
assert.ok(!renderPane(busy, { width: 100, height: 40, stream: { isTTY: false }, env: truecolor }).join("\n").includes("\x1b"));
// truecolor: the brand colours (card background, amber mark, teal running)
const colored = renderPane(busy, { width: 100, height: 40, stream: tty, env: truecolor }).join("\n");
assert.ok(colored.includes("\x1b[48;2;21;24;30m"), "card background #15181E");
assert.ok(colored.includes("38;2;45;212;191"), "teal");

// ASCII (a 16-colour console): no box drawing, blocks or unicode symbols
for (const m of [busy, empty]) {
  const out = strip(renderPane(m, { width: 100, height: 40, stream: tty, env: xterm16 }).join("\n"));
  assert.ok(!/[─-⟿]/.test(out), `ascii: ${out.match(/[─-⟿]/)?.[0]}`);
  assert.ok(out.includes("> ekip"));
}

// ---- what the pane says ------------------------------------------------------------------------------
{
  const out = strip(renderPane(busy, { width: 110, height: 60, stream: tty, env: noColor }).join("\n"));
  assert.match(out.split("\n")[0], /^ ❯ ekip {3}\? 1 waiting for you {3}■ 1 stuck {3}● 2 running {3}✓ 3 done +14:32 {2}v1\.5\.0 $/);
  for (const s of ["Submit iOS v2.4 for review", "ios-app", "A) Submit now", "B) Wait for the test", "step 2/4", "codex", "queued (place 2)", "Result: rate limit page", "pools", "codex 1/2", "free 3/3", "workers", "copilot"]) assert.ok(out.includes(s), s);
  // what needs you comes first, as the model orders it; the pools sit on the last line
  assert.ok(out.indexOf("Submit iOS") < out.indexOf("Add rate limits"));
  assert.match(out.split("\n").at(-1), /pools/);
}
{ // too short for every card: the first ones keep their full card, the rest go short, none disappear silently
  const out = strip(renderPane(busy, { width: 110, height: 16, stream: tty, env: noColor }).join("\n"));
  assert.ok(out.includes("A) Submit now"), "the question stays readable");
  assert.ok(out.includes("Document the rate limits") || /\+ \d+ more tasks/.test(out));
  const tiny = strip(renderPane(busy, { width: 110, height: 9, stream: tty, env: noColor }).join("\n"));
  assert.match(tiny, /\+ \d+ more tasks \(ekip tasks\)/);
}
{ // empty: the logo, calm, the last results and where to look
  const out = strip(renderPane(empty, { width: 110, height: 30, stream: tty, env: noColor }).join("\n"));
  for (const s of ["calm: nothing is running", "finished lately", "Upload the release build", "1.4 GB on the CDN", "ekip status", "ekip track ls", "╭──●"]) assert.ok(out.includes(s), s);
  const narrow = strip(renderPane(empty, { width: 40, height: 20, stream: tty, env: noColor }).join("\n"));
  assert.ok(narrow.includes("calm: nothing is running") && !narrow.includes("╭──●"), "a narrow pane drops the logo");
}
{ // narrow (< 60): counts without labels, the project under the title instead of on the right
  const st = styleFor(tty, noColor);
  assert.match(strip(header(busy, 40, st)).trim(), /^❯ ekip {3}\? 1 {3}■ 1 {3}● 2 {3}✓ 3( +14:32)?$/, "labels drop first");
  assert.match(strip(header(busy, 32, st)).trim(), /^❯ ekip {3}\? 1 {3}■ 1 {3}● 2 {3}✓ 3$/, "then the clock");
  assert.match(strip(header(busy, 24, st)).trim(), /^❯ ekip \? 1 ■ 1 ● 2 ✓ 3$/, "then the spacing");
  assert.ok(strip(header(busy, 70, st)).includes("waiting for you"));
  const out = renderPane(busy, { width: NARROW - 1, height: 60, stream: tty, env: noColor }).map(strip);
  const title = out.findIndex((l) => l.includes("Submit iOS"));
  assert.ok(out[title + 1].includes("ios-app"));
}

// ---- the model from real tasks and the terminal status file -------------------------------------------
{
  const a = tasks.create({ title: "Add rate limits", project: "payments-api", steps: ["Read the routes", "Token bucket"] });
  tasks.step(a.id, 1, "done");
  tasks.step(a.id, 2, "running", { pct: 40, detail: "go test ok" });
  const b = tasks.create({ title: "Submit iOS v2.4", project: "ios-app", steps: ["Submit"] });
  tasks.ask(b.id, "Submit now?", ["Yes", "No"]);
  const c = tasks.create({ title: "Backfill", steps: ["Backfill"] });
  tasks.hold(c.id, "blocked", "quota resets at 18:00");
  const status = JSON.parse(fs.readFileSync(tasks.STATUS_FILE, "utf8"));
  assert.deepEqual({ waiting: status.waiting, blocked: status.blocked, running: status.running }, { waiting: 1, blocked: 1, running: 1 });
  fs.writeFileSync(path.join(tmp, "projects.json"), JSON.stringify([{ name: "payments-api", path: "/x/payments-api" }]));
  assert.equal(tasks.writeTerminalStatus(), true, "a new project is written");
  assert.equal(tasks.writeTerminalStatus(), false, "nothing changed: no write");
  assert.deepEqual(JSON.parse(fs.readFileSync(tasks.STATUS_FILE, "utf8")).projects, [{ name: "payments-api", path: "/x/payments-api" }]);

  const m = tasks.paneModel({ tasks: tasks.active(), version: "1.5.0" });
  const card = m.cards.find((x) => x.title === "Add rate limits");
  assert.equal(card.step.n, 2);
  assert.equal(card.step.note, "40% · go test ok");
  assert.equal(card.pct, 70);
  const ask = m.cards.find((x) => x.title === "Submit iOS v2.4");
  assert.deepEqual(ask.ask, { question: "Submit now?", options: ["Yes", "No"] });
  assert.equal(ask.state, "waiting-user");
  assert.match(m.cards.find((x) => x.title === "Backfill").status, /^blocked: quota resets/);
  for (const l of renderPane(m, { width: 80, height: 30, stream: tty, env: truecolor })) assert.ok(cols(l) <= 80);
}

// ---- the painter rewrites only what changed -----------------------------------------------------------
{
  let written = "";
  const out = { columns: 80, rows: 10, write: (s) => { written += s; } };
  const draw = painter(out);
  draw(["one", "two", "three"]);
  assert.ok(written.includes("\x1b[2J") && written.includes("three"), "first frame: full");
  assert.ok(written.startsWith("\x1b[?2026h") && written.endsWith("\x1b[?2026l"), "synchronized update");
  written = "";
  draw(["one", "TWO", "three"]);
  assert.ok(!written.includes("\x1b[2J") && written.includes("\x1b[2;1H") && written.includes("TWO") && !written.includes("three"), "only line 2");
  written = "";
  draw(["one", "TWO"]);
  assert.ok(written.includes("\x1b[3;1H\x1b[0m\x1b[J"), "a shorter frame clears below");
  written = "";
  out.columns = 60;
  draw(["one", "TWO"]);
  assert.ok(written.includes("\x1b[2J"), "a resize redraws everything");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("task pane: ok");
