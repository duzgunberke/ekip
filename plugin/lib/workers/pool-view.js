// The pools as the user sees them, the same in the task pane, `ekip durum`, the `ekip agents` summary
// and (hub/web/src/lib/pools.ts) the panel: only the pools this user connected (signed in and tested,
// or with a successful run; not installed, never signed in and switched-off pools are hidden and
// counted as "+3 kapalı"), each with its state instead of a bare "0/2": ready (green dot), running n
// (teal, "2/2 dolu" once it is full), at its limit until a time (orange, "limitte · Çar 01:00").
// Running first, then ready, then full, then limited: what is out of quota always comes last. The free
// pool lists the providers behind it (only those with a key): ready, resting after a 429
// ("dinleniyor ~12 dk") or failing, in the same order.
//
// Each pool and provider shows its real logo, the same mark as the web panel (workers/logos.js): an
// inline image in WezTerm and iTerm2 (OSC 1337) and kitty (graphics protocol), a "◆" in the brand
// colour elsewhere, nothing with NO_COLOR. "poolLogos" in data/config.json: "auto" (default), "glyph"
// (the coloured glyph only) or "off". The pools and the providers share one grid (mark, name, state)
// under a label gutter shared with the background line, so every footer row starts its columns at the
// same x; a limited or resting item, last on its row, spends the free space on the right on its long
// state ("limitte · Çar 01:00"), else it falls back to "limitte 01:00" or "limitte".
import { t, lang } from "../core/i18n.js";
import { glyphColor, logoImage } from "./logos.js";

export const PROVIDER_NAMES = { google: "Google", groq: "Groq", openrouter: "OpenRouter", nvidia: "NVIDIA", zhipu: "Z.ai", ovh: "OVH", cerebras: "Cerebras", mistral: "Mistral", cohere: "Cohere", cloudflare: "Cloudflare", huggingface: "HuggingFace", routeway: "Routeway", bazaarlink: "BazaarLink", router9: "Router9", modelscope: "ModelScope" };

// ---- the model ------------------------------------------------------------------------------------

// running, ready, full, then the ones out of quota or failing (in their own order: a stable sort)
const RANK = { running: 0, ready: 1, full: 2, limited: 3, resting: 3, error: 3 };
const rankOf = (state, full = false) => RANK[state === "running" && full ? "full" : state] ?? 3;

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
  pools.sort((a, b) => rankOf(a.state, a.full) - rankOf(b.state, b.full));
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
// the shorter limit: "limitte 01:00" (the time without the day), "" without a reset time
const limitTime = (p, at) => (p.resetAt ? `${t("limitte")} ${resetLabel(p.resetAt, at).split(" ").at(-1)}` : "");
const providerText = (x) => (x.state === "resting" ? `${t("dinleniyor")}${x.minutes ? ` ~${t("{n} dk", { n: x.minutes })}` : ""}` : x.state === "error" ? t("hata") : "");


// ---- icons ----------------------------------------------------------------------------------------

/** Which image protocol this output understands: "iterm" (iTerm2, WezTerm), "kitty" or null. */
export function imageProtocol(stream = process.stdout, env = process.env, setting = undefined) {
  if ((setting ?? "auto") !== "auto" || !stream?.isTTY || env.NO_COLOR || env.TERM === "dumb" || env.TMUX) return null;
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_PANE) return "iterm";
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "kitty";
  return null;
}

/**
 * A pool's or provider's mark: the real logo as an image two cells wide, a one-colour "◆" in the brand
 * colour without images, nothing with NO_COLOR, ASCII or logos "off".
 */
export function logoMark(id, st, { proto = null, logos = "auto" } = {}) {
  if (logos === "off" || st.ascii || !st.color) return { width: 0, paint: () => "" };
  const img = logos === "auto" ? logoImage(id, proto) : "";
  return img ? { width: 2, paint: () => img } : { width: 1, paint: () => st.fg(glyphColor(id), "◆") };
}

// ---- rendering ------------------------------------------------------------------------------------

const GAP = 3;
const len = (s) => [...String(s)].length;

/** The label column shared by the pane's footer lines (background, pools, providers); 1 when narrow. */
export function gutterWidth(labels, width) {
  return width < 60 ? 1 : 1 + Math.max(0, ...labels.filter(Boolean).map(len)) + 3;
}

// A state as a coloured symbol and words, longest first (the last one is the short form for tight
// cells): hazır ●, n çalışıyor, n/n dolu, limitte · saat, dinleniyor ~dk, hata.
function status(state, words, st, tone) {
  const sym = st.ascii ? { running: "*", ready: "o", full: "#", limited: "#", resting: "~", error: "x" }[state] : { running: "●", ready: "●", full: "●", limited: "■", resting: "◐", error: "✗" }[state];
  const paintWords = (w) => (state === "ready" ? st.muted(w) : tone(w));
  const make = (w) => ({ text: w ? `${sym} ${w}` : sym, paint: () => `${tone(sym)}${w ? ` ${paintWords(w)}` : ""}` });
  const forms = [...new Set(words.filter((w, i) => w || i === words.length - 1))].map(make);
  return { forms, full: forms[0], bare: forms.at(-1) };
}

