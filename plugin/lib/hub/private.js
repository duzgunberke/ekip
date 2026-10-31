// `ekip hub private`: the VPS hub reachable only from the user's own devices, through Tailscale. The
// Mac and the VPS join the user's tailnet, `tailscale serve` puts the hub (127.0.0.1:<port> on the
// VPS) on https://<name>.<tailnet>.ts.net with a real certificate (the panel's Secure cookie and
// passkeys need HTTPS), the Mac's
// hubUrl switches to it (the token stays), and the hub's public route (a Traefik dynamic file, a
// Coolify domain) is shown, backed up and removed after a yes. No domain, DNS record or open port.
//
//   ekip hub private [--ssh HOST] [--hostname ekip-hub] [--port 7777] [--yes] [--keep-route]
//   ekip hub private status
//   ekip hub private off          serve off, the backed up route back, hubUrl back to the public URL
//
// Every step goes through `io` (run, ssh, open, ask, fetch, sleep, save): the tests drive the whole
// flow with a fake one and no network.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { REMOTE, SETTINGS, ask, has, openUrl, saveSettings, sleep } from "../core/core.js";
import { t } from "../core/i18n.js";

export const MAC_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const DEFAULT_HOSTNAME = "ekip-hub";
export const DEFAULT_PORT = 7777;
const UP_LOG = "/tmp/ekip-tailscale-up.log";
const SERVE_LOG = "/tmp/ekip-tailscale-serve.log";
const BACKUP_DIR = "$HOME/ekip-route-backup";
// where a reverse proxy in front of the hub keeps its routes: Coolify's Traefik, a plain Traefik,
// nginx, Caddy (only Traefik dynamic files are removed by ekip, the others are shown)
const ROUTE_DIRS = ["/data/coolify/proxy/dynamic", "/etc/traefik", "/etc/nginx/sites-enabled", "/etc/nginx/conf.d", "/etc/caddy"];

// ---- parsing (pure) -------------------------------------------------------------------------------

/** The login link `tailscale up` prints for a new node, or null. */
export const parseLoginUrl = (text) => String(text ?? "").match(/https:\/\/login\.tailscale\.com\/a\/[\w-]+/)?.[0] ?? null;

/** "Serve is not enabled on your tailnet. To enable, visit: <url>" (also HTTPS/Funnel): the url, or null. */
export function parseServeEnableUrl(text) {
  const s = String(text ?? "");
  if (!/not enabled on your tailnet|To enable, visit/i.test(s)) return null;
  return s.match(/To enable, visit:?\s*(https:\/\/\S+)/i)?.[1] ?? s.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0] ?? null;
}

/** `tailscale status --json` → { state, online, dnsName, ip } (dnsName without the trailing dot). */
export function parseStatus(json) {
  let s;
  try { s = typeof json === "string" ? JSON.parse(json) : json; } catch { return { state: null, online: false, dnsName: null, ip: null }; }
  const self = s?.Self ?? {};
  return { state: s?.BackendState ?? null, online: s?.BackendState === "Running", dnsName: parseDnsName(s), ip: self.TailscaleIPs?.[0] ?? null };
}

