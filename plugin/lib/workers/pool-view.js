// The pools as the user sees them, the same in the task pane, `ekip durum`, the `ekip agents` summary
// and (hub/web/src/lib/pools.ts) the panel: only the pools this user connected (signed in and tested,
// or with a successful run; not installed, never signed in and switched-off pools are hidden and
// counted as "+3 kapalı"), each with its state instead of a bare "0/2": ready (green dot), running n
// (teal, "2/2 dolu" once it is full), at its limit until a time (orange, "limitte · Çar 01:00").
// Running first, then ready, then limited. The free pool lists the providers behind it (only those
// with a key): ready, resting after a 429 ("dinleniyor ~12 dk") or failing.
//
// Each pool and provider shows its real logo, the same mark as the web panel (workers/logos.js): an
// inline image in WezTerm and iTerm2 (OSC 1337) and kitty (graphics protocol), a "◆" in the brand
// colour elsewhere, nothing with NO_COLOR. "poolLogos" in data/config.json: "auto" (default), "glyph"
// (the coloured glyph only) or "off". The lines are aligned columns (mark, name, state) under a label
// gutter shared with the background line.
import { t, lang } from "../core/i18n.js";
import { glyphColor, logoImage } from "./logos.js";

export const PROVIDER_NAMES = { google: "Google", groq: "Groq", openrouter: "OpenRouter", nvidia: "NVIDIA", zhipu: "Z.ai", ovh: "OVH", cerebras: "Cerebras", mistral: "Mistral", cohere: "Cohere", cloudflare: "Cloudflare", huggingface: "HuggingFace", routeway: "Routeway", bazaarlink: "BazaarLink", router9: "Router9", modelscope: "ModelScope" };

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

// A state as a coloured symbol and words, with a shorter form for narrow panes:
// hazır ●, çalışıyor n, n/n dolu, limitte · saat, dinleniyor ~dk, hata.
function status(state, full, bare, st, tone) {
  const sym = st.ascii ? { running: "*", ready: "o", full: "#", limited: "#", resting: "~", error: "x" }[state] : { running: "●", ready: "●", full: "●", limited: "■", resting: "◐", error: "✗" }[state];
  const paintWords = (w) => (state === "ready" ? st.muted(w) : tone(w));
  const make = (w) => ({ text: w ? `${sym} ${w}` : sym, paint: () => `${tone(sym)}${w ? ` ${paintWords(w)}` : ""}` });
  return { full: make(full), bare: make(bare) };
}

/**
 * The footer's groups: [{ label, items: [{ id, name, full, bare }], tail }]: the pools (running first,
 * "+3 kapalı" after them) and the providers behind the free pool.
 */
export function chips(view, st, { at = Date.now(), providers = true, label = t("havuzlar") } = {}) {
  const tone = (state) => ({ running: (s) => st.fg("team", s), ready: (s) => st.fg("done", s), full: (s) => st.fg("blocked", s), limited: (s) => st.fg("blocked", s), resting: (s) => st.fg("blocked", s), error: (s) => st.fg("failed", s) }[state]);
  const pool = (p) => {
    const state = p.state === "running" && p.full ? "full" : p.state;
    const words = { ready: [t("hazır"), ""], running: [t("{n} çalışıyor", { n: p.running }), String(p.running)], full: [stateText(p, at), `${p.running}/${p.capacity}`], limited: [stateText(p, at), t("limitte")] }[state];
    return { id: p.name, name: p.name, state, ...status(state, words[0], words[1], st, tone(state)) };
  };
  const provider = (x) => {
    const words = { ready: [t("hazır"), ""], resting: [providerText(x), x.minutes ? `~${t("{n} dk", { n: x.minutes })}` : t("dinleniyor")], error: [t("hata"), t("hata")] }[x.state];
    return { id: x.id, name: x.name, state: x.state, ...status(x.state, words[0], words[1], st, tone(x.state)) };
  };
  const groups = [];
  if (view.pools.length || view.hidden) {
    const tail = view.hidden ? t("+{n} kapalı", { n: view.hidden }) : "";
    groups.push({ label, items: view.pools.map(pool), tail });
  }
  const free = view.pools.find((p) => p.name === "free");
  if (providers && free?.providers?.length) groups.push({ label: t("sağlayıcılar"), items: free.providers.map(provider), tail: "", providers: true });
  return groups;
}

