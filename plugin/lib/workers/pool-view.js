// The pools as the user sees them, the same in the task pane, `ekip durum`, the `ekip agents` summary
// and (hub/web/src/lib/pools.ts) the panel: only the pools this user connected (signed in and tested,
// or with a successful run; not installed, never signed in and switched-off pools are hidden and
// counted as "+3 kapalı"), each with its state instead of a bare "0/2": ready (green dot), running n
// (teal, only when n > 0, "2/2 dolu" once it is full), at its limit until a time (orange, "limitte ·
// Çar 01:00"). Running first, then ready, then limited. The free pool lists the providers behind it
// (only those with a key): ready, resting after a 429 ("dinleniyor ~12 dk") or failing.
//
// Each pool has a small icon: in WezTerm and iTerm2 (inline images) and kitty (graphics protocol) a
// one-row PNG badge ekip draws itself (a tinted square with the pool's two letters; no vendor logo),
// elsewhere the same two letters in colour. "poolLogos" in data/config.json: "auto" (default),
// "glyph" (letters only) or "off".
import zlib from "node:zlib";
import { t, lang } from "../core/i18n.js";

// Own colours and two-letter monograms (not brand marks).
export const MONO = {
  agy: ["ag", "#4F8EF7"], codex: ["cx", "#10A37F"], gemini: ["gm", "#1C69FF"], copilot: ["cp", "#8957E5"], qwen: ["qw", "#615CED"],
  opencode: ["oc", "#C9CDD4"], jcode: ["jc", "#E8A33D"], grok: ["gk", "#9CA3AF"], claude: ["cl", "#D97757"], free: ["fr", "#2DD4BF"],
  google: ["go", "#4285F4"], groq: ["gq", "#F55036"], openrouter: ["or", "#6467F2"], nvidia: ["nv", "#76B900"], zhipu: ["zh", "#3859FF"],
  ovh: ["ov", "#4A7BD0"], cerebras: ["cb", "#F05A28"], mistral: ["mi", "#FA520F"], cohere: ["co", "#4DB6AC"], cloudflare: ["cf", "#F38020"],
  huggingface: ["hf", "#FFD21E"], routeway: ["rw", "#A78BFA"], bazaarlink: ["bz", "#F472B6"], router9: ["r9", "#34D399"], modelscope: ["ms", "#60A5FA"],
};
export const PROVIDER_NAMES = { google: "Google", groq: "Groq", openrouter: "OpenRouter", nvidia: "NVIDIA", zhipu: "Z.ai", ovh: "OVH", cerebras: "Cerebras", mistral: "Mistral", cohere: "Cohere", cloudflare: "Cloudflare", huggingface: "HuggingFace", routeway: "Routeway", bazaarlink: "BazaarLink", router9: "Router9", modelscope: "ModelScope" };
export const monogram = (id) => MONO[id] ?? [String(id ?? "?").slice(0, 2), "#98A1B0"];

// ---- the model ------------------------------------------------------------------------------------

const RANK = { running: 0, ready: 1, limited: 2 };

/**
 * The visible pools. workers: limits.workerPools() rows ({ name, status, limit, running, capacity,
 * runs, successRate }); free: { keys, running, capacity, providers }; claude: { running, capacity }.
 * → { pools: [{ name, state, running, capacity, full, resetAt, providers? }], hidden }
 */
export function poolView({ workers = [], free = null, claude = null, disabled = [] } = {}) {
  const pools = [], hidden = [];
  for (const w of workers) {
    const off = disabled.includes(w.name) || w.capacity === 0;
    const connected = w.status === "ready" || w.status === "limited" || (w.status !== "off" && (w.successRate ?? 0) > 0);
    if (off || !connected) { hidden.push(w.name); continue; }
    pools.push(entry(w.name, w.status === "limited" && !(w.running > 0) ? "limited" : w.running > 0 ? "running" : "ready", w.running, w.capacity, w.limit?.resetAt));
  }
  if (claude?.capacity > 0) pools.push(entry("claude", claude.running > 0 ? "running" : "ready", claude.running, claude.capacity));
  if (free?.keys) pools.push({ ...entry("free", free.running > 0 ? "running" : "ready", free.running, free.capacity), providers: free.providers ?? [] });
  else if (free) hidden.push("free");
  pools.sort((a, b) => RANK[a.state] - RANK[b.state]);
  return { pools, hidden: hidden.length };
}
const entry = (name, state, running = 0, capacity = 0, resetAt = null) => ({ name, state, running: running ?? 0, capacity: capacity ?? 0, full: capacity > 0 && running >= capacity, resetAt: state === "limited" ? resetAt ?? null : null });

/**
 * The providers behind the free pool, from freellmapi's routing snapshot (only platforms with a key):
 * ready, resting (every model cooling, or rate-limited), failing. → [{ id, name, state, minutes, error }]
 */
