// The live task pane (`ekip tasks --watch`), drawn from a plain model so it can be tested without a
// terminal: a header strip (the ekip mark, what waits for you / is stuck / runs / finished, the clock
// and version), one card per task (title, project, a coloured progress bar, the current step, its
// workers), a calm empty state with the logo and the last results, and the pools as a footer.
// Colours from docs/brand.md (dark). Without 256 colours or truecolor it falls back to ASCII, NO_COLOR
// and pipes get no escape codes, and a narrow pane (< 60 columns) gets the short form. Every line fits
// the pane; text is shortened at a word boundary with "…", never mid-word.
import { asciiOnly, bar as stateBar, colorMode, glyph, paint } from "../core/status-style.js";
import { CHEVRON, FAN } from "../core/ui.js";
import { t, lang } from "../core/i18n.js";

export const NARROW = 60;
const HEX = {
  bg: "#0E1014", card: "#15181E", text: "#ECEEF2", muted: "#98A1B0", border: "#252A33",
  lead: "#F07B3F", leadHi: "#FFB45C", team: "#2DD4BF", done: "#3FCF7A", failed: "#F2555A", blocked: "#F5A524", waiting: "#FACC15",
};
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const cube = ([r, g, b]) => 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);

/** Escape codes for one output: foreground, card background and bold, or nothing at all. */
export function styleFor(stream = process.stdout, env = process.env) {
  const mode = colorMode(stream, env), ascii = asciiOnly(stream, env);
  const fg = (hex, s) => {
    s = String(s);
    if (mode === "none" || !s) return s;
    if (mode === "16") return s;
    const [r, g, b] = rgbOf(HEX[hex] ?? hex);
    return `\x1b[${mode === "rgb" ? `38;2;${r};${g};${b}` : `38;5;${cube([r, g, b])}`}m${s}\x1b[39m`;
  };
  // the card colour is a few shades above the background; a 256-colour terminal gets the grey ramp
  const cardOn = mode === "rgb" ? `\x1b[48;2;${rgbOf(HEX.card).join(";")}m` : mode === "256" ? "\x1b[48;5;234m" : "";
  return {
    mode, ascii, color: mode !== "none",
    fg, muted: (s) => fg("muted", s), bold: (s) => (mode === "none" ? String(s) : `\x1b[1m${s}\x1b[22m`),
    card: (s) => (cardOn ? `${cardOn}${s}\x1b[49m` : s),
    state: (state, s) => paint(state, s, stream, env), glyph: (state) => glyph(state, stream, env),
    // a thin line bar: the done part in the task's colour, half cells as "╸", the rest in the border colour
    bar: (state, pct, cells) => {
      if (ascii) return stateBar(state, pct, cells, stream, env);
      const halves = Math.round(Math.max(0, Math.min(100, Number(pct) || 0)) / 100 * cells * 2);
      const full = Math.floor(halves / 2), half = halves % 2;
      return `${paint(state, "━".repeat(full) + (half ? "╸" : ""), stream, env)}${fg("#343A46", "━".repeat(cells - full - half))}`;
    },
  };
}

// ---- text width and shortening -------------------------------------------------------------------

export const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const wide = (cp) => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff);
/** Columns a string takes on screen (escape codes do not count; CJK and emoji take two). */
export function cols(s) {
  let n = 0;
  for (const ch of strip(s)) { const cp = ch.codePointAt(0); n += cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) ? 0 : wide(cp) ? 2 : 1; }
  return n;
}
/** Plain text in at most n columns: whole words and "…"; only a long token (a path, an id) is ever cut. */
export function clip(text, n) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (n <= 0) return "";
  if (cols(s) <= n) return s;
  if (n === 1) return "…";
  let out = "";
  for (const w of s.split(" ")) {
    const next = out ? `${out} ${w}` : w;
    if (cols(next) > n - 1) break;
    out = next;
  }
  if (out) return `${out.replace(/[\s,.;:·-]+$/, "")}…`;
  // not even the first word fits: an ordinary word is never cut (only "…" is left); a long token
  // such as a path or an id is cut, since it has no shorter whole form
  const first = s.split(" ")[0];
  if (cols(first) <= 12) return "…";
  let cut = "";
  for (const ch of s) { if (cols(cut + ch) > n - 1) break; cut += ch; }
  return `${cut}…`;
}
/** Middle ellipsis for names (a long project or folder): keeps the start and the end. */
export function middle(text, n) {
  const s = String(text ?? "");
  if (cols(s) <= n) return s;
  if (n <= 1) return n === 1 ? "…" : "";
  const chars = [...s], head = Math.ceil((n - 1) / 2), tail = Math.floor((n - 1) / 2);
  return `${chars.slice(0, head).join("")}…${tail ? chars.slice(-tail).join("") : ""}`;
}
const pad = (s, n) => `${s}${" ".repeat(Math.max(0, n - cols(s)))}`;

