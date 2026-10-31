// The pools as the user sees them: only connected ones, a state instead of "0/2", running first, the
// providers behind the free pool, the real logos (two cells) or a brand-coloured glyph, aligned
// columns under one label gutter, and the background-work line in the same style.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EKIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-pools-"));
process.env.EKIP_LANG = "en";
const pv = await import("./pool-view.js");
const bg = await import("../ops/background.js");
const { styleFor, cols, renderPane, strip } = await import("../tasks/pane.js");

const at = Date.parse("2026-10-28T10:00:00Z");
const workers = [
  { name: "agy", status: "ready", running: 0, capacity: 2, successRate: 90 },
  { name: "codex", status: "limited", running: 0, capacity: 2, limit: { resetAt: "2026-10-29T01:00:00Z" } },
  { name: "copilot", status: "ready", running: 2, capacity: 2 },
  { name: "qwen", status: "login", running: 0, capacity: 1, successRate: null }, // never signed in: hidden
  { name: "opencode", status: "off", running: 0, capacity: 1 }, // not installed: hidden
  { name: "jcode", status: "ready", running: 0, capacity: 3 },
  { name: "grok", status: "untested", running: 0, capacity: 1, successRate: 100 }, // a successful run: shown
];
const rs = { platforms: {
  nvidia: { models: 17, cooling: 0, ok24: 1700, fail24: 40, lastError: null },
  openrouter: { models: 10, cooling: 10, ok24: 2, fail24: 300, lastError: "upstream 429: rate limit", coolUntil: at + 12 * 60_000 },
  zhipu: { models: 3, cooling: 0, ok24: 0, fail24: 8, lastError: "500 internal" },
}, recent: { platform: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b", at: new Date(at - 60_000).toISOString() } };

const view = pv.poolView({ workers, free: { keys: true, running: 1, capacity: 3, providers: pv.freeProviders(rs, at) }, claude: { running: 0, capacity: 0 }, disabled: ["jcode"] });
assert.deepEqual(view.pools.map((p) => p.name), ["copilot", "free", "agy", "grok", "codex"], "running > ready > limited; hidden ones left out");
assert.equal(view.hidden, 3, "qwen (no login), opencode (not installed), jcode (switched off)");
const by = Object.fromEntries(view.pools.map((p) => [p.name, p]));
assert.equal(pv.stateText(by.copilot, at), "2/2 full");
assert.equal(pv.stateText(by.free, at), "1");
assert.equal(pv.stateText(by.agy, at), "", "ready: no meaningless 0/2");
assert.match(pv.stateText(by.codex, at), /^limited · \w{3} \d\d:\d\d$/);
// the free pool's providers: ready first, resting with minutes, failing last
const prov = by.free.providers;
assert.deepEqual(prov.map((x) => [x.id, x.state]), [["nvidia", "ready"], ["openrouter", "resting"], ["zhipu", "error"]]);
assert.equal(prov[1].minutes, 12);
assert.equal(pv.freeServing(rs, at), "NVIDIA nemotron-3-ultra-550b…");
assert.equal(pv.freeServing(rs, at + 3600_000), null, "an old request is not what runs now");
// no free keys: the free pool is hidden too
assert.equal(pv.poolView({ workers: [], free: { keys: false } }).hidden, 1);

// the lines: every chip whole, "+3 off" after the pools, within the width at any size, plain without colour
const plain = styleFor({ isTTY: false }, {});
for (const w of [30, 44, 60, 80, 120, 160]) {
  const lines = pv.chipLines(view, w, plain, { at });
  for (const l of lines) assert.ok(cols(l) <= w, `${w}: ${l}`);
  const text = lines.map((l) => l.replace(/\s+/g, " ").trim()).join(" | ");
  assert.ok(!/\x1b/.test(lines.join("")), "plain: no escape codes");
  const expect = w < 60 ? ["copilot ● 2/2", "free ● 1", "agy ●", "codex ■ limited", "+3 off", "OpenRouter ◐ ~12 min", "Z.ai ✗ failed"]
    : ["copilot ● 2/2 full", "free ● 1 running", "agy ● ready", "codex ■ limited ·", "+3 off", "NVIDIA ● ready", "OpenRouter ◐ resting ~12 min", "Z.ai ✗ failed"];
  for (const s of expect) assert.ok(text.includes(s), `${w}: ${s} in ${text}`);
  if (w < 60) assert.ok(!text.includes("NVIDIA") && !text.includes("pools"), `${w}: narrow drops the labels and the ready providers: ${text}`);
  else assert.ok(lines[0].startsWith(" pools ") && lines.some((l) => l.startsWith(" providers ")), `${w}: labels in the gutter`);
}
// aligned columns: on a pane that needs two rows the names and states start at the same columns
const two = pv.chipLines(view, 100, plain, { at }).filter((l) => !l.startsWith(" providers"));
assert.ok(two.length >= 2);
const starts = (l) => [...l.matchAll(/ {2,}(?=\S)/g)].map((m) => m.index + m[0].length);
assert.deepEqual(starts(two[1]).slice(0, 2), starts(two[0]).slice(0, 2), `columns line up:\n${two.join("\n")}`);
// a wide pane fits the pools on one row
assert.equal(pv.chipLines(view, 160, plain, { at }).filter((l) => !l.startsWith(" providers") && !l.startsWith("  ")).length, 1);

// colour without images: a one-colour "◆" in the brand colour, no letter monograms; images: the real logos
const color = styleFor({ isTTY: true }, { TERM: "xterm-256color", COLORTERM: "truecolor" });
const glyphs = pv.chipLines(view, 120, color, { at }).join("\n");
assert.match(strip(glyphs), /◆ copilot {2}● 2\/2 full/);
assert.ok(!/\b(cp|cx|or|zh|nv)\b ●/.test(strip(glyphs)), "no two-letter monograms");
assert.ok(glyphs.includes("\x1b[38;2;118;185;0m◆"), "NVIDIA's mark in NVIDIA green");
const img = pv.chipLines(view, 120, color, { proto: "iterm", at });
assert.ok(img.join("").includes("\x1b]1337;File=inline=1;size="), "OSC 1337 inline images");
assert.ok(img.join("").includes(";width=2;height=1;preserveAspectRatio=1:iVBORw0KGgo"), "two cells, one row, a PNG");
assert.ok(!img.join("").includes("◆"), "images replace the glyphs");
for (const l of img) assert.ok(cols(l) <= 120);
// the columns are the same with images (two cells) as the plain lines say
assert.deepEqual(img.map((l) => cols(l)), pv.chipLines(view, 120, styleFor({ isTTY: true }, { TERM: "xterm-256color", COLORTERM: "truecolor" }), { proto: "iterm", at }).map((l) => cols(l)));
assert.ok(pv.chipLines(view, 120, color, { proto: "kitty", at }).join("").includes("\x1b_Ga=p,i="), "kitty: placements");
assert.ok(!pv.chipLines(view, 120, color, { proto: "iterm", logos: "glyph", at }).join("").includes("1337"), "glyph: no images");
assert.ok(!strip(pv.chipLines(view, 120, color, { logos: "off", at }).join("")).includes("◆"), "off: no marks");
// NO_COLOR: no marks at all, the states still in words
const noColor = styleFor({ isTTY: true }, { NO_COLOR: "1", TERM: "xterm-256color" });
const nc = pv.chipLines(view, 120, noColor, { proto: pv.imageProtocol({ isTTY: true }, { NO_COLOR: "1", TERM_PROGRAM: "WezTerm" }), at }).join("\n");
assert.ok(!/\x1b|◆/.test(nc), "NO_COLOR: no escapes, no marks");
assert.match(nc, /copilot {2}● 2\/2 full/);
// which terminals get images
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "WezTerm" }), "iterm");
assert.equal(pv.imageProtocol({ isTTY: true }, { WEZTERM_PANE: "3" }), "iterm");
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "iTerm.app" }), "iterm");
assert.equal(pv.imageProtocol({ isTTY: true }, { KITTY_WINDOW_ID: "1" }), "kitty");
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM: "xterm-kitty" }), "kitty");
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "Apple_Terminal" }), null);
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "vscode" }), null);
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "WezTerm", NO_COLOR: "1" }), null);
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "WezTerm", TMUX: "/tmp/t" }), null);
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "WezTerm" }, "glyph"), null);
assert.equal(pv.imageProtocol({ isTTY: false }, { TERM_PROGRAM: "WezTerm" }), null);
// the pane takes the view as its footer
const pane = renderPane({ clock: "10:00", counts: {}, cards: [], pools: view }, { width: 70, height: 16, stream: { isTTY: false }, env: {} });
assert.match(pane.join("\n"), /^ pools {7,}copilot {2}● 2\/2 full/m);

