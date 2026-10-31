// `ekip hub private` without a network: the parsers (login link, Serve enable link, DNSName, Traefik
// hosts), the settings switch, the setup gap, and the whole flow (Mac ready, VPS installs and joins,
// Serve first off then on, the hub checked, the public Traefik file backed up, status, off) driven by
// a fake run/ssh/open/fetch. Nothing here touches a real VPS.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ekip-private-"));
process.env.EKIP_HOME = tmp;
process.env.EKIP_LANG = "en";
fs.writeFileSync(path.join(tmp, "config.json"), "{}");
const pv = await import("./private.js");

// ---- parsing ----
const upOut = "\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2b3c4d5e6f\n\n";
assert.equal(pv.parseLoginUrl(upOut), "https://login.tailscale.com/a/1a2b3c4d5e6f");
assert.equal(pv.parseLoginUrl("Success."), null);
const serveOut = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nExample123\n";
assert.equal(pv.parseServeEnableUrl(serveOut), "https://login.tailscale.com/f/serve?node=nExample123");
assert.equal(pv.parseServeEnableUrl("Available within your tailnet:\n\nhttps://hub.tailnet-name.ts.net/\n|-- proxy http://127.0.0.1:7777"), null);
const TAILNET = { Name: "alice@example.com", MagicDNSSuffix: "tailnet-name.ts.net" };
const OTHER = { Name: "other-team.example", MagicDNSSuffix: "other-tailnet.ts.net" };
const nodeJson = (dns, tailnet = TAILNET) => JSON.stringify({ BackendState: "Running", Self: { DNSName: `${dns}.${tailnet.MagicDNSSuffix}.`, TailscaleIPs: ["100.64.0.10"], UserID: 7 }, User: { 7: { LoginName: tailnet.Name.includes("@") ? tailnet.Name : "bob@example.org" } }, CurrentTailnet: tailnet });
const statusJson = nodeJson("ekip-hub");
assert.equal(pv.parseDnsName(JSON.parse(statusJson)), "ekip-hub.tailnet-name.ts.net");
assert.deepEqual(pv.parseStatus(statusJson), { state: "Running", online: true, dnsName: "ekip-hub.tailnet-name.ts.net", ip: "100.64.0.10", tailnet: { name: "alice@example.com", suffix: "tailnet-name.ts.net", login: "alice@example.com" } });
// an older CLI without CurrentTailnet: the suffix of the DNS name
assert.deepEqual(pv.parseStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tailnet-name.ts.net." } })).tailnet, { name: null, suffix: "tailnet-name.ts.net", login: null });
const vpsOther = pv.parseStatus(nodeJson("ekip-hub", OTHER));
assert.equal(pv.sameTailnet(pv.parseStatus(statusJson).tailnet, vpsOther.tailnet), false);
assert.equal(pv.sameTailnet(pv.parseStatus(statusJson).tailnet, pv.parseStatus(nodeJson("mac")).tailnet), true);
assert.equal(pv.sameTailnet(null, vpsOther.tailnet), null);
assert.equal(pv.tailnetLabel(vpsOther.tailnet), "bob@example.org · other-team.example (other-tailnet.ts.net)");
assert.equal(pv.tailnetMismatch(pv.parseStatus(nodeJson("mac")), pv.parseStatus(statusJson), "vps"), null);
assert.match(pv.tailnetMismatch(pv.parseStatus(nodeJson("mac")), vpsOther, "vps"), /Mac: alice@example\.com \(tailnet-name\.ts\.net\), VPS: bob@example\.org · other-team\.example[\s\S]*ssh vps sudo tailscale logout/);
// what port 443 serves
const hubServe = (port = 7777) => JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { "ekip-hub.tailnet-name.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });
assert.equal(pv.parseServe("{}", 7777).state, "none");
assert.equal(pv.parseServe("", 7777).state, "none");
assert.equal(pv.parseServe(null, 7777).state, "unknown");
assert.equal(pv.parseServe("No serve config", 7777).state, "unknown");
assert.equal(pv.parseServe(hubServe(), 7777).state, "hub");
assert.equal(pv.parseServe(hubServe(3000), 7777).state, "other");
assert.deepEqual(pv.parseServe(hubServe(3000), 7777).lines, ["https://ekip-hub.tailnet-name.ts.net/ → proxy http://127.0.0.1:3000"]);
assert.equal(pv.parseServe({ ...JSON.parse(hubServe()), AllowFunnel: { "ekip-hub.tailnet-name.ts.net:443": true } }, 7777).state, "other", "Funnel is public: not the private hub");
assert.equal(pv.parseServe({ Web: { "h.tailnet-name.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7777" }, "/files": { Path: "/srv" } } } } }, 7777).state, "other");
const tcpServe = pv.parseServe({ TCP: { 443: { TCPForward: "127.0.0.1:8443" } } }, 7777);
assert.equal(tcpServe.state, "other");
assert.equal(tcpServe.tcp, true);
assert.equal(pv.parseServe(JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { "h.tailnet-name.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } } }), 7777).state, "none", "other ports are not 443");
assert.equal(pv.parseStatus("not json").online, false);
assert.equal(pv.parseStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: {} })).online, false);
assert.deepEqual(pv.routeHosts("rule: Host(`hub.example.com`) || Host(`a.example.com`,`b.example.com`)"), ["hub.example.com", "a.example.com", "b.example.com"]);

