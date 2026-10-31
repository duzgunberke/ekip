#!/usr/bin/env node
// Renders the pool and provider logos the web panel shows (hub/web/src/lib/logos.json) into small PNGs
// for the terminal: plugin/assets/logos/<name>@2x.png and @3x.png (26×32 and 38×48 px, transparent:
// the shape of two cells of one row, the mark centred in it), plus plugin/assets/logos/logos.json (the same list, the file names
// and the colours). Made for a dark terminal: one-colour black marks are drawn light, coloured marks
// keep their brand colour unless it is too dark to read on the pane's background.
//
// The SVGs come from the panel's own packages (@lobehub/icons-static-svg, MIT; simple-icons, CC0;
// lucide's "bot" for anything without a logo, ISC), so run it after `pnpm install` in hub/web. Chrome
// draws them (the same renderer as the panel); the PNGs are committed, users need neither npm nor Chrome.
//
//   node scripts/render-logos.mjs [--modules hub/web/node_modules] [--chrome PATH]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MODULES = path.resolve(arg("--modules", path.join(root, "hub/web/node_modules")));
const CHROME = arg("--chrome", ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p)));
const OUT = path.join(root, "plugin/assets/logos");
const MAP = path.join(root, "hub/web/src/lib/logos.json");
// the task pane's colours (plugin/lib/tasks/pane.js, docs/brand.md)
const BG = "#0E1014", TEXT = "#ECEEF2", MUTED = "#98A1B0";
const SIZES = { 2: [26, 32], 3: [38, 48] }; // two cells of a 16 pt row (cells are about 0.4 as wide as high), at 2x and 3x
const INK = 0.88; // the mark's share of the width: a little air on each side, centred in the height

if (!fs.existsSync(path.join(MODULES, "simple-icons")) || !fs.existsSync(path.join(MODULES, "@lobehub/icons-static-svg"))) {
  console.error(`no logo packages in ${MODULES}: run pnpm install in hub/web first (or pass --modules)`);
  process.exit(1);
}
if (!CHROME) { console.error("needs Google Chrome or Chromium (--chrome PATH)"); process.exit(1); }

const version = (pkg) => JSON.parse(fs.readFileSync(path.join(MODULES, pkg, "package.json"), "utf8")).version;
const map = JSON.parse(fs.readFileSync(MAP, "utf8"));
const si = await import(path.join(fs.realpathSync(path.join(MODULES, "simple-icons")), "index.mjs"));
const bySlug = Object.fromEntries(Object.values(si).filter((x) => x?.slug).map((x) => [x.slug, x]));

// ---- colours ---------------------------------------------------------------------------------------

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** The brand colour when it reads on the dark pane, the pane's text colour when it does not. */
const readable = (hex) => (hex && contrast(hex, BG) >= 3 ? hex.toUpperCase() : TEXT);

// ---- the marks -------------------------------------------------------------------------------------