// background work: embeddings with their provider and queue, a stopped backfill, the import, reindexing
const jobs = bg.backgroundJobs({
  routing: { embeddings: { nvidia: { ok24: 3000, fail24: 4, lastOkAt: new Date(at - 120_000).toISOString(), lastAt: new Date(at - 120_000).toISOString(), lastStatus: "success" }, openrouter: { ok24: 40, fail24: 3000, lastStatus: "error", lastError: "429" } } },
  vectors: { layer: "L1", done: 120, total: 400, running: false, queue: 280 }, index: { projects: [{ name: "shop", busy: true, wiki: "processing %40", graphs: 1 }] }, importPid: process.pid, at,
});
assert.deepEqual(jobs.map((j) => [j.id, j.state]), [["embeddings", "running"], ["backfill", "error"], ["import", "running"], ["index:shop", "running"]]);
assert.match(jobs[0].detail, /^NVIDIA · 280 queued · last success 2 min ago$/);
assert.match(jobs[1].detail, /120\/400 \(30%\) · stopped → ekip memory reindex/);
for (const w of [40, 70, 100]) { const l = bg.backgroundLine(jobs, w, plain); assert.equal(l.length, 1); assert.ok(cols(l[0]) <= w, `${w}: ${l[0]}`); assert.ok(!/\S…\S/.test(l[0])); }
assert.deepEqual(bg.backgroundLine([{ id: "embeddings", label: "embeddings", state: "ok" }], 80, plain), [], "quiet: no line");
const quietPane = renderPane({ clock: "10:00", counts: {}, cards: [], pools: view, background: jobs }, { width: 90, height: 18, stream: { isTTY: false }, env: {} });
assert.ok(quietPane.some((l) => l.startsWith(" background")), "the pane shows it over the pools");
assert.match(bg.statusSection(jobs), /Background/);

console.log("pools: ok");
