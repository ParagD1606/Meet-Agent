import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config } from "../config";
import { log } from "../log";
import { db, lockPool, pool } from "./index";

/** The embedding column's dimension is baked into the generated SQL; make it follow EMBEDDING_DIM. */
async function reconcileEmbeddingDim() {
  const { rows } = await pool.query(
    `select atttypmod as dim from pg_attribute where attrelid = 'memories'::regclass and attname = 'embedding'`,
  );
  const current = rows[0]?.dim as number | undefined;
  if (!current || current === config.EMBEDDING_DIM) return;
  const { rows: cnt } = await pool.query("select count(*)::int as n from memories");
  if (cnt[0].n > 0) {
    throw new Error(
      `EMBEDDING_DIM=${config.EMBEDDING_DIM} but memories.embedding is vector(${current}) with ${cnt[0].n} rows; ` +
        "changing embedding models requires re-embedding (truncate memories or restore the old EMBEDDING_DIM).",
    );
  }
  log.warn("resizing memories.embedding", { from: current, to: config.EMBEDDING_DIM });
  await pool.query("drop index if exists memories_emb_idx");
  await pool.query(`alter table memories alter column embedding type vector(${config.EMBEDDING_DIM})`);
  await pool.query("create index memories_emb_idx on memories using hnsw (embedding vector_cosine_ops)");
}

const MIGRATION_LOCK = 7_300_001;

/** Serialised across processes with a session advisory lock so two booting replicas never race the DDL. */
export async function runMigrations() {
  const client = await lockPool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
    await reconcileEmbeddingDim();
  } finally {
    const unlocked = await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).then(() => true, () => false);
    client.release(!unlocked);
  }
}

if (import.meta.main) {
  await runMigrations();
  await pool.end();
  await lockPool.end();
}
