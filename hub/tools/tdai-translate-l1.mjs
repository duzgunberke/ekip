// Rewrites L1 memories that the extractor wrote in Chinese/Japanese into Turkish, inside the
// tdai-memory-core container (same DB, same FTS tokenizer, same embedding model as memory-core):
// l1_records.content, the l1_fts row and the l1_vec vector change together. Resumable: a record
// that no longer contains CJK text is skipped. Run with `node --import tsx` so the tokenizer loads.
//
//   docker cp tdai-translate-l1.mjs tdai-memory-core:/app/translate-l1.mjs
//   docker exec -d -w /app -e LLM_URL=http://freellmapi:3001/v1 -e LLM_KEY=... -e LLM_MODEL=auto:translate \
//     -e EMBED_MODEL=nemotron-3-embed-1b tdai-memory-core node --import tsx /app/translate-l1.mjs
// Progress: /data/tdai-memory/translate.log
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "/app/node_modules/sqlite-vec/index.mjs";
import { tokenizeForFts } from "/app/src/core/store/tokenize.ts";

const DB = process.env.TDAI_DB ?? "/data/tdai-memory/vectors.db";
// auto:translate is a freellmapi profile of fast models kept apart from the busy memory profile
const { LLM_URL, LLM_KEY, LLM_MODEL = "auto:translate", EMBED_MODEL } = process.env;
const BATCH = Number(process.env.BATCH ?? 10), LOG = "/data/tdai-memory/translate.log";
const CJK = /[぀-ヿ一-鿿]/;
const log = (s) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// APPLY_FILE=/path.json: apply translations made elsewhere ({record_id: text}), no LLM calls.
const APPLY = process.env.APPLY_FILE ? JSON.parse(fs.readFileSync(process.env.APPLY_FILE, 'utf8')) : null;
if ((!APPLY && (!LLM_URL || !LLM_KEY)) || !EMBED_MODEL) { console.error("LLM_URL, LLM_KEY, EMBED_MODEL are required"); process.exit(2); }

// one copy at a time: a second run would compete for the same free-pool quota and rows
const LOCK = `/data/tdai-memory/translate-${process.env.SHARD ?? 0}.lock`;
try { const pid = Number(fs.readFileSync(LOCK, "utf8")); process.kill(pid, 0); console.error(`already running (pid ${pid})`); process.exit(0); } catch { /* free */ }
fs.writeFileSync(LOCK, String(process.pid));
process.on("exit", () => { try { if (fs.readFileSync(LOCK, "utf8") === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* ignore */ } });

const db = new DatabaseSync(DB, { allowExtension: true });
sqliteVec.load(db);
db.exec("PRAGMA busy_timeout = 15000");

async function post(path, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${LLM_URL}${path}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (r.ok) return r.json();
    const wait = Math.min(10 * 60_000, 5000 * 2 ** attempt);
    log(`${path} HTTP ${r.status}: ${(await r.text()).slice(0, 160)} · retry in ${Math.round(wait / 1000)}s`);
    if (attempt >= 6) throw new Error(`${path} failed`);
    await sleep(wait);
  }
}

const PROMPT = `Translate each memory below into natural Turkish. These are facts an AI assistant remembers about
its user (Berke) and his software projects. Keep code, file paths, commands, identifiers, URLs, numbers,
product and project names exactly as they are. Do not add or drop information. Answer with ONLY a JSON array
of strings, one per input, in the same order.`;

async function translate(texts, batchRows) {
  if (APPLY) return batchRows.map((r) => APPLY[r.record_id] ?? r.content);
  const j = await post("/chat/completions", {
    model: LLM_MODEL, temperature: 0.1,
    messages: [{ role: "system", content: PROMPT }, { role: "user", content: JSON.stringify(texts) }],
  });
  const raw = j.choices?.[0]?.message?.content ?? "";
  const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
  if (!Array.isArray(arr) || arr.length !== texts.length || arr.some((t) => typeof t !== "string" || !t.trim())) throw new Error("bad shape");
  return arr;
}

const embed = async (texts) => (await post("/embeddings", { model: EMBED_MODEL, input: texts })).data
  .sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));

// SHARD=k SHARDS=n: run n copies side by side, each takes every n-th record (no overlap)
const SHARD = Number(process.env.SHARD ?? 0), SHARDS = Number(process.env.SHARDS ?? 1);
const rows = db.prepare("SELECT record_id, content FROM l1_records").all()
  .filter((r, i) => CJK.test(r.content) && (!APPLY || r.record_id in APPLY) && [...r.record_id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % SHARDS === SHARD);
log(`start${SHARDS > 1 ? ` shard ${SHARD}/${SHARDS}` : ""} · ${rows.length} records with CJK text · model ${LLM_MODEL}`);
const upd = db.prepare("UPDATE l1_records SET content = ? WHERE record_id = ?");
const updFts = db.prepare("UPDATE l1_fts SET content = ?, content_original = ? WHERE record_id = ?");
const vecTime = db.prepare("SELECT updated_time FROM l1_vec WHERE record_id = ?");
const delVec = db.prepare("DELETE FROM l1_vec WHERE record_id = ?");
const insVec = db.prepare("INSERT INTO l1_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)");
let done = 0, skipped = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  let out;
  try { out = await translate(batch.map((r) => r.content), batch); }
  catch (e) {
    // a model that answers in the wrong shape: try once more, then leave the batch for a later run
    try { out = await translate(batch.map((r) => r.content), batch); } catch { skipped += batch.length; log(`batch ${i}: skipped (${e.message})`); continue; }
  }
  const keep = batch.map((r, k) => [r, out[k]]).filter(([, t]) => !CJK.test(t));
  if (!keep.length) { skipped += batch.length; continue; }
  const vecs = await embed(keep.map(([, t]) => t));
  db.exec("BEGIN");
  try {
    keep.forEach(([r, t], k) => {
      upd.run(t, r.record_id);
      updFts.run(tokenizeForFts(t), t, r.record_id);
      const time = vecTime.get(r.record_id)?.updated_time ?? "";
      delVec.run(r.record_id);
      insVec.run(r.record_id, Buffer.from(vecs[k].buffer), time);
    });
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* ignore */ } log(`batch ${i}: write failed: ${e.message}`); await sleep(5000); continue; }
  done += keep.length; skipped += batch.length - keep.length;
  if ((i / BATCH) % 10 === 0) log(`${done}/${rows.length} translated, ${skipped} skipped`);
  await sleep(APPLY ? 0 : 500);
}
log(`complete · ${done} translated, ${skipped} left for a later run`);
