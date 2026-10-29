// Read-only token accounting across Claude, worker logs and freellmapi.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME, REMOTE, ROOT, RUNS, SETTINGS, FREE_CONTAINER_SH } from '../core/core.js';
import { c, title } from '../core/ui.js';
import { t, lang } from '../core/i18n.js';

const dayKey = (v) => { const d = new Date(v); return Number.isNaN(+d) ? null : d.toISOString().slice(0, 10); };
const bucket = (map, day) => map[day] ??= { claude: 0, other: 0, pools: {}, unmeasured: 0 };
const weighted = (u = {}) => (+u.input_tokens || 0) + (+u.cache_read_input_tokens || +u.cache_read_tokens || 0) * .1 + (+u.cache_creation_input_tokens || 0) * 1.25 + (+u.output_tokens || 0) * 5 + (+u.thinking_tokens || 0) * 5;
function walk(dir, seen, files) {
  let real; try { real = fs.realpathSync(dir); } catch { return; }
  if (seen.has(real)) return; seen.add(real);
  let entries; try { entries = fs.readdirSync(real, { withFileTypes: true }); } catch { return; }
  for (const e of entries) { const p = path.join(real, e.name); if (e.isDirectory()) walk(p, seen, files); else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p); }
}
function claudeUsage(days) {
  const map = {};
  const roots = [path.join(os.homedir(), '.claude/projects'), path.join(HOME, 'claude-free/projects')];
  const seenDirs = new Set(), seenIds = new Set(), files = [];
  roots.forEach((r) => walk(r, seenDirs, files));
  for (const file of files) { let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) { try { const row = JSON.parse(line), m = row.message; if (row.type !== 'assistant' || !m?.usage) continue; if (m.id && seenIds.has(m.id)) continue; if (m.id) seenIds.add(m.id); const d = dayKey(row.timestamp); if (!days.includes(d)) continue; bucket(map,d).claude += weighted(m.usage); } catch { /* partial JSONL line */ } }
  }
  return map;
}
const copilot = /Tokens\s+↑\s+([\d.,]+)([kmb]?)\s+\(([\d.,]+)([kmb]?) cached,\s*([\d.,]+)([kmb]?) written\)\s*•\s*↓\s*([\d.,]+)([kmb]?)(?:\s*\(([\d.,]+)([kmb]?) reasoning\))?/i;
function amount(n,u='') { const x=Number(String(n).replace(/,/g,''))||0; return x*({k:1e3,m:1e6,b:1e9}[u.toLowerCase()]||1); }
function logs(map, days) {
 let files=[]; try { files=fs.readdirSync(RUNS).filter(x=>x.endsWith('.log')); } catch {}
 for(const f of files){ const m=f.match(/^(\d{4}-\d\d-\d\d)[T_].*?(?:-|\+)(agy|codex|copilot)(?:\+[^.]*)?\.log$/); if(!m||!days.includes(m[1]))continue; const via=m[2], text=fs.readFileSync(path.join(RUNS,f),'utf8'); let value=0, found=false;
  if(via==='agy'){ for(const line of text.split('\n'))try{const x=JSON.parse(line);if(x.event==='result'&&x.usage){value+=weighted({input_tokens:x.usage.input_tokens,output_tokens:x.usage.output_tokens,thinking_tokens:x.usage.thinking_tokens,cache_read_tokens:x.usage.cache_read_tokens});found=true;}}catch{} }
  if(via==='copilot'){const x=text.match(copilot);if(x){value=amount(x[1],x[2])+amount(x[3],x[4])*.1+amount(x[5],x[6])*1.25+amount(x[7],x[8])*5+amount(x[9]||0,x[10])*5;found=true;}}
  if(via==='codex'){const x=text.match(/tokens used\s*([\d,]+)/i);if(x){value=Number(x[1].replace(/,/g,''));found=true;}}
  const b=bucket(map,m[1]); if(!found)b.unmeasured++; b.other+=value; if(found)b.pools[via]=(b.pools[via]||0)+value;
 }
}
function freeUsageScript() { return `const D=require('/app/node_modules/better-sqlite3');const db=new D('/app/server/data/freeapi.db',{readonly:true});const cols=db.prepare('pragma table_info(requests)').all().map(x=>x.name);const out={rows:[],measurable:false};const date=cols.includes('created_at')?'created_at':null;const type=cols.includes('request_type')?'request_type':null;const ins=cols.find(x=>/input_tokens/i.test(x));const outs=cols.find(x=>/output_tokens/i.test(x));if(date&&ins&&outs){out.measurable=true;const q='select substr('+date+',1,10) day, sum('+ins+') input_tokens, sum('+outs+') output_tokens from requests '+(type?'where '+type+" != 'embedding' ":'')+'group by day';out.rows=db.prepare(q).all()}process.stdout.write(JSON.stringify(out));`; }
function freeUsage(map, days) { const script=freeUsageScript(); const r=REMOTE?spawnSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',REMOTE.ssh,`docker exec -i $(${FREE_CONTAINER_SH}) node -`],{input:script,encoding:'utf8',timeout:40000}):spawnSync('sh',['-c',`docker exec -i $(${FREE_CONTAINER_SH}) node -`],{input:script,encoding:'utf8',timeout:40000}); try{const x=JSON.parse(r.stdout);if(!x.measurable)throw Error('schema');const hf=path.join(HOME,'savings-history.json');let hist={};try{hist=JSON.parse(fs.readFileSync(hf,'utf8'))}catch{}for(const row of x.rows){const v0=+row.input_tokens+5*(+row.output_tokens);if(!hist[row.day]||hist[row.day]<v0)hist[row.day]=v0;}try{fs.writeFileSync(hf,JSON.stringify(hist))}catch{}x.rows=Object.entries(hist).map(([day,v])=>({day,input_tokens:v,output_tokens:0}));for(const row of x.rows){const d=dayKey(row.day);if(!days.includes(d))continue;const v=+row.input_tokens+5*(+row.output_tokens);bucket(map,d).other+=v;bucket(map,d).pools.free=(bucket(map,d).pools.free||0)+v;}}catch{for(const d of days)bucket(map,d).unmeasured++;} }
export async function report(args=[]) { let n=14; for(let i=0;i<args.length;i++){if(args[i]==='--days')n=Math.max(1,Math.min(365,Number(args[++i])||14));} const today=new Date(), days=Array.from({length:n},(_,i)=>{const d=new Date(today);d.setUTCDate(d.getUTCDate()-(n-1-i));return d.toISOString().slice(0,10)}); const map=claudeUsage(days);logs(map,days);freeUsage(map,days); const rows=days.map(d=>({day:d,...bucket(map,d)})); const totals=rows.reduce((a,r)=>({claude:a.claude+r.claude,other:a.other+r.other,unmeasured:a.unmeasured+r.unmeasured}),{claude:0,other:0,unmeasured:0}); const pct=totals.claude+totals.other?Math.round(totals.other/(totals.claude+totals.other)*100):0; const result={days:n,rows,totals:{...totals,outsidePercent:pct},claudeWithoutOtherWouldBe:Math.round(totals.claude+totals.other),weights:{cacheRead:.1,cacheWrite:1.25,outputAndThinking:5,input:1},note:lang==='tr'?'Girdi eşdeğeri token; oranlar Anthropic fiyat oranlarıdır, abonelik limitinin tam ölçüsü değildir.':'Input-equivalent tokens; Anthropic price ratios, not an exact measure of subscription limits.'};
 if(args.includes('--json')){if(!args.includes('--silent'))console.log(JSON.stringify(result,null,2)); await push(result); return result;} console.log(title(t('Claude vs diğer kotalar'))); console.log(`${t('Gün').padEnd(12)} ${'Claude'.padStart(12)} ${t('Diğer kotalar').padStart(42)} ${t('Dışarıda').padStart(10)}`); const breakdown=(r)=>Object.entries(r.pools).map(([k,v])=>`${k}:${Math.round(v).toLocaleString()}`).join(' ')||'-'; for(const r of rows){const sum=r.claude+r.other; console.log(`${r.day} ${Math.round(r.claude).toLocaleString().padStart(12)} ${`${Math.round(r.other).toLocaleString()} (${breakdown(r)})`.padStart(42)} ${`${sum?Math.round(r.other/sum*100):0}%`.padStart(10)}${r.unmeasured?` · ${r.unmeasured} ${t('ölçülemedi')}`:''}`);} console.log(`${t('TOPLAM').padEnd(12)} ${Math.round(totals.claude).toLocaleString().padStart(12)} ${Math.round(totals.other).toLocaleString().padStart(42)} ${`${pct}%`.padStart(10)}`); console.log(t('ekip olmasa bu işin hepsi Claude’da olurdu: {n}',{n:Math.round(totals.claude+totals.other).toLocaleString()})); console.log(result.note); await push(result); return result; }
export async function push(snapshot) { if(!SETTINGS.hubUrl||!SETTINGS.hubToken)return; await fetch(`${SETTINGS.hubUrl}/api/savings`,{method:'PUT',headers:{'content-type':'application/json',authorization:`Bearer ${SETTINGS.hubToken}`},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(8000)}).catch(()=>{}); }
