// One colour and one symbol per state, the same in the task pane, `ekip tasks` and `ekip agents`:
// running (teal ●), done (green ✓), failed (red ✗), blocked (orange ■ + why), waiting for the user
// (yellow ?, listed first), paused / orphaned (grey ◌, no process works on it), queued (blue ⧗ + place).
// Colours come from docs/brand.md (dark). Without 256 colours or truecolor the symbols fall back to
// plain ASCII; NO_COLOR, a pipe or TERM=dumb drop the colour and keep the symbols.
export const STATES = {
  running: { glyph: "●", ascii: "*", rgb: [45, 212, 191], ansi: 36 },
  done: { glyph: "✓", ascii: "+", rgb: [63, 207, 122], ansi: 32 },
  failed: { glyph: "✗", ascii: "x", rgb: [242, 85, 90], ansi: 31 },
  stalled: { glyph: "⚠", ascii: "!", rgb: [242, 85, 90], ansi: 31 },
  blocked: { glyph: "■", ascii: "#", rgb: [245, 165, 36], ansi: 33 },
  "waiting-user": { glyph: "?", ascii: "?", rgb: [250, 204, 21], ansi: "1;33", bold: true },
  paused: { glyph: "◌", ascii: "o", rgb: [152, 161, 176], ansi: 90 },
  queued: { glyph: "⧗", ascii: "~", rgb: [96, 165, 250], ansi: 34 },
  pending: { glyph: "○", ascii: ".", rgb: [152, 161, 176], ansi: 90 },
  skipped: { glyph: "–", ascii: "-", rgb: [152, 161, 176], ansi: 90 },
  cancelled: { glyph: "–", ascii: "-", rgb: [152, 161, 176], ansi: 90 },
};
// What needs the user's eye comes first in every list.
const ATTENTION = ["waiting-user", "failed", "stalled", "blocked", "paused", "running", "queued", "pending", "done", "skipped", "cancelled"];
export const rank = (state) => { const i = ATTENTION.indexOf(state); return i < 0 ? ATTENTION.length : i; };

// "none" (no colour), "16", "256" or "rgb"; read at call time so tests and a resized pane see the env.
export function colorMode(stream = process.stdout, env = process.env) {
  if (!stream?.isTTY || env.NO_COLOR || env.TERM === "dumb") return "none";
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return "rgb";
  return /256color/.test(env.TERM ?? "") ? "256" : "16";
}
// Unicode symbols on a capable terminal and in pipes (the lead reads those); ASCII on a 16-colour or
// bare console, or when EKIP_ASCII=1.
export function asciiOnly(stream = process.stdout, env = process.env) {
  if (env.EKIP_ASCII === "1") return true;
  if (["dumb", "linux", "vt100", "vt220"].includes(env.TERM)) return true;
  return !!stream?.isTTY && colorMode(stream, env) === "16";
}

const def = (state) => STATES[state] ?? STATES.pending;
export const glyph = (state, stream, env) => (asciiOnly(stream, env) ? def(state).ascii : def(state).glyph);

/** Text in the state's colour. */
export function paint(state, text, stream = process.stdout, env = process.env) {
  const d = def(state), mode = colorMode(stream, env), s = String(text);
  if (mode === "none" || !s) return s;
  if (mode === "16") return `\x1b[${d.ansi}m${s}\x1b[${d.bold ? "22;" : ""}39m`;
  const [r, g, b] = d.rgb;
  const fg = mode === "rgb" ? `38;2;${r};${g};${b}` : `38;5;${16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51)}`;
  return `\x1b[${d.bold ? "1;" : ""}${fg}m${s}\x1b[${d.bold ? "22;" : ""}39m`;
}
export const icon = (state, stream, env) => paint(state, glyph(state, stream, env), stream, env);
export const badge = (state, text, stream, env) => `${icon(state, stream, env)} ${paint(state, text, stream, env)}`;

/** A progress bar in the task's colour; `[####......]` without unicode. */
export function bar(state, pct, cells = 20, stream = process.stdout, env = process.env) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
  if (asciiOnly(stream, env)) {
    const full = Math.round(p * cells);
    return `[${paint(state, "#".repeat(full), stream, env)}${".".repeat(cells - full)}]`;
  }
  const value = p * cells, full = Math.floor(value), eighth = Math.floor((value - full) * 8);
  const part = full < cells ? ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"][eighth] : "";
  const rest = "░".repeat(Math.max(0, cells - full - (part ? 1 : 0)));
  return `${paint(state, "█".repeat(full) + part, stream, env)}${paint("pending", rest, stream, env)}`;
}
// A narrow pane gets a shorter bar, so the percent and the state still fit on the line.
export const barCells = (cols = process.stdout.columns || Number(process.env.COLUMNS) || 80, wide = 20) => (cols < 50 ? 6 : cols < 70 ? 10 : wide);

/** A task's state for colour and order; `paused` is the caller's paused(t) (no live worker). */
export function taskState(t, { paused = false } = {}) {
  if (t.status === "done") return "done";
  if (t.status === "failed") return "failed";
  if (t.status === "cancelled") return "cancelled";
  if (t.hold?.kind === "waiting-user") return "waiting-user";
  if (t.hold) return "blocked";
  return paused ? "paused" : "running";
}