export function freeProviders(rs, at = Date.now()) {
  return Object.entries(rs?.platforms ?? {}).map(([id, m]) => {
    const limitErr = /429|rate.?limit|quota|too many/i.test(m.lastError ?? "");
    const resting = (m.models > 0 && m.cooling >= m.models) || (limitErr && m.fail24 > m.ok24);
    const minutes = m.coolUntil ? Math.max(1, Math.round((m.coolUntil - at) / 60000)) : null;
    const state = !m.models ? "error" : resting ? "resting" : m.ok24 === 0 && m.fail24 > 0 ? "error" : "ready";
    return { id, name: PROVIDER_NAMES[id] ?? id, state, minutes: state === "resting" ? minutes : null, error: state === "error" ? (m.models ? m.lastError : t("model yok")) : null, ok24: m.ok24 ?? 0 };
  }).sort((a, b) => ({ ready: 0, resting: 1, error: 2 })[a.state] - ({ ready: 0, resting: 1, error: 2 })[b.state] || b.ok24 - a.ok24);
}

/** What a running free-pool worker is on, from the snapshot's latest chat request: "NVIDIA nemotron-…". */
export function freeServing(rs, at = Date.now(), maxAgeMs = 10 * 60_000) {
  const r = rs?.recent;
  if (!r?.platform || !r.at || at - Date.parse(r.at) > maxAgeMs) return null;
  const model = String(r.model ?? "").split("/").pop();
  return `${PROVIDER_NAMES[r.platform] ?? r.platform}${model ? ` ${model.length > 22 ? `${model.slice(0, 21)}…` : model}` : ""}`;
}