export const parseDnsName = (s) => String(s?.Self?.DNSName ?? "").replace(/\.$/, "") || null;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** A host only reachable from this machine, a private network or the tailnet. */
export function isPrivateHost(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h === "::1" || /\.(localhost|local|internal|lan|home\.arpa|ts\.net)$/.test(h) || /^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;
  if (!h.includes(".")) return true; // a bare name (an ssh alias, a LAN host) has no public DNS
  const m = h.match(IPV4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/** The hub is linked at a public address and private mode is not set: the setup gap. */
export function hubExposed(s = SETTINGS) {
  if (!s?.hubUrl || s.hubLocal || s.hubPrivate?.url) return false;
  try { return !isPrivateHost(new URL(s.hubUrl).hostname); } catch { return false; }
}

/** The settings after the switch: hubUrl on the tailnet, the token kept, the old URL remembered. */
export function privateSettings(s, { url, ssh, hostname, port, route = null }) {
  const publicUrl = s.hubPrivate?.publicUrl ?? (s.hubUrl && s.hubUrl !== url ? s.hubUrl : null);
  return { hubUrl: url, hubToken: s.hubToken, hubLocal: false, hubPrivate: { url, ssh, hostname, port, publicUrl, route, at: new Date().toISOString() } };
}

/** The hosts a Traefik rule file routes: Host(`a`) and Host(`a`,`b`). */
export function routeHosts(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/Host(?:SNI)?\(([^)]*)\)/g)) for (const h of m[1].matchAll(/`([^`]+)`/g)) out.add(h[1].toLowerCase());
  return [...out];
}

/**
 * The route probe's output → [{ kind, path?, name?, removable, hosts }]. A Traefik dynamic file that
 * routes only this host is removable (Traefik watches the folder: moving the file out drops the route);
 * a file with other hosts, an nginx or Caddy file, or a Coolify app domain is shown for the user.
 */
export function parseRoutes(out, host) {
  const routes = [];
  for (const block of String(out ?? "").split(/^=== /m).slice(1)) {
    const nl = block.indexOf("\n");
    const head = (nl < 0 ? block : block.slice(0, nl)).trim(), body = nl < 0 ? "" : block.slice(nl + 1);
    if (head.startsWith("container ")) { routes.push({ kind: "coolify", name: head.slice(10).trim(), removable: false, hosts: [host] }); continue; }
    if (!head.startsWith("file ")) continue;
    const file = head.slice(5).trim();
    const traefik = /traefik|coolify\/proxy/.test(file) && /\.(ya?ml|toml)$/.test(file);
    const hosts = traefik ? routeHosts(body) : [host];
    routes.push({ kind: traefik ? "traefik" : /caddy/i.test(file) ? "caddy" : /nginx/.test(file) ? "nginx" : "file", path: file, removable: traefik && hosts.length > 0 && hosts.every((h) => h === host), hosts, text: body.trim() });
  }
  return routes;
}

// ---- io -------------------------------------------------------------------------------------------

const result = (r) => ({ status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" });

export function realIo() {
  return {
    run: (cmd, args, o = {}) => result(spawnSync(cmd, args, { encoding: "utf8", timeout: o.timeout ?? 20_000, stdio: o.inherit ? "inherit" : ["ignore", "pipe", "pipe"] })),
    ssh: (host, cmd, o = {}) => result(spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, cmd], { encoding: "utf8", timeout: o.timeout ?? 60_000, stdio: ["ignore", "pipe", "pipe"] })),
    exists: (f) => fs.existsSync(f), has, open: openUrl, ask, sleep, log: console.log,
    fetch: (url, init) => fetch(url, init), settings: SETTINGS, save: saveSettings,
    tty: !!(process.stdin.isTTY && process.stdout.isTTY), platform: process.platform,
  };
}

// the VPS shell: root or passwordless sudo
const vsh = (cmd) => `SU=; [ "$(id -u)" = 0 ] || SU="sudo -n"; ${cmd}`;
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

async function waitFor(io, fn, { timeoutMs, everyMs = 3000 }) {
  const until = Date.now() + timeoutMs;
  for (let i = 0; ; i++) {
    const v = await fn(i);
    if (v) return v;
    if (Date.now() > until) return null;
    await io.sleep(everyMs);
  }
}

// ---- the Mac --------------------------------------------------------------------------------------

/** The Mac's tailscale CLI: the app's binary, or `tailscale` on PATH; null when not installed. */
export const macCli = (io) => (io.exists(MAC_CLI) ? MAC_CLI : io.has("tailscale") ? "tailscale" : null);
export const macStatus = (io, cli = macCli(io)) => (cli ? parseStatus(io.run(cli, ["status", "--json"], { timeout: 8000 }).stdout) : { state: null, online: false, dnsName: null });

async function macInstall(io) {
  if (!io.has("brew")) {
    io.log(`  ${t("Tailscale kurulu değil; indirme sayfası açılıyor. Kurun, uygulamada oturum açın, sonra tekrar çalıştırın.")}`);
    io.open("https://tailscale.com/download/mac");
    return false;
  }
  if (io.tty) {
    io.log(`  ${t("Tailscale kuruluyor (brew install --cask tailscale-app; macOS parolanızı sorabilir)…")}`);
    if (io.run("brew", ["install", "--cask", "tailscale-app"], { inherit: true, timeout: 900_000 }).status !== 0) return false;
  } else {
    // no terminal for sudo: fetch the package and let macOS's installer ask for the password
    io.log(`  ${t("Tailscale indiriliyor; kurulum penceresi açılınca parolanızı girin.")}`);
    if (io.run("brew", ["fetch", "--cask", "tailscale-app"], { timeout: 900_000 }).status !== 0) return false;
    const pkg = io.run("brew", ["--cache", "--cask", "tailscale-app"]).stdout.trim();
    if (!pkg) return false;
    io.open(pkg);
  }
  return true;
}

/** Tailscale installed, running and signed in on the Mac; waits for the user while they sign in. */
export async function ensureMac(io, { timeoutMs = 15 * 60_000 } = {}) {
  let cli = macCli(io);
  if (!cli && !(await macInstall(io))) return null;
  if (!macStatus(io, cli ?? undefined).online) {
    io.run("open", ["-a", "Tailscale"]);
    io.log(`  ${t("Tailscale uygulamasında oturum açın (menü çubuğu simgesi → Log in); bekleniyor…")}`);
  }
  const st = await waitFor(io, () => { cli = macCli(io); const s = macStatus(io, cli); return s.online ? s : null; }, { timeoutMs, everyMs: 5000 });
  if (st) io.log(`  ✓ Mac: ${st.dnsName ?? "tailnet"}`);
  return st;
}

// ---- the VPS --------------------------------------------------------------------------------------

export const vpsStatus = (io, host) => parseStatus(io.ssh(host, vsh("$SU tailscale status --json 2>/dev/null"), { timeout: 20_000 }).stdout);

/** Tailscale installed and the VPS in the tailnet as `hostname`; the login link opens on the Mac. */
export async function ensureVps(io, host, { hostname = DEFAULT_HOSTNAME, timeoutMs = 15 * 60_000 } = {}) {
  if (io.ssh(host, "command -v tailscale", { timeout: 20_000 }).status !== 0) {
    io.log(`  ${t("VPS'e Tailscale kuruluyor (resmi kurulum betiği)…")}`);
    const r = io.ssh(host, vsh("curl -fsSL https://tailscale.com/install.sh | $SU sh"), { timeout: 600_000 });
    if (r.status !== 0) { io.log(`  ✗ ${t("Tailscale VPS'e kurulamadı")}: ${(r.stderr || r.stdout).trim().split("\n").pop()}`); return null; }
  }
  let st = vpsStatus(io, host);
  if (st.online) { io.log(`  ✓ VPS: ${st.dnsName}`); return st; }
  // `tailscale up` waits until the node is signed in: it runs in the background under a time limit
  // and its log gives the login link
  io.ssh(host, vsh(`$SU nohup timeout 900 tailscale up --hostname=${hostname} > ${UP_LOG} 2>&1 < /dev/null & sleep 3; cat ${UP_LOG}`), { timeout: 30_000 });
  const url = await waitFor(io, () => parseLoginUrl(io.ssh(host, `cat ${UP_LOG} 2>/dev/null`, { timeout: 15_000 }).stdout) ?? (vpsStatus(io, host).online ? "online" : null), { timeoutMs: 60_000, everyMs: 2000 });
  if (url && url !== "online") {
    io.log(`  ${t("VPS'i tailnet'e eklemek için bu bağlantıyı açın (tarayıcıda açılıyor)")}: ${url}`);
    io.open(url);
  }
  st = await waitFor(io, () => { const s = vpsStatus(io, host); return s.online ? s : null; }, { timeoutMs, everyMs: 5000 });
  if (st) io.log(`  ✓ VPS: ${st.dnsName}`);
  else io.log(`  ✗ ${t("VPS tailnet'e katılmadı")} (${UP_LOG})`);
  return st;
}

/**
 * `tailscale serve --bg --https=443 http://127.0.0.1:<port>`. When Serve is off on the tailnet the
 * command prints an enable link and blocks: it runs under `timeout` into a log, the link opens for
 * the user, and it is retried until it goes through. (Never `pkill -f "tailscale serve"` over ssh:
 * the ssh shell's own command line matches and dies.)
 */
export async function serve(io, host, port, { timeoutMs = 15 * 60_000 } = {}) {
  let opened = null, errors = 0;
  const ok = await waitFor(io, () => {
    if (errors >= 3) return "fail"; // a real error, not the enable page: no point waiting
    const r = io.ssh(host, vsh(`$SU timeout 20 tailscale serve --bg --https=443 http://127.0.0.1:${port} > ${SERVE_LOG} 2>&1 < /dev/null; echo "exit=$?"; cat ${SERVE_LOG}`), { timeout: 45_000 });
    const exit = Number(r.stdout.match(/exit=(\d+)/)?.[1] ?? r.status);
    const url = parseServeEnableUrl(r.stdout);
    if (url) {
      if (url !== opened) { io.log(`  ${t("Tailnet'te Serve (HTTPS) kapalı; açmak için bu sayfa açılıyor")}: ${url}`); io.open(url); opened = url; }
      return null;
    }
    if (exit === 0) return true;
    errors++;
    io.log(`  ! tailscale serve: ${r.stdout.replace(/exit=\d+\s*/, "").trim().split("\n").pop()}`);
    return null;
  }, { timeoutMs, everyMs: 10_000 });
  return ok === true;
}

// ---- the old public route -------------------------------------------------------------------------

const HOST_RE = /^[a-z0-9.-]+$/i;
const PATH_RE = /^[\w./@:+-]+$/;

export function routeProbe(host) {
  if (!HOST_RE.test(host)) throw new Error(`bad host ${host}`);
  return `for d in ${ROUTE_DIRS.join(" ")}; do [ -d "$d" ] && grep -rlsF -- ${q(host)} "$d"; done 2>/dev/null | sort -u | while read -r f; do echo "=== file $f"; head -c 4000 "$f"; echo; done; `
    + `docker ps --format '{{.Names}}\t{{.Labels}}' 2>/dev/null | grep -F -- ${q(host)} | cut -f1 | while read -r n; do echo "=== container $n"; done`;
}

/** Shows the hub's public route, backs it up and removes it after a yes; returns the backup record. */
export async function removeRoute(io, sshHost, publicUrl, { yes = false } = {}) {
  let host;
  try { host = new URL(publicUrl).hostname; } catch { return null; }
  if (!HOST_RE.test(host)) return null;
  const routes = parseRoutes(io.ssh(sshHost, vsh(routeProbe(host)), { timeout: 30_000 }).stdout, host);
  const removed = [];
  if (!routes.length) io.log(`  ${t("VPS'te {host} için bir yönlendirme bulunamadı (Traefik, nginx, Caddy, Coolify); varsa elle kaldırın.", { host })}`);
  for (const r of routes) {
    if (r.kind === "coolify") { io.log(`  • Coolify: ${r.name} → ${host}. ${t("Bu alan adını Coolify'da uygulamanın Domains alanından silin.")}`); continue; }
    io.log(`  • ${r.kind}: ${r.path}${r.hosts.length > 1 ? ` (${r.hosts.join(", ")})` : ""}`);
    if (r.text) io.log(r.text.split("\n").slice(0, 20).map((l) => `      ${l}`).join("\n"));
    if (!r.removable) { io.log(`    ${t("başka adresler de var ya da Traefik dosyası değil; ekip dokunmuyor, {host} kısmını elle kaldırın", { host })}`); continue; }
    if (!PATH_RE.test(r.path)) continue;
    let go = yes;
    if (!go && io.tty) go = /^(e|evet|y|yes)$/i.test((await io.ask(`    ${t("Bu dosya yedeklenip kaldırılsın mı? [e/H]")} `)).trim());
    if (!go) { io.log(`    ${t("kaldırılmadı (onaylamak için --yes)")}`); continue; }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = r.path.split("/").pop();
    const out = io.ssh(sshHost, vsh(`mkdir -p ${BACKUP_DIR} && $SU mv -- ${q(r.path)} "${BACKUP_DIR}/${base}.${stamp}" && echo "${BACKUP_DIR}/${base}.${stamp}"`), { timeout: 20_000 });
    if (out.status === 0 && out.stdout.trim()) { removed.push({ path: r.path, backup: out.stdout.trim().split("\n").pop() }); io.log(`    ✓ ${t("kaldırıldı, yedek")}: ${out.stdout.trim().split("\n").pop()}`); }
    else io.log(`    ✗ ${(out.stderr || out.stdout).trim()}`);
  }
  io.log(`  ${t("Son adım sizde: DNS sağlayıcınızda {host} kaydını (A/AAAA/CNAME) silin; ekip DNS'e erişmiyor.", { host })}`);
  return removed.length ? { host, files: removed } : null;
}

// ---- checks ---------------------------------------------------------------------------------------

/** HTTP answer of url/healthz from this Mac (true/false), bounded by `ms`. */
export async function answers(io, url, ms = 6000) {
  try { const r = await io.fetch(`${url.replace(/\/$/, "")}/healthz`, { signal: AbortSignal.timeout(ms), redirect: "manual" }); return r.ok; } catch { return false; }
}

// ---- commands -------------------------------------------------------------------------------------

function options(args) {
  const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  return { ssh: val("--ssh"), hostname: val("--hostname"), port: val("--port"), yes: args.includes("--yes") || args.includes("-y"), keepRoute: args.includes("--keep-route") };
}

export const sshHost = (s, opt = {}) => opt.ssh ?? s.hubPrivate?.ssh ?? s.remote?.ssh ?? REMOTE?.ssh ?? s.vps?.ssh ?? null;

export async function enable(io, opt = {}) {
  const s = io.settings;
  const host = sshHost(s, opt);
  if (!host) { io.log(t("VPS'in ssh adresi yok: ekip hub private --ssh <ssh-host> (ya da ekip remote <ssh-host>)")); return 2; }
  const hostname = opt.hostname ?? s.hubPrivate?.hostname ?? DEFAULT_HOSTNAME;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(hostname)) { io.log(`--hostname: ${hostname}?`); return 2; }
  const port = Number(opt.port ?? s.hubPrivate?.port ?? DEFAULT_PORT);
  if (!s.hubToken) io.log(`  ! ${t("hub token'ı yok; önce ekip hub link <url> <token>")}`);
  io.log(`\n› ${t("1/5 Mac'te Tailscale")}`);
  if (io.platform === "darwin" && !(await ensureMac(io, opt))) { io.log(`  ✗ ${t("Mac tailnet'e katılmadı; Tailscale'de oturum açıp tekrar deneyin.")}`); return 1; }
  io.log(`\n› ${t("2/5 VPS'te Tailscale")} (${host})`);
  const vps = await ensureVps(io, host, { hostname, timeoutMs: opt.timeoutMs });
  if (!vps?.dnsName) return 1;
  io.log(`\n› ${t("3/5 Hub'ı tailnet'te yayınla")} (127.0.0.1:${port})`);
  if (io.ssh(host, `curl -fsS -m 5 http://127.0.0.1:${port}/healthz`, { timeout: 20_000 }).status !== 0) {
    io.log(`  ✗ ${t("hub VPS'te 127.0.0.1:{port} adresinde cevap vermiyor; doğru portu --port ile verin", { port })}`);
    return 1;
  }
  if (!(await serve(io, host, port, { timeoutMs: opt.timeoutMs }))) { io.log(`  ✗ ${t("tailscale serve tamamlanmadı")} (${SERVE_LOG})`); return 1; }
  const url = `https://${vps.dnsName}`;
  io.log(`\n› ${t("4/5 Mac'ten kontrol")}: ${url}`);
  // the first request waits for the certificate
  if (!(await waitFor(io, () => answers(io, url, 15_000), { timeoutMs: opt.checkMs ?? 3 * 60_000, everyMs: 5000 }))) {
    io.log(`  ✗ ${t("{url} Mac'ten açılmadı; hubUrl değişmedi (MagicDNS açık mı?)", { url })}`);
    return 1;
  }
  const before = s.hubUrl;
  const next = privateSettings(s, { url, ssh: host, hostname, port });
  io.save(next);
  io.log(`  ✓ hubUrl: ${url}${before && before !== url ? ` (${t("önceki")}: ${before})` : ""}`);
  io.log(`\n› ${t("5/5 Eski genel adres")}`);
  const pub = next.hubPrivate.publicUrl;
  if (!pub || isPrivateHost(new URL(pub).hostname)) io.log(`  ${t("genel adres yok, kaldırılacak bir şey yok")}`);
  else if (opt.keepRoute) io.log(`  ${t("--keep-route: {url} olduğu gibi kaldı", { url: pub })}`);
  else {
    const route = await removeRoute(io, host, pub, { yes: opt.yes });
    if (route) io.save({ hubPrivate: { ...io.settings.hubPrivate, route } });
  }
  io.log(`\n✓ ${t("Hub artık yalnız tailnet'teki cihazlarınızdan açılıyor")}: ${url}\n  ${t("telefon ve diğer cihazlar: Tailscale uygulamasını kurup aynı hesapla oturum açın")}\n  ${t("durum: ekip hub private status · geri almak: ekip hub private off")}`);
  return 0;
}

