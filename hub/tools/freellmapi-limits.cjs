// Read-only snapshot of freellmapi's routing state, printed as JSON; run inside the freellmapi
// container (`docker exec -i freellmapi node - < freellmapi-limits.cjs`). Used by `ekip limits`.
// Per platform: models with a key, how many are cooling down now, last-24h successes/failures and
// the most common recent error. Per routing profile: the first models the router would try.
const D = require("/app/node_modules/better-sqlite3");
const db = new D("/app/server/data/freeapi.db", { readonly: true });
const now = Date.now();
const keyed = new Set(db.prepare("SELECT DISTINCT platform FROM api_keys WHERE enabled = 1").all().map((r) => r.platform));
const cooling = new Set(db.prepare("SELECT platform || '/' || model_id AS k FROM rate_limit_cooldowns WHERE expires_at_ms > ?").all(now).map((r) => r.k));
const platforms = {};
for (const r of db.prepare("SELECT platform, model_id FROM models WHERE enabled = 1").all()) {
  if (!keyed.has(r.platform)) continue;
  const p = (platforms[r.platform] ??= { models: 0, cooling: 0, ok24: 0, fail24: 0, lastError: null });
  p.models++;
  if (cooling.has(`${r.platform}/${r.model_id}`)) p.cooling++;
}
for (const r of db.prepare(`SELECT platform, SUM(status = 'success') ok, SUM(status != 'success') bad FROM requests
    WHERE created_at > datetime('now', '-1 day') AND request_type != 'embedding' GROUP BY platform`).all()) {
  if (platforms[r.platform]) Object.assign(platforms[r.platform], { ok24: r.ok, fail24: r.bad });
}
for (const p of Object.keys(platforms)) {
  const e = db.prepare(`SELECT error, COUNT(*) n FROM requests WHERE platform = ? AND status != 'success' AND error IS NOT NULL
      AND created_at > datetime('now', '-1 day') GROUP BY substr(error, 1, 80) ORDER BY n DESC LIMIT 1`).get(p);
  if (e) platforms[p].lastError = String(e.error).slice(0, 120);
}
// when the last cooling model of a platform comes back (the panel and pane say "dinleniyor ~12 dk")
for (const r of db.prepare("SELECT platform, MIN(expires_at_ms) until FROM rate_limit_cooldowns WHERE expires_at_ms > ? GROUP BY platform").all(now)) {
  if (platforms[r.platform]) platforms[r.platform].coolUntil = r.until;
}
const iso = (s) => (s ? `${String(s).replace(" ", "T")}Z` : null);
// the newest chat request: which provider and model a free-pool worker is on right now
const last = db.prepare("SELECT platform, model_id, status, created_at FROM requests WHERE request_type = 'chat' ORDER BY id DESC LIMIT 1").get();
const recent = last ? { platform: last.platform, model: last.model_id, status: last.status, at: iso(last.created_at) } : null;
// embeddings (memory vectors) per platform over the last day: served, failed, last success, last error
const embeddings = {};
for (const r of db.prepare(`SELECT platform, model_id, SUM(status = 'success') ok, SUM(status != 'success') bad, MAX(CASE WHEN status = 'success' THEN created_at END) last_ok, MAX(created_at) last_at
    FROM requests WHERE request_type = 'embedding' AND created_at > datetime('now', '-1 day') GROUP BY platform`).all()) {
  const lastRow = db.prepare("SELECT status, error FROM requests WHERE request_type = 'embedding' AND platform = ? ORDER BY id DESC LIMIT 1").get(r.platform);
  embeddings[r.platform] = { model: r.model_id, ok24: r.ok, fail24: r.bad, lastOkAt: iso(r.last_ok), lastAt: iso(r.last_at), lastStatus: lastRow?.status ?? null, lastError: lastRow?.error ? String(lastRow.error).slice(0, 120) : null };
}
// profile order: explicit profile_models priority; the default profile falls back to intelligence rank
const profile = (id) => {
  const rows = db.prepare(`SELECT m.platform, m.model_id FROM profile_models pm JOIN models m ON m.id = pm.model_db_id
      WHERE pm.profile_id = ? AND pm.enabled = 1 AND m.enabled = 1 ORDER BY pm.priority`).all(id);
  const list = rows.length ? rows : db.prepare("SELECT platform, model_id FROM models WHERE enabled = 1 ORDER BY intelligence_rank").all();
  const usable = list.filter((r) => keyed.has(r.platform));
  const open = usable.filter((r) => !cooling.has(`${r.platform}/${r.model_id}`));
  return { next: open.slice(0, 3).map((r) => `${r.platform}/${r.model_id}`), models: usable.length, cooling: usable.length - open.length };
};
const active = Number(db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get()?.value ?? 1);
const profiles = { auto: profile(active) };
for (const p of db.prepare("SELECT id, name FROM profiles WHERE type = 'custom'").all()) profiles[`auto:${p.name}`] = profile(p.id);
process.stdout.write(JSON.stringify({ platforms, profiles, recent, embeddings }));