// Parts in priority order, joined until the next one would not fit: [{ text, paint }]; the first part
// is shortened when even it does not fit.
function fitParts(parts, n, sep = "  ") {
  const out = [];
  let used = 0;
  for (const [i, p] of parts.entries()) {
    if (!p?.text) continue;
    const gap = out.length ? cols(sep) : 0;
    if (used + gap + cols(p.text) <= n) { out.push(p.paint ? p.paint(p.text) : p.text); used += gap + cols(p.text); continue; }
    if (i === 0 || (p.shrink && n - used - gap > 8)) { const s = clip(p.text, n - used - gap); out.push(p.paint ? p.paint(s) : s); used += gap + cols(s); }
    break;
  }
  return { text: out.join(sep), used };
}

// ---- the header strip ----------------------------------------------------------------------------

const COUNT = [
  ["waiting", "waiting-user", "?", () => t("senden beklenen")],
  ["stuck", "blocked", "■", () => t("takılan")],
  ["running", "running", "●", () => t("çalışan")],
  ["done", "done", "✓", () => t("biten")],
];

/** The top line: the mark, the four counts (labels drop first when narrow), clock and version on the right. */
export function header(m, width, st) {
  const markText = st.ascii ? "> ekip" : "❯ ekip";
  const mark = st.color ? `${st.fg("lead", st.ascii ? ">" : "❯")} ${st.bold(st.fg("team", "ekip"))}` : markText;
  const counts = m.counts ?? {};
  const item = (k, state, sym, label, withLabel) => {
    const n = counts[k] ?? 0, s = `${st.ascii ? { waiting: "?", stuck: "#", running: "*", done: "+" }[k] : sym} ${n}${withLabel ? ` ${label()}` : ""}`;
    return { text: s, paint: (x) => (n ? st.state(state, x) : st.muted(x)) };
  };
  const right = [m.clock, m.version ? `v${m.version}` : ""].filter(Boolean).join("  ");
  const inner = width - 2;
  for (const labels of [true, false]) {
    const items = COUNT.map(([k, state, sym, label]) => item(k, state, sym, label, labels));
    const need = cols(markText) + 3 + items.reduce((a, x) => a + cols(x.text), 0) + (items.length - 1) * 3;
    for (const r of [right, m.clock ?? "", ""]) {
      if (need + (r ? cols(r) + 2 : 0) > inner) continue;
      const left = `${mark}   ${items.map((x) => x.paint(x.text)).join("   ")}`;
      const gap = inner - cols(left) - cols(r);
      return st.card(` ${left}${" ".repeat(gap)}${r ? st.muted(r) : ""} `);
    }
  }
  // very narrow: the mark and the non-zero counts that fit
  const items = COUNT.map(([k, state, sym, label]) => item(k, state, sym, label, false));
  const { text } = fitParts([{ text: markText, paint: () => mark }, ...items], inner, " ");
  return st.card(pad(` ${text}`, width));
}

// ---- task cards ----------------------------------------------------------------------------------

// One line inside a card: the accent bar in the task's colour, then the content, padded to the card.
function cardLine(content, state, width, st) {
  const accent = st.state(state, st.ascii ? "|" : "▎");
  return ` ${st.card(`${accent} ${content}${" ".repeat(Math.max(0, width - 2 - 3 - cols(content)))} `)}`;
}

/**
 * A task as a card. card: { state, title, project, pct, status, statusState, when, step: { n, total,
 * title, note }, stalled, workers: [{ state, via, label, note }], ask: { question, options }, result }.
 */
