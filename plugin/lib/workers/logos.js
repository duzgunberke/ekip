// The pools' and providers' real logos in the terminal, the same marks as the web panel
// (hub/web/src/components/provider-logo.tsx): one list, hub/web/src/lib/logos.json, rendered by
// scripts/render-logos.mjs into plugin/assets/logos/ (PNG squares at 2x and 3x, light on dark, and
// logos.json with the list, the file names and the brand colours).
//
// In WezTerm and iTerm2 a logo is an inline image (OSC 1337) two cells wide and one row high; kitty
// gets the graphics protocol, the PNG sent once per image id and only placed afterwards. Elsewhere the
// caller draws a one-colour glyph in the brand colour (glyph()).
import fs from "node:fs";

const DIR = new URL("../../assets/logos/", import.meta.url);
const DATA = (() => { try { return JSON.parse(fs.readFileSync(new URL("logos.json", DIR), "utf8")); } catch { return { icons: {}, families: [], files: {} }; } })();
const FAMILIES = DATA.families.map(([re, key]) => [new RegExp(re), key]);
export const logoData = DATA;

/** The logo key for a pool or provider id (and a model id when known), as the panel's logoFor does. */
export function logoFor(id, modelId) {
  const key = String(id ?? "").toLowerCase();
  const model = String(modelId ?? (key.includes("/") ? key : "")).toLowerCase();
  const family = model && FAMILIES.find(([re]) => re.test(model.split("/").pop() ?? model))?.[1];
  if (family) return family;
  const host = model.includes("/") ? model.split("/")[0] : "";
  if (host && DATA.icons[host]) return host;
  return DATA.icons[key] ? key : "unknown";
}

/** { key, title, file, color, glyph } for an id; "unknown" (the panel's bot icon) when it has no logo. */
export function logoInfo(id, modelId) {
  const key = logoFor(id, modelId);
  const icon = DATA.icons[key];
  const f = DATA.files[icon?.logo ?? "unknown"] ?? DATA.files.unknown ?? { file: "unknown", color: "#98A1B0", glyph: "#98A1B0" };
  return { key, title: icon?.title ?? null, ...f };
}

/** The brand colour for a text-only terminal (light when the brand colour is too dark for the pane). */
export const glyphColor = (id) => logoInfo(id).glyph;

// A Retina Mac gets the 3x square, other machines 2x; the terminal scales it into the cells either way.
export const SCALE = process.platform === "darwin" ? 3 : 2;
const pngs = new Map();
/** The PNG bytes of an id's logo, or null when the file is missing. */
export function logoPng(id, scale = SCALE) {
  const file = `${logoInfo(id).file}@${scale}x.png`;
  if (!pngs.has(file)) { try { pngs.set(file, fs.readFileSync(new URL(file, DIR))); } catch { pngs.set(file, null); } }
  return pngs.get(file);
}

// kitty image ids: one per logo file, stable for the life of the process
const kittyIds = new Map();
const kittyId = (file) => { if (!kittyIds.has(file)) kittyIds.set(file, 0x0e4b00 + kittyIds.size + 1); return kittyIds.get(file); };
const kittyFile = new Map();

const escapes = new Map();
/**
 * The escape that draws an id's logo in two cells of one row: OSC 1337 for "iterm" (iTerm2, WezTerm),
 * a kitty placement (the PNG itself goes out once, see kittyUpload) for "kitty"; "" without a protocol.
 */
export function logoImage(id, proto, scale = SCALE) {
  if (!proto) return "";
  const key = `${proto}:${logoInfo(id).file}@${scale}`;
  if (!escapes.has(key)) {
    const png = logoPng(id, scale);
    if (!png) escapes.set(key, "");
    else if (proto === "kitty") {
      const n = kittyId(`${logoInfo(id).file}@${scale}`);
      kittyFile.set(n, png);
      escapes.set(key, `\x1b_Ga=p,i=${n},c=2,r=1,q=2\x1b\\`);
    } else escapes.set(key, `\x1b]1337;File=inline=1;size=${png.length};width=2;height=1;preserveAspectRatio=1:${png.toString("base64")}\x07`);
  }
  return escapes.get(key);
}

/**
 * kitty: turns the first placement of each image in a line into transmit-and-place, so the PNG goes
 * out once per output (sent: the ids this output already has); later placements are a few bytes.
 */
export function kittyUpload(line, sent) {
  return String(line).replace(/\x1b_Ga=p,i=(\d+),([^;\x1b]*)\x1b\\/g, (m, id, rest) => {
    const png = kittyFile.get(Number(id));
    if (!png || sent.has(id)) return m;
    sent.add(id);
    // the payload in 4096-byte chunks, as the protocol asks
    const b64 = png.toString("base64"), parts = b64.match(/.{1,4096}/g);
    return parts.map((p, i) => (i === 0 ? `\x1b_Ga=T,f=100,i=${id},${rest},m=${parts.length > 1 ? 1 : 0};${p}\x1b\\` : `\x1b_Gm=${i < parts.length - 1 ? 1 : 0};${p}\x1b\\`)).join("");
  });
}
