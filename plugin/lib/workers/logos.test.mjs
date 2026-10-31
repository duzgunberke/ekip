// The terminal's logos are the web panel's: the same list (hub/web/src/lib/logos.json), every logo
// rendered at 2x and 3x as a transparent PNG, the panel's model-family rules, kitty uploads sent once,
// and a pane that does not send a logo again while it stays where it was.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.EKIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-logos-"));
process.env.EKIP_LANG = "en";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const lg = await import("./logos.js");
const { PROVIDER_NAMES } = await import("./pool-view.js");
const { painter } = await import("../tasks/pane.js");

// one list: the plugin's copy says what the hub's says
const hub = JSON.parse(fs.readFileSync(path.join(root, "hub/web/src/lib/logos.json"), "utf8"));
assert.deepEqual(lg.logoData.icons, hub.icons, "plugin/assets/logos/logos.json is stale: run node scripts/render-logos.mjs");
assert.deepEqual(lg.logoData.families, hub.families, "model families differ from the hub's");
// the panel imports every logo the list names
const tsx = fs.readFileSync(path.join(root, "hub/web/src/components/provider-logo.tsx"), "utf8");
for (const { logo } of Object.values(hub.icons)) {
  const [pkg, name] = logo.split(":");
  if (pkg === "lobehub") assert.ok(tsx.includes(`@lobehub/icons-static-svg/icons/${name}.svg?url`) && new RegExp(`\\b${name}: \\w+Logo\\b`).test(tsx), `panel imports lobehub ${name}`);
  else assert.ok(new RegExp(`\\b${name}: si\\w+`).test(tsx), `panel imports simple-icons ${name}`);
  assert.ok(lg.logoData.files[logo], `rendered: ${logo}`);
}

