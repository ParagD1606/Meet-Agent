import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { memories, memoryReviews, recallLog } from "../db/schema";
import { log } from "../log";
import { clearRecallCache } from "../memory/recall";

export const DOWN_DELTA = -0.15;
export const UP_DELTA = 0.05;
const WINDOW_MS = 15 * 60_000;

/** The memory ids the turn that produced bot message `messageTs` recalled (recall_log is keyed by the user message that triggered the turn). */
export async function recalledFor(a: { channelId: string; messageTs: string; threadTs?: string | null }): Promise<number[]> {
  const at = Number(a.messageTs) * 1000;
  if (!Number.isFinite(at)) return [];
  const rows = await db.select({ hitIds: recallLog.hitIds }).from(recallLog).where(and(
    eq(recallLog.channelId, a.channelId),
    a.threadTs ? eq(recallLog.threadKey, a.threadTs) : undefined,
    lte(recallLog.createdAt, new Date(at + 5_000)),
    gte(recallLog.createdAt, new Date(at - WINDOW_MS)),
  )).orderBy(desc(recallLog.createdAt)).limit(a.threadTs ? 1 : 2);
  // without a thread several turns in the channel fit the window: guessing would blame another turn's facts
  return !a.threadTs && rows.length > 1 ? [] : rows[0]?.hitIds ?? [];
}

/**
 * Learn from one NEW rating (the caller skips repeats): thumbs-down lowers the recalled facts' importance and queues each for
 * admin review (kind low_confidence, one pending review per fact); thumbs-up nudges importance up slightly.
 * ponytail: every recalled fact is blamed equally; weight by rank/score if reviews get noisy.
 */
export async function applyFeedback(a: { channelId: string; messageTs: string; userId: string; rating: "up" | "down"; threadTs?: string | null }): Promise<number[]> {
  try {
    const ids = await recalledFor(a);
    if (!ids.length) return [];
    const delta = a.rating === "down" ? DOWN_DELTA : UP_DELTA;
    await db.transaction(async (tx) => {
      await tx.update(memories).set({ importance: sql`least(1, greatest(0.05, ${memories.importance} + ${delta}))` }).where(inArray(memories.id, ids));
      if (a.rating !== "down") return;
      const pending = new Set((await tx.select({ id: memoryReviews.memoryId }).from(memoryReviews)
        .where(and(eq(memoryReviews.kind, "low_confidence"), eq(memoryReviews.status, "pending"), inArray(memoryReviews.memoryId, ids)))).map((r) => r.id));
      const fresh = ids.filter((id) => !pending.has(id));
      if (fresh.length) {
        await tx.insert(memoryReviews).values(fresh.map((memoryId) => ({
          id: newId("rv_"), kind: "low_confidence" as const, memoryId,
          payload: { reason: "thumbs_down", channelId: a.channelId, messageTs: a.messageTs }, requestedBy: a.userId,
        })));
      }
    });
    clearRecallCache();
    return ids;
  } catch (e) {
    log.warn("feedback learning failed", { error: String(e) });
    return [];
  }
}
