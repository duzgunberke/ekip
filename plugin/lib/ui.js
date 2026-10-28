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

export const banner = (stream = process.stdout) => [
  c.magenta("  ┌─┐┬┌─┬┌─┐", stream),
  `${c.magenta("  ├┤ ├┴┐│├─┘", stream)}  ${c.dim("one terminal, one Claude, a whole team", stream)}`,
  c.magenta("  └─┘┴ ┴┴┴  ", stream),
].join("\n");
