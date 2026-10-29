#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../..');
const chrome=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port=process.env.CDP_PORT||'9222', base=process.env.DEMO_URL||'http://127.0.0.1:7790';
const shots=path.join(root,'docs/screenshots'), demo=path.join(root,'docs/demo');fs.mkdirSync(shots,{recursive:true});fs.mkdirSync(demo,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ekip-demo-chrome-'));
const proc=spawn(chrome,['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-gpu','--hide-scrollbars'],{stdio:'ignore'});
let browser;
try {
 for(let i=0;i<60;i++){try{browser=await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();break}catch{await sleep(250)}}
 if(!browser)throw Error('Chrome remote debugging did not start');
 const target=await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`,{method:'PUT'})).json();
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 let seq=0, recording=false, frameDir='', frameNo=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}else if(m.method==='Page.screencastFrame'){ws.send(JSON.stringify({id:++seq,method:'Page.screencastFrameAck',params:{sessionId:m.params.sessionId}}));if(recording)fs.writeFileSync(path.join(frameDir,`f${String(frameNo++).padStart(4,'0')}.jpg`),Buffer.from(m.params.data,'base64'))} };
 const cdp=(method,params={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);ws.send(JSON.stringify({id,method,params}))});
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
 const evalJs=async expression=>(await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})).result?.result?.value;
 await fetch(`${base}/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'demo'})});
 // Secure cookies are accepted for loopback; use browser fetch so it stores the Set-Cookie.
 await cdp('Page.navigate',{url:`${base}/sign-in`});await sleep(900);
 const login=await evalJs(`fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'demo'})}).then(r=>r.status)`);if(login!==200)throw Error(`Login failed: ${login}`);
 const pages=[['panel-tasks-dark','/tasks','dark'],['panel-overview-dark','/overview','dark'],['panel-pools-dark','/pools','dark'],['panel-runs-dark','/runs','dark'],['panel-projects-dark','/projects','dark'],['panel-codemap-dark','/code-map?proje=storefront-web','dark'],['panel-tasks-light','/tasks','light'],['panel-overview-light','/overview','light']];
 const english=(route)=>`${route}${route.includes('?')?'&':'?'}lang=en`;
 const frameFiles=[];
 for(const [name,route,theme] of pages){await evalJs(`document.cookie='ekip-theme=${theme}; path=/; max-age=31536000'`);await cdp('Page.navigate',{url:base+english(route)});await sleep(1900);await cdp('Runtime.evaluate',{expression:`document.documentElement.classList.remove('dark','light');document.documentElement.classList.add('${theme}')`});if(route.includes('code-map')){await evalJs(`document.querySelector('.react-flow__node[data-id^="r:"]')?.click()`);await sleep(1300)}else await sleep(450);const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true});fs.writeFileSync(path.join(shots,`${name}.png`),Buffer.from(shot.result.data,'base64'));if(['panel-tasks-dark','panel-overview-dark','panel-projects-dark','panel-codemap-dark','panel-runs-dark','panel-pools-dark'].includes(name))frameFiles.push({route,theme});}
 // Page.screencastFrame carries the video frames while the page changes and scrolls.
 const frames=path.join(demo,'.frames');fs.rmSync(frames,{recursive:true,force:true});fs.mkdirSync(frames,{recursive:true});frameDir=frames;frameNo=0;recording=true;
 await cdp('Page.startScreencast',{format:'jpeg',quality:78,maxWidth:2880,maxHeight:1800,everyNthFrame:1});
 for(const {route,theme} of frameFiles){await evalJs(`document.cookie='ekip-theme=${theme}; path=/; max-age=31536000'`);await cdp('Page.navigate',{url:base+english(route)});await sleep(1100);if(route.includes('code-map')){await evalJs(`document.querySelector('.react-flow__node[data-id^="r:"]')?.click()`);await sleep(650)}for(let k=0;k<45;k++){await evalJs(`window.scrollTo({top:${k<12?0:k<37?(k-12)*16:(37-k)*16},behavior:'instant'})`);await sleep(35)}}
 await sleep(400);await cdp('Page.stopScreencast');recording=false;if(frameNo<30)throw Error(`screencast returned only ${frameNo} frames`);
 ws.close();
 const ffmpeg=(args)=>{const r=spawnSync('ffmpeg',args,{stdio:'ignore'});if(r.status!==0)throw Error(`ffmpeg failed: ${args.join(' ')}`)};
 ffmpeg(['-y','-framerate','30','-i',path.join(frames,'f%04d.jpg'),'-vf','setpts=2*PTS,fps=30,scale=1440:900:flags=lanczos,format=yuv420p','-c:v','libx264','-preset','medium','-crf','22','-movflags','+faststart',path.join(demo,'panel-demo.mp4')]);
 const palette=path.join(os.tmpdir(),'ekip-demo-palette.png');
 ffmpeg(['-y','-i',path.join(demo,'panel-demo.mp4'),'-vf','fps=12,scale=960:-1:flags=lanczos,palettegen=max_colors=16:stats_mode=diff','-frames:v','1',palette]);
 ffmpeg(['-y','-i',path.join(demo,'panel-demo.mp4'),'-i',palette,'-filter_complex','fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3','-loop','0',path.join(demo,'panel-demo.gif')]);
 const term=spawnSync(process.execPath,[path.join(root,'hub/demo/terminal.mjs')],{stdio:'inherit'});if(term.status!==0)throw Error('terminal screenshots failed');
} finally {proc.kill('SIGTERM');}
