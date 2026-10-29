// Per-project development databases on the explicitly configured Coolify dev resources.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { HOME, SETTINGS, die, saveSettings } from "../core/core.js";
import { findProject, getProject, listProjects } from "../projects/projects.js";

// Which container is the shared dev Postgres, its superuser and the VPS file with per-project
// passwords all come from data/config.json ("dev"), set once with `ekip dev init`.
const PG_UUID = () => SETTINGS.dev?.postgresUuid ?? die("dev Postgres tanımlı değil: ekip dev init --postgres <coolify-uuid> [--superuser NAME] [--secrets /root/.devpg]");
const SUPER = () => SETTINGS.dev?.superuser ?? "postgres";
const SECRETS = () => SETTINGS.dev?.secretsFile ?? "/root/.devpg";
const SSH = () => SETTINGS.vps?.ssh ?? SETTINGS.remote?.ssh ?? die("VPS SSH ayarlı değil (ekip vps add ...)");
const DEV_DIR = HOME;
const PIDFILE = path.join(DEV_DIR, "dev-tunnel.pid");
const LOGFILE = path.join(DEV_DIR, "dev-tunnel.log");
const PORTS = () => ({ postgres: Number(SETTINGS.dev?.ports?.postgres ?? 55432), redis: Number(SETTINGS.dev?.ports?.redis ?? 56379) });
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
function remote(command, { allowFailure = false } = {}) {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", SSH(), command], { encoding: "utf8" });
  if (r.status !== 0 && !allowFailure) throw new Error(r.stderr.trim() || `SSH failed (${r.status})`);
  return r.stdout.trim();
}
export function guard({ uuid, db }) {
  if (uuid !== PG_UUID() && uuid !== SETTINGS.dev?.redisUuid) throw new Error(`Güvenlik: izin verilmeyen container UUID: ${uuid}`);
  if (db !== undefined && !/^[a-z0-9_]+_dev$/.test(db)) throw new Error(`Güvenlik: veritabanı adı _dev ile bitmeli: ${db}`);
  if (uuid === SETTINGS.dev?.redisUuid && db !== undefined) throw new Error("Güvenlik: Redis hedefinde DB adı kullanılamaz");
}
function projects() { return SETTINGS.dev?.projects ?? {}; }
function persistDev(dev) { saveSettings({ dev }); }
function entry(name) { const x = projects()[name]; if (!x) die(`proje için dev veritabanı yok: ${name} (ekip dev add ${name})`); return x; }
function projectInfo(name) {
  const p = name ? getProject(name) : findProject(process.cwd());
  if (!p) die("proje bulunamadı; proje adı verin veya önce ekip project add ile kaydedin");
  return p;
}
function randomPassword() { return crypto.randomBytes(24).toString("base64url"); }
function shellEscapeSql(s) { return `'${String(s).replaceAll("'", "''")}'`; }
function pg(sql, db = "postgres") {
  guard({ uuid: PG_UUID(), ...(db === "postgres" ? {} : { db }) });
  return remote(`docker exec -i ${quote(PG_UUID())} psql -U ${quote(SUPER())} -d ${quote(db)} -v ON_ERROR_STOP=1 -Atqc ${quote(sql)}`);
}
function pgFile() { return remote(`cat ${quote(SECRETS())}`); }
function varsFor(name) {
  const map = entry(name), env = Object.fromEntries(pgFile().split(/\r?\n/).filter((x) => x.includes("=")).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
  const key = map.db.replace(/_dev$/, "");
  const user = env[`PG_${key}_USER`] ?? map.db;
  const password = env[`PG_${key}_PASSWORD`];
  if (!password) die(`VPS ${SECRETS()} içinde PG_${key}_PASSWORD yok`);
  return { DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${PORTS().postgres}/${map.db}`, PGHOST: "127.0.0.1", PGPORT: String(PORTS().postgres), PGDATABASE: map.db, PGUSER: user, PGPASSWORD: password, REDIS_URL: SETTINGS.dev?.redisUuid && SETTINGS.dev?.redisPassword ? `redis://:${encodeURIComponent(SETTINGS.dev.redisPassword)}@127.0.0.1:${PORTS().redis}/${map.redisDb}` : undefined };
}
async function ensureRedis() {
  if (SETTINGS.dev?.redisUuid) return true;
  if (!SETTINGS.vps?.token || !SETTINGS.vps?.coolifyUrl) { console.log("Redis dev kurulmadı; önce ekip vps token çalıştırın, sonra ekip dev up komutunu tekrarlayın. Postgres kullanılabilir."); return false; }
  const base = SETTINGS.vps.coolifyUrl.replace(/\/$/, ""), headers = { authorization: `Bearer ${SETTINGS.vps.token}`, "content-type": "application/json", accept: "application/json" };
  const api = async (p, init) => { const r=await fetch(`${base}/api/v1${p}`,{...init,headers:{...headers,...init?.headers},signal:AbortSignal.timeout(30000)});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`Coolify ${p}: HTTP ${r.status} ${body.message??""}`);return body; };
  const [ps, ss] = await Promise.all([api("/projects"), api("/servers")]);
  const project = ps.find((x)=>x.name==="platform"); if(!project) throw new Error("Coolify projesi platform bulunamadı");
  const server = ss.find((x)=>x.ip==="localhost"||x.name==="localhost") ?? ss[0]; if(!server) throw new Error("Coolify sunucusu bulunamadı");
  const password = randomPassword();
  const created=await api("/databases/redis",{method:"POST",body:JSON.stringify({server_uuid:server.uuid,project_uuid:project.uuid,environment_name:"production",name:"redis-dev",image:"redis:7-alpine",is_public:false,redis_password:password,limits_memory:"256M",instant_deploy:true})});
  const uuid=created.uuid??created.database?.uuid; if(!uuid) throw new Error("Coolify Redis yanıtında resource UUID yok; Redis oluşturulduysa ekip vps apps ile kontrol edin");
  persistDev({...SETTINGS.dev,postgresUuid:PG_UUID(),redisUuid:uuid,redisPassword:password,projects:projects()});
  return true;
}
function isTunnelUp() {
  try { const pid = Number(fs.readFileSync(PIDFILE, "utf8")); process.kill(pid, 0); return true; } catch { return false; }
}
function tunnelUp() {
  const ports = PORTS();
  const inspect = (uuid, port) => {
    guard({ uuid });
    const state = remote(`docker inspect -f '{{.State.Status}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${quote(uuid)}`);
    const [status, ip] = state.split(/\s+/);
    if (status !== "running") throw new Error(`${uuid} çalışmıyor (${status})`);
    return `${ip}:${port}`;
  };
  const pgAddr = inspect(PG_UUID(), 5432);
  const redisUuid = SETTINGS.dev?.redisUuid;
  const args = ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${ports.postgres}:${pgAddr}`];
  if (redisUuid) args.push("-L", `127.0.0.1:${ports.redis}:${inspect(redisUuid, 6379)}`);
  args.push(SSH());
  fs.mkdirSync(DEV_DIR, { recursive: true });
  const out = fs.openSync(LOGFILE, "a");
  const child = spawn("ssh", args, { detached: true, stdio: ["ignore", out, out] });
  child.unref(); fs.writeFileSync(PIDFILE, `${child.pid}\n`);
  return { pid: child.pid, ports };
}
function stopTunnel() {
  try { process.kill(Number(fs.readFileSync(PIDFILE, "utf8")), "SIGTERM"); } catch {}
  fs.rmSync(PIDFILE, { force: true });
}
function writeEnv(p, name) {
  const env = varsFor(name), file = path.join(p.path, ".env.ekip-dev");
  fs.writeFileSync(file, Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  const ignore = path.join(p.path, ".gitignore");
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  if (!current.split(/\r?\n/).includes(".env.ekip-dev")) fs.appendFileSync(ignore, `${current && !current.endsWith("\n") ? "\n" : ""}.env.ekip-dev\n`);
  return file;
}
function resolveName(s) { const n = s ?? projectInfo().name; if (!projects()[n]) die(`proje için dev eşlemesi yok: ${n}`); return n; }

export function devEnv(project, { onVps = false } = {}) {
  const map = entry(project);
  if (!onVps) return varsFor(project);
  const env = Object.fromEntries(pgFile().split(/\r?\n/).filter((x) => x.includes("=")).map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]));
  const key = map.db.replace(/_dev$/, ""), user = env[`PG_${key}_USER`] ?? map.db, password = env[`PG_${key}_PASSWORD`];
  // On the server the container name is the address: it resolves on the shared docker network and,
  // unlike an IP, survives restarts.
  const pgHost = PG_UUID();
  const out = { DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${pgHost}:5432/${map.db}`, PGHOST: pgHost, PGPORT: "5432", PGDATABASE: map.db, PGUSER: user, PGPASSWORD: password };
  if (SETTINGS.dev.redisUuid) out.REDIS_URL = `redis://:${encodeURIComponent(SETTINGS.dev.redisPassword)}@${SETTINGS.dev.redisUuid}:6379/${map.redisDb}`;
  return out;
}

