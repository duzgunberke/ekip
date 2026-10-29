// ekip memory compact: drops exact duplicate conversation rows (same agent, same text: the oldest is
// kept) and tool noise from TencentDB memory-core's SQLite store. Their vectors go with the next
// memory-core start, whose ekip patch rebuilds the vector tables per agent and keeps only vectors that
// still have a conversation row. Runs inside a one-off memory-core container (`--volumes-from` the
// stopped core), so it works the same on a laptop and on a server.
//   node tdai-compact.mjs [path to vectors.db]   (default: $TDAI_DATA_DIR/vectors.db)
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const file = process.argv[2] ?? path.join(process.env.TDAI_DATA_DIR ?? "/data/tdai-memory", "vectors.db");
const db = new DatabaseSync(file);
const count = () => db.prepare("SELECT count(*) AS n FROM l0_conversations").get().n;
const t0 = Date.now(), before = count();
const NOISE = `message_text IN ('[tool_result]', '[tool_result] ', 'Tool loaded.', '[tool_result] (Bash completed with no output)')
  OR length(trim(message_text)) < 3
  OR (message_text LIKE '[Image: original %' AND length(message_text) < 300)
  OR message_text LIKE '[tool_call] ToolSearch(%' OR message_text LIKE '[tool_call] ListAgents(%'`;
db.exec("CREATE TEMP TABLE drop_ids(record_id TEXT PRIMARY KEY)");
db.exec(`INSERT OR IGNORE INTO drop_ids SELECT record_id FROM l0_conversations WHERE ${NOISE}`);
db.exec("INSERT OR IGNORE INTO drop_ids SELECT record_id FROM l0_conversations WHERE rowid NOT IN (SELECT min(rowid) FROM l0_conversations GROUP BY agent_id, message_text)");
const n = db.prepare("SELECT count(*) AS n FROM drop_ids").get().n;
db.exec("BEGIN");
db.exec("DELETE FROM l0_conversations WHERE record_id IN (SELECT record_id FROM drop_ids)");
try { db.exec("DELETE FROM l0_fts WHERE record_id IN (SELECT record_id FROM drop_ids)"); } catch { /* no FTS table */ }
db.exec("COMMIT");
console.log(JSON.stringify({ before, after: count(), removed: n, seconds: Math.round((Date.now() - t0) / 1000) }));