// The items of one group in aligned columns (mark, name, state), as many columns as fit `room`, row by
// row; the full words when they fit, else the short ones, else names shortened in the middle.
// A wide pane keeps the words over a row more; a narrow one (fewer: true) takes the fewer rows.
function table(items, room, mark, fewer = false) {
  const cell = (cols) => cols.reduce((a, c) => a + c.w, 0) + GAP * (cols.length - 1);
  const tries = ["full", "bare"].flatMap((form) => items.map((_, i) => [form, items.length - i]));
  if (fewer) tries.sort((a, b) => b[1] - a[1]);
  for (const [form, k] of tries) {
    const cols = Array.from({ length: k }, (_, j) => {
      const mine = items.filter((_, i) => i % k === j);
      const name = Math.max(...mine.map((x) => len(x.name))), state = Math.max(...mine.map((x) => len(x[form].text)));
      return { name, state, w: (mark ? mark + 1 : 0) + name + 2 + state };
    });
    if (cell(cols) <= room) return { form, cols, k };
  }
  // one column, still too wide: shorten the names (the state stays whole)
  const state = Math.max(...items.map((x) => len(x.bare.text)));
  const name = Math.max(1, room - (mark ? mark + 1 : 0) - 2 - state);
  return { form: "bare", cols: [{ name, state, w: room }], k: 1, clipName: name };
}

const middleClip = (s, n) => (len(s) <= n ? s : n <= 1 ? "…" : `${[...s].slice(0, Math.ceil((n - 1) / 2)).join("")}…${[...s].slice(len(s) - Math.floor((n - 1) / 2)).join("")}`);

/**
 * The footer lines: each group's label in a shared gutter, its items in aligned columns, wrapped by
 * whole items within `width` (a chip is never split); a narrow pane (< 60) drops the labels and the
 * ready providers. opts: proto, logos, label, gutter, at, providers.
 */
export function chipLines(view, width, st, opts = {}) {
  const groups = chips(view, st, opts);
  if (!groups.length) return [];
  const narrow = width < 60;
  const gutter = opts.gutter ?? gutterWidth(groups.map((g) => g.label), width);
  const room = width - gutter - 1;
  const out = [];
  for (const group of groups) {
    // a narrow pane keeps only the providers that need a look (resting, failing)
    const g = narrow && group.providers ? { ...group, items: group.items.filter((x) => x.state !== "ready") } : group;
    if (!g.items.length && !g.tail) continue;
    const marks = g.items.map((x) => logoMark(x.id, st, opts));
    const mark = Math.max(0, ...marks.map((m) => m.width));
    const lines = [];
    if (g.items.length) {
      const { form, cols, k, clipName } = table(g.items, room, mark, narrow);
      for (let r = 0; r * k < g.items.length; r++) {
        const row = g.items.slice(r * k, r * k + k).map((x, j) => {
          const name = clipName ? middleClip(x.name, clipName) : x.name, s = x[form], c = cols[j], last = j === k - 1 || r * k + j === g.items.length - 1;
          const m = mark ? `${marks[r * k + j].paint() || " ".repeat(mark)} ` : "";
          return `${m}${name}${" ".repeat(c.name - len(name) + 2)}${s.paint()}${last ? "" : " ".repeat(c.state - len(s.text))}`;
        });
        const used = row.length ? cols.slice(0, row.length).reduce((a, c) => a + c.w, 0) + GAP * (row.length - 1) : 0;
        lines.push({ text: row.join(" ".repeat(GAP)), used: used - (cols[row.length - 1].state - len(g.items[r * k + row.length - 1][form].text)) });
      }
    }
    // "+3 kapalı" after the last row when it fits, on its own row otherwise
    if (g.tail) {
      const last = lines.at(-1);
      if (last && last.used + GAP + len(g.tail) <= room) last.text += `${" ".repeat(GAP)}${st.muted(g.tail)}`;
      else lines.push({ text: st.muted(g.tail) });
    }
    lines.forEach((l, i) => {
      const head = !narrow && i === 0 && g.label ? ` ${st.muted(g.label)}${" ".repeat(Math.max(1, gutter - 1 - len(g.label)))}` : " ".repeat(gutter);
      out.push(`${head}${l.text}`);
    });
  }
  return out;
}
