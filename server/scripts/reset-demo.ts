/**
 * Removes ONLY demo-marked data, so a demo can be re-run from a clean slate without touching real data.
 *   bun run scripts/reset-demo.ts --yes [--dry-run] [--force]
 * Markers (nothing else is ever matched):
 *   meetings      source_file_id LIKE 'demo:%'  |  id LIKE 'mt_demo_%'  |  source_file_id = 'F_DEMO_0930' (scripts/seed-demo.ts)
 *   commitments   source_ref LIKE 'demo:%'  |  LIKE 'seed-demo:%'
 *   memories      source IN ('demo','demo-seed')  |  source_ref LIKE 'demo:%' OR = 'seed-demo' OR LIKE 'seed-demo:%'   (+ their entity links, edges, reminders, reviews;
 *                 entities left with no remaining facts and linked only through demo facts are removed)
 *   fixtures      users 'UDEMO%', channels 'CDEMO%' and their memberships
 * Requires --yes. Refuses NODE_ENV=production without --force. --dry-run only prints the counts. Prints the target database (no password) first.
 */
import { sql } from "drizzle-orm";

const args = new Set(process.argv.slice(2));
export const resetGuard = (a: Set<string>, env = process.env.NODE_ENV): string | null =>
  !a.has("--yes") ? "Refusing to run without --yes (this DELETES demo-marked rows from the database in DATABASE_URL)."
    : env === "production" && !a.has("--force") ? "Refusing to run with NODE_ENV=production without --force." : null;

/** Where DATABASE_URL points, without credentials. */
export const describeDb = (url = process.env.DATABASE_URL ?? ""): string => {
  try { const u = new URL(url); return `${u.hostname || u.searchParams.get("host") || "socket"}:${u.port || u.searchParams.get("port") || "5432"}${u.pathname}`; } catch { return "(unparsable DATABASE_URL)"; }
};

export type ResetCounts = Record<string, number>;

export async function resetDemo(opts: { dryRun?: boolean } = {}): Promise<ResetCounts> {
  const { db } = await import("../src/db");
  const n = async (q: ReturnType<typeof sql>) => Number((await db.execute(q)).rows[0]?.n ?? 0);
  const meetingWhere = sql`source_file_id like 'demo:%' or id like 'mt\_demo\_%' or source_file_id = 'F_DEMO_0930'`;
  const memWhere = sql`source in ('demo', 'demo-seed') or source_ref like 'demo:%' or source_ref = 'seed-demo' or source_ref like 'seed-demo:%'`;
  const comWhere = sql`source_ref like 'demo:%' or source_ref like 'seed-demo:%'`;
  const counts: ResetCounts = {
    meetings: await n(sql`select count(*) n from meetings where ${meetingWhere}`),
    meetingTaskNotifications: await n(sql`select count(*) n from meeting_task_notifications where meeting_id in (select id from meetings where ${meetingWhere})`),
    commitments: await n(sql`select count(*) n from commitments where ${comWhere}`),
    memories: await n(sql`select count(*) n from memories where ${memWhere}`),
    users: await n(sql`select count(*) n from users where id like 'UDEMO%'`),
    channels: await n(sql`select count(*) n from channels where id like 'CDEMO%'`),
  };
  if (opts.dryRun) return counts;

  await db.transaction(async (tx) => {
    const memIds = sql`select id from memories where ${memWhere}`;
    // entities touched only by demo facts: remember them, drop the links, then drop the ones nothing else references
    const ents = (await tx.execute(sql`select distinct entity_id from fact_entities where fact_id in (${memIds})`)).rows.map((r) => String(r.entity_id));
    await tx.execute(sql`delete from fact_entities where fact_id in (${memIds})`);
    await tx.execute(sql`delete from memory_edges where from_id in (${memIds}) or to_id in (${memIds})`);
    await tx.execute(sql`delete from memory_reminders where memory_id in (${memIds})`);
    await tx.execute(sql`delete from memory_reviews where memory_id in (${memIds})`);
    await tx.execute(sql`delete from memories where ${memWhere}`);
    if (ents.length) {
      const list = sql.join(ents.map((e) => sql`${e}`), sql`, `);
      const orphans = (await tx.execute(sql`select id from entities e where id in (${list}) and not exists (select 1 from fact_entities f where f.entity_id = e.id)`)).rows.map((r) => String(r.id));
      if (orphans.length) {
        const o = sql.join(orphans.map((e) => sql`${e}`), sql`, `);
        await tx.execute(sql`delete from entity_summaries where entity_id in (${o})`);
        await tx.execute(sql`delete from entities where id in (${o})`);
      }
    }
    await tx.execute(sql`delete from meeting_task_notifications where meeting_id in (select id from meetings where ${meetingWhere})`);
    await tx.execute(sql`delete from meetings where ${meetingWhere}`);
    await tx.execute(sql`delete from commitments where ${comWhere}`);
    await tx.execute(sql`delete from channel_members where channel_id like 'CDEMO%' or user_id like 'UDEMO%'`);
    await tx.execute(sql`delete from channels where id like 'CDEMO%'`);
    await tx.execute(sql`delete from users where id like 'UDEMO%'`);
  });
  return counts;
}

if (import.meta.main) {
  const problem = resetGuard(args);
  if (problem) { console.error(problem); process.exit(1); }
  console.log(`target database: ${describeDb()}${args.has("--dry-run") ? " (dry run)" : ""}`);
  const counts = await resetDemo({ dryRun: args.has("--dry-run") });
  console.log(`${args.has("--dry-run") ? "would remove" : "removed"}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  process.exit(0);
}