export async function status(io) {
  const s = io.settings, p = s.hubPrivate;
  const cli = io.platform === "darwin" ? macCli(io) : io.has("tailscale") ? "tailscale" : null;
  const mac = macStatus(io, cli);
  const row = (k, v) => io.log(`${k.padEnd(9)}${v}`);
  row("Mac", `${!cli ? t("Tailscale kurulu değil") : mac.online ? `✓ ${mac.dnsName}` : `✗ ${mac.state ?? t("kapalı")}`}`);
  const host = sshHost(s);
  if (host) {
    const v = vpsStatus(io, host);
    row("VPS", `${v.online ? `✓ ${v.dnsName}` : `✗ ${v.state ?? t("Tailscale yok ya da erişilemiyor")}`} (${host})`);
    const sv = io.ssh(host, vsh("$SU timeout 10 tailscale serve status 2>&1 | head -8"), { timeout: 20_000 }).stdout.trim();
    if (sv) row("serve", sv.split("\n").join(`\n${" ".repeat(9)}`));
  }
  if (!p?.url) { row("hub", `${s.hubUrl ?? t("bağlı değil")} · ${t("gizli mod kapalı (ekip hub private)")}`); return 0; }
  const ok = await answers(io, p.url);
  row("hub", `${ok ? "✓" : "✗"} ${p.url}${s.hubUrl === p.url ? "" : ` (${t("hubUrl başka")}: ${s.hubUrl})`}`);
  if (p.publicUrl) {
    const open = await answers(io, p.publicUrl);
    row(t("genel"), `${open ? `! ${p.publicUrl} ${t("hâlâ cevap veriyor")}` : `✓ ${p.publicUrl} ${t("cevap vermiyor")}`}`);
  }
  if (p.route?.files?.length) row(t("yedek"), p.route.files.map((f) => f.backup).join(", "));
  return ok ? 0 : 1;
}

