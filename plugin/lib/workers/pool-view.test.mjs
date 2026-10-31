// The pools as the user sees them: only connected ones, a state instead of "0/2", running first, the
// providers behind the free pool, icons that fit their two cells, and the background-work line.
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

// the line: every chip whole, "+3 off" at the end, within the width at any size, plain without colour
const plain = styleFor({ isTTY: false }, {});
for (const w of [30, 44, 60, 80, 120]) {
  const lines = pv.chipLines(view, w, plain);
  for (const l of lines) assert.ok(cols(l) <= w, `${w}: ${l}`);
  const text = lines.map((l) => l.trim()).join("   ");
  for (const s of ["copilot 2/2 full", "free 1", "NVIDIA", "OpenRouter resting ~12 min", "Z.ai failed", "+3 off"]) assert.ok(text.includes(s), `${w}: ${s} in ${text}`);
}
// colour: monograms in front of the names; with an image protocol a PNG badge per pool, counted as two cells
const color = styleFor({ isTTY: true }, { TERM: "xterm-256color", COLORTERM: "truecolor" });
assert.match(strip(pv.chipLines(view, 120, color).join("")), /cp ● copilot/);
const img = pv.chipLines(view, 120, color, { proto: "iterm" });
assert.ok(img.join("").includes("\x1b]1337;File=inline=1;width=2;height=1"));
for (const l of img) assert.ok(cols(l) <= 120);
assert.ok(pv.chipLines(view, 120, color, { proto: "kitty" }).join("").includes("\x1b_Ga=T,f=100,c=2,r=1"));
assert.ok(!pv.chipLines(view, 120, color, { proto: "iterm", logos: "glyph" }).join("").includes("1337"), "glyph: letters only");
assert.ok(!strip(pv.chipLines(view, 120, color, { logos: "off" }).join("")).includes("cp ●"), "off: no icons");
const png = pv.badgePng("codex");
assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert.equal(png.readUInt32BE(16), 32);
// which terminals get images
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "WezTerm" }), "iterm");
assert.equal(pv.imageProtocol({ isTTY: true }, { KITTY_WINDOW_ID: "1" }), "kitty");
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "Apple_Terminal" }), null);
assert.equal(pv.imageProtocol({ isTTY: true }, { TERM_PROGRAM: "WezTerm" }, "glyph"), null);
assert.equal(pv.imageProtocol({ isTTY: false }, { TERM_PROGRAM: "WezTerm" }), null);
// the pane takes the view as its footer
const pane = renderPane({ clock: "10:00", counts: {}, cards: [], pools: view }, { width: 70, height: 16, stream: { isTTY: false }, env: {} });
assert.match(pane.join("\n"), /pools {3}● copilot 2\/2 full/);

// background work: embeddings with their provider and queue, a stopped backfill, the import, reindexing
const jobs = bg.backgroundJobs({
  routing: { embeddings: { nvidia: { ok24: 3000, fail24: 4, lastOkAt: new Date(at - 120_000).toISOString(), lastAt: new Date(at - 120_000).toISOString(), lastStatus: "success" }, openrouter: { ok24: 40, fail24: 3000, lastStatus: "error", lastError: "429" } } },
  vectors: { layer: "L1", done: 120, total: 400, running: false, queue: 280 }, index: { projects: [{ name: "shop", busy: true, wiki: "processing %40", graphs: 1 }] }, importPid: process.pid, at,
});
assert.deepEqual(jobs.map((j) => [j.id, j.state]), [["embeddings", "running"], ["backfill", "error"], ["import", "running"], ["index:shop", "running"]]);
assert.match(jobs[0].detail, /^NVIDIA · 280 queued · last success 2 min ago$/);
assert.match(jobs[1].detail, /120\/400 \(%30\) · stopped → ekip memory reindex/);
for (const w of [40, 70, 100]) { const l = bg.backgroundLine(jobs, w, plain); assert.equal(l.length, 1); assert.ok(cols(l[0]) <= w, `${w}: ${l[0]}`); assert.ok(!/\S…\S/.test(l[0])); }
assert.deepEqual(bg.backgroundLine([{ id: "embeddings", label: "embeddings", state: "ok" }], 80, plain), [], "quiet: no line");
const quietPane = renderPane({ clock: "10:00", counts: {}, cards: [], pools: view, background: jobs }, { width: 90, height: 18, stream: { isTTY: false }, env: {} });
assert.ok(quietPane.some((l) => l.startsWith(" background")), "the pane shows it over the pools");
assert.match(bg.statusSection(jobs), /Background/);

console.log("pools: ok");
