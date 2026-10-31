import { t } from "./i18n.js";
// Shared terminal language for ekip's own screens. Never color piped output or NO_COLOR.
const on = (stream = process.stdout) => !!stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const mode = () => process.env.COLORTERM?.match(/truecolor|24bit/i) ? "rgb" : process.env.TERM?.includes("256color") ? "256" : "16";
const ansi = (open, close) => (s, stream = process.stdout) => on(stream) ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
const rgbColor = ([r, g, b], s, stream = process.stdout) => {
  if (!on(stream)) return String(s);
  if (mode() === "rgb") return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  if (mode() === "256") return `\x1b[38;5;${16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51)}m${s}\x1b[39m`;
  const index = [r, g, b].indexOf(Math.max(r, g, b));
  return `\x1b[${index === 0 ? (g > 100 ? 33 : 31) : index === 1 ? (r > 100 ? 33 : 32) : (r > 100 ? 35 : 34)}m${s}\x1b[39m`;
};

export const c = {
  bold: ansi(1, 22), dim: ansi(2, 22), italic: ansi(3, 23), under: ansi(4, 24),
  red: ansi(31, 39), green: ansi(32, 39), yellow: ansi(33, 39), blue: ansi(34, 39), magenta: ansi(35, 39), cyan: ansi(36, 39), gray: ansi(90, 39),
  rgb: rgbColor,
};
export const sym = { ok: "●", warn: "●", bad: "●", off: "○", arrow: "›", dot: "·", check: "✓", cross: "✗" };
export const dot = (state, stream) => ({ ok: c.green, warn: c.yellow, bad: c.red, off: c.gray }[state] ?? c.gray)(state === "off" ? sym.off : sym.ok, stream);
export const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
export const width = (stream = process.stdout, fallback = 80) => Math.max(24, stream.columns || Number(process.env.COLUMNS) || fallback);
export function fit(s, max = width()) {
  s = String(s);
  if (process.env.EKIP_NO_FIT === "1") return s;
  if (strip(s).length <= max) return s;
  // cut at the last word boundary (when it keeps most of the line), never in the middle of a word
  let out = "", n = 0, space = -1, spaceN = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/g)) {
    if (part.startsWith("\x1b[")) { out += part; continue; }
    for (const ch of part) {
      if (n >= Math.max(0, max - 1)) {
        const head = space >= 0 && spaceN > max * 0.5 && ch !== " " ? out.slice(0, space).replace(/[\s,.;:·-]+$/, "") : out;
        return `${head}…${on() ? "\x1b[0m" : ""}`;
      }
      if (ch === " ") { space = out.length; spaceN = n; }
      out += ch; n++;
    }
  }
  return out;
}
export function rows(pairs, { pad } = {}) {
  const w = pad ?? Math.max(0, ...pairs.map(([k]) => strip(k).length));
  return pairs.map(([k, v]) => fit(`  ${k}${" ".repeat(Math.max(1, w - strip(k).length + 2))}${v}`)).join("\n");
}
export const title = (s, stream) => `\n${c.cyan("›", stream)} ${c.bold(s, stream)}`;
export function progress(pct, cells = 16, stream) {
  const value = Math.max(0, Math.min(100, Number(pct) || 0)) / 100 * cells;
  const full = Math.floor(value), eighth = Math.floor((value - full) * 8);
  const chars = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  return `${c.cyan("█".repeat(full) + (full < cells ? chars[eighth] : ""), stream)}${c.gray("░".repeat(Math.max(0, cells - full - (eighth ? 1 : 0))), stream)}`;
}
export const say = (s) => process.stderr.write(`${c.cyan("ekip", process.stderr)} ${c.gray(sym.arrow, process.stderr)} ${t(s)}\n`);
export const warn = (s) => process.stderr.write(`${c.yellow("ekip", process.stderr)} ${c.yellow("!", process.stderr)} ${t(s)}\n`);

// The logo in the terminal: the prompt (the lead, amber) fanning out to the team (teal).
const LEAD = [[255, 180, 92], [247, 150, 74], [240, 123, 63], [240, 123, 63]];
const TEAM = [45, 212, 191];
export const CHEVRON = ["  ▜█▄    ", "    ▜█▄  ", "    ▟█▀  ", "  ▟█▀    "];
export const FAN = ["     ╭──●", "─────┼──●", "     ╰──●", ""];
export function banner(stream = process.stdout) {
  const text = [c.bold("ekip", stream), c.gray(t("tek terminal, tek Claude, koca bir ekip"), stream), "", ""];
  const lines = CHEVRON.map((ch, i) => `${c.rgb(LEAD[i], ch, stream)}${c.rgb(TEAM, FAN[i].padEnd(9), stream)}   ${text[i]}`.trimEnd());
  return `\n${lines.join("\n")}\n`;
}
export const mark = (stream = process.stdout) => `${c.rgb(LEAD[2], "❯", stream)} ${c.bold(c.rgb(TEAM, "ekip", stream), stream)}`;
export function welcome(stream = process.stdout) {
  return `${banner(stream)}${mark(stream)}  ${c.bold(t("tek Claude lead’in işleri kendi kotalarındaki işçilere dağıtır."), stream)}\n  ${c.cyan("1", stream)} ${t("Claude’a her zamanki gibi isteğini söyle; ekip işi böler ve diğer kotalardaki işçilere verir.")}\n  ${c.cyan("2", stream)} ${t("İlerlemeyi alttaki bölmede ve web panelinde izle.")}\n  ${c.cyan("3", stream)} ${t("Durum ve yardım için ekip status / ekip help.")}`;
}