/**
 * The footer's groups: [{ label, items: [{ id, name, state, forms, full, bare }], tail }]: the pools
 * (running, ready, full, limited; "+3 kapalı" after them) and the providers behind the free pool.
 */
export function chips(view, st, { at = Date.now(), providers = true, label = t("havuzlar") } = {}) {
  const tone = (state) => ({ running: (s) => st.fg("team", s), ready: (s) => st.fg("done", s), full: (s) => st.fg("blocked", s), limited: (s) => st.fg("blocked", s), resting: (s) => st.fg("blocked", s), error: (s) => st.fg("failed", s) }[state]);
  const pool = (p) => {
    const state = p.state === "running" && p.full ? "full" : p.state;
    const words = { ready: [t("hazır"), ""], running: [t("{n} çalışıyor", { n: p.running }), String(p.running)], full: [stateText(p, at), `${p.running}/${p.capacity}`], limited: [stateText(p, at), limitTime(p, at), t("limitte")] }[state];
    return { id: p.name, name: p.name, state, ...status(state, words, st, tone(state)) };
  };
  const provider = (x) => {
    const words = { ready: [t("hazır"), ""], resting: [providerText(x), x.minutes ? `~${t("{n} dk", { n: x.minutes })}` : t("dinleniyor")], error: [t("hata"), t("hata")] }[x.state];
    return { id: x.id, name: x.name, state: x.state, ...status(x.state, words, st, tone(x.state)) };
  };
  const ordered = (items) => items.map((x, i) => [x, i]).sort(([a, i], [b, j]) => rankOf(a.state) - rankOf(b.state) || i - j).map(([x]) => x);
  const groups = [];
  if (view.pools.length || view.hidden) {
    const tail = view.hidden ? t("+{n} kapalı", { n: view.hidden }) : "";
    groups.push({ label, items: ordered(view.pools.map(pool)), tail });
  }
  const free = view.pools.find((p) => p.name === "free");
  if (providers && free?.providers?.length) groups.push({ label: t("sağlayıcılar"), items: ordered(free.providers.map(provider)), tail: "", providers: true });
  return groups;
}

// Items whose long state may not widen the grid: they come last and spend the room on their right.
const LONG = new Set(["limited", "resting"]);

// One grid for every group: the cell is the widest mark, name and state, the state counted in its
// words ("1 çalışıyor") or short ("1"), a limited or resting item always short; as many cells as fit
// `room`. A wide pane keeps the words over a row more; a narrow one (fewer: true) takes the fewer rows.
function grid(groups, room, mark, fewer = false) {
  const items = groups.flatMap((g) => g.items);
  const name = Math.max(...items.map((x) => len(x.name)));
  const plan = (form) => {
    const state = Math.max(...items.map((x) => len((form === "bare" || LONG.has(x.state) ? x.bare : x.full).text)));
    const w = (mark ? mark + 1 : 0) + name + 2 + state;
    const k = Math.min(Math.floor((room + GAP) / (w + GAP)), Math.max(...groups.map((g) => g.items.length)));
    return { name, state, w, k, rows: k > 0 ? groups.reduce((a, g) => a + Math.ceil(g.items.length / k), 0) : Infinity };
  };
  const words = plan("full"), bare = plan("bare");
  if (bare.k < 1) {
    // one column, still too wide: shorten the names (the short state stays whole)
    const clip = Math.max(1, room - (mark ? mark + 1 : 0) - 2 - bare.state);
    return { ...bare, name: clip, w: room, k: 1, clipName: clip };
  }
  return words.k >= 1 && words.rows <= bare.rows + (fewer ? 0 : 1) ? words : bare;
}

const middleClip = (s, n) => (len(s) <= n ? s : n <= 1 ? "…" : `${[...s].slice(0, Math.ceil((n - 1) / 2)).join("")}…${[...s].slice(len(s) - Math.floor((n - 1) / 2)).join("")}`);

// the groups as the footer shows them: a narrow pane keeps only the providers that need a look
function footerGroups(view, width, st, opts) {
  const narrow = width < 60;
  return chips(view, st, opts)
    .map((g) => (narrow && g.providers ? { ...g, items: g.items.filter((x) => x.state !== "ready") } : g))
    .filter((g) => g.items.length || g.tail);
}

/**
 * The footer's shared grid: { gutter, room, mark, cell: { name, state, w, k, clipName }, stops } with
 * stops the x of every column (the background line starts its items on them too); null when empty.
 */
