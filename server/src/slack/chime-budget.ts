import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { chimeLog } from "../db/schema";

export const CHIME_MAX_PER_HOUR = 3;
export const CHIME_MIN_GAP_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

export type BudgetVerdict = { allowed: true } | { allowed: false; reason: "hourly_cap" | "min_gap" };

/** Pure: `recent` are chime timestamps (ms) for ONE channel. */
export function evaluateBudget(recent: number[], nowMs: number): BudgetVerdict {
  const inHour = recent.filter((t) => nowMs - t < HOUR_MS);
  if (inHour.length >= CHIME_MAX_PER_HOUR) return { allowed: false, reason: "hourly_cap" };
  if (inHour.some((t) => nowMs - t < CHIME_MIN_GAP_MS)) return { allowed: false, reason: "min_gap" };
  return { allowed: true };
}

/**
 * Atomically check the per-channel budget and, if allowed, record the chime. The advisory lock makes
 * concurrent messages in one channel serialize, so two racing messages can't both slip under the cap.
 */
export async function reserveChime(channelId: string, threadTs?: string, now = new Date()): Promise<BudgetVerdict> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"chime:" + channelId}))`);
    const rows = await tx.select({ at: chimeLog.at }).from(chimeLog)
      .where(and(eq(chimeLog.channelId, channelId), gt(chimeLog.at, new Date(now.getTime() - HOUR_MS))));
    const verdict = evaluateBudget(rows.map((r) => r.at.getTime()), now.getTime());
    if (verdict.allowed) {
      await tx.insert(chimeLog).values({ channelId, threadTs: threadTs ?? null, at: now });
      // housekeeping: rows older than a day are irrelevant to the budget
      await tx.delete(chimeLog).where(lt(chimeLog.at, new Date(now.getTime() - 24 * HOUR_MS)));
    }
    return verdict;
  });
}
