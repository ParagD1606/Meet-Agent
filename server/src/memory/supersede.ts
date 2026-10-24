import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { memories, memoryEdges, memoryReviews } from "../db/schema";
import { log } from "../log";
import type { AgentContext } from "./core-blocks";
import { attachMentions, type Mention } from "./entities";
import { embed } from "./embed";
import { clearRecallCache } from "./recall";
import { completeJson } from "./llm";
import { SHARED_TAG } from "./scope";
import { vectorLiteral } from "./search";

/** Cosine similarity at/above which a new fact is considered a duplicate of an existing one. */
export const DUPLICATE_SIMILARITY = 0.97;
/** Neighbours at/above this are shown to the contradiction check and linked with a graph edge. */
export const RELATED_SIMILARITY = 0.4;
/** Shared facts below this confidence are held for admin review instead of going live. */
export const LOW_CONFIDENCE = 0.5;
const NEIGHBOURS = 5;

/** What gets embedded: the contextual prefix (if any) followed by the fact. */
export const embedText = (text: string, prefix?: string | null) => (prefix ? `${prefix}\n${text}` : text);

const verdict = z.object({ superseded: z.array(z.number().int()) });

const SYSTEM = `You maintain a company knowledge base of short facts. Given a NEW fact and numbered EXISTING facts, list the existing facts that the new fact CONTRADICTS or REPLACES (e.g. a changed owner, deadline, decision, number or status), so they become outdated.
Do NOT list facts that are merely related, more general, or compatible with the new fact.
Reply with JSON only: {"superseded":[<ids>]}. Use {"superseded":[]} if none.`;

/** Which of `existing` does `text` contradict or replace? Empty on any LLM failure (a failing check never blocks a write). */
export async function findContradicted(text: string, existing: { id: number; text: string }[]): Promise<number[]> {
  if (!existing.length) return [];
  try {
    const prompt = `NEW: ${text}\n\nEXISTING:\n${existing.map((r) => `[${r.id}] ${r.text}`).join("\n")}`;
    const v = await completeJson({ system: SYSTEM, prompt, role: "extract", maxOutputTokens: 120 }, verdict);
    const allowed = new Set(existing.map((r) => r.id));
    return [...new Set(v.superseded)].filter((id) => allowed.has(id));
  } catch (e) {
    log.warn("memory contradiction check failed", { err: String(e) });
    return [];
  }
}

