// Reminders the user silenced for a while (`ekip setup snooze <id> [days]`): data/setup-snooze.json
// maps a setup step id to the time its reminder may come back.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/core.js";

const FILE = () => path.join(HOME, "setup-snooze.json");
const read = () => { try { return JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return {}; } };

/** True while the reminder for `id` is silenced. */
export const snoozed = (id, at = Date.now()) => { const until = Date.parse(read()[id] ?? ""); return Number.isFinite(until) && until > at; };

/** Silences `id` for `days` days; returns the time it comes back. */
export function snooze(id, days = 7, at = Date.now()) {
  const all = read();
  const until = new Date(at + days * 86400_000).toISOString();
  all[id] = until;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(FILE(), `${JSON.stringify(all, null, 2)}\n`);
  return until;
}

export function unsnooze(id) {
  const all = read();
  if (!(id in all)) return false;
  delete all[id];
  fs.writeFileSync(FILE(), `${JSON.stringify(all, null, 2)}\n`);
  return true;
}