export async function off(io, opt = {}) {
  const s = io.settings, p = s.hubPrivate;
  const host = sshHost(s, opt);
  if (!p && !host) { io.log(t("gizli mod açık değil")); return 0; }
  if (host) {
    const r = io.ssh(host, vsh("$SU timeout 20 tailscale serve --https=443 off"), { timeout: 40_000 });
    io.log(r.status === 0 ? `✓ ${t("tailscale serve kapatıldı")}` : `! tailscale serve: ${(r.stderr || r.stdout).trim()}`);
    for (const f of p?.route?.files ?? []) {
      if (!PATH_RE.test(f.path) || !PATH_RE.test(f.backup)) continue;
      const m = io.ssh(host, vsh(`[ -e ${q(f.path)} ] && echo exists || $SU mv -- ${q(f.backup)} ${q(f.path)}`), { timeout: 20_000 });
      io.log(m.stdout.includes("exists") ? `! ${f.path} ${t("zaten var, yedek bırakıldı")}: ${f.backup}` : m.status === 0 ? `✓ ${t("yönlendirme geri geldi")}: ${f.path}` : `✗ ${f.path}: ${m.stderr.trim()}`);
    }
  }
  const patch = { hubPrivate: null };
  if (p?.publicUrl) patch.hubUrl = p.publicUrl;
  io.save(patch);
  io.log(p?.publicUrl ? `✓ hubUrl: ${p.publicUrl}${p.route?.host ? ` · ${t("DNS kaydını sildiyseniz geri ekleyin")}: ${p.route.host}` : ""}` : `! ${t("eski genel adres kayıtlı değil; ekip hub link <url> <token>")}`);
  return 0;
}

export async function main(args = [], io = realIo()) {
  const [sub] = args;
  const opt = options(args);
  if (sub === "status") return status(io);
  if (sub === "off") return off(io, opt);
  if (sub && !sub.startsWith("-")) { io.log("usage: ekip hub private [--ssh HOST] [--hostname NAME] [--port N] [--yes] [--keep-route] | status | off"); return 2; }
  return enable(io, opt);
}
