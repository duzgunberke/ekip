#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = process.env.CDP_PORT || '9222';
const base = process.env.DEMO_URL || 'http://127.0.0.1:7790';
const demo = path.join(root, 'docs/demo');
fs.mkdirSync(demo, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ekip-demo-chrome-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ekip-demo-capture-'));
const pages = [
  ['tasks', '/tasks'],
  ['overview', '/overview'],
  ['projects', '/projects'],
  ['code-map', '/code-map?proje=storefront-web'],
  ['runs', '/runs'],
  ['pools', '/pools'],
  ['tasks-return', '/tasks'],
];
const segmentSeconds = 5.4;
const overlapSeconds = 0.6;
const fps = 30;
const segmentFrames = Math.round(segmentSeconds * fps);
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
], { stdio: 'ignore' });
let browser;

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw Error(`ffmpeg failed: ${result.stderr || args.join(' ')}`);
}

try {
  for (let i = 0; i < 60; i++) {
    try { browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!browser) throw Error('Chrome remote debugging did not start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0, latestFrame = null, frameNo = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Page.screencastFrame') {
      ws.send(JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId: message.params.sessionId } }));
      latestFrame = Buffer.from(message.params.data, 'base64');
    }
  };
  const cdp = (method, params = {}) => new Promise(resolve => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'demo' }) });
  await cdp('Page.navigate', { url: `${base}/sign-in?lang=en` });
  await sleep(500);
  const login = await evaluate(`fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'demo'})}).then(r=>r.status)`);
  if (login !== 200) throw Error(`Login failed: ${login}`);

  const english = route => `${route}${route.includes('?') ? '&' : '?'}lang=en`;
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
  const clips = [];
  for (let index = 0; index < pages.length; index++) {
    const [name, route] = pages[index];
    await evaluate(`document.cookie='ekip-theme=dark; path=/; max-age=31536000'`);
    await cdp('Page.navigate', { url: base + english(route) });
    // Wait for the document and app shell, then let the route's API-backed content settle.
    const ready = Date.now() + 12000;
    while (Date.now() < ready) {
      const state = await evaluate(`({ready:document.readyState==='complete' && !!document.querySelector('main'), loading:!!document.querySelector('[aria-busy="true"], [data-loading="true"]')})`);
      if (state?.ready && !state.loading) break;
      await sleep(200);
    }
    await sleep(700);
    await evaluate(`document.documentElement.classList.remove('light');document.documentElement.classList.add('dark');document.documentElement.lang='en';window.scrollTo(0,0)`);
    if (route.includes('code-map')) {
      const selected = await evaluate(`(()=>{const n=document.querySelector('.react-flow__node[data-id^="r:"]');if(n)n.click();return !!n})()`);
      if (!selected) throw Error('Code map has no selectable node');
      await sleep(450);
    }

    const segmentDir = path.join(work, `segment-${index}`);
    fs.mkdirSync(segmentDir);
    frameNo = 0;
    const initial = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88, captureBeyondViewport: false, fromSurface: true });
    latestFrame = Buffer.from(initial.result.data, 'base64');
    const frameTimer = setInterval(() => {
      if (!latestFrame) return;
      fs.writeFileSync(path.join(segmentDir, `f${String(frameNo++).padStart(4, '0')}.jpg`), latestFrame);
    }, 1000 / fps);
    const start = Date.now();
    // Scroll only when the document is taller than the viewport. Ease to a 500px offset over 2s.
    // Keep the savings card fully in view on the overview page.
    const longPage = index !== 1 && await evaluate(`document.documentElement.scrollHeight > innerHeight + 80`);
    if (longPage) {
      await evaluate(`new Promise(resolve=>{const from=window.scrollY,to=Math.min(from+500,document.documentElement.scrollHeight-innerHeight),begin=performance.now(),duration=2000;function step(now){const t=Math.min(1,(now-begin)/duration),e=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;window.scrollTo(0,from+(to-from)*e);if(t<1)requestAnimationFrame(step);else resolve() }requestAnimationFrame(step)})`);
      await sleep(350);
    }
    // The whole visible segment is held for 5.4s after readiness; pad the tail after any scroll.
    const elapsed = Date.now() - start;
    await sleep(Math.max(0, segmentSeconds * 1000 - elapsed));
    clearInterval(frameTimer);
    while (frameNo < segmentFrames) {
      fs.writeFileSync(path.join(segmentDir, `f${String(frameNo++).padStart(4, '0')}.jpg`), latestFrame);
    }
    clips.push(path.join(work, `${name}.mp4`));
    ffmpeg(['-framerate', String(fps), '-i', path.join(segmentDir, 'f%04d.jpg'), '-frames:v', String(segmentFrames), '-vf', 'scale=1440:900:flags=lanczos,format=yuv420p', '-r', String(fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-an', '-video_track_timescale', '90000', clips.at(-1)]);
    console.log(`${name}: ${frameNo} frames (${segmentSeconds.toFixed(1)}s)`);
  }
  await cdp('Page.stopScreencast');
  ws.close();

  const inputs = clips.flatMap(file => ['-i', file]);
  const chain = [];
  let previous = '[0:v]';
  for (let i = 1; i < clips.length; i++) {
    const output = `[x${i}]`;
    const offset = (segmentSeconds - overlapSeconds) * i;
    chain.push(`${previous}[${i}:v]xfade=transition=fade:duration=${overlapSeconds}:offset=${offset.toFixed(3)}${output}`);
    previous = output;
  }
  ffmpeg([...inputs, '-filter_complex', `${chain.join(';')};${previous}scale=iw:ih:in_range=pc:out_range=tv,format=yuv420p[vout]`, '-map', '[vout]', '-r', String(fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(demo, 'panel-demo.mp4')]);

  const palette = path.join(work, 'palette.png');
  const gifPath = path.join(demo, 'panel-demo.gif');
  const makeGif = (width, rate, colors = 256) => {
    ffmpeg(['-i', path.join(demo, 'panel-demo.mp4'), '-vf', `fps=${rate},scale=${width}:-1:flags=lanczos,palettegen=max_colors=${colors}:stats_mode=diff`, '-frames:v', '1', palette]);
    ffmpeg(['-i', path.join(demo, 'panel-demo.mp4'), '-i', palette, '-filter_complex', `fps=${rate},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gifPath]);
  };
  makeGif(960, 12);
  const gifLimit = 9_000_000;
  if (fs.statSync(gifPath).size >= gifLimit) makeGif(880, 10, 128);
  if (fs.statSync(gifPath).size >= gifLimit) makeGif(800, 10, 128);
  if (fs.statSync(gifPath).size >= gifLimit) makeGif(800, 10, 96);
  if (fs.statSync(gifPath).size >= gifLimit) makeGif(800, 8, 96);
  if (fs.statSync(gifPath).size >= gifLimit) throw Error('GIF is still 9 MB or larger after size fallbacks');
} finally {
  proc.kill('SIGTERM');
  await sleep(350);
  for (const directory of [profile, work]) {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); }
    catch (error) { console.warn(`Temporary directory cleanup deferred: ${directory} (${error.message})`); }
  }
}
