import { eq, lt } from "drizzle-orm";
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

/** Give the claim back (handler failed before doing the work) so Slack's retry or a redelivery can process the event. */
export async function releaseEvent(id: string): Promise<void> {
  await db.delete(events).where(eq(events.id, id));
}

/** Claim, run, and release the claim if `fn` throws. Returns false for duplicates. */
export async function withEventClaim(id: string, fn: () => Promise<void>): Promise<boolean> {
  if (!(await claimEvent(id))) return false;
  try { await fn(); } catch (e) { await releaseEvent(id).catch(() => {}); throw e; }
  return true;
}
