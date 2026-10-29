// The user's VPS: shell over SSH and the Coolify API, so the lead (or the user) can deploy, read
// logs and restart apps from the same terminal. The API token is created by the user in Coolify
// (Keys & Tokens → API tokens) and stored in data/config.json; it never leaves this machine.
import { spawnSync } from "node:child_process";
import { SETTINGS, ask, die, openUrl, saveSettings } from "../core/core.js";

const vps = () => SETTINGS.vps ?? die("no VPS configured: ekip vps add <ssh-host> <coolify-url>");

async function coolify(pathname, init = {}) {
  const v = vps();
  if (!v.token) die("no Coolify API token: ekip vps token");
  const r = await fetch(`${v.coolifyUrl}/api/v1${pathname}`, {
    ...init, signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${v.token}`, "content-type": "application/json", accept: "application/json", ...init.headers },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) die(`coolify ${pathname}: HTTP ${r.status} ${body.message ?? ""}`);
  return body;
}

export async function main([sub = "status", ...args]) {
  if (sub === "add") {
    const [ssh, coolifyUrl] = args;
    if (!ssh || !coolifyUrl) die("usage: ekip vps add <ssh-host> <https://coolify.example.com>");
    saveSettings({ vps: { ...SETTINGS.vps, ssh, coolifyUrl: coolifyUrl.replace(/\/$/, "") } });
    console.log(`VPS ${ssh}, Coolify ${coolifyUrl}. Next: ekip vps token`);
  } else if (sub === "token") {
    const v = vps();
    console.log(`Opening ${v.coolifyUrl}/security/api-tokens — create a token (permission: root or read+deploy), paste it here.`);
    openUrl(`${v.coolifyUrl}/security/api-tokens`);
    const token = await ask("token: ");
    if (!token) return;
    saveSettings({ vps: { ...v, token } });
    const apps = await coolify("/applications");
    console.log(`ok, ${apps.length} applications visible`);
  } else if (sub === "sh") {
    if (!args.length) die('usage: ekip vps sh "<command>"');
    const r = spawnSync("ssh", ["-o", "BatchMode=yes", vps().ssh, args.join(" ")], { stdio: "inherit" });
    process.exitCode = r.status ?? 1;
  } else if (sub === "apps") {
    for (const a of await coolify("/applications")) console.log(`${a.uuid}  ${String(a.status ?? "").padEnd(18)} ${a.name}  ${a.fqdn ?? ""}`);
  } else if (sub === "deploy") {
    if (!args[0]) die("usage: ekip vps deploy <app uuid|name>");
    const uuid = await resolveApp(args[0]);
    const r = await coolify(`/deploy?uuid=${uuid}`, { method: "GET" });
    console.log(JSON.stringify(r.deployments ?? r, null, 2));
  } else if (sub === "logs") {
    const uuid = await resolveApp(args[0] ?? die("usage: ekip vps logs <app>"));
    const r = await coolify(`/applications/${uuid}/logs?lines=${args[1] ?? 100}`);
    console.log(r.logs ?? JSON.stringify(r));
  } else if (sub === "restart") {
    const uuid = await resolveApp(args[0] ?? die("usage: ekip vps restart <app>"));
    console.log(JSON.stringify(await coolify(`/applications/${uuid}/restart`, { method: "GET" })));
  } else if (sub === "status") {
    const v = SETTINGS.vps;
    if (!v) { console.log("no VPS configured (ekip vps add <ssh-host> <coolify-url>)"); return; }
    const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", v.ssh, "uptime; df -h / | tail -1; free -h | sed -n 2p"], { encoding: "utf8" });
    console.log(`ssh ${v.ssh}: ${r.status === 0 ? `\n${r.stdout.trim()}` : "unreachable"}\ncoolify ${v.coolifyUrl}: ${v.token ? "token set" : "no token (ekip vps token)"}`);
  } else die("usage: ekip vps add|token|status|sh|apps|deploy|logs|restart");
}

async function resolveApp(nameOrUuid) {
  const apps = await coolify("/applications");
  const hit = apps.find((a) => a.uuid === nameOrUuid || a.name === nameOrUuid);
  return hit?.uuid ?? die(`no Coolify app ${nameOrUuid} (ekip vps apps)`);
}