export function card(x, width, st, { compact = false } = {}) {
  const narrow = width < NARROW, inner = width - 2 - 3 - 1;
  const lines = [];
  // title line: icon, title (bold), project (muted) on the right
  const icon = st.state(x.state, st.glyph(x.state));
  const project = x.project && !narrow ? middle(x.project, Math.min(24, Math.floor(inner / 3))) : "";
  const titleRoom = inner - 2 - (project ? cols(project) + 2 : 0);
  const title = clip(x.title, titleRoom);
  const barCells = narrow ? 8 : compact ? 12 : Math.min(24, Math.max(10, Math.floor(inner / 4)));
  const pctText = `${x.pct ?? 0}%`;
  if (compact) {
    // one line: icon title  bar pct  status
    const tail = ` ${st.bar(x.state, x.pct, barCells)} ${pctText}`;
    const room = inner - 2 - cols(tail) - 1;
    const tt = clip(x.title, Math.max(8, room));
    const head = `${icon} ${st.bold(tt)}`;
    const fill = Math.max(1, inner - cols(head) - cols(tail));
    lines.push(cardLine(`${head}${" ".repeat(fill)}${tail}`, x.state, width, st));
    if (x.ask?.question) {
      // the question and, when there is room, its options: answering is what the user came for
      const opts = (x.ask.options ?? []).map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join("   ");
      const withOpts = opts && inner - 2 - cols(opts) - 3 >= 24;
      const q = clip(`${st.glyph("waiting-user")} ${x.ask.question}`, withOpts ? inner - 2 - cols(opts) - 3 : inner - 2);
      lines.push(cardLine(`  ${st.state("waiting-user", q)}${withOpts ? `   ${opts.replace(/([A-H]\))/g, (k) => st.fg("team", k))}` : ""}`, x.state, width, st));
      return lines;
    }
    const now = x.result ? { text: `${t("Sonuç")}: ${x.result}` } : x.step ? { text: `${t("adım {n}/{total}", { n: x.step.n, total: x.step.total })}  ${x.step.title}`, paint: st.muted } : null;
    if (now) lines.push(cardLine(`  ${fitParts([{ ...now, shrink: true }], inner - 2).text}`, x.state, width, st));
    return lines;
  }
  lines.push(cardLine(`${icon} ${st.bold(title)}${project ? `${" ".repeat(Math.max(2, inner - 2 - cols(title) - cols(project)))}${st.muted(project)}` : ""}`, x.state, width, st));
  if (narrow && x.project) lines.push(cardLine(`  ${st.muted(middle(x.project, inner - 2))}`, x.state, width, st));
  // progress: bar, percent, what holds it, time
  const status = fitParts([
    { text: x.status, paint: (s) => st.state(x.statusState ?? x.state, s), shrink: true },
    ...(x.when ?? []).map((w) => ({ text: w, paint: st.muted })),
  ], inner - 2 - barCells - 2 - cols(pctText) - 2, " · ");
  lines.push(cardLine(`  ${st.bar(x.state, x.pct, barCells)}  ${st.bold(pctText)}  ${status.text}`, x.state, width, st));
  if (x.step) {
    const label = t("adım {n}/{total}", { n: x.step.n, total: x.step.total });
    const parts = fitParts([{ text: x.step.title, shrink: true }, ...(x.step.note ? [{ text: x.step.note, paint: st.muted, shrink: true }] : [])], inner - 2 - cols(label) - 2, " · ");
    lines.push(cardLine(`  ${st.muted(label)}  ${parts.text}`, x.state, width, st));
  }
  if (x.stalled) lines.push(cardLine(`  ${st.state("stalled", `${st.glyph("stalled")} ${clip(x.stalled, inner - 4)}`)}`, x.state, width, st));
  if (x.ask?.question) {
    lines.push(cardLine(`  ${st.state("waiting-user", `${st.glyph("waiting-user")} ${clip(x.ask.question, inner - 4)}`)}`, x.state, width, st));
    if (x.ask.options?.length) {
      const opts = x.ask.options.map((o, i) => ({ text: `${String.fromCharCode(65 + i)}) ${o}`, paint: (s) => `${st.fg("team", s.slice(0, 2))}${s.slice(2)}` }));
      lines.push(cardLine(`    ${fitParts(opts, inner - 4, "   ").text}`, x.state, width, st));
    }
  }
  for (const w of (x.workers ?? []).slice(0, narrow ? 1 : 3)) {
    const sym = st.state(w.state, st.glyph(w.state));
    const parts = fitParts([{ text: w.via, paint: st.bold }, ...(w.label ? [{ text: w.label, shrink: true }] : []), ...(w.note ? [{ text: w.note, paint: (s) => (w.state === "running" ? st.muted(s) : st.state(w.state, s)) }] : [])], inner - 4, "  ");
    lines.push(cardLine(`  ${sym} ${parts.text}`, x.state, width, st));
  }
  if (x.result) lines.push(cardLine(`  ${st.state("done", `${t("Sonuç")}:`)} ${clip(x.result, inner - 2 - cols(t("Sonuç")) - 2)}`, x.state, width, st));
  return lines;
}

