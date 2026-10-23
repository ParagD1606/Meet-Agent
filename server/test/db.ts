import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { runMigrations } from "../src/db/migrate";

/** Migrates the DATABASE_URL database and truncates every table. Call in beforeAll/beforeEach. */
export async function resetDb() {
  await runMigrations();
  const { rows } = await pool.query(
    "select tablename from pg_tables where schemaname='public' and tablename not like '\\_\\_%' and tablename not like 'pgboss%'",
  );
  const names = rows.map((r) => `"${r.tablename}"`).filter((n) => !n.includes("drizzle"));
  if (names.length) await db.execute(sql.raw(`truncate ${names.join(",")} restart identity cascade`));
}
export { db, pool };