export function footerGrid(view, width, st, opts = {}) {
  const groups = footerGroups(view, width, st, opts);
  if (!groups.length) return null;
  const gutter = opts.gutter ?? gutterWidth(groups.map((g) => g.label), width);
  const room = width - gutter - 1;
  const mark = Math.max(0, ...groups.flatMap((g) => g.items.map((x) => logoMark(x.id, st, opts).width)));
  const cell = groups.some((g) => g.items.length) ? grid(groups.filter((g) => g.items.length), room, mark, width < 60) : { name: 0, state: 0, w: 0, k: 1 };
  return { groups, gutter, room, mark, cell, stops: Array.from({ length: cell.k }, (_, j) => gutter + j * (cell.w + GAP)) };
}

// One group laid on the grid: rows of { x, item, form } (x from the gutter, always a column stop) and
// where the tail goes. An item takes one cell, a longer state the cells it needs; the last one on a
// row may also run into the free space right of the grid. pick[i]: the form item i asks for.
function flow(items, tail, cell, room, head, pick) {
  const step = cell.w + GAP, rows = [];
  let col = cell.k;
  items.forEach((x, i) => {
    const form = x.forms[pick[i]], wide = head + len(form.text);
    const span = wide <= cell.w ? 1 : Math.ceil((wide + GAP) / step);
    if (col >= cell.k || (col + span > cell.k && col * step + wide > room)) { rows.push([]); col = 0; }
    rows.at(-1).push({ x: col * step, item: x, form });
    col += span;
  });
  let tailAt = null;
  if (tail) {
    const last = rows.at(-1)?.at(-1), used = last ? last.x + head + len(last.form.text) : 0;
    const stop = Array.from({ length: cell.k }, (_, j) => j * step).find((x) => x >= used + GAP && x + len(tail) <= room);
    if (last && (stop != null || used + GAP + len(tail) <= room)) tailAt = { row: rows.length - 1, x: stop ?? used + GAP };
    else tailAt = { row: rows.length, x: 0 };
  }
  return { rows, tailAt, height: Math.max(rows.length, tailAt ? tailAt.row + 1 : 0) };
}

/**
 * The footer lines: each group's label in a shared gutter, its items on the shared grid, row by row
 * (a chip is never split). Each item shows its longest state that fits before the next one; a limited
 * or resting item takes the long state over more cells when that costs no extra row. A narrow pane
 * (< 60) drops the labels and the ready providers. opts: proto, logos, label, gutter, at, providers.
 */
export function chipLines(view, width, st, opts = {}) {
  const fg = footerGrid(view, width, st, opts);
  if (!fg) return [];
  const { groups, gutter, room, mark, cell } = fg;
  const narrow = width < 60, head = (mark ? mark + 1 : 0) + cell.name + 2;
  const out = [];
  for (const g of groups) {
    // the cell's form for everyone, the short one for the long states; then each long state, in
    // order, as long as it fits without another row
    const base = g.items.map((x) => (cell.clipName || LONG.has(x.state) ? x.forms.length - 1 : Math.max(0, x.forms.findIndex((f) => len(f.text) <= cell.state))));
    const pick = [...base];
    const height = flow(g.items, g.tail, cell, room, head, pick).height;
    g.items.forEach((x, i) => {
      if (!LONG.has(x.state)) return;
      for (let f = 0; f < base[i]; f++) if (flow(g.items, g.tail, cell, room, head, pick.with(i, f)).height <= height) { pick[i] = f; break; }
    });
    const { rows, tailAt } = flow(g.items, g.tail, cell, room, head, pick);
    const lines = [];
    for (let r = 0; r < Math.max(rows.length, tailAt ? tailAt.row + 1 : 0); r++) {
      const row = rows[r] ?? [], tail = tailAt?.row === r ? tailAt : null;
      let text = "", used = 0;
      row.forEach(({ x, item }, j) => {
        // the room up to the next item (or the tail, or the edge): the longest state that fits it
        const limit = (row[j + 1]?.x ?? (tail ? tail.x : room + GAP)) - GAP;
        const s = item.forms.find((f) => len(f.text) <= limit - x - head) ?? item.bare;
        const name = cell.clipName ? middleClip(item.name, cell.clipName) : item.name;
        const m = mark ? `${logoMark(item.id, st, opts).paint() || " ".repeat(mark)} ` : "";
        text += `${" ".repeat(x - used)}${m}${name}${" ".repeat(cell.name - len(name) + 2)}${s.paint()}`;
        used = x + head + len(s.text);
      });
      if (tail) text += `${" ".repeat(Math.max(row.length ? 1 : 0, tail.x - used))}${st.muted(g.tail)}`;
      lines.push(text);
    }
    lines.forEach((l, i) => {
      const lead = !narrow && i === 0 && g.label ? ` ${st.muted(g.label)}${" ".repeat(Math.max(1, gutter - 1 - len(g.label)))}` : " ".repeat(gutter);
      out.push(`${lead}${l}`);
    });
  }
  return out;
}
