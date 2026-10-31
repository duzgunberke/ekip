#!/usr/bin/env node
// The terminal media in the README: ekip's WezTerm layout (lead, worker column, task pane), `ekip
// status` and `ekip track`. Every pane that shows ekip's own screens is real output: the task pane,
// the status digest and `ekip track ls` run in a pty against a throw-away EKIP_HOME filled with demo
// tasks, tracked jobs and worker logs, then drawn in ekip's WezTerm theme (plugin/lib/ops/terminal.js)
// by headless Chrome, frame by frame, and encoded with ffmpeg. The lead's transcript and the worker
// logs are demo text. Nothing is read from the user's own data or screen.
//
//   node hub/demo/terminal-demo.mjs [hero|status|track ...]   (default: all three)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const EKIP = path.join(root, "plugin/bin/ekip.js");
const DEMO = path.join(root, "docs/demo"), SHOTS = path.join(root, "docs/screenshots");
const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);

// A throw-away ekip home: demo config, two "ready" pools (stub binaries on PATH), no hub.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-term-demo-"));
const SHOWN_HOME = "~/ekip/data";
const BIN = path.join(HOME, "bin");
fs.mkdirSync(BIN, { recursive: true });
for (const b of ["codex", "copilot"]) { fs.writeFileSync(path.join(BIN, b), "#!/bin/sh\nexit 0\n"); fs.chmodSync(path.join(BIN, b), 0o755); }
fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify({ agents: { codex: { ok: true }, copilot: { ok: true } }, autoOrder: ["codex", "copilot"], terminal: "wezterm" }));
process.env.EKIP_HOME = HOME;
process.env.EKIP_LANG = "en";
const { t } = await import("../../plugin/lib/core/i18n.js");

// ---- demo state ----------------------------------------------------------------------------------