/** { svg (markup, fill = currentColor), color (what the PNG is drawn in), glyph (the brand colour for a text-only terminal) } */
function mark(logo) {
  const [pkg, name] = logo.split(":");
  if (pkg === "lobehub") {
    const dir = path.join(MODULES, "@lobehub/icons-static-svg/icons");
    const svg = fs.readFileSync(path.join(dir, `${name}.svg`), "utf8");
    // one-colour marks (black on the panel's light theme): light here; the colour variant names the brand colour
    const colorFile = path.join(dir, `${name}-color.svg`);
    const brand = fs.existsSync(colorFile) ? fs.readFileSync(colorFile, "utf8").match(/(?:fill|stop-color)="(#[0-9a-fA-F]{6})"/)?.[1] : null;
    return { svg, color: TEXT, glyph: readable(brand) };
  }
  if (pkg === "simple-icons") {
    const icon = bySlug[name];
    if (!icon) throw Error(`simple-icons has no "${name}"`);
    const color = readable(`#${icon.hex}`);
    return { svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="${icon.path}"/></svg>`, color, glyph: color };
  }
  throw Error(`unknown logo source ${logo}`);
}
// lucide "bot" (ISC), the panel's icon for a pool or provider without a logo
const BOT = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`;

const files = {};
for (const { logo } of Object.values(map.icons)) {
  if (files[logo]) continue;
  const name = logo.split(":")[1];
  if (Object.values(files).some((f) => f.file === name)) throw Error(`two logos would share the file name ${name}`);
  files[logo] = { file: name, ...mark(logo) };
}
files.unknown = { file: "unknown", svg: BOT, color: MUTED, glyph: MUTED };

// ---- render: one sprite per size in Chrome, cut into squares here ------------------------------------

function decodePng(buf) {
  let at = 8, width, height, type, depth;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.toString("ascii", at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; if (data[12]) throw Error("interlaced PNG"); }
    if (kind === "IDAT") idat.push(data);
    at += 12 + len;
  }
  if (depth !== 8 || (type !== 6 && type !== 2)) throw Error(`unexpected PNG (depth ${depth}, type ${type})`);
  const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(width * height * 4), line = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      px[o] = line[x * bpp]; px[o + 1] = line[x * bpp + 1]; px[o + 2] = line[x * bpp + 2]; px[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
  }
  return { width, height, px };
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
};
function encodePng(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-logos-"));
const list = Object.values(files);
const PER_ROW = 8;
try {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [scale, [SW, SH]] of Object.entries(SIZES)) {
    const rows = Math.ceil(list.length / PER_ROW), W = PER_ROW * SW, H = rows * SH, ink = Math.round(SW * INK), px0 = (SW - ink) / 2, py0 = (SH - ink) / 2;
    const cells = list.map((f, i) => `<div style="position:absolute;left:${(i % PER_ROW) * SW + px0}px;top:${Math.floor(i / PER_ROW) * SH + py0}px;width:${ink}px;height:${ink}px;color:${f.color}">${f.svg.replace(/<svg\b/, '<svg width="100%" height="100%" style="display:block"').replace(/\s(?:width|height)="1em"/g, "")}</div>`).join("");
    const html = path.join(tmp, `sprite-${scale}.html`), png = path.join(tmp, `sprite-${scale}.png`);
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}</style></head><body>${cells}</body></html>`);
    const r = spawnSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(tmp, "profile")}`,
      "--force-device-scale-factor=1", "--default-background-color=00000000", `--window-size=${W},${H}`, `--screenshot=${png}`, `file://${html}`], { encoding: "utf8", timeout: 60_000 });
    if (!fs.existsSync(png)) throw Error(`Chrome made no screenshot: ${r.stderr || r.error}`);
    const img = decodePng(fs.readFileSync(png));
    if (img.width < W || img.height < H) throw Error(`sprite is ${img.width}x${img.height}, wanted ${W}x${H}`);
    list.forEach((f, i) => {
      const ox = (i % PER_ROW) * SW, oy = Math.floor(i / PER_ROW) * SH, px = Buffer.alloc(SW * SH * 4);
      for (let y = 0; y < SH; y++) img.px.copy(px, y * SW * 4, ((oy + y) * img.width + ox) * 4, ((oy + y) * img.width + ox + SW) * 4);
      fs.writeFileSync(path.join(OUT, `${f.file}@${scale}x.png`), encodePng(SW, SH, px));
    });
  }
  const out = {
    about: "Generated by scripts/render-logos.mjs from hub/web/src/lib/logos.json; do not edit by hand. color: what the PNG is drawn in; glyph: the brand colour for a terminal without images.",
    packages: { "@lobehub/icons-static-svg": version("@lobehub/icons-static-svg"), "simple-icons": version("simple-icons"), "lucide-react": version("lucide-react") },
    sizes: Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [`${k}x`, v.join("x")])),
    icons: map.icons, families: map.families,
    files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { file: f.file, color: f.color, glyph: f.glyph }])),
  };
  fs.writeFileSync(path.join(OUT, "logos.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${list.length} logos × ${Object.keys(SIZES).length} sizes → ${path.relative(root, OUT)}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
