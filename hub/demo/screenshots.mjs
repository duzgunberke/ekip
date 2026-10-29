#!/usr/bin/env node
// Still screenshots of the panel for the docs, from the demo workspace. Needs the demo server
// (`sh hub/demo/run.sh`) on DEMO_URL; writes docs/screenshots/panel-<page>-<theme>.png.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = process.env.CDP_PORT || '9223';
const base = process.env.DEMO_URL || 'http://127.0.0.1:7790';
const out = path.join(root, 'docs/screenshots');
const shots = [['tasks', 'dark'], ['tasks', 'light'], ['overview', 'dark'], ['overview', 'light'], ['projects', 'dark'], ['runs', 'dark'], ['pools', 'dark']];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ekip-shots-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars'], { stdio: 'ignore' });
try {
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ok = true; } catch { await sleep(250); } }
  if (!ok) throw Error('Chrome remote debugging did not start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const cdp = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: `${base}/sign-in?lang=en` }); await sleep(800);
  const login = await evaluate(`fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'demo'})}).then(r=>r.status)`);
  if (login !== 200) throw Error(`Login failed: ${login}`);
  for (const [page, theme] of shots) {
    await evaluate(`(()=>{document.cookie='ekip-theme=${theme}; path=/';try{localStorage.setItem('ekip-theme','${theme}')}catch{}})()`);
    await cdp('Page.navigate', { url: `${base}/${page}?lang=en` });
    await sleep(2500);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, `panel-${page}-${theme}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log(`panel-${page}-${theme}.png`);
  }
  ws.close();
} finally {
  proc.kill(); await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
  fs.rmSync(profile, { recursive: true, force: true });
}
