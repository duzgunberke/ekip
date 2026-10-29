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
const fps = 30, segmentSeconds = 7.5, overlapSeconds = .5, segmentFrames = Math.round(segmentSeconds * fps);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars'], { stdio: 'ignore' });
let browser;
function ffmpeg(args) { const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw Error(`ffmpeg failed: ${r.stderr || args.join(' ')}`); }
try {
  for (let i = 0; i < 60; i++) { try { browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(250); } }
  if (!browser) throw Error('Chrome remote debugging did not start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0, latestFrame = null, frameNo = 0; const pending = new Map();
  ws.onmessage = event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Page.screencastFrame') { ws.send(JSON.stringify({ id: ++seq, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } })); latestFrame = Buffer.from(m.params.data, 'base64'); } };
  const cdp = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async expression => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const english = route => `${route}${route.includes('?') ? '&' : '?'}lang=en`;
  await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'demo' }) });
  await cdp('Page.navigate', { url: `${base}/sign-in?lang=en` }); await sleep(500);
  const login = await evaluate(`fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'demo'})}).then(r=>r.status)`);
  if (login !== 200) throw Error(`Login failed: ${login}`);
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
  const moveRaw = async (x,y) => { await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x,y}); await evaluate(`(()=>{const c=document.getElementById('__demo_cursor');if(c){c.style.left='${x}px';c.style.top='${y}px'}})()`); };
  let pointer = {x:690,y:820};
  const moveTo = async (selector, duration=.72, hover=true) => {
    const box = await evaluate(`(()=>{const e=${selector};if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`);
    if (!box) { console.warn(`Target not found: ${selector}`); return false; }
    const from={...pointer}, start=Date.now(), ms=duration*1000;
    while(Date.now()-start<ms){const t=Math.min(1,(Date.now()-start)/ms),e=1-Math.pow(1-t,3);pointer={x:from.x+(box.x-from.x)*e,y:from.y+(box.y-from.y)*e};await moveRaw(pointer.x,pointer.y);await sleep(16)}
    pointer=box; await moveRaw(box.x,box.y); if(hover)await sleep(450); return true;
  };
  const click = async () => { await evaluate(`(()=>{const c=document.getElementById('__demo_cursor');if(c){const r=document.createElement('i');r.className='__demo_ripple';r.style.left=c.style.left;r.style.top=c.style.top;document.body.append(r);setTimeout(()=>r.remove(),650)}})()`); await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:pointer.x,y:pointer.y,button:'left',clickCount:1}); await sleep(45); await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:pointer.x,y:pointer.y,button:'left',clickCount:1}); await sleep(120); };
  const clickTarget=async(selector,duration=.72)=>{if(await moveTo(selector,duration,false))await click()};
  const textTarget=(needle,scope='document')=>`(()=>[...${scope}.querySelectorAll('button,a,[role="option"],[role="row"],tr,.react-flow__node,[data-slot="card"],article')].find(e=>e.innerText?.includes(${JSON.stringify(needle)})))()`;
  const nav = async route => { await cdp('Page.navigate',{url:base+english(route)}); const until=Date.now()+12000; while(Date.now()<until){const s=await evaluate(`({ok:document.readyState==='complete'&&!!document.querySelector('main'),busy:!!document.querySelector('[aria-busy="true"],[data-loading="true"]')})`);if(s?.ok&&!s.busy)break;await sleep(200)} await sleep(850); await evaluate(`document.documentElement.classList.remove('light');document.documentElement.classList.add('dark');document.documentElement.lang='en';window.scrollTo(0,0)`); };
  const wait = ms => sleep(ms);
  const actions = [
    {name:'tasks',route:'/tasks',run:async()=>{await wait(350);const stalled=`[...document.querySelectorAll('p,span,div')].filter(e=>e.innerText?.trim().startsWith('stalled for')).sort((a,b)=>a.innerText.length-b.innerText.length)[0]`;await moveTo(stalled,.78,true);await wait(350);const second=textTarget('Ship paywall A/B test');await moveTo(second,.75,false);await evaluate(`(()=>{const e=${second};if(e)e.scrollIntoView({behavior:'smooth',block:'center'})})()`);await wait(600);await moveTo(second,.7,true);await wait(700)}},
    {name:'command-map',route:'/tasks',run:async()=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'k',code:'KeyK',windowsVirtualKeyCode:75,modifiers:4});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'k',code:'KeyK',windowsVirtualKeyCode:75,modifiers:4});await wait(350);await moveTo(`document.querySelector('[data-slot="command-input"]')`,.65,false);await click();await cdp('Input.insertText',{text:'code'});await wait(600);const item=textTarget('Code map',"document.querySelector('[role=dialog]')");await moveTo(item,.7,true);await click();await wait(900)}},
    {name:'code-map',route:'/code-map?proje=storefront-web',run:async()=>{const repo=`document.querySelector('.react-flow__node[data-id^="r:"]')`;await moveTo(repo,.72,true);await click();await wait(300);const src=`[...document.querySelectorAll('.react-flow__node')].find(e=>e.innerText.trim().startsWith('src'))`;await moveTo(src,.68,true);await click();await wait(250);const checkout=`[...document.querySelectorAll('.react-flow__node')].find(e=>e.innerText.trim().startsWith('checkout'))`;await moveTo(checkout,.7,true);await click();await wait(250);const file=`[...document.querySelectorAll('button')].find(e=>e.innerText.includes('CheckoutFlow.tsx'))`;await moveTo(file,.68,true);await click();await wait(800);}},
    {name:'runs',route:'/runs',run:async()=>{const status=`document.querySelector('button[class*="border-dashed"]')`;await clickTarget(status);await wait(350);await clickTarget(`document.querySelector('[cmdk-item]') && [...document.querySelectorAll('[cmdk-item]')].find(e=>e.innerText.includes('Failed'))`);await wait(500);const row=`[...document.querySelectorAll('tr')].find(e=>e.innerText.includes('Failed'))`;await moveTo(row,.72,true);await click();await wait(950);const report=`document.querySelector('button[aria-label="Show report"]')`;await clickTarget(report);await wait(900);await clickTarget(`document.querySelector('button[aria-label="Hide report"]')`);await wait(300)}},
    {name:'projects',route:'/projects',run:async()=>{const card=`[...document.querySelectorAll('[data-slot="card"][role="button"]')].find(e=>e.innerText.trim().startsWith('storefront-web'))`;await moveTo(card,.75,true);await click();await wait(450);if(!(await evaluate(`!!document.querySelector('[data-slot="sheet-content"]')`)))await evaluate(`(()=>{history.pushState({},'','/projects?p=storefront-web&lang=en');dispatchEvent(new PopStateEvent('popstate'))})()`);await wait(500);await wait(1100);const close=`document.querySelector('[data-slot="sheet-content"] > button:last-child')`;await clickTarget(close);await wait(650)}},
    {name:'pools',route:'/pools',run:async()=>{await evaluate(`new Promise(r=>{const s=window.scrollY,b=performance.now();function f(n){let t=Math.min(1,(n-b)/1900),e=t*t*(3-2*t);scrollTo(0,s+Math.min(380,document.documentElement.scrollHeight-innerHeight-s)*e);if(t<1)requestAnimationFrame(f);else r()}requestAnimationFrame(f)})`);await wait(300);await moveTo(textTarget('If a job arrived now'),.75,true);await wait(1200)}},
    {name:'overview-return',route:'/overview',run:async()=>{const chart=`document.querySelector('.recharts-bar-rectangle path')`;await moveTo(chart,.8,true);await wait(1100);await nav('/tasks');await wait(750);await moveTo(textTarget('Fix checkout race condition'),.7,true);await wait(500)}}
  ];
  const clips=[];
  for(let index=0;index<actions.length;index++){
    const a=actions[index]; await nav(a.route);
    const cursorInfo=await evaluate(`(()=>{document.getElementById('__demo_cursor')?.remove();const s=document.createElement('style');s.textContent='.__demo_ripple{position:fixed!important;z-index:2147483646!important;width:22px;height:22px;border:2px solid #36d6c0;border-radius:50%;pointer-events:none;transform:translate(-50%,-50%);animation:demo-ripple .58s ease-out forwards}@keyframes demo-ripple{from{opacity:.9;scale:.55}to{opacity:0;scale:2.4}}';document.head.append(s);const c=document.createElement('div');c.id='__demo_cursor';c.innerHTML='<svg viewBox="0 0 28 36" width="28" height="36" xmlns="http://www.w3.org/2000/svg"><path d="M3 2.5v23l6.2-6 4.5 10 4.1-1.9-4.8-9.5 9-.3L3 2.5z" fill="white" stroke="#111827" stroke-width="1.8" stroke-linejoin="round"/></svg>';Object.assign(c.style,{position:'fixed',zIndex:'2147483647',width:'28px',height:'36px',pointerEvents:'none',filter:'drop-shadow(0 2px 2px #0009)',transform:'translate(-2px,-2px)',left:'690px',top:'820px'});document.body.append(c);return {cursor:!!document.getElementById('__demo_cursor'),computed:getComputedStyle(c).position,rect:c.getBoundingClientRect().toJSON()}})()`);
    console.log('cursor:',JSON.stringify(cursorInfo));
    await moveRaw(pointer.x,pointer.y);
    const segmentDir=path.join(work,`segment-${index}`);fs.mkdirSync(segmentDir);frameNo=0;
    const initial=await cdp('Page.captureScreenshot',{format:'jpeg',quality:90,captureBeyondViewport:false,fromSurface:true});latestFrame=Buffer.from(initial.result.data,'base64');
    const frameTimer=setInterval(()=>{if(latestFrame)fs.writeFileSync(path.join(segmentDir,`f${String(frameNo++).padStart(4,'0')}.jpg`),latestFrame)},1000/fps);
    const start=Date.now();await a.run();await sleep(Math.max(0,segmentSeconds*1000-(Date.now()-start)));clearInterval(frameTimer);
    while(frameNo<segmentFrames)fs.writeFileSync(path.join(segmentDir,`f${String(frameNo++).padStart(4,'0')}.jpg`),latestFrame);
    const clip=path.join(work,`${a.name}.mp4`);clips.push(clip);
    ffmpeg(['-framerate',String(fps),'-i',path.join(segmentDir,'f%04d.jpg'),'-frames:v',String(segmentFrames),'-vf','scale=1440:900:flags=lanczos,format=yuv420p','-r',String(fps),'-c:v','libx264','-preset','medium','-crf','23','-an','-video_track_timescale','90000',clip]);
    console.log(`${a.name}: ${frameNo} frames (${segmentSeconds.toFixed(1)}s)`);
  }
  await cdp('Page.stopScreencast');
  const inputs=clips.flatMap(file=>['-i',file]),chain=[];let previous='[0:v]';
  for(let i=1;i<clips.length;i++){const out=`[x${i}]`;chain.push(`${previous}[${i}:v]xfade=transition=fade:duration=${overlapSeconds}:offset=${(segmentSeconds-overlapSeconds)*i}${out}`);previous=out;}
  ffmpeg([...inputs,'-filter_complex',`${chain.join(';')};${previous}scale=iw:ih:in_range=pc:out_range=tv,format=yuv420p[vout]`,'-map','[vout]','-r',String(fps),'-c:v','libx264','-preset','medium','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',path.join(demo,'panel-demo.mp4')]);
  const palette=path.join(work,'palette.png'),gifPath=path.join(demo,'panel-demo.gif');
  const makeGif=(width,rate,colors=256)=>{ffmpeg(['-i',path.join(demo,'panel-demo.mp4'),'-vf',`fps=${rate},scale=${width}:-1:flags=lanczos,palettegen=max_colors=${colors}:stats_mode=diff`,'-frames:v','1',palette]);ffmpeg(['-i',path.join(demo,'panel-demo.mp4'),'-i',palette,'-filter_complex',`fps=${rate},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,'-loop','0',gifPath]);};
  makeGif(800,10,256);if(fs.statSync(gifPath).size>=9_500_000)makeGif(760,10,256);if(fs.statSync(gifPath).size>=9_500_000)makeGif(760,10,192);if(fs.statSync(gifPath).size>=9_500_000)throw Error('GIF is still >=9.5 MB after 760px fallbacks');
  // Selected-file screenshot is captured from the finished interaction state.
  await cdp('Page.navigate',{url:base+english('/code-map?proje=storefront-web')});await sleep(1300);await evaluate(`document.documentElement.classList.add('dark');document.documentElement.lang='en'`);
  await evaluate(`(()=>{const n=document.querySelector('.react-flow__node[data-id^="r:"]');n?.click()})()`);await sleep(650);
  await evaluate(`(()=>[...document.querySelectorAll('.react-flow__node')].find(e=>e.innerText.trim().startsWith('src'))?.click())()`);await sleep(450);await evaluate(`(()=>[...document.querySelectorAll('.react-flow__node')].find(e=>e.innerText.trim().startsWith('checkout'))?.click())()`);await sleep(500);await clickTarget(`([...document.querySelectorAll('button')].find(e=>e.innerText.includes('CheckoutFlow.tsx')))`,.72);await evaluate(`(()=>[...document.querySelectorAll('button')].find(e=>e.innerText.includes('CheckoutFlow.tsx'))?.click())()`);await sleep(1200);
  console.log('codemap screenshot state:',JSON.stringify(await evaluate(`({titles:[...document.querySelectorAll('h2')].map(e=>e.innerText),symbols:[...document.querySelectorAll('li')].map(e=>e.innerText).filter(x=>x.includes('Controller')||x.includes('useCheckout'))})`)));
  const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});fs.writeFileSync(path.join(root,'docs/screenshots/panel-codemap-dark.png'),Buffer.from(shot.result.data,'base64'));ws.close();
} finally { proc.kill('SIGTERM');await sleep(350);for(const d of [profile,work])try{fs.rmSync(d,{recursive:true,force:true,maxRetries:8,retryDelay:150})}catch(e){console.warn(`Temporary cleanup deferred: ${d} (${e.message})`)} }