export async function main([sub = "ls", ...args]) {
  try {
    if (sub === "init") {
      const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
      const uuid = opt("--postgres") ?? die("kullanım: ekip dev init --postgres <coolify-uuid> [--superuser NAME] [--secrets DOSYA] [--redis <uuid>]");
      persistDev({ ...SETTINGS.dev, postgresUuid: uuid, superuser: opt("--superuser") ?? SETTINGS.dev?.superuser, secretsFile: opt("--secrets") ?? SETTINGS.dev?.secretsFile,
        ...(opt("--redis") ? { redisUuid: opt("--redis") } : {}), projects: projects() });
      console.log(`dev Postgres: ${uuid}`);
      return 0;
    }
    if (sub === "ls") {
      for (const [name, map] of Object.entries(projects())) {
        guard({ uuid: PG_UUID(), db: map.db });
        let exists = false, size = "-";
        try { exists = pg(`select 1 from pg_database where datname=${shellEscapeSql(map.db)}`) === "1"; if (exists) size = pg(`select pg_size_pretty(pg_database_size(${shellEscapeSql(map.db)}))`); } catch {}
        let status = "?"; try { status = remote(`docker inspect -f '{{.State.Status}}' ${quote(PG_UUID())}`); } catch {}
        console.log(`${name.padEnd(20)} ${map.db} ${exists ? size : "yok"} redis:${map.redisDb ?? "-"} container:${status} tünel:${isTunnelUp() ? PORTS().postgres : "kapalı"}`);
      }
    } else if (sub === "add") {
      const name = args[0]; if (!name) die("kullanım: ekip dev add PROJE [--db NAME]");
      let db = null; for (let i=1;i<args.length;i++) if (args[i] === "--db") db = args[++i];
      db ??= `${name.replace(/[^a-z0-9_]/g, "_")}_dev`; guard({ uuid: PG_UUID(), db });
      const user = db, password = randomPassword();
      // Escaping and identifier validation above keep this confined to the dev cluster.
      const exists = pg(`select 1 from pg_database where datname=${shellEscapeSql(db)}`) === "1";
      const oldPassword = (() => { try { return Object.fromEntries(pgFile().split(/\r?\n/).filter((x) => x.includes("=")).map((x) => [x.slice(0,x.indexOf("=")),x.slice(x.indexOf("=")+1)]))[`PG_${db.replace(/_dev$/, "")}_PASSWORD`]; } catch { return null; } })();
      const savedPassword = oldPassword ?? password;
      const roleExists = pg(`select 1 from pg_roles where rolname=${shellEscapeSql(user)}`) === "1";
      if (!roleExists) pg(`create role ${user} login password ${shellEscapeSql(savedPassword)}`);
      if (!exists) pg(`create database ${db} owner ${user}`);
      pg(`revoke connect on database ${db} from public`, db);
      remote(`printf '%s\\n' ${quote(`PG_${db.replace(/_dev$/, "")}_USER=${user}\nPG_${db.replace(/_dev$/, "")}_PASSWORD=${savedPassword}`)} >> ${quote(SECRETS())} && chmod 600 ${quote(SECRETS())}`);
      const redisDb = projects()[name]?.redisDb ?? (Array.from({length:15},(_,i)=>i+1).find((i)=>!Object.values(projects()).some((p)=>p.redisDb===i)) ?? die("boş Redis DB indeksi kalmadı (1..15)"));
      const next = { ...SETTINGS.dev, postgresUuid: PG_UUID(), projects: { ...projects(), [name]: { db, redisDb } } }; persistDev(next);
      ensureRedis(); console.log(`${name} → ${db} (redis DB ${redisDb})`);
    } else if (sub === "up") {
      const name = resolveName(args.find((x)=>!x.startsWith("-"))); const p = projectInfo(name); entry(name);
      remote(`docker inspect -f '{{.State.Status}}' ${quote(PG_UUID())}`).trim() !== "running" && remote(`docker start ${quote(PG_UUID())}`);
      let redis = await ensureRedis();
      if (SETTINGS.dev?.redisUuid) remote(`docker inspect -f '{{.State.Status}}' ${quote(SETTINGS.dev.redisUuid)}`).trim() !== "running" && remote(`docker start ${quote(SETTINGS.dev.redisUuid)}`);
      if (!isTunnelUp()) tunnelUp();
      console.log(`Dev ortamı hazır: ${writeEnv(p, name)}`); if (!redis) console.log("Postgres hazır; Redis token bekliyor.");
    } else if (sub === "env") {
      const show = args.includes("--show"), shell = args.includes("--shell"), name = resolveName(args.find((x)=>!x.startsWith("--")));
      const env = varsFor(name);
      for (const [k,v] of Object.entries(env)) if (v !== undefined) console.log(shell ? `export ${k}=${quote(v)}` : `${k}=${show ? v : k.toLowerCase().includes("password") ? "********" : k.endsWith("_URL") ? v.replace(/:[^:@/]+@/, ":********@") : v}`);
    } else if (sub === "down") {
      const all = args.includes("--all"), name = args.find((x)=>!x.startsWith("--"));
      if (all || !name) stopTunnel();
      if (args.includes("--stop")) { remote(`docker stop ${quote(PG_UUID())}`, { allowFailure: true }); if (SETTINGS.dev?.redisUuid) remote(`docker stop ${quote(SETTINGS.dev.redisUuid)}`, { allowFailure: true }); }
      console.log("Dev tüneli kapatıldı" + (args.includes("--stop") ? "; dev container'ları durduruldu" : ""));
    } else if (sub === "reset") {
      const name=args[0]; if (!name || !args.includes("--yes")) die("kullanım: ekip dev reset PROJE --yes"); const db=entry(name).db; guard({uuid:PG_UUID(),db});
      pg(`drop database if exists ${db} with (force)`); pg(`create database ${db} owner ${db}`); pg(`revoke connect on database ${db} from public`, db); console.log(`${db} sıfırlandı`);
    } else if (sub === "sql" || sub === "psql") {
      const name=resolveName(args[0]); const db=entry(name).db; guard({uuid:PG_UUID(),db}); const env=varsFor(name);
      if (sub === "sql") {
        const query=args.slice(1).join(" "); if(!query) die('kullanım: ekip dev sql PROJE "sorgu"');
        const role=env.PGUSER.replaceAll('"','""');
        const result=remote(`docker exec -i ${quote(PG_UUID())} psql -U ${quote(SUPER())} -d ${quote(db)} -v ON_ERROR_STOP=1 -Atqc ${quote(`set role "${role}"; ${query}`)}`);
        console.log(result);
      } else {
        const r=spawnSync("ssh",["-o","BatchMode=yes",SSH(),`docker exec -it ${quote(PG_UUID())} psql -U ${quote(SUPER())} -d ${quote(db)}`],{stdio:"inherit"});
        if(r.status)process.exitCode=r.status;
      }
    } else die("kullanım: ekip dev ls|add|up|env|down|reset|sql|psql");
  } catch (e) { die(e.message); }
}
