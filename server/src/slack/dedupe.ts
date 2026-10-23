import { lt } from "drizzle-orm";
import { db } from "../db";
import { events } from "../db/schema";

/** Atomically claim an id. True => first time seen (we own processing); false => duplicate/retry. */
export async function claimEvent(id: string): Promise<boolean> {
  const rows = await db.insert(events).values({ id }).onConflictDoNothing().returning({ id: events.id });
  return rows.length > 0;
}

export async function pruneEvents(olderThanMs = 7 * 24 * 3_600_000): Promise<void> {
  await db.delete(events).where(lt(events.createdAt, new Date(Date.now() - olderThanMs)));
}
