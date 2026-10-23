import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config";
import { log } from "../log";
import * as schema from "./schema";

/** Pool for queries. Bounded so a leak shows up as a timeout error instead of a silent hang. */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000,
});
/**
 * Separate pool that only ever holds session-level advisory locks (one connection per running turn / memory write).
 * Lock holders issue their queries on `pool`, so exhausting one pool can never deadlock the other.
 */
export const lockPool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_LOCK_POOL_MAX,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 30_000,
});
// An idle client dying (server restart, network) emits 'error' on the pool; unhandled it would crash the process.
pool.on("error", (err) => log.error("pg pool error", { err: String(err) }));
lockPool.on("error", (err) => log.error("pg lock pool error", { err: String(err) }));

export const db = drizzle(pool, { schema });
export type Db = typeof db;
