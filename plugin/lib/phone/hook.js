#!/usr/bin/env node
// Claude Code hooks for the phone: `node hook.js session|prompt|tool|stop|end` (reads the hook's JSON
// on stdin) and `node hook.js pump LEAD` (types what waited for a turn, started by the Stop hook).
// A hook never blocks or fails a session: every error is swallowed and it exits 0.
const [event, arg] = process.argv.slice(2);

async function readStdin(timeoutMs = 2000) {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let s = "";
    const done = () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => { clearTimeout(timer); done(); });
    process.stdin.on("error", () => { clearTimeout(timer); done(); });
  });
}

// The tool hook runs on every tool call: without verbose mode on, it stops before loading anything.
async function verboseOn() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  let root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
  try { const p = fs.readFileSync(path.join(os.homedir(), ".config/ekip/root"), "utf8").trim(); if (p && fs.existsSync(path.join(p, "plugin/bin/ekip.js"))) root = p; } catch { /* the repo itself */ }
  try { return JSON.parse(fs.readFileSync(path.join(process.env.EKIP_HOME ?? path.join(root, "data"), "phone/state.json"), "utf8")).verbose === true; } catch { return false; }
}

try {
  // not a lead session: nothing to do, and nothing loaded
  if (event === "tool" && !(await verboseOn())) { /* nothing */ } else if (event === "pump") {
    const phone = await import("./phone.js");
    // Claude Code redraws its prompt after the Stop hook returns
    await new Promise((r) => setTimeout(r, 1500));
    phone.pump(arg);
  } else if (process.env.EKIP_LEAD === "1" && !(Number(process.env.EKIP_RUN_DEPTH ?? 0) > 0)) {
    const input = await readStdin();
    const phone = await import("./phone.js");
    await phone.hook(event, input);
  }
} catch (e) {
  try {
    const fs = await import("node:fs");
    const { HOME } = await import("../core/core.js");
    fs.mkdirSync(`${HOME}/logs`, { recursive: true });
    fs.appendFileSync(`${HOME}/logs/hooks.log`, `${new Date().toISOString()} phone ${event}: ${e?.stack ?? e}\n`);
  } catch { /* ignore */ }
}
process.exit(0);