export type AddFactInput = {
  tag: string; text: string; source: string; sourceRef?: string | null;
  createdBy?: string | null; permalink?: string | null; confidence?: number; importance?: number; validAt?: Date;
  /** Who is writing. Anything but primary/consolidation writing to "shared" is held for admin review. */
  agentContext?: AgentContext;
  factType?: "fact" | "preference" | "decision" | "procedure" | "opinion";
  /** Forget-after horizon: the fact stops being recalled (but stays as history) after this instant. */
  validUntil?: Date | null;
  /** One-line who/channel/date/topic context, embedded and keyword-indexed with the text. */
  contextPrefix?: string | null;
  /** Precomputed embedding (batched by the caller); must already include the context prefix if there is one. */
  embedding?: number[];
  /** Entities named in the fact; resolved (alias / embedding / LLM tie-break) and linked after the write. */
  entities?: Mention[];
};
export type AddFactResult = { id: number; superseded: number[]; deduped: boolean; heldForReview?: boolean; reviewId?: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Stores a fact in `tag`. Near-duplicates return the existing row; otherwise the nearest same-tag active facts
 * are checked by the LLM for contradictions. Contradicted facts get `invalid_at` + status superseded (rows are kept as history).
 * Embedding and the LLM check run lock-free; the per-tag advisory lock is a transaction-scoped lock held only for the
 * final re-check + insert, so it can never leak past a failed unlock and never spans an LLM call.
 * A failing contradiction check never blocks the write.
 */
export async function addFact(a: AddFactInput): Promise<AddFactResult> {
  const r = await addFactCore(a);
  if (!r.deduped) clearRecallCache(); // after COMMIT: a recall racing the in-tx clear could re-cache pre-commit state
  // also on a dedupe: a repeat mention may name entities the first one did not (links are idempotent)
  if (a.entities?.length) await attachMentions(r.id, a.entities, a.text);
  return r;
}

async function addFactCore(a: AddFactInput): Promise<AddFactResult> {
  const text = a.text.trim();
  if (!text) throw new Error("addFact: empty text");
  const confidence = clamp01(a.confidence ?? 1);
  const shared = a.tag === SHARED_TAG;
  const ctx = a.agentContext ?? "primary";
  const writerHeld = shared && ctx !== "primary" && ctx !== "consolidation";
  const held = shared && (confidence < LOW_CONFIDENCE || writerHeld);
  const validAt = a.validAt ?? new Date();

  // Rejected rows never count; pending rows only dedupe other held writes (so a primary write is not swallowed by a held one).
  const states: ("ok" | "pending")[] = held ? ["ok", "pending"] : ["ok"];
  const prefix = a.contextPrefix?.trim() || null;
  const qv = a.embedding ?? (await embed([embedText(text, prefix)]))[0]!;
  const vec = vectorLiteral(qv);
  const dist = sql`${memories.embedding} <=> ${vec}::vector`;
  const nearQuery = (n: number) => db
    .select({ id: memories.id, text: memories.text, sim: sql<number>`1 - (${dist})` })
    .from(memories)
    .where(and(eq(memories.scopeTag, a.tag), eq(memories.status, "active"), eq(memories.kind, "fact"), isNull(memories.invalidAt), inArray(memories.reviewState, states)))
    .orderBy(dist)
    .limit(n);
  const isDup = (n: { text: string; sim: number }) => Number(n.sim) >= DUPLICATE_SIMILARITY || norm(n.text) === norm(text);

  const near = await nearQuery(NEIGHBOURS);
  const dup = near.find(isDup);
  if (dup) return { id: dup.id, superseded: [], deduped: true };

  const related = near.filter((n) => Number(n.sim) >= RELATED_SIMILARITY);
  const contradicted = await findContradicted(text, related);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`memory:${a.tag}`}))`);
    // A concurrent writer may have stored the same fact while we were embedding / asking the LLM.
    const racers = await tx
      .select({ id: memories.id, text: memories.text, sim: sql<number>`1 - (${dist})` })
      .from(memories)
      .where(and(eq(memories.scopeTag, a.tag), eq(memories.status, "active"), eq(memories.kind, "fact"), isNull(memories.invalidAt), inArray(memories.reviewState, states)))
      .orderBy(dist)
      .limit(2);
    const racer = racers.find(isDup);
    if (racer) return { id: racer.id, superseded: [], deduped: true };

    const [row] = await tx
      .insert(memories)
      .values({
        scopeTag: a.tag, text, embedding: qv, source: a.source, sourceRef: a.sourceRef ?? null, kind: "fact",
        createdBy: a.createdBy ?? null, permalink: a.permalink ?? null, confidence,
        importance: clamp01(a.importance ?? 0.5), validAt, reviewState: held ? "pending" : "ok",
        factType: a.factType ?? "fact", validUntil: a.validUntil ?? null, contextPrefix: prefix, sourceScope: a.tag,
      })
      .returning({ id: memories.id });
    const id = row!.id;

    let superseded: number[] = [];
    if (contradicted.length && !held) {
      const done = await tx.update(memories)
        .set({ status: "superseded", supersededBy: id, invalidAt: validAt })
        .where(and(inArray(memories.id, contradicted), eq(memories.scopeTag, a.tag), eq(memories.status, "active")))
        .returning({ id: memories.id });
      superseded = done.map((d) => d.id);
    }
    if (related.length) {
      await tx.insert(memoryEdges).values(related.map((r) => ({ fromId: id, toId: r.id, weight: Number(r.sim), relation: superseded.includes(r.id) ? "supersedes" : null }))).onConflictDoNothing();
    }

    let reviewId: string | undefined;
    if (shared && held) {
      reviewId = newId("rv_");
      await tx.insert(memoryReviews).values({
        id: reviewId, kind: writerHeld ? "shared_write" : "low_confidence", memoryId: id,
        payload: { text, confidence, agentContext: ctx, wouldSupersede: contradicted }, requestedBy: a.createdBy ?? null,
      });
    } else if (shared && superseded.length) {
      reviewId = newId("rv_");
      await tx.insert(memoryReviews).values({
        id: reviewId, kind: "supersede", memoryId: id,
        payload: { text, supersededIds: superseded }, requestedBy: a.createdBy ?? null,
      });
    }
    clearRecallCache();
    return { id, superseded, deduped: false, ...(held ? { heldForReview: true } : {}), ...(reviewId ? { reviewId } : {}) };
  });
}
