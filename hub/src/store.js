// JSON-file persistence: one file per collection under $EKIP_DATA, written atomically (tmp + rename)
// and debounced so a burst of updates costs one write.
import fs from "node:fs";
import path from "node:path";

export class Collection {
  constructor(dir, name, fallback) {
    this.file = path.join(dir, `${name}.json`);
    this.data = fallback;
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) {
      if (e.code !== "ENOENT") {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        console.error(`store: ${this.file} unreadable (${e.message}); starting empty`);
      }
    }
    this.timer = null;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export function openStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const s = {
    projects: new Collection(dir, "projects", []),
    jobs: new Collection(dir, "jobs", []),
    runs: new Collection(dir, "runs", []),
    tasks: new Collection(dir, "tasks", []),
    clients: new Collection(dir, "clients", {}),
    // development env per project (DATABASE_URL, REDIS_URL, PG*): read by jobs only, never served by the API
    devenv: new Collection(dir, "devenv", {}),
    limits: new Collection(dir, "limits", null),
    savings: new Collection(dir, "savings", null),
    // knowledge usage summary pushed by `ekip stats` / `ekip doctor` (lookups, hit rates, skills)
    usage: new Collection(dir, "usage", null),
  };
  s.flushAll = () => { for (const c of Object.values(s)) if (c instanceof Collection) c.flush(); };
  return s;
}

// Keep at most `max` entries, dropping the oldest finished ones first.
export function trim(list, max, isActive = () => false) {
  while (list.length > max) {
    const i = list.findIndex((x) => !isActive(x));
    if (i < 0) break;
    list.splice(i, 1);
  }
}
