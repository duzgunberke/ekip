// Backfills TencentDB memory-core's vector tables (l1_vec, l0_vec) for records that have none —
// memory-core embeds new records itself but never re-embeds old ones after the embedding model
// changes (its reindexAll exists but nothing calls it). Runs inside the tdai-memory-core container
// next to the live server: same DB file (WAL, busy timeout), small batches, a pause between calls,
// exponential backoff on rate limits, resumable (records that already have a vector are skipped).
//
//   docker cp tdai-backfill-vectors.mjs tdai-memory-core:/tmp/
//   docker exec -d -e EMBED_URL=http://freellmapi:3001/v1 -e EMBED_KEY=... -e EMBED_MODEL=nemotron-3-embed-1b \
//     tdai-memory-core node /tmp/tdai-backfill-vectors.mjs
// Progress: /data/tdai-memory/backfill.log (and backfill.state.json).
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "/app/node_modules/sqlite-vec/index.mjs";

const DB = process.env.TDAI_DB ?? "/data/tdai-memory/vectors.db";
const URL_ = process.env.EMBED_URL, KEY = process.env.EMBED_KEY, MODEL = process.env.EMBED_MODEL;
const BATCH = Number(process.env.BATCH ?? 96), PAUSE = Number(process.env.PAUSE_MS ?? 300), MAXC = Number(process.env.MAX_CHARS ?? 4000);
const LOG = "/data/tdai-memory/backfill.log", STATE = "/data/tdai-memory/backfill.state.json";
if (!URL_ || !KEY || !MODEL) { console.error("EMBED_URL, EMBED_KEY, EMBED_MODEL are required"); process.exit(2); }

const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new DatabaseSync(DB, { allowExtension: true });
sqliteVec.load(db);
db.exec("PRAGMA busy_timeout = 15000");

const meta = (() => { try { return JSON.parse(db.prepare("SELECT value FROM embedding_meta WHERE key = 'embedding_provider_info'").get()?.value ?? "{}"); } catch { return {}; } })();
const dims = Number(meta.dimensions ?? 0);
const metaModel = meta.model;
if (!dims) { log("no embedding_meta yet (start memory-core with embeddings first)"); process.exit(1); }
if (metaModel && metaModel !== MODEL) log(`warning: index model is ${metaModel}, backfilling with ${MODEL}`);

// NVIDIA's embedder treats an inline "data:image/..." URI as an image and rejects the whole batch,
// so neutralize those (and long base64 runs) before sending; the meaning of the text is kept.
const clean = (t) => (t || " ").replace(/data:(image|video|audio)\//gi, "data-$1/").replace(/[A-Za-z0-9+/=]{200,}/g, "[base64]").slice(0, MAXC) || " ";

// A 400 from upstream is about the input, not the rate: retrying the same batch never succeeds.
const isInputError = (status, body) => status === 400 || (status === 502 && /upstream 400/.test(body));

async function embed(texts) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${URL_}/embeddings`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, input: texts.map(clean) }),
      signal: AbortSignal.timeout(120000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (r.ok) {
      const j = await r.json();
      const out = j.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
      if (out.some((v) => v.length !== dims)) throw new Error(`model returned ${out[0].length} dims, index has ${dims}`);
      return out;
    }
    const body = await r.text();
    if (isInputError(r.status, body)) {
      // Split the batch so one bad record cannot block the rest; a single bad record is skipped.
      if (texts.length === 1) { log(`skip record: ${body.slice(0, 200)}`); return [null]; }
      const half = Math.ceil(texts.length / 2);
      return [...(await embed(texts.slice(0, half))), ...(await embed(texts.slice(half)))];
    }
    const wait = Math.min(15 * 60_000, 5000 * 2 ** attempt);
    log(`embed HTTP ${r.status}: ${body.slice(0, 160)} · retry in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}

async function layer(name, rowsSql, vecTable, timeCol) {
  const have = new Set(db.prepare(`SELECT record_id FROM ${vecTable}`).all().map((r) => r.record_id));
  const rows = db.prepare(rowsSql).all().filter((r) => !have.has(r.record_id));
  const total = rows.length + have.size;
  log(`${name}: ${have.size}/${total} already have vectors, ${rows.length} to do`);
  const ins = db.prepare(`INSERT INTO ${vecTable} (record_id, embedding, ${timeCol}) VALUES (?, ?, ?)`);
  const del = db.prepare(`DELETE FROM ${vecTable} WHERE record_id = ?`);
  let done = have.size;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vecs = await embed(batch.map((r) => r.text));
    db.exec("BEGIN");
    try {
      batch.forEach((r, k) => { if (!vecs[k]) return; del.run(r.record_id); ins.run(r.record_id, Buffer.from(vecs[k].buffer), r.t ?? ""); });
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch { /* ignore */ } log(`${name}: write failed, will retry later: ${e.message}`); await sleep(10000); i -= BATCH; continue; }
    done += batch.length;
    fs.writeFileSync(STATE, JSON.stringify({ layer: name, done, total, at: new Date().toISOString() }));
    if ((i / BATCH) % 10 === 0) log(`${name}: ${done}/${total}`);
    await sleep(PAUSE);
  }
  log(`${name}: complete (${done}/${total})`);
}

log(`start · model ${MODEL} · ${dims} dims · batch ${BATCH}`);
await layer("L1", "SELECT record_id, content AS text, updated_time AS t FROM l1_records", "l1_vec", "updated_time");
await layer("L0", "SELECT record_id, message_text AS text, recorded_at AS t FROM l0_conversations", "l0_vec", "recorded_at");
fs.writeFileSync(STATE, JSON.stringify({ layer: "done", at: new Date().toISOString() }));
log("all layers complete");
