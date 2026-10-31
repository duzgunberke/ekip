// Text for Telegram: Markdown (what a Claude turn writes) to Telegram's HTML subset, safely escaped,
// split into messages of at most 4096 characters with code blocks closed and reopened at a split.
export const LIMIT = 4096;

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s) => esc(s).replace(/"/g, "&quot;");

/** Inline Markdown of one escaped line: `code`, **bold**, [text](https://url), # headings. */
function inline(line) {
  const codes = [];
  let s = line.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  const h = s.match(/^#{1,6}\s+(.*)$/);
  if (h) s = `<b>${h[1]}</b>`;
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${attr(url.replace(/&amp;/g, "&"))}">${txt}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

/** Markdown → Telegram HTML (parse_mode "HTML"). An unclosed fence runs to the end. */
export function mdToHtml(md) {
  const out = [];
  let fence = null; // language of the open code block, "" for none
  let code = [];
  for (const line of String(md ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const f = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (f && fence === null) { fence = f[1]; code = []; continue; }
    if (f && fence !== null) { out.push(pre(fence, code)); fence = null; continue; }
    if (fence !== null) code.push(line); else out.push(inline(line));
  }
  if (fence !== null) out.push(pre(fence, code));
  return out.join("\n");
}
const pre = (lang, lines) => `<pre><code${lang ? ` class="language-${attr(lang)}"` : ""}>${esc(lines.join("\n"))}</code></pre>`;

// Telegram counts the text after its entities are parsed; the escaped length is an upper bound.
const cost = (line) => esc(line).length + 1;

/**
 * Markdown → HTML messages of at most `max` characters each. Splits between lines (a single line
 * longer than a message is cut), never inside an HTML tag; a split inside a code block closes the
 * block in one message and reopens it, with its language, in the next.
 */
export function splitMessage(md, max = LIMIT) {
  const budget = max - 64;
  const chunks = [];
  let cur = [], size = 0, fence = null;
  const close = () => {
    if (!cur.length) return;
    chunks.push(fence !== null ? [...cur, "```"] : cur);
    cur = fence !== null ? [`\`\`\`${fence}`] : [];
    size = cur.length ? cost(cur[0]) : 0;
  };
  for (let line of String(md ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    while (cost(line) > budget) {
      // a very long line: cut it in pieces that fit (by characters, escaping counted)
      let n = budget - size - 4;
      if (n < 200) { close(); n = budget - size - 4; }
      let piece = line.slice(0, n);
      while (cost(piece) > budget - size && piece.length > 1) piece = piece.slice(0, Math.floor(piece.length * 0.9));
      cur.push(piece); size += cost(piece);
      close();
      line = line.slice(piece.length);
    }
    if (size + cost(line) > budget) close();
    cur.push(line); size += cost(line);
    const f = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (f) fence = fence === null ? f[1] : null;
  }
  if (cur.length && !(cur.length === 1 && fence !== null && cur[0].startsWith("```") && chunks.length)) chunks.push(cur);
  return chunks.map((c) => mdToHtml(c.join("\n")).trim()).filter(Boolean).map((h) => (h.length > max ? h.slice(0, max) : h));
}

/** "▰▰▰▰▱▱▱▱▱▱ 40%" */
export function bar(pct, cells = 10) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const on = Math.round((p / 100) * cells);
  return `${"▰".repeat(on)}${"▱".repeat(cells - on)} ${p}%`;
}