// every logo at 2x (26×32) and 3x (38×48), the shape of two cells of a row: RGBA with a transparent corner
const pngInfo = (buf) => {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), type = buf[25];
  const idat = [];
  for (let at = 8; at < buf.length;) { const n = buf.readUInt32BE(at); if (buf.toString("ascii", at + 4, at + 8) === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + n)); at += 12 + n; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { w, h, type, cornerAlpha: raw[4] }; // the first pixel of the first row is stored as is
};
for (const [logo, f] of Object.entries(lg.logoData.files)) {
  for (const [scale, w, h] of [[2, 26, 32], [3, 38, 48]]) {
    const file = path.join(root, "plugin/assets/logos", `${f.file}@${scale}x.png`);
    assert.ok(fs.existsSync(file), `${logo}: ${file}`);
    const info = pngInfo(fs.readFileSync(file));
    assert.deepEqual([info.w, info.h, info.type], [w, h, 6], `${f.file}@${scale}x: ${w}x${h} RGBA`);
    assert.equal(info.cornerAlpha, 0, `${f.file}@${scale}x: transparent background`);
  }
  assert.match(f.color, /^#[0-9A-F]{6}$/i);
  assert.match(f.glyph, /^#[0-9A-F]{6}$/i);
}
// the licences of the marks are written down
const notice = fs.readFileSync(path.join(root, "THIRD_PARTY.md"), "utf8");
for (const s of ["@lobehub/icons-static-svg", "simple-icons", "lucide", "MIT", "CC0", "ISC"]) assert.ok(notice.includes(s), `THIRD_PARTY.md: ${s}`);

// the panel's rules: pool ids, providers, model families, hosts, and the bot for the rest
assert.equal(lg.logoFor("codex"), "codex");
assert.equal(lg.logoFor("copilot"), "copilot");
assert.equal(lg.logoFor("free"), "unknown");
assert.equal(lg.logoFor("routeway"), "unknown");
assert.equal(lg.logoFor("free", "openrouter/deepseek/deepseek-v4"), "deepseek");
assert.equal(lg.logoFor("groq", "groq/openai/gpt-oss-120b"), "openai");
assert.equal(lg.logoFor("nvidia", "nvidia/nemotron-3-ultra"), "nvidia");
assert.equal(lg.logoInfo("claude").file, "anthropic");
assert.equal(lg.logoInfo("free").file, "unknown");
assert.equal(lg.logoInfo("nvidia").glyph, "#76B900", "brand colour");
assert.equal(lg.logoInfo("copilot").color, "#ECEEF2", "a black mark is drawn light on the dark pane");
for (const id of ["agy", "codex", "gemini", "copilot", "qwen", "opencode", "jcode", "grok", "claude", "free", ...Object.keys(PROVIDER_NAMES)]) {
  for (const s of [2, 3]) assert.ok(lg.logoPng(id, s)?.length > 100, `${id}@${s}x`);
}

// escapes: OSC 1337 with the PNG, two cells by one row; kitty placements, the PNG sent once per output
const osc = lg.logoImage("nvidia", "iterm");
assert.match(osc, /^\x1b\]1337;File=inline=1;size=\d+;width=2;height=1;preserveAspectRatio=1:[A-Za-z0-9+/=]+\x07$/);
assert.equal(Buffer.from(osc.split(":")[1].slice(0, -1), "base64").length, lg.logoPng("nvidia").length);
assert.equal(lg.logoImage("nvidia", null), "");
const place = lg.logoImage("nvidia", "kitty");
assert.match(place, /^\x1b_Ga=p,i=\d+,c=2,r=1,q=2\x1b\\$/);
const sent = new Set();
const first = lg.kittyUpload(`a ${place} b`, sent);
assert.match(first, /\x1b_Ga=T,f=100,i=\d+,c=2,r=1,q=2,m=0;iVBORw0KGgo/, "first use: transmit and place");
for (const chunk of first.match(/;[^\x1b]*\x1b\\/g)) assert.ok(chunk.length - 3 <= 4096, "chunks of at most 4096 bytes");
assert.equal(lg.kittyUpload(`a ${place} b`, sent), `a ${place} b`, "then only the placement");
assert.equal(lg.logoImage("codex", "kitty") === place, false, "one image id per logo");

// the pane: a line whose logos stay put is rewritten around them, the images are not sent again
const frames = [];
const out = { columns: 80, rows: 4, write: (s) => frames.push(s) };
const draw = painter(out);
const line = (n, logo = "nvidia") => ` pools   ${lg.logoImage(logo, "iterm")} copilot  \x1b[38;2;45;212;191m● ${n} running\x1b[39m   ${lg.logoImage("codex", "iterm")} codex  ● ready`;
draw(["head", line(1)]);
assert.equal(frames[0].match(/1337;File/g).length, 2, "first frame: both logos");
draw(["head", line(2)]);
assert.ok(!frames[1].includes("1337"), "a count changed: no image sent again");
assert.ok(frames[1].includes("\x1b[2;12H") && frames[1].includes("● 2 running"), "only the text after the logo, at its column");
assert.ok(frames[1].includes("\x1b[38;2;45;212;191m"), "the colours in force are restored");
draw(["head", line(2)]);
assert.equal(frames[2], "\x1b[?2026h\x1b[?25l\x1b[?2026l", "nothing changed: nothing written");
draw(["head", line(3, "groq")]);
assert.equal(frames[3].match(/1337;File/g).length, 2, "a logo changed: the line is drawn whole");
out.columns = 100;
draw(["head", line(3, "groq")]);
assert.equal(frames[4].match(/1337;File/g).length, 2, "a resize redraws everything");
// kitty: placements only after the first frame; a line drawn whole drops its old placements first
const kframes = [];
const kdraw = painter({ columns: 80, rows: 4, write: (s) => kframes.push(s) });
const kline = (n, at = "") => ` pools   ${at}${lg.logoImage("nvidia", "kitty")} NVIDIA  ● ${n}`;
kdraw(["head", kline(1)]);
assert.match(kframes[0], /a=T,f=100/);
kdraw(["head", kline(2)]);
assert.ok(!kframes[1].includes("a=T") && !kframes[1].includes("a=p"), "kitty: unchanged logo, not placed again");
kdraw(["head", kline(2, "  ")]);
assert.ok(kframes[2].includes("\x1b_Ga=d,d=y,y=2,q=2\x1b\\") && kframes[2].includes("a=p,") && !kframes[2].includes("a=T"), "kitty: moved logo, old placement dropped, PNG not sent again");

console.log("logos: ok");
