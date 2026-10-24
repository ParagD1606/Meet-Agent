import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { memories, memoryReviews } from "../db/schema";
import { log } from "../log";
import { applyCoreBlockReview } from "./core-blocks";
import { clearRecallCache } from "./recall";

export type Review = typeof memoryReviews.$inferSelect;

/** Newest first; `status` defaults to everything. Admin-only at the route layer. */
export async function listReviews(status?: "pending" | "approved" | "rejected", limit = 200): Promise<Review[]> {
  return db.select().from(memoryReviews)
    .where(status ? eq(memoryReviews.status, status) : undefined)
    .orderBy(desc(memoryReviews.createdAt)).limit(limit);
}

/** Reviews an admin surface may show: shared-scope ones only (private channel / DM text never reaches the review UIs). */
export async function sharedReviews(rows: Review[]): Promise<Review[]> {
  const out: Review[] = [];
  for (const r of rows) {
    if (r.kind === "core_block") { if ((r.payload as Record<string, unknown>).tag === "shared") out.push(r); continue; }
    if (r.memoryId == null) continue;
    const [m] = await db.select({ tag: memories.scopeTag }).from(memories).where(eq(memories.id, r.memoryId));
    if (m?.tag === "shared") out.push(r);
  }
  return out;
}

export type DecideResult = { ok: boolean; status?: "approved" | "rejected"; error?: string };

/**
 * Approve or reject one pending review (idempotent: a second decision is a no-op error). Effects:
 *  - core_block: approve applies the queued edit.
 *  - low_confidence / shared_write: approve makes the held fact live (and applies the supersession it would have caused); reject marks it rejected.
 *  - supersede: reject reactivates the facts the LLM superseded and rejects the new fact; approve keeps the history as is.
 */
export async function decideReview(id: string, userId: string, approve: boolean): Promise<DecideResult> {
  return db.transaction(async (tx) => {
    const [rv] = await tx.select().from(memoryReviews).where(eq(memoryReviews.id, id)).for("update");
    if (!rv) return { ok: false, error: "not_found" };
    if (rv.status !== "pending") return { ok: false, error: "already_decided" };
    const p = rv.payload as Record<string, unknown>;

    if (rv.kind === "core_block") {
      if (approve) {
        const r = await applyCoreBlockReview(p as Parameters<typeof applyCoreBlockReview>[0], userId);
        if (!r.ok) return { ok: false, error: r.error ?? "edit_failed" };
      }
    } else if (rv.memoryId != null) {
      if (rv.kind === "supersede") {
        if (!approve) {
          const ids = ((p.supersededIds as number[] | undefined) ?? []).filter((n) => Number.isInteger(n));
          if (ids.length) {
            await tx.update(memories).set({ status: "active", supersededBy: null, invalidAt: null })
              .where(and(inArray(memories.id, ids), eq(memories.supersededBy, rv.memoryId)));
          }
          await tx.update(memories).set({ reviewState: "rejected" }).where(eq(memories.id, rv.memoryId));
        }
      } else if (approve) {
        await tx.update(memories).set({ reviewState: "ok" }).where(eq(memories.id, rv.memoryId));
        const would = ((p.wouldSupersede as number[] | undefined) ?? []).filter((n) => Number.isInteger(n));
        if (would.length) {
          await tx.update(memories).set({ status: "superseded", supersededBy: rv.memoryId, invalidAt: new Date() })
            .where(and(inArray(memories.id, would), eq(memories.status, "active")));
        }
      } else {
        await tx.update(memories).set({ reviewState: "rejected" }).where(eq(memories.id, rv.memoryId));
      }
    }
    await tx.update(memoryReviews)
      .set({ status: approve ? "approved" : "rejected", decidedBy: userId, decidedAt: new Date() })
      .where(eq(memoryReviews.id, id));
    log.info("memory review decided", { id, kind: rv.kind, approve, by: userId });
    clearRecallCache();
    return { ok: true, status: approve ? "approved" : "rejected" };
  });
}