// ---- hosts and the setup gap ----
for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "100.100.1.1", "hub.tailnet-name.ts.net", "vps", "box.local"]) assert.ok(pv.isPrivateHost(h), h);
for (const h of ["hub.example.com", "8.8.8.8", "172.32.0.1"]) assert.ok(!pv.isPrivateHost(h), h);
assert.equal(pv.hubExposed({ hubUrl: "https://hub.example.com", hubToken: "x" }), true);
assert.equal(pv.hubExposed({ hubUrl: "http://localhost:7777", hubToken: "x", hubLocal: true }), false);
assert.equal(pv.hubExposed({ hubUrl: "https://hub.tailnet-name.ts.net", hubToken: "x" }), false);
assert.equal(pv.hubExposed({ hubUrl: "https://hub.example.com", hubPrivate: { url: "https://hub.tailnet-name.ts.net" } }), false);
assert.equal(pv.hubExposed({}), false);

// the onboarding gap and the setup step follow the same rule
const setup = await import("../ops/setup.js");
const base = { platform: "darwin", node: 22, git: true, claude: true, docker: { ok: true }, env: { gitIdentity: true, ghInstalled: true, ghAuth: true }, onPath: true, freeUp: true, memUp: true, keys: [], embeddings: false, logged: [], projects: [], projectGaps: [], vectors: null, wezterm: true, terminal: "wezterm", notifier: true, hub: true, cwd: tmp };
assert.ok(!setup.evaluate({ ...base, hubExposed: false }, { env: {} }).some((s) => s.id === "hub-private"), "hidden without a public hub");
const step = setup.evaluate({ ...base, hubExposed: true }, { env: {} }).find((s) => s.id === "hub-private");
assert.equal(step.done, false);
assert.equal(step.level, "optional");
assert.equal(step.command, "ekip hub private");
assert.equal(setup.summary(setup.evaluate({ ...base, hubExposed: true }, { env: {} })).total, setup.summary(setup.evaluate(base, { env: {} })).total, "optional: not counted");

// ---- settings switch ----
const sw = pv.privateSettings({ hubUrl: "https://hub.example.com", hubToken: "tok" }, { url: "https://ekip-hub.tailnet-name.ts.net", ssh: "vps", hostname: "ekip-hub", port: 7777 });
assert.equal(sw.hubUrl, "https://ekip-hub.tailnet-name.ts.net");
assert.equal(sw.hubToken, "tok");
assert.equal(sw.hubPrivate.publicUrl, "https://hub.example.com");
// a second run keeps the first public URL
assert.equal(pv.privateSettings({ hubUrl: sw.hubUrl, hubToken: "tok", hubPrivate: sw.hubPrivate }, { url: sw.hubUrl }).hubPrivate.publicUrl, "https://hub.example.com");