const PID = process.pid; // alive while the captures run: the demo workers count as live
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const min = (m) => m * 60_000;
const clock = (ms) => new Date(Date.now() + ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtBytes = (n) => { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`; };
const GB = 1024 ** 3, MB = 1024 ** 2;
// the detail line a tracked job writes onto its step ("252 MB / 1.4 GB · 11.2 MB/s · finish ~14:32")
const trackDetail = (done, total, rate) => {
  const left = (total - done) / rate * 1000;
  return { pct: Math.round(done / total * 100), rate: `${fmtBytes(rate)}/s`, etaAt: iso(left), detail: `${fmtBytes(done)} / ${fmtBytes(total)} · ${fmtBytes(rate)}/s · ${t("bitiş ~{time}", { time: clock(left) })}` };
};
const runName = (agoMin, via) => `${iso(-min(agoMin)).slice(0, 19).replace(/:/g, "-")}.000Z-${via}.log`;

function step(title, status, extra = {}) {
  const s = { title, status, ...extra };
  if (status === "running" || status === "blocked" || status === "waiting-user") Object.assign(s, { startedAt: s.startedAt ?? iso(-min(3)), progressAt: iso(-20_000) });
  return s;
}
function task(id, title, project, agoMin, steps, more = {}) {
  return { id, title, project, status: "running", createdAt: iso(-min(agoMin)), updatedAt: iso(-15_000), p0: 0, p0At: iso(-min(agoMin)), steps, workers: [], notes: [], ...more };
}
const worker = (via, label, runId, extra = {}) => ({ runId, via, label, pid: PID, status: "running", startedAt: iso(-min(extra.since ?? 6)), log: path.join(HOME, "runs", runId), ...extra });

// Writes tasks.json, the tracked jobs and the worker logs for one moment of a scene.
function writeState({ tasks = [], tracks = [], runs = [], release = null }) {
  for (const d of ["tracks", "runs"]) { fs.rmSync(path.join(HOME, d), { recursive: true, force: true }); fs.mkdirSync(path.join(HOME, d), { recursive: true }); }
  fs.writeFileSync(path.join(HOME, "tasks.json"), JSON.stringify(tasks, null, 2));
  for (const j of tracks) fs.writeFileSync(path.join(HOME, "tracks", `${j.id}.json`), JSON.stringify(j, null, 2));
  for (const r of runs) {
    const file = path.join(HOME, "runs", r.name);
    fs.writeFileSync(file, `cwd: ~/code/${r.project}\nproject: ${r.project}\nlabel: ${r.label}\ntaskId: ${r.taskId ?? "-"}\npid: ${PID}\ntask:\n${r.label}\n\n${r.via === "track" ? "" : `[ekip pool ${r.via}]\n`}${r.lines.join("\n")}\n${r.exit != null ? `\n[exit ${r.exit}]\n` : ""}`);
    if (r.mtimeAgoMin) fs.utimesSync(file, new Date(Date.now() - min(r.mtimeAgoMin)), new Date(Date.now() - min(r.mtimeAgoMin)));
  }
  fs.writeFileSync(path.join(HOME, "release-status.json"), JSON.stringify(release ?? {
    at: iso(0), version: "1.7.0", latest: "1.7.0", behind: false,
    main: { sha: "abc1234e7b3d8c6a5e0f1b2c3d4e5f6a7b8c9d0e", at: iso(-min(26)) },
    ci: { sha: "abc1234", status: "pass", finishedAt: iso(-min(12)) }, testing: null,
    hub: { commit: "abc1234", version: "1.7.0" },
  }));
}

// ---- real ekip output in a pty ------------------------------------------------------------------

const PTY = String.raw`
import os,pty,fcntl,termios,struct,subprocess,select,sys,time
out,cols,rows,limit=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),float(sys.argv[4])
m,s=pty.openpty();fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
p=subprocess.Popen(sys.argv[5:],stdin=s,stdout=s,stderr=s,start_new_session=True);os.close(s);b=bytearray();t0=time.time()
while True:
  if limit>0 and time.time()-t0>limit and p.poll() is None: p.terminate()
  try:
    if not select.select([m],[],[],.1)[0]:
      if p.poll() is not None: break
      continue
    q=os.read(m,65536)
    if not q: break
    b.extend(q)
  except OSError: break
p.wait();open(out,'wb').write(b)`;

function ekip(args, { cols = 120, rows = 40, seconds = 0 } = {}) {
  const out = path.join(HOME, "pty.out");
  const env = { ...process.env, EKIP_HOME: HOME, EKIP_LANG: "en", COLORTERM: "truecolor", TERM: "xterm-256color", PATH: `${BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: HOME };
  for (const k of ["NO_COLOR", "COLUMNS", "LINES", "EKIP_NO_FIT", "EKIP_TERMINAL", "ITERM_SESSION_ID", "TERM_PROGRAM", "WEZTERM_PANE", "TMUX"]) delete env[k];
  const r = spawnSync("python3", ["-c", PTY, out, String(cols), String(rows), String(seconds), process.execPath, EKIP, ...args], { env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw Error(`ekip ${args.join(" ")}: ${r.stderr}`);
  let s = fs.readFileSync(out, "utf8").replace(/\r/g, "");
  // a watching pane repaints from the top of the screen: keep its last full frame
  if (s.includes("\x1b[H")) s = s.split("\x1b[H").filter((x) => x.trim()).at(-1);
  s = s.replace(/\x1b\[\?[0-9;]*[hl]|\x1b\[[0-9]*[JK]/g, "").replaceAll(HOME, SHOWN_HOME);
  return s.replace(/\n+$/, "");
}

// ---- ANSI to HTML in ekip's WezTerm theme -------------------------------------------------------

const C = { bg: "#0E1014", card: "#15181E", text: "#ECEEF2", muted: "#98A1B0", border: "#252A33", lead: "#FFA95E", team: "#2DD4BF", done: "#3FCF7A", failed: "#F2555A", blocked: "#F5A524", waiting: "#FACC15", queued: "#60A5FA" };
const ANSI16 = [C.card, C.failed, C.done, C.blocked, C.queued, "#C084FC", C.team, C.text];
const BRIGHT = [C.muted, "#FF7A7F", "#6EE7A0", C.waiting, "#93C5FD", "#D8B4FE", "#5EEAD4", "#FFFFFF"];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function html(text) {
  let out = "", st = {}, open = false;
  const flush = () => {
    if (open) out += "</span>";
    const css = [st.fg && `color:${st.fg}`, st.bg && `background:${st.bg};display:inline-block`, st.bold && "font-weight:700", st.dim && "opacity:.6", st.under && "text-decoration:underline", st.italic && "font-style:italic"].filter(Boolean).join(";");
    open = !!css;
    if (css) out += `<span style="${css}">`;
  };
  for (const part of String(text).split(/(\x1b\[[0-9;]*m)/)) {
    if (!part.startsWith("\x1b[")) { out += esc(part.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")); continue; }
    const n = part.slice(2, -1).split(";").map((x) => Number(x || 0));
    for (let i = 0; i < n.length; i++) {
      const k = n[i];
      if (k === 0) st = {};
      else if (k === 1) st.bold = true;
      else if (k === 2) st.dim = true;
      else if (k === 3) st.italic = true;
      else if (k === 4) st.under = true;
      else if (k === 22) { st.bold = false; st.dim = false; }
      else if (k === 23) st.italic = false;
      else if (k === 24) st.under = false;
      else if (k === 39) st.fg = null;
      else if (k >= 30 && k <= 37) st.fg = ANSI16[k - 30];
      else if (k >= 90 && k <= 97) st.fg = BRIGHT[k - 90];
      else if (k === 38 && n[i + 1] === 2) { st.fg = `rgb(${n[i + 2]},${n[i + 3]},${n[i + 4]})`; i += 4; }
      else if (k === 49) st.bg = null;
      else if (k === 48 && n[i + 1] === 2) { st.bg = `rgb(${n[i + 2]},${n[i + 3]},${n[i + 4]})`; i += 4; }
      else if (k === 48 && n[i + 1] === 5) { const v = n[i + 2]; st.bg = v >= 232 ? `rgb(${8 + (v - 232) * 10},${8 + (v - 232) * 10},${8 + (v - 232) * 10})` : C.card; i += 2; }
      else if (k === 38 && n[i + 1] === 5) { const v = n[i + 2] - 16; st.fg = `rgb(${Math.floor(v / 36) * 51},${Math.floor(v / 6) % 6 * 51},${v % 6 * 51})`; i += 2; }
    }
    flush();
  }
  return out + (open ? "</span>" : "");
}
// small ANSI helpers for the demo text (the lead's transcript, worker logs, a shell)
const A = { bold: (s) => `\x1b[1m${s}\x1b[22m`, gray: (s) => `\x1b[90m${s}\x1b[39m`, cyan: (s) => `\x1b[36m${s}\x1b[39m`, green: (s) => `\x1b[32m${s}\x1b[39m`, yellow: (s) => `\x1b[33m${s}\x1b[39m`, lead: (s) => `\x1b[38;2;255;169;94m${s}\x1b[39m`, team: (s) => `\x1b[38;2;45;212;191m${s}\x1b[39m` };

// ---- scenes: layers of timed frames ---------------------------------------------------------------

const FONT = "'JetBrains Mono', Menlo, 'SF Mono', 'Apple Symbols', monospace";
const LINE = 1.28;

/** A terminal surface: frames [{ at, text }] (ANSI), drawn bottom-anchored when `scroll` is set. */
const term = (rect, frames, { size = 14, scroll = false, pad = [8, 10] } = {}) => ({ rect, size, scroll, pad, frames: frames.map((f) => ({ at: f.at, html: html(f.text) })) });

/** A shell transcript built over time: type a command, print lines, each a new frame. */
class Shell {
  constructor(prompt = `${A.team("~/code/storefront-web")} ${A.lead("❯")} `) { this.prompt = prompt; this.lines = [prompt]; this.frames = [{ at: 0, text: this.text(true) }]; }
  text(cursor) { return this.lines.join("\n") + (cursor ? "\x1b[38;2;255;169;94m█\x1b[39m" : ""); }
  type(at, cmd, cps = 38) {
    for (let i = 1; i <= cmd.length; i++) { this.lines[this.lines.length - 1] = this.prompt + cmd.slice(0, i); this.frames.push({ at: at + i / cps, text: this.text(true) }); }
    return at + cmd.length / cps;
  }
  print(at, text, { prompt = true } = {}) {
    this.lines.push(...String(text).split("\n"));
    if (prompt) this.lines.push(this.prompt);
    this.frames.push({ at, text: this.text(prompt) });
    return at;
  }
}

// The tab bar as ekip.lua draws it: the mark, one tab per project (amber edge on the active one),
// the open tasks on the right with short labels (zero counts faint).
function tabBar(at, { title, counts, width }) {
  const n = counts;
  const mark = `&nbsp;&nbsp;<span style="color:${C.lead}">❯ </span><b style="color:${C.team}">ekip</b>&nbsp;&nbsp;&nbsp;`;
  const tab = `<span style="background:${C.card};color:${C.text};display:inline-block"><span style="color:${C.lead}">▎</span><b> ${esc(title)}&nbsp;&nbsp;</b></span>`;
  const item = (k, sym, color, label) => `<span style="color:${n[k] ? color : "#5B6472"}">${sym} ${n[k]} ${label}</span>`;
  const right = [item("waiting", "?", C.waiting, t("bekleyen")), item("blocked", "■", C.blocked, t("takılan")), item("running", "●", C.team, t("çalışan"))].join("&nbsp;&nbsp;&nbsp;");
  return { at, html: `<div style="display:flex;justify-content:space-between;width:${width}px;white-space:pre"><span>${mark}${tab}</span><span>${right}&nbsp;&nbsp;</span></div>` };
}
// what the tab bar shows: the terminal status file ekip itself wrote for this moment
const statusCounts = () => { try { const j = JSON.parse(fs.readFileSync(path.join(HOME, "terminal-status.json"), "utf8")); return { waiting: j.waiting, blocked: j.blocked, running: j.running }; } catch { return { waiting: 0, blocked: 0, running: 0 }; } };

/** The page: a macOS window frame around the layers, with `show(t)` picking each layer's frame. */
function page(scene) {
  const layers = scene.layers.map((l, i) => {
    const [x, y, w, h] = l.rect;
    const inner = l.raw ? "" : `<pre style="margin:0;padding:${l.pad[0]}px ${l.pad[1]}px;font:${l.size}px/${LINE} ${FONT};white-space:pre;color:${C.text};${l.scroll ? "" : "position:absolute;left:0;right:0;top:0"}"></pre>`;
    return `<div id="l${i}" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;overflow:hidden;${l.style ?? ""}">${inner}</div>`;
  }).join("");
  const data = scene.layers.map((l) => ({ frames: l.frames, raw: !!l.raw, scroll: !!l.scroll, from: l.from ?? 0, until: l.until ?? 1e9, fade: l.fade ?? 0 }));
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${scene.backdrop ?? "#07080B"};width:${scene.width}px;height:${scene.height}px;overflow:hidden;position:relative;-webkit-font-smoothing:antialiased">${layers}
<script>const L=${JSON.stringify(data)};const cur=L.map(()=>-1);
window.show=(t)=>{L.forEach((l,i)=>{const el=document.getElementById('l'+i);let o=t<l.from||t>=l.until?0:1;if(l.fade&&o){o=Math.min(1,(t-l.from)/l.fade,(l.until-t)/l.fade)}el.style.opacity=Math.max(0,o);let k=-1;for(let j=0;j<l.frames.length;j++)if(l.frames[j].at<=t)k=j;if(k!==cur[i]&&k>=0){cur[i]=k;(l.raw?el:el.firstChild).innerHTML=l.frames[k].html;if(l.scroll)el.scrollTop=el.scrollHeight}})};</script>`;
}

// A window: title bar (traffic lights) and a WezTerm tab bar, as layers.
function windowFrame(rect, { title = "", tabs = null, from = 0, until, fade = 0 } = {}) {
  const [x, y, w, h] = rect;
  const lights = ["#FF5F57", "#FEBC2E", "#28C840"].map((c) => `<i style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${c};margin-right:8px"></i>`).join("");
  const frame = { rect, raw: true, from, until, fade, style: `background:${C.bg};border:1px solid #2A2F39;border-radius:11px;box-shadow:0 30px 90px rgba(0,0,0,.55)`, frames: [{ at: 0, html: `<div style="height:30px;display:flex;align-items:center;padding:0 14px;background:#1A1D24;border-bottom:1px solid ${C.border};border-radius:11px 11px 0 0"><span>${lights}</span><span style="flex:1;text-align:center;margin-right:60px;color:${C.muted};font:13px -apple-system,BlinkMacSystemFont,'Inter',sans-serif">${esc(title)}</span></div>` }] };
  const out = [frame];
  if (tabs) out.push({ rect: [x + 1, y + 31, w - 2, 24], raw: true, from, until, fade, style: `background:${C.bg};font:13px/24px ${FONT};color:${C.muted}`, frames: tabs });
  return out;
}
const splitV = (rect) => ({ rect, raw: true, style: `background:${C.border}`, frames: [{ at: 0, html: "" }] });

// ---- capture --------------------------------------------------------------------------------------

const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = process.env.CDP_PORT || "9231";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-term-chrome-"));
let browser, cdp;
async function startChrome() {
  browser = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb"], { stdio: "ignore" });
  let ok = false;
  for (let i = 0; i < 80 && !ok; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); ok = true; } catch { await sleep(200); } }
  if (!ok) throw Error("Chrome did not start");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  cdp = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await cdp("Page.enable");
}
function ffmpeg(args) { const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" }); if (r.status !== 0) throw Error(`ffmpeg: ${r.stderr}`); }

/** Draws every frame, writes the MP4 (when asked), the GIF and the still PNGs. */
async function capture(scene, { mp4, gif, stills = [], fps = 12, gifFps = fps, colors = 128 }) {
  const file = path.join(HOME, `${scene.name}.html`);
  fs.writeFileSync(file, page(scene));
  await cdp("Emulation.setDeviceMetricsOverride", { width: scene.width, height: scene.height, deviceScaleFactor: 2, mobile: false });
  await cdp("Page.navigate", { url: `file://${file}` });
  await sleep(800);
  const dir = fs.mkdtempSync(path.join(HOME, `${scene.name}-frames-`));
  const frames = Math.round(scene.duration * fps);
  for (let i = 0; i < frames; i++) {
    await cdp("Runtime.evaluate", { expression: `show(${i / fps})` });
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(dir, `${String(i).padStart(4, "0")}.png`), Buffer.from(r.result.data, "base64"));
  }
  for (const s of stills) {
    await cdp("Runtime.evaluate", { expression: `show(${s.at})` });
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, s.file), Buffer.from(r.result.data, "base64"));
  }
  const w = scene.outWidth ?? scene.width;
  const seq = ["-framerate", String(fps), "-i", path.join(dir, "%04d.png")];
  if (mp4) ffmpeg([...seq, "-vf", `scale=${w}:-2:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", path.join(DEMO, mp4)]);
  const palette = path.join(dir, "palette.png");
  ffmpeg([...seq, "-vf", `fps=${gifFps},scale=${w}:-1:flags=lanczos,palettegen=max_colors=${colors}:stats_mode=full`, palette]);
  ffmpeg([...seq, "-i", palette, "-filter_complex", `fps=${gifFps},scale=${w}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`, path.join(DEMO, gif)]);
  console.log(`${scene.name}: ${frames} frames → ${[mp4, gif, ...stills.map((s) => s.file)].filter(Boolean).join(", ")}`);
}

// ---- the hero: `ekip` moves to WezTerm; lead, workers and the task pane -------------------------

function heroStates() {
  const ios = task("g7k4ma", "Submit iOS v2.4 for review", "ios-app", 9, [step("Build and sign v2.4", "done"), step("Submit for review", "pending")]);
  const askIos = { ask: { question: "Submit v2.4 for review now, or after the paywall test ends?", options: ["Submit now", "Wait for the test"], at: iso(-30_000) }, hold: { kind: "waiting-user", reason: "Submit v2.4 now, or after the paywall test?", at: iso(-30_000), step: 2 } };
  const codexRun = runName(7, "codex"), copilotRun = runName(5, "copilot"), trackId = `${iso(-min(2)).replace(/[:.]/g, "-")}-track`;
  const runs = (k) => [
    { name: codexRun, via: "codex", project: "payments-api", label: "Token bucket per API key", taskId: "g7k2xa", lines: ["reading src/http/middleware.go", "edited src/ratelimit/bucket.go", "go test ./... ok"].slice(0, 1 + Math.min(2, k)), exit: k >= 4 ? 0 : null },
    { name: copilotRun, via: "copilot", project: "docs-site", label: "Rate limit page with examples", taskId: "g7k3pb", lines: ["writing src/content/docs/api/rate-limits.mdx"] },
    ...(k >= 1 ? [{ name: `${trackId}.log`, via: "track", project: "storefront-web", label: "Upload release build", taskId: "g7k5tc", lines: ["$ ./scripts/upload.sh", `upload ${[18, 52, 86, 100][k - 1]}%`].concat(k >= 4 ? ["upload complete: 1.4 GB in 2 min"] : []), exit: k >= 4 ? 0 : null }] : []),
  ];
  const upload = (pct) => trackDetail(1.4 * GB * pct / 100, 1.4 * GB, 11.2 * MB);
  const states = [];
  for (let k = 0; k <= 4; k++) {
    const api = task("g7k2xa", "Add rate limits to the public API", "payments-api", 7 + k * 2, [
      step("Read the API routes", "done"),
      step("Token bucket per API key", k < 3 ? "running" : "done", { pct: [30, 70, 90][k] }),
      step("Tests for 429 answers", k < 3 ? "pending" : k === 3 ? "running" : "done"),
      step("Review and merge", k < 4 ? "pending" : "done"),
    ], { workers: [worker("codex", "Token bucket per API key", codexRun, { since: 7 + k * 2, ...(k >= 4 ? { status: "done", endedAt: iso(-20_000) } : {}) })] });
    if (k >= 4) Object.assign(api, { status: "done", endedAt: iso(-25_000), result: { text: "token bucket per API key, 429 with Retry-After; 14 tests pass", links: ["https://github.com/northwind-labs/payments-api/pull/412"] } });
    const docs = task("g7k3pb", "Document the rate limits", "docs-site", 5 + k * 2, [
      step("Draft the rate limit page", k < 2 ? "running" : "done", { pct: 40 }),
      step("Check the code samples", k < 2 ? "pending" : k < 4 ? "running" : "done"),
      step("Publish the preview", "pending"),
    ], { workers: [worker("copilot", "Rate limit page with examples", copilotRun, { since: 5 + k * 2 })] });
    const build = task("g7k5tc", "Upload the release build", "storefront-web", 2 + k, [
      step("Build storefront-web", "done"),
      step("Upload release build", k < 4 ? "running" : "done", { ...(k >= 1 && k < 4 ? upload([18, 52, 86][k - 1]) : {}) }),
    ], { workers: k >= 1 ? [{ runId: trackId, via: "track", label: "Upload release build", pid: PID, status: k < 4 ? "running" : "done", startedAt: iso(-min(2)), log: path.join(HOME, "runs", `${trackId}.log`) }] : [] });
    if (k >= 4) Object.assign(build, { status: "done", endedAt: iso(-10_000), result: { text: "1.4 GB on the CDN, checksum verified", links: [] } });
    const forecast = task("g7k6qd", "Backfill the demand forecast", "data-pipeline", 4 + k, [step("Backfill 90 days", k < 2 ? "pending" : "blocked", k >= 2 ? { reason: "BigQuery quota resets at 18:00" } : {})],
      k < 2 ? { workers: [{ runId: runName(1, "free"), via: "free", label: "Backfill 90 days", pid: PID, status: "queued", queue: 2 - k, why: "free 3/3", startedAt: iso(-min(1)) }] } : { hold: { kind: "blocked", reason: "BigQuery quota resets at 18:00", at: iso(-min(1)), step: 1 } });
    const iosK = k === 2 ? { ...ios, ...askIos, steps: [ios.steps[0], step("Submit for review", "waiting-user", { reason: askIos.hold.reason })] } : k >= 3 ? { ...ios, steps: [ios.steps[0], step("Submit for review", "running", { detail: "App Store Connect: waiting for upload processing" })], notes: [{ at: iso(-min(0.3)), text: "user chose: Submit now" }] } : null;
    const tasks = [api, ...(k >= 1 ? [docs, build] : []), forecast, ...(iosK ? [iosK] : [])];
    states.push({ tasks, runs: runs(k).filter((r) => k >= 1 || r.via === "codex") });
  }
  return states;
}

async function hero() {
  const W = 1600, H = 1000, win = [16, 14, W - 32, H - 28];
  const [wx, wy, ww, wh] = win;
  const top = wy + 31 + 24, bottomH = 410, colW = Math.round(ww * 0.4), leadW = ww - colW - 1;
  const leadRect = [wx + 1, top, leadW, wh - 31 - 24 - bottomH - 1], taskRect = [wx + 1, top + leadRect[3] + 1, ww - 2, bottomH - 1];
  const colX = wx + 1 + leadW + 1, colH = leadRect[3], colRect1 = [colX, top, colW - 2, Math.floor(colH / 2)], colRect2 = [colX, top + Math.floor(colH / 2) + 1, colW - 2, colH - Math.floor(colH / 2) - 1];
  const charW = 13 * 0.602, rowH = 13 * LINE;
  const cols = (w) => Math.floor((w - 20) / charW), rowsOf = (h) => Math.floor((h - 16) / rowH);
  const keys = [2.2, 5.6, 9.0, 12.4, 15.4];
  const states = heroStates();
  const pane = [], tabs = [];
  states.forEach((s, k) => {
    writeState(s);
    pane.push({ at: keys[k], text: ekip(["tasks", "--watch", "--once"], { cols: cols(taskRect[2]), rows: rowsOf(taskRect[3]) }) });
    tabs.push(tabBar(keys[k], { title: "payments-api", counts: statusCounts(), width: ww - 2 }));
  });

  // the lead: a Claude Code session the user talks to as before
  const you = (s) => `${A.gray("❯")} ${A.bold(s)}`, say = (s) => `${A.lead("⏺")} ${s}`, out = (s) => `  ${A.gray("⎿")}  ${A.gray(s)}`;
  const tool = (cmd) => `${A.team("⏺")} ${A.bold("Bash")}(${cmd})`;
  const lead = [
    [2.4, you("Add rate limits to the public API, document them and upload the release build.")], [2.5, ""],
    [3.2, say("Three parts, each on another quota. I plan and review; the workers do the reading and typing.")], [3.3, ""],
    [3.9, tool('ekip run --via codex --task g7k2xa "Token bucket per API key, with tests"')], [4.1, out("codex started · pane on the right · log ~/ekip/data/runs/…-codex.log")],
    [4.6, tool('ekip run --via auto --task g7k3pb "Rate limit page with examples"')], [4.8, out("auto → copilot · pane on the right")],
    [5.4, tool('ekip track --task g7k5tc --label "Upload release build" --total 1.4G -- ./scripts/upload.sh')], [5.6, out("◆ tracking: Upload release build · step 2")], [5.7, ""],
    [9.3, say(`${A.yellow("One decision is yours")} (ios-app): submit v2.4 for review now, or after the paywall test?`)], [9.4, `  ${A.cyan("A)")} Submit now   ${A.cyan("B)")} Wait for the test`], [9.5, ""],
    [11.4, you("A")], [11.5, ""],
    [12.6, tool('ekip task answer g7k4ma "Submit now"')], [12.7, ""],
    [15.6, say("codex is done: token bucket per API key, 429 with Retry-After, 14 tests pass. Reviewing the diff now.")],
    [16.4, `${A.team("⏺")} ${A.bold("Read")}(src/ratelimit/bucket.go)`], [16.6, out("Read 118 lines")],
  ];
  const leadFrames = [{ at: 0, text: `${A.gray("ekip lead · payments-api · Claude Code")}\n` }];
  let acc = leadFrames[0].text;
  for (const [at, line] of lead) {
    if (line.startsWith(`${A.gray("❯")} `)) {
      const full = line.replace(/\x1b\[[0-9;]*m/g, "").slice(2);
      for (let i = 1; i <= full.length; i += 2) leadFrames.push({ at: at - 0.9 + (0.9 * i) / full.length, text: `${acc}\n${you(full.slice(0, i))}${A.lead("█")}` });
    }
    acc += `\n${line}`;
    leadFrames.push({ at, text: acc });
  }

  // two workers in the column, their logs as `ekip run` writes them
  const logPane = (header, lines, start, every) => {
    const frames = [{ at: 0, text: header }];
    let acc2 = header;
    lines.forEach((l, i) => { acc2 += `\n${l}`; frames.push({ at: start + i * every, text: acc2 }); });
    return frames;
  };
  const head = (via, project, label) => `${A.gray(`cwd: ~/code/${project}\nproject: ${project}\nlabel: ${label}`)}\n${A.gray(`[ekip pool ${via}]`)}`;
  const codex = logPane(head("codex", "payments-api", "Token bucket per API key"), [
    `${A.bold("codex")} ${A.gray("· reading the project card, memory and code graph")}`,
    `${A.gray("›")} rg -n "func .*Handler" src/http`, A.gray("  src/http/routes.go:41  src/http/middleware.go:12"),
    `${A.gray("›")} reading src/http/middleware.go`,
    `${A.green("✎")} src/ratelimit/bucket.go ${A.green("+86")}`, `${A.green("✎")} src/http/middleware.go ${A.green("+14")} ${A.gray("-2")}`,
    `${A.gray("›")} go test ./src/ratelimit/...`, A.green("  ok   ratelimit  0.41s"),
    `${A.green("✎")} src/http/middleware_test.go ${A.green("+58")}`,
    `${A.gray("›")} go test ./...`, A.green("  ok   http        1.12s"), A.green("  ok   ratelimit   0.39s"),
    `${A.gray("›")} go vet ./... ${A.green("clean")}`,
    `${A.bold("report")} token bucket per API key, 429 with Retry-After, 14 tests pass`,
    "[exit 0]",
  ], 2.6, 0.95);
  const copilot = logPane(head("copilot", "docs-site", "Rate limit page with examples"), [
    `${A.bold("copilot")} ${A.gray("· docs-site · Astro 5, MDX")}`,
    `${A.gray("›")} reading src/content/docs/api/authentication.mdx`,
    `${A.gray("›")} reading the payments-api card: limits, headers`,
    `${A.green("✎")} src/content/docs/api/rate-limits.mdx ${A.green("+72")}`,
    `${A.gray("›")} pnpm astro check`, A.green("  0 errors, 0 warnings"),
    `${A.green("✎")} examples/rate-limit.ts ${A.green("+31")}`,
    `${A.gray("›")} pnpm test examples`, A.green("  ✓ 6 examples"),
    `${A.gray("›")} checking links`, A.green("  148 links ok"),
    `${A.gray("›")} drafting the preview note`,
  ], 5.0, 1.05);

  // first, `ekip` typed in another terminal moves the lead to WezTerm
  const intro = new Shell(`${A.gray("~/code/payments-api")} % `);
  let at = intro.type(0.35, "ekip", 9);
  intro.print(at + 0.35, t("ekip WezTerm'de açıldı; bu sekme kapanıyor"), { prompt: false });
  const introWin = [430, 330, 740, 250];
  const until = 2.25;

  const layers = [
    ...windowFrame(introWin, { title: "Terminal · zsh", from: 0, until, fade: 0.25 }),
    { ...term([introWin[0] + 1, introWin[1] + 31, introWin[2] - 2, introWin[3] - 32], intro.frames, { size: 15, pad: [12, 14] }), from: 0, until, fade: 0.25 },
    ...windowFrame(win, { title: "ekip · payments-api", tabs, from: 1.75, fade: 0.4 }),
    { ...term(leadRect, leadFrames, { scroll: false }), from: 1.75, fade: 0.4 },
    { ...splitV([leadRect[0] + leadW, top, 1, colH]), from: 1.75, fade: 0.4 },
    { ...term(colRect1, codex, { scroll: true, size: 13 }), from: 1.75, fade: 0.4, style: "filter:brightness(.8) saturate(.85)" },
    { ...splitV([colX, top + Math.floor(colH / 2), colW - 2, 1]), from: 1.75, fade: 0.4 },
    { ...term(colRect2, copilot, { scroll: true, size: 13 }), from: 1.75, fade: 0.4, style: "filter:brightness(.8) saturate(.85)" },
    { ...splitV([wx + 1, taskRect[1] - 1, ww - 2, 1]), from: 1.75, fade: 0.4 },
    { ...term(taskRect, [{ at: 0, text: "" }, ...pane], { size: 13 }), from: 1.75, fade: 0.4, style: "filter:brightness(.92)" },
  ];
  await capture({ name: "hero", width: W, height: H, duration: 18.5, layers }, { mp4: "terminal-wezterm.mp4", gif: "terminal-wezterm.gif", fps: 12, gifFps: 10, stills: [{ at: 17.5, file: "terminal-wezterm-hero.png" }] });
}

// ---- `ekip status` -------------------------------------------------------------------------------

function statusState() {
  const s = heroStates()[2];
  const trackId = s.tasks.find((x) => x.id === "g7k5tc").workers[0].runId;
  const up = trackDetail(0.73 * GB, 1.4 * GB, 11.2 * MB);
  const tracks = [{ id: trackId, label: "Upload release build", cmd: "./scripts/upload.sh", taskId: "g7k5tc", step: 2, pid: PID, status: "running", startedAt: iso(-min(2)), createdAt: iso(-min(2)), log: path.join(HOME, "runs", `${trackId}.log`), lastLine: "upload 52%", ...up }];
  const failed = task("g7k1ne", "Nightly e2e run", "storefront-web", 140, [step("Run the e2e suite", "failed")], {
    status: "failed", endedAt: iso(-min(48)), updatedAt: iso(-min(48)),
    notes: [{ at: iso(-min(95)), text: "e2e (agy): quota reached, moved to the codex pool" }, { at: iso(-min(48)), text: "e2e (codex): exit 1 · 3 checkout specs fail on Safari 18" }],
  });
  const done = [
    task("g7j9rf", "Fix checkout race condition", "storefront-web", 180, [step("Add idempotency guard", "done")], { status: "done", endedAt: iso(-min(35)), result: { text: "idempotency key on submit; double charge no longer reproducible, 212 checkout tests pass", links: ["https://github.com/northwind-labs/storefront-web/pull/1873"] } }),
    task("g7j8wd", "Weekly dependency updates", "docs-site", 300, [step("Update and test", "done")], { status: "done", endedAt: iso(-min(190)), result: { text: "11 packages updated, build and link check green", links: [] } }),
  ];
  return { tasks: [...s.tasks, failed, ...done], tracks, runs: s.runs };
}

async function status() {
  writeState(statusState());
  const W = 1240, cols = 128;
  const text = ekip(["status", "--offline"], { cols, rows: 60 });
  fs.writeFileSync(path.join(HOME, "status.ansi"), text);
  const lines = text.split("\n");
  const sh = new Shell(`${A.team("~/code/payments-api")} ${A.lead("❯")} `);
  let at = sh.type(0.5, "ekip status", 12);
  // the digest prints at once; reveal it section by section so the eye can follow
  const parts = [];
  let cur = [];
  for (const l of lines) { if (!l.trim() && cur.length) { parts.push(cur); cur = []; } else cur.push(l); }
  if (cur.length) parts.push(cur);
  at += 0.4;
  parts.forEach((p, i) => sh.print(at + i * 0.35, `${i ? "\n" : ""}${p.join("\n")}`, { prompt: i === parts.length - 1 }));
  const rows = sh.lines.length + 1;
  const H = Math.round(31 + 16 + rows * 14 * LINE + 30);
  // a 16:10 canvas like the other README cards, the window centred on it
  const CW = Math.round(H * 1.6), win = [Math.round((CW - W) / 2) + 16, 14, W - 32, H - 28];
  const layers = [...windowFrame(win, { title: "ekip · payments-api" }), term([win[0] + 1, win[1] + 31, win[2] - 2, win[3] - 32], sh.frames, { pad: [10, 14] })];
  await capture({ name: "status", width: CW, height: H, duration: 9, layers }, { gif: "terminal-status.gif", fps: 10, colors: 96, stills: [{ at: 8.5, file: "terminal-status.png" }] });
}

// ---- `ekip track` ----------------------------------------------------------------------------------

async function track() {
  // 16:10 canvas (1280 × 800) like the other README cards, the 1240 px window centred on it
  const W = 1280, H = 800, win = [36, 14, 1208, H - 28];
  const [wx, wy, ww, wh] = win;
  const top = wy + 31 + 24, paneH = 370, shellRect = [wx + 1, top, ww - 2, wh - 31 - 24 - paneH - 1], taskRect = [wx + 1, top + shellRect[3] + 1, ww - 2, paneH - 1];
  const charW = 13 * 0.602, rowH = 13 * LINE, cols = Math.floor((taskRect[2] - 20) / charW), rows = Math.floor((taskRect[3] - 16) / rowH);
  const upId = `${iso(-min(2)).replace(/[:.]/g, "-")}-track`, nasId = `${iso(-min(3)).replace(/[:.]/g, "-")}-track`;
  const nasLog = path.join(HOME, "runs", `${nasId}.log`), upLog = path.join(HOME, "runs", `${upId}.log`);
  const nas = trackDetail(9.4 * GB, 120 * GB, 6 * MB);
  const takes = Math.round((Date.parse(nas.etaAt) - Date.now()) / 60_000) + 3;
  const slow = t("{label}: beklenenden yavaş: hız {rate}, tahmini bitiş {time} ({dur} sürer; sınır {max} dk)", { label: "Copy raw footage to the NAS", rate: nas.rate, time: clock(Date.parse(nas.etaAt) - Date.now()), dur: t("{h} sa {m} dk", { h: Math.floor(takes / 60), m: takes % 60 }), max: 60 });
  const keys = [3.6, 6.4, 9.0, 11.6];
  const pane = [], tabs = [];
  const states = [8, 41, 77, 100].map((pct, k) => {
    const done = pct >= 100;
    const up = trackDetail(1.4 * GB * pct / 100, 1.4 * GB, 11.2 * MB);
    const build = task("g7k5tc", "Upload the release build", "storefront-web", 4 + k, [step("Build storefront-web", "done"), step("Upload release build", done ? "done" : "running", done ? {} : up)], {
      workers: [{ runId: upId, via: "track", label: "Upload release build", pid: PID, status: done ? "done" : "running", startedAt: iso(-min(2)), log: upLog }],
      ...(done ? { status: "done", endedAt: iso(-5_000), result: { text: "1.4 GB on the CDN, checksum verified", links: [] } } : {}),
    });
    const tracks = [
      { id: upId, label: "Upload release build", cmd: "./scripts/upload.sh", taskId: "g7k5tc", step: 2, pid: PID, startedAt: iso(-min(2)), createdAt: iso(-min(2)), log: upLog, ...(done ? { status: "done", exitCode: 0, endedAt: iso(-5_000), pct: 100, lastLine: "upload complete: 1.4 GB in 2 min" } : { status: "running", ...up, lastLine: `upload ${pct}%` }) },
      { id: nasId, label: "Copy raw footage to the NAS", cmd: "./scripts/copy-footage.sh", taskId: null, pid: PID, status: "running", startedAt: iso(-min(3)), createdAt: iso(-min(3)), log: nasLog, etaMax: 60, slow: k >= 2 ? slow : null, ...nas, lastLine: k >= 2 ? `[ekip] ${slow}` : "9.4G   7%  6.00MB/s  5:37:12" },
    ];
    const runs = [
      { name: `${upId}.log`, via: "track", project: "storefront-web", label: "Upload release build", taskId: "g7k5tc", lines: ["$ ./scripts/upload.sh", `upload ${pct}%`, ...(done ? ["upload complete: 1.4 GB in 2 min"] : [])], exit: done ? 0 : null },
      { name: `${nasId}.log`, via: "track", project: "storefront-web", label: "Copy raw footage to the NAS", lines: ["$ ./scripts/copy-footage.sh", "9.4G   7%  6.00MB/s  5:37:12", ...(k >= 2 ? [`[ekip] ${slow}`] : [])] },
    ];
    return { tasks: [build], tracks, runs };
  });
  states.forEach((s, k) => {
    writeState(s);
    pane.push({ at: keys[k], text: ekip(["tasks", "--watch", "--once"], { cols, rows }) });
    tabs.push(tabBar(keys[k], { title: "storefront-web", counts: statusCounts(), width: ww - 2 }));
  });
  const ls = ekip(["track", "ls"], { cols: Math.floor((shellRect[2] - 28) / (14 * 0.602)), rows: 30 });

  const sh = new Shell();
  const tracking = (label, id, log, extra = "") => `${id}\n${A.cyan("◆")} ${t("izleniyor")}: ${label} ${A.gray(`· pid ${41200 + id.length} · log ${log.replaceAll(HOME, SHOWN_HOME)}${extra}`)}`;
  let at = sh.type(0.3, 'ekip track --label "Copy raw footage to the NAS" --total 120G --eta-max 60 -- ./scripts/copy-footage.sh', 60);
  sh.print(at + 0.25, tracking("Copy raw footage to the NAS", nasId, nasLog));
  at = sh.type(at + 0.7, 'ekip track --task g7k5tc --label "Upload release build" --total 1.4G --wait -- ./scripts/upload.sh', 60);
  sh.print(at + 0.25, tracking("Upload release build", upId, upLog, " · g7k5tc/2"), { prompt: false });
  sh.print(keys[3], `${A.green("✓")} Upload release build: ${t("çıkış {code}", { code: 0 })}\nupload complete: 1.4 GB in 2 min`);
  at = sh.type(keys[3] + 0.8, "ekip track ls", 14);
  sh.print(at + 0.3, ls);

  // the macOS notification the slow job sends
  const mark = fs.readFileSync(path.join(root, "docs/brand/logo-mark.svg"), "utf8");
  const toast = { rect: [wx + ww - 424, 250, 400, 96], raw: true, from: keys[2] + 0.2, until: keys[2] + 4.2, fade: 0.25, style: "border-radius:16px;background:rgba(40,43,51,.96);box-shadow:0 12px 40px rgba(0,0,0,.5);border:1px solid #3A3F4A", frames: [{ at: 0, html: `<div style="display:flex;gap:12px;padding:14px 16px;font:13px/1.35 -apple-system,BlinkMacSystemFont,'Inter',sans-serif;color:#ECEEF2"><img src="data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}" style="width:38px;height:38px;border-radius:9px;background:#0E1014;padding:4px;box-sizing:border-box"><div style="min-width:0"><b>Copy raw footage to the NAS</b><div style="color:#F5A524">⚠ ${t("Beklenenden yavaş")}</div><div style="color:#C9CED8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:310px">speed ${nas.rate}, takes ${t("{h} sa {m} dk", { h: Math.floor(takes / 60), m: takes % 60 })}; limit 60 min</div></div></div>` }] };
  const layers = [
    ...windowFrame(win, { title: "ekip · storefront-web", tabs: [tabBar(0, { title: "storefront-web", counts: { running: 0, waiting: 0, blocked: 0 }, width: ww - 2 }), ...tabs] }),
    term(shellRect, sh.frames, { scroll: true }),
    splitV([wx + 1, taskRect[1] - 1, ww - 2, 1]),
    { ...term(taskRect, [{ at: 0, text: "" }, ...pane], { size: 13 }), style: "filter:brightness(.92)" },
    toast,
  ];
  await capture({ name: "track", width: W, height: H, duration: 16, layers }, { gif: "terminal-track.gif", fps: 10, colors: 96 });
}

try {
  await startChrome();
  if (want("hero")) await hero();
  if (want("status")) await status();
  if (want("track")) await track();
} finally {
  browser?.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  if (!process.env.EKIP_DEMO_KEEP) fs.rmSync(HOME, { recursive: true, force: true });
  else console.log(`kept ${HOME}`);
}