// ---- footer: pools -------------------------------------------------------------------------------

/** Pools as small dots (teal: work running, amber: full, grey: idle), wrapped over as many lines as needed. */
export function poolLines(pools = [], width, st, { mesai = false } = {}) {
  if (!pools.length) return [];
  const label = `${t("havuzlar")}${mesai ? ` (${t("mesai")})` : ""}`;
  const items = pools.map((p) => {
    const full = p.capacity > 0 && p.running >= p.capacity, busy = p.running > 0;
    const dot = st.ascii ? (full ? "#" : busy ? "*" : "o") : full ? "●" : busy ? "●" : "○";
    const text = `${dot} ${p.name} ${p.running}/${p.capacity}`;
    return { text, paint: (s) => (full ? st.fg("blocked", s) : busy ? `${st.fg("team", s.slice(0, 1))}${s.slice(1)}` : st.muted(s)) };
  });
  const out = [];
  let line = ` ${st.muted(label)}`, used = 1 + cols(label);
  const indent = width < NARROW ? 1 : used;
  for (const it of items) {
    if (used + 3 + cols(it.text) > width - 1 && used > indent) { out.push(line); line = " ".repeat(indent); used = indent; }
    line += `   ${it.paint(it.text)}`;
    used += 3 + cols(it.text);
  }
  out.push(line);
  return out;
}

// ---- empty state ---------------------------------------------------------------------------------

function emptyState(m, width, st) {
  const out = [];
  const narrow = width < NARROW;
  const calm = t("sakin: çalışan iş yok");
  const recent = (m.recent ?? []).slice(0, 3);
  const hint = t("ayrıntı: {status} · uzun işler: {track}", { status: lang === "en" ? "ekip status" : "ekip durum", track: "ekip track ls" });
  // one left edge for the logo, the last results and the hint, the whole block centred
  const listW = Math.max(0, ...recent.map((r) => 2 + cols(r.title) + (r.result ? 2 + cols(r.result) : 0)));
  const blockW = Math.min(width - 4, Math.max(18 + 3 + Math.max(4, cols(calm)), listW, cols(hint)));
  const left = narrow ? 1 : Math.max(1, Math.floor((width - blockW) / 2));
  const room = width - left - 1;
  const at = (s) => `${" ".repeat(left)}${s}`;
  if (!narrow) {
    const lead = ["leadHi", "lead", "lead", "lead"];
    const text = [st.bold("ekip"), st.muted(clip(calm, room - 21)), "", ""];
    CHEVRON.forEach((ch, i) => {
      const art = st.ascii ? ["  \\\\     ", "   \\\\    ", "   //    ", "  //     "][i] + ["     .--o", "-----+--o", "     '--o", "         "][i] : null;
      const colored = art ?? `${st.fg(lead[i], ch)}${st.fg("team", FAN[i].padEnd(9))}`;
      out.push(at(`${colored}${text[i] ? `   ${text[i]}` : ""}`).trimEnd());
    });
  } else out.push(at(st.muted(clip(calm, room))));
  if (recent.length) {
    out.push("", at(st.muted(clip(t("son biten"), room))));
    for (const r of recent) {
      const parts = fitParts([{ text: r.title, paint: st.bold, shrink: true }, ...(r.result ? [{ text: r.result, paint: st.muted, shrink: true }] : [])], room - 2, "  ");
      out.push(at(`${st.state("done", st.ascii ? "+" : "✓")} ${parts.text}`));
    }
  }
  out.push("", at(st.muted(clip(hint, room))));
  return out;
}

