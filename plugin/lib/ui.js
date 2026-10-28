// Terminal styling for ekip's own output: colors only on a TTY, never with NO_COLOR, and never on
// stdout that a lead agent parses (worker reports stay plain).
const on = (stream) => stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const wrap = (open, close) => (s, stream = process.stdout) => (on(stream) ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), under: wrap(4, 24),
  red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39), magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
};

export const sym = { ok: "●", warn: "●", bad: "●", off: "○", arrow: "→", dot: "·", check: "✓", cross: "✗" };

/** A colored status dot: ok / warn / bad / off. */
export const dot = (state, stream) => ({ ok: c.green, warn: c.yellow, bad: c.red, off: c.gray }[state] ?? c.gray)(state === "off" ? sym.off : sym.ok, stream);

/** "label   value" rows with the labels padded to one column. */
export function rows(pairs, { pad } = {}) {
  const w = pad ?? Math.max(...pairs.map(([k]) => strip(k).length));
  return pairs.map(([k, v]) => `  ${k}${" ".repeat(Math.max(1, w - strip(k).length + 2))}${v}`).join("\n");
}

/** A section title: a colored bar and the name. */
export const title = (s, stream) => `\n${c.magenta("▍", stream)}${c.bold(s, stream)}`;

/** Messages ekip prints about itself go to stderr, prefixed and colored. */
export const say = (s) => process.stderr.write(`${c.magenta("ekip", process.stderr)} ${c.gray(sym.arrow, process.stderr)} ${s}\n`);
export const warn = (s) => process.stderr.write(`${c.yellow("ekip", process.stderr)} ${c.yellow("!", process.stderr)} ${s}\n`);

export const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

const LOGO = [
  "███████╗██╗  ██╗██╗██████╗ ",
  "██╔════╝██║ ██╔╝██║██╔══██╗",
  "█████╗  █████╔╝ ██║██████╔╝",
  "██╔══╝  ██╔═██╗ ██║██╔═══╝ ",
  "███████╗██║  ██╗██║██║     ",
  "╚══════╝╚═╝  ╚═╝╚═╝╚═╝     ",
];
// Violet → cyan, one color per row; truecolor when the terminal says so, else the 256-color cube.
const GRADIENT = [[167, 139, 250], [139, 151, 248], [111, 163, 246], [83, 175, 244], [56, 189, 238], [34, 211, 238]];
const rgb = ([r, g, b], s) => (process.env.COLORTERM?.match(/truecolor|24bit/)
  ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`
  : `\x1b[38;5;${16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51)}m${s}\x1b[39m`);

/** The big logo with a tagline beside its lower half (status, help, init). */
export function banner(stream = process.stdout) {
  const tag = ["", "", "", c.bold("tek terminal, tek Claude, koca bir ekip", stream), c.gray("işler başka kotalara · her proje kendi hafızasıyla", stream), ""];
  return `\n${LOGO.map((l, i) => `  ${on(stream) ? rgb(GRADIENT[i], l) : l}   ${tag[i]}`.trimEnd()).join("\n")}`;
}

/** One line for the top of a lead session. */
export const mark = (stream = process.stdout) => (on(stream) ? `${rgb(GRADIENT[0], "◆")} ${c.bold(rgb(GRADIENT[2], "ekip"), stream)}` : "◆ ekip");