// ---- the routes on the VPS ----
const probe = "=== file /data/coolify/proxy/dynamic/ekip-hub.yaml\nhttp:\n  routers:\n    ekip:\n      rule: Host(`hub.example.com`)\n=== file /data/coolify/proxy/dynamic/shared.yaml\nrule: Host(`hub.example.com`) || Host(`app.example.com`)\n=== file /etc/nginx/sites-enabled/hub\nserver_name hub.example.com;\n=== container ekip-hub-abc123\n";
const routes = pv.parseRoutes(probe, "hub.example.com");
assert.deepEqual(routes.map((r) => [r.kind, r.removable]), [["traefik", true], ["traefik", false], ["nginx", false], ["coolify", false]]);
assert.throws(() => pv.routeProbe("bad host; rm -rf /"));

// ---- the whole flow with a fake io ----
function fakeIo({ settings, serveOffTimes = 1, vpsHasTailscale = false, vpsOnline = false, vpsTailnet = TAILNET, macTailnet = TAILNET, serveConf = null, hubServed = false }) {
  const log = [], opened = [], sshCmds = [];
  let vpsUp = vpsOnline, installed = vpsHasTailscale || vpsOnline, serveTries = 0, served = hubServed, routeFile = true, publicAnswers = true;
  const io = {
    log: (m) => log.push(m), opened, sshCmds, settings, platform: "darwin", tty: false,
    exists: (f) => f === pv.MAC_CLI, has: (b) => b === "brew", sleep: async () => {}, ask: async () => "n",
    save: (patch) => Object.assign(settings, patch), open: (u) => opened.push(u),
    run: (cmd, args) => (cmd === pv.MAC_CLI && args[0] === "status" ? { status: 0, stdout: nodeJson("mac", macTailnet) } : { status: 0, stdout: "" }),
    ssh: (host, cmd) => {
      assert.equal(host, "vps");
      sshCmds.push(cmd);
      assert.ok(!/pkill|killall/.test(cmd), `never kill by name over ssh: ${cmd}`);
      if (cmd === "command -v tailscale") return { status: installed ? 0 : 1, stdout: "" };
      if (cmd.includes("install.sh")) { installed = true; return { status: 0, stdout: "Installation complete!" }; }
      if (cmd.includes("tailscale status --json")) return { status: 0, stdout: vpsUp ? nodeJson("ekip-hub", vpsTailnet) : JSON.stringify({ BackendState: "NeedsLogin", Self: {} }) };
      if (cmd.includes("serve status --json")) return { status: 0, stdout: served ? hubServe() : serveConf ? JSON.stringify(serveConf) : "{}" };
      if (cmd.includes("tailscale up")) { assert.match(cmd, /timeout \d+ tailscale up --hostname=ekip-hub/); return { status: 0, stdout: "" }; }
      if (cmd.includes("cat /tmp/ekip-tailscale-up.log")) { vpsUp = true; return { status: 0, stdout: upOut }; }
      if (cmd.includes("/healthz")) return { status: 0, stdout: '{"ok":true}' };
      if (cmd.includes("tailscale serve --bg")) {
        assert.match(cmd, /timeout \d+ tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:7777 > \S+ 2>&1/);
        serveTries++;
        if (serveTries <= serveOffTimes) return { status: 0, stdout: `exit=124\n${serveOut}` };
        served = true;
        return { status: 0, stdout: "exit=0\nAvailable within your tailnet:\nhttps://ekip-hub.tailnet-name.ts.net/" };
      }
      if (cmd.includes("=== file")) return { status: 0, stdout: routeFile ? probe.split("=== file /data/coolify/proxy/dynamic/shared.yaml")[0] : "" };
      if (cmd.includes("mv -- '/data/coolify")) { routeFile = false; publicAnswers = false; return { status: 0, stdout: "/root/ekip-route-backup/ekip-hub.yaml.2026\n" }; }
      if (cmd.includes("serve status")) return { status: 0, stdout: served ? "https://ekip-hub.tailnet-name.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:7777" : "No serve config" };
      if (cmd.includes("serve --https=443 off")) { served = false; serveConf = null; return { status: 0, stdout: "" }; }
      if (cmd.includes("mv -- '/root/ekip-route-backup")) { routeFile = true; return { status: 0, stdout: "" }; }
      return { status: 0, stdout: "" };
    },
    fetch: async (url) => {
      if (url.startsWith("https://ekip-hub.tailnet-name.ts.net")) return { ok: served };
      if (url.startsWith("https://hub.example.com")) return { ok: publicAnswers };
      throw new Error("offline");
    },
  };
  return { io, log, opened, sshCmds };
}
const PRIVATE = "https://ekip-hub.tailnet-name.ts.net";
const FOREIGN = { TCP: { 443: { HTTPS: true } }, Web: { "ekip-hub.tailnet-name.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };

{
  const settings = { hubUrl: "https://hub.example.com", hubToken: "tok", vps: { ssh: "vps" } };
  const { io, log, opened, sshCmds } = fakeIo({ settings, serveOffTimes: 2 });
  assert.equal(await pv.main(["--yes"], io), 0, log.join("\n"));
  assert.ok(sshCmds.some((c) => c.includes("install.sh")), "installs Tailscale on the VPS");
  assert.ok(opened.includes("https://login.tailscale.com/a/1a2b3c4d5e6f"), "opens the VPS login link");
  assert.equal(opened.filter((u) => u.includes("/f/serve")).length, 1, "opens the Serve enable page once, retries serve");
  assert.equal(sshCmds.filter((c) => c.includes("tailscale serve --bg")).length, 3);
  assert.equal(settings.hubUrl, "https://ekip-hub.tailnet-name.ts.net");
  assert.equal(settings.hubToken, "tok");
  assert.equal(settings.hubPrivate.publicUrl, "https://hub.example.com");
  assert.deepEqual(settings.hubPrivate.route.files, [{ path: "/data/coolify/proxy/dynamic/ekip-hub.yaml", backup: "/root/ekip-route-backup/ekip-hub.yaml.2026" }]);
  assert.ok(log.some((l) => /DNS provider/.test(l)), "tells the user to delete the DNS record");
  assert.equal(pv.hubExposed(settings), false);

  // status: both sides on the tailnet, served, the public URL no longer answers
  log.length = 0;
  assert.equal(await pv.main(["status"], io), 0);
  const out = log.join("\n");
  assert.match(out, /Mac\s+✓ mac\.tailnet-name\.ts\.net/);
  assert.match(out, /VPS\s+✓ ekip-hub\.tailnet-name\.ts\.net/);
  assert.match(out, /hub\s+✓ https:\/\/ekip-hub\.tailnet-name\.ts\.net/);
  assert.match(out, /does not answer/);

  // off: serve off, the route back, hubUrl back to the public URL
  log.length = 0;
  assert.equal(await pv.main(["off"], io), 0);
  assert.ok(sshCmds.some((c) => c.includes("serve --https=443 off")));
  assert.ok(sshCmds.some((c) => c.includes("mv -- '/root/ekip-route-backup/ekip-hub.yaml.2026' '/data/coolify/proxy/dynamic/ekip-hub.yaml'")));
  assert.equal(settings.hubUrl, "https://hub.example.com");
  assert.equal(settings.hubPrivate, null);
  assert.equal(settings.hubToken, "tok");
}

// without --yes and without a terminal the route stays, and nothing is moved
{
  const settings = { hubUrl: "https://hub.example.com", hubToken: "tok", remote: { ssh: "vps" } };
  const { io, sshCmds, log } = fakeIo({ settings, serveOffTimes: 0, vpsHasTailscale: true });
  assert.equal(await pv.main([], io), 0, log.join("\n"));
  assert.ok(!sshCmds.some((c) => c.includes("install.sh")));
  assert.ok(!sshCmds.some((c) => c.includes(" mv -- ")), "no removal without a yes");
  assert.equal(settings.hubPrivate.route, null);
  assert.ok(log.some((l) => /--yes/.test(l)));
}

// the hub never answers on the tailnet: hubUrl is not switched
{
  const settings = { hubUrl: "https://hub.example.com", hubToken: "tok", vps: { ssh: "vps" } };
  const { io } = fakeIo({ settings, serveOffTimes: 0, vpsHasTailscale: true });
  io.fetch = async () => ({ ok: false });
  assert.equal(await pv.enable(io, { checkMs: 0 }), 1);
  assert.equal(settings.hubUrl, "https://hub.example.com");
  assert.equal(settings.hubPrivate, undefined);
}

// the Mac without Tailscale and without a terminal: brew fetches the package, macOS's installer opens
// (it asks for the password), the app opens for the sign-in, and the flow waits until the Mac is online
{
  const runs = [], opened = [];
  let installedAt = null, polls = 0;
  const io = {
    log: () => {}, open: (u) => { opened.push(u); installedAt = polls; }, sleep: async () => { polls++; }, tty: false,
    exists: (f) => f === pv.MAC_CLI && installedAt !== null, has: (b) => b === "brew",
    run: (cmd, args) => {
      runs.push([cmd, ...args].join(" "));
      if (cmd === "brew" && args[0] === "--cache") return { status: 0, stdout: "/tmp/brew-cache/Tailscale.pkg\n" };
      if (cmd === pv.MAC_CLI) return { status: 0, stdout: polls > 2 ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tailnet-name.ts.net." } }) : JSON.stringify({ BackendState: "NeedsLogin" }) };
      return { status: 0, stdout: "" };
    },
  };
  const st = await pv.ensureMac(io, { timeoutMs: 60_000 });
  assert.equal(st?.dnsName, "mac.tailnet-name.ts.net");
  assert.ok(runs.includes("brew fetch --cask tailscale-app"));
  assert.ok(!runs.some((r) => r.startsWith("brew install")), "no sudo prompt without a terminal");
  assert.deepEqual(opened, ["/tmp/brew-cache/Tailscale.pkg"]);
  assert.ok(runs.includes("open -a Tailscale"));
}

// serve fails for another reason than the enable page: it gives up after three tries
{
  let tries = 0;
  const io = { log: () => {}, open: () => assert.fail("nothing to open"), sleep: async () => {}, ssh: () => { tries++; return { status: 0, stdout: "exit=1\nerror: some failure" }; } };
  assert.equal(await pv.serve(io, "vps", 7777), false);
  assert.equal(tries, 3);
}

// no ssh host: a clear message, exit 2
{
  const { io, log } = fakeIo({ settings: { hubUrl: "https://hub.example.com" } });
  assert.equal(await pv.main([], io), 2);
  assert.match(log.join("\n"), /ssh host/);
}

// off without private mode never touches a Serve config ekip did not set up
{
  const { io, sshCmds, log } = fakeIo({ settings: { hubUrl: "https://hub.example.com", hubSsh: "vps" } });
  assert.equal(await pv.off(io), 0);
  assert.equal(sshCmds.length, 0, "no ssh command");
  assert.match(log.join("\n"), /gizli mod|private mode/);
}

// ---- a user who already has Tailscale ----

// the VPS is signed in to another tailnet: stop before Serve, name both tailnets and the way out
{
  const settings = { hubUrl: "https://hub.example.com", hubToken: "tok", vps: { ssh: "vps" } };
  const { io, log, sshCmds } = fakeIo({ settings, vpsOnline: true, vpsTailnet: OTHER });
  assert.equal(await pv.main(["--yes"], io), 1);
  const out = log.join("\n");
  assert.match(out, /different tailnets: Mac: alice@example\.com \(tailnet-name\.ts\.net\), VPS: bob@example\.org · other-team\.example \(other-tailnet\.ts\.net\)/);
  assert.match(out, /tailscale logout/);
  assert.ok(!sshCmds.some((c) => /tailscale (serve|up)\b/.test(c) && !c.includes("status")), "no serve, no up");
  assert.equal(settings.hubUrl, "https://hub.example.com");
  assert.equal(settings.hubPrivate, undefined);
  // status shows it too, and fails
  log.length = 0;
  assert.equal(await pv.main(["status"], io), 1);
  assert.match(log.join("\n"), /tailnet\s+✗ The Mac and the VPS are in different tailnets/);
}

// 443 already serves something else: shown; without a terminal and --yes it stops untouched
{
  const settings = { hubUrl: "https://hub.example.com", hubToken: "tok", vps: { ssh: "vps" } };
  const { io, log, sshCmds } = fakeIo({ settings, vpsOnline: true, serveConf: FOREIGN });
  assert.equal(await pv.main([], io), 1);
  const out = log.join("\n");
  assert.match(out, /Port 443 on the VPS already serves something else/);
  assert.match(out, /https:\/\/ekip-hub\.tailnet-name\.ts\.net\/ → proxy http:\/\/127\.0\.0\.1:3000/);
  assert.match(out, /--yes/);
  assert.ok(!sshCmds.some((c) => c.includes("serve --bg") || c.includes("=443 off")), "nothing replaced");
  assert.equal(settings.hubUrl, "https://hub.example.com");
}
// … a terminal and the default answer (no): untouched too
{
  const settings = { hubUrl: "https://hub.example.com", hubToken: "tok", vps: { ssh: "vps" } };
  const { io, sshCmds } = fakeIo({ settings, vpsOnline: true, serveConf: FOREIGN });
  io.tty = true;
  const asked = [];
  io.ask = async (qn) => { asked.push(qn); return ""; };
  assert.equal(await pv.main([], io), 1);
  assert.ok(asked.some((qn) => /\[y\/N\]/.test(qn) && /serve the hub/.test(qn)));
  assert.ok(!sshCmds.some((c) => c.includes("serve --bg") || c.includes("=443 off")));
}
// … --yes replaces it: the old config off first, then the hub
{
  const settings = { hubUrl: "https://hub.example.com", hubToken: "tok", vps: { ssh: "vps" } };
  const { io, log, sshCmds } = fakeIo({ settings, vpsOnline: true, serveConf: FOREIGN, serveOffTimes: 0 });
  assert.equal(await pv.main(["--yes"], io), 0, log.join("\n"));
  const offAt = sshCmds.findIndex((c) => c.includes("serve --https=443 off")), serveAt = sshCmds.findIndex((c) => c.includes("serve --bg"));
  assert.ok(offAt >= 0 && serveAt > offAt, "off, then serve");
  assert.equal(settings.hubUrl, PRIVATE);
}
// 443 already serves the hub: said and skipped, the rest of the flow goes on
{
  const settings = { hubUrl: "https://hub.example.com", hubToken: "tok", vps: { ssh: "vps" } };
  const { io, log, sshCmds } = fakeIo({ settings, vpsOnline: true, hubServed: true });
  assert.equal(await pv.main(["--yes"], io), 0, log.join("\n"));
  assert.match(log.join("\n"), /port 443 already serves the hub/);
  assert.ok(!sshCmds.some((c) => c.includes("serve --bg") || c.includes("=443 off")), "serve not run again");
  assert.equal(settings.hubUrl, PRIVATE);
}

// already set up end to end: one line, exit 0, nothing run on the VPS but reads
{
  const settings = { hubUrl: PRIVATE, hubToken: "tok", vps: { ssh: "vps" } };
  const { io, log, sshCmds } = fakeIo({ settings, vpsOnline: true, hubServed: true });
  assert.equal(await pv.main([], io), 0);
  assert.deepEqual(log, [`✓ already set up: ${PRIVATE}`]);
  assert.ok(sshCmds.every((c) => c.includes("status --json")), sshCmds.join("\n"));
  assert.equal(settings.hubPrivate.url, PRIVATE, "private mode recorded");
  assert.equal(settings.hubToken, "tok");
  // a second run: the same one line
  log.length = 0;
  assert.equal(await pv.main([], io), 0);
  assert.equal(log.length, 1);
}
// … but not when the hub does not answer: the full flow runs
{
  const settings = { hubUrl: PRIVATE, hubToken: "tok", vps: { ssh: "vps" } };
  const { io, log } = fakeIo({ settings, vpsOnline: true, hubServed: true });
  io.fetch = async () => ({ ok: false });
  assert.equal(await pv.enable(io, { checkMs: 0 }), 1);
  assert.ok(!log.some((l) => /already set up/.test(l)));
}

// off leaves a 443 config that is no longer the hub alone
{
  const settings = { hubUrl: PRIVATE, hubToken: "tok", hubPrivate: { url: PRIVATE, ssh: "vps", port: 7777, publicUrl: "https://hub.example.com" } };
  const { io, log, sshCmds } = fakeIo({ settings, vpsOnline: true, serveConf: FOREIGN });
  assert.equal(await pv.off(io), 0);
  assert.ok(!sshCmds.some((c) => c.includes("=443 off")));
  assert.match(log.join("\n"), /left alone/);
  assert.equal(settings.hubUrl, "https://hub.example.com");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("hub private: ok");