// ---- the whole pane ------------------------------------------------------------------------------

/**
 * The pane as lines, each at most `width` columns: header, cards (or the empty state), loose workers,
 * and the pools as a footer on the last lines. Too tall: cards go compact, then the last ones are
 * counted instead of shown.
 */
export function renderPane(m, { width = 100, height = 30, stream = process.stdout, env = process.env } = {}) {
  const st = styleFor(stream, env);
  width = Math.max(20, width);
  const top = [header(m, width, st), ""];
  const foot = poolLines(m.pools, width, st, { mesai: m.mesai });
  const loose = (m.loose ?? []).map((r) => {
    const parts = fitParts([{ text: r.via, paint: st.bold }, { text: r.label, shrink: true }, ...(r.note ? [{ text: r.note, paint: st.muted }] : [])], width - 5, "  ");
    return ` ${st.state(r.state, st.glyph(r.state))} ${parts.text}`;
  });
  const looseBlock = loose.length ? [` ${st.muted(t("işçiler"))}`, ...loose] : [];
  const room = height - top.length - (foot.length ? foot.length + 1 : 0);
  let body;
  if (!m.cards?.length) body = emptyState(m, width, st);
  else {
    // every card short, then the first ones full while they fit: what needs you stays readable
    const full = m.cards.map((x) => card(x, width, st)), short = m.cards.map((x) => card(x, width, st, { compact: true }));
    const want = room;
    const size = (pick) => pick.reduce((a, c, i) => a + c.length + (i ? 1 : 0), 0);
    const pick = [...short];
    for (let i = 0; i < pick.length; i++) { const next = [...pick]; next[i] = full[i]; if (size(next) <= want) pick[i] = full[i]; }
    body = pick.flatMap((c, i) => [...(i ? [""] : []), ...c]);
    if (body.length > room) {
      // cards that do not fit are counted on the last line
      const lines = [];
      let shown = 0;
      for (const c of short) {
        if (lines.length + c.length + (shown ? 1 : 0) > room - 1) break;
        lines.push(...(shown ? [""] : []), ...c);
        shown++;
      }
      body = [...lines, ` ${st.muted(t("+ {n} görev daha (ekip tasks)", { n: m.cards.length - shown }))}`];
    }
  }
  if (looseBlock.length && body.length + looseBlock.length + 1 <= room) body = [...body, "", ...looseBlock];
  // an empty pane keeps the calm block in the middle; a busy one starts at the top
  const spare = Math.max(0, room - body.length);
  const before = m.cards?.length ? 0 : Math.floor(spare / 2);
  const lines = [...top, ...Array(before).fill(""), ...body.slice(0, Math.max(0, room)), ...Array(Math.max(0, spare - before)).fill(""), ...(foot.length ? ["", ...foot] : [])];
  return lines.slice(0, height).map((l) => (cols(l) > width ? fitLine(l, width) : l));
}

// Last guard: an escape-aware cut for a line that still overflows (never expected, never mid-escape).
function fitLine(s, n) {
  let out = "", used = 0;
  for (const part of String(s).split(/(\x1b\[[0-9;?]*[A-Za-z])/g)) {
    if (part.startsWith("\x1b[")) { out += part; continue; }
    for (const ch of part) { const w = cols(ch); if (used + w > n) return `${out}\x1b[0m`; out += ch; used += w; }
  }
  return out;
}

/**
 * Draws frames without flicker: only the lines that changed are rewritten, inside a synchronized
 * update, with the cursor hidden. A resize (or the first frame) redraws everything.
 */
export function painter(out = process.stdout) {
  let prev = [], size = "";
  return (lines) => {
    const now = `${out.columns}x${out.rows}`;
    const full = now !== size;
    size = now;
    let buf = "\x1b[?2026h\x1b[?25l";
    if (full) buf += "\x1b[H\x1b[2J";
    lines.forEach((l, i) => { if (full || prev[i] !== l) buf += `\x1b[${i + 1};1H\x1b[0m${l}\x1b[0m\x1b[K`; });
    if (lines.length < prev.length) buf += `\x1b[${lines.length + 1};1H\x1b[0m\x1b[J`;
    buf += "\x1b[?2026l";
    prev = lines;
    out.write(buf);
  };
}