// "Çar 01:00" / "Wed 01:00"; today: just the time
export function resetLabel(iso, at = Date.now()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const loc = lang === "tr" ? "tr-TR" : "en-GB";
  const time = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (new Date(at).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString(loc, { weekday: "short" }).replace(/\.$/, "")} ${time}`;
}

/** A pool's state words: "", "1", "2/2 dolu", "limitte · Çar 01:00". */
export function stateText(p, at = Date.now()) {
  if (p.state === "running") return p.full ? t("{n}/{cap} dolu", { n: p.running, cap: p.capacity }) : String(p.running);
  if (p.state === "limited") return p.resetAt ? `${t("limitte")} · ${resetLabel(p.resetAt, at)}` : t("limitte");
  return "";
}
const providerText = (x) => (x.state === "resting" ? `${t("dinleniyor")}${x.minutes ? ` ~${t("{n} dk", { n: x.minutes })}` : ""}` : x.state === "error" ? t("hata") : "");

// ---- icons ----------------------------------------------------------------------------------------

/** Which image protocol this output understands: "iterm" (iTerm2, WezTerm), "kitty" or null. */
export function imageProtocol(stream = process.stdout, env = process.env, setting = undefined) {
  if ((setting ?? "auto") !== "auto" || !stream?.isTTY || env.NO_COLOR || env.TERM === "dumb" || env.TMUX) return null;
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_PANE) return "iterm";
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "kitty";
  return null;
}

// 5×7 capitals and digits for the badge
const FONT = {
  A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110", C: "01110100011000010000100001000101110", D: "11110100011000110001100011000111110",
  E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000", G: "01110100011000010111100011000101111", H: "10001100011000111111100011000110001",
  I: "01110001000010000100001000010001110", J: "00111000100001000010000101001001100", K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111",
  M: "10001110111010110101100011000110001", N: "10001100011100110101100111000110001", O: "01110100011000110001100011000101110", P: "11110100011000111110100001000010000",
  Q: "01110100011000110001101011001001101", R: "11110100011000111110101001001010001", S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110", V: "10001100011000110001100010101000100", W: "10001100011000110101101011010101010", X: "10001100010101000100010101000110001",
  Y: "10001100010101000100001000010000100", Z: "11111000010001000100010001000011111", 9: "01110100011000101111000010001001100",
};
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The badge as PNG bytes: a rounded square tinted with the pool's colour, its two letters in white. */
export function badgePng(id, size = 32) {
  const [letters, color] = monogram(id);
  const [r, g, b] = rgb(color);
  const px = Buffer.alloc(size * size * 4);
  const rad = Math.round(size * 0.22);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = Math.max(rad - x, x - (size - 1 - rad), 0), dy = Math.max(rad - y, y - (size - 1 - rad), 0);
    const inside = dx * dx + dy * dy <= rad * rad;
    const i = (y * size + x) * 4;
    if (inside) { px[i] = Math.round(r * 0.85); px[i + 1] = Math.round(g * 0.85); px[i + 2] = Math.round(b * 0.85); px[i + 3] = 255; }
  }
  const text = letters.toUpperCase().slice(0, 2), scale = Math.max(1, Math.floor(size / 12));
  const w = text.length * 5 * scale + (text.length - 1) * scale, h = 7 * scale;
  const ox = Math.floor((size - w) / 2), oy = Math.floor((size - h) / 2);
  [...text].forEach((ch, k) => {
    const bits = FONT[ch] ?? FONT.O;
    for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) {
      if (bits[row * 5 + col] !== "1") continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const x = ox + k * 6 * scale + col * scale + sx, y = oy + row * scale + sy, i = (y * size + x) * 4;
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
      }
    }
  });
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const pngCache = new Map();
/** The escape that draws the badge in two cells of one row, or "" without an image protocol. */
export function badgeImage(id, proto) {
  if (!proto) return "";
  const key = `${proto}:${id}`;
  if (!pngCache.has(key)) {
    const b64 = badgePng(id).toString("base64");
    pngCache.set(key, proto === "kitty" ? `\x1b_Ga=T,f=100,c=2,r=1,q=2;${b64}\x1b\\` : `\x1b]1337;File=inline=1;width=2;height=1;preserveAspectRatio=1:${b64}\x07`);
  }
  return pngCache.get(key);
}

// ---- rendering ------------------------------------------------------------------------------------

/**
 * Chips for a line: [{ text (plain, for width), width, paint() → the coloured string }]. st: the pane's
 * style (fg, muted, state, ascii, color). proto: image protocol or null; logos: "auto" | "glyph" | "off".
 */
export function chips(view, st, { proto = null, logos = "auto", at = Date.now(), providers = true } = {}) {
  const icon = (id) => {
    if (logos === "off" || st.ascii || !st.color) return { text: "", width: 0, paint: () => "" };
    const [letters, color] = monogram(id);
    const img = logos === "auto" ? badgeImage(id, proto) : "";
    return { text: letters, width: 2, paint: () => (img || st.bold(st.fg(color, letters))) };
  };
  const dot = (state) => (st.ascii ? { running: "*", ready: "o", limited: "#", resting: "~", error: "x" }[state] : { running: "●", ready: "●", limited: "■", resting: "◐", error: "✗" }[state]);
  const tone = (state) => ({ running: (s) => st.fg("team", s), ready: (s) => st.fg("done", s), limited: (s) => st.fg("blocked", s), resting: (s) => st.fg("blocked", s), error: (s) => st.fg("failed", s) }[state]);
  const one = (id, name, state, words) => {
    const ic = icon(id);
    const label = `${dot(state)} ${name}${words ? ` ${words}` : ""}`;
    const sep = ic.width ? 1 : 0;
    const make = (w) => ({ text: `${ic.text}${sep ? " " : ""}${dot(state)} ${name}${w ? ` ${w}` : ""}`, width: ic.width + sep + [...`${dot(state)} ${name}${w ? ` ${w}` : ""}`].length, paint: () => `${ic.paint()}${sep ? " " : ""}${tone(state)(dot(state))} ${name}${w ? ` ${state === "ready" ? st.muted(w) : tone(state)(w)}` : ""}` });
    // a chip too wide for a narrow pane drops its words (the dot's colour still says the state)
    return { ...make(words), bare: words ? make("") : null, label };
  };
  const out = [];
  for (const p of view.pools) {
    out.push(one(p.name, p.name, p.state, stateText(p, at)));
    // the providers behind the free pool follow it: "● free › nv ● NVIDIA  gq ◐ Groq dinleniyor ~12 dk"
    if (p.name === "free" && providers) (p.providers ?? []).forEach((x, i) => {
      const c = one(x.id, x.name, x.state, providerText(x));
      const arrow = (x) => (x ? { ...x, text: `› ${x.text}`, width: x.width + 2, paint: () => `${st.muted("›")} ${x.paint()}` } : null);
      out.push(i ? { ...c, sub: true } : { ...arrow(c), bare: arrow(c.bare), sub: true });
    });
  }
  if (view.hidden) out.push({ text: t("+{n} kapalı", { n: view.hidden }), width: [...t("+{n} kapalı", { n: view.hidden })].length, paint: () => st.muted(t("+{n} kapalı", { n: view.hidden })) });
  return out;
}

/** The pools wrapped over lines of at most `width` columns, after a muted label ("havuzlar"). */
export function chipLines(view, width, st, opts = {}) {
  const items = chips(view, st, opts);
  if (!items.length) return [];
  const label = opts.label ?? t("havuzlar");
  const out = [];
  let line = ` ${st.muted(label)}`, used = 1 + [...label].length;
  const indent = width < 60 ? 1 : used;
  for (let it of items) {
    let gap = it.sub ? 2 : 3;
    if (used + gap + it.width > width - 1 && used > indent) { out.push(line); line = " ".repeat(indent); used = indent; gap = indent > 1 ? 3 : 0; }
    if (used + gap + it.width > width - 1 && it.bare) it = it.bare;
    if (used + gap + it.width > width - 1) continue; // even its name does not fit this pane
    line += `${" ".repeat(gap)}${it.paint()}`;
    used += gap + it.width;
  }
  out.push(line);
  return out;
}
