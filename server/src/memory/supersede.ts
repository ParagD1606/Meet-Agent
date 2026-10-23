import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "../db";
import { memories, memoryEdges } from "../db/schema";
import { log } from "../log";
import { embed } from "./embed";
import { completeJson } from "./llm";
import { vectorLiteral } from "./search";

/** Cosine similarity at/above which a new fact is considered a duplicate of an existing one. */
export const DUPLICATE_SIMILARITY = 0.97;
/** Neighbours at/above this are shown to the contradiction check and linked with a graph edge. */
export const RELATED_SIMILARITY = 0.4;
const NEIGHBOURS = 5;

const verdict = z.object({ superseded: z.array(z.number().int()) });

const SYSTEM = `You maintain a company knowledge base of short facts. Given a NEW fact and numbered EXISTING facts, list the existing facts that the new fact CONTRADICTS or REPLACES (e.g. a changed owner, deadline, decision, number or status), so they become outdated.
Do NOT list facts that are merely related, more general, or compatible with the new fact.
Reply with JSON only: {"superseded":[<ids>]}. Use {"superseded":[]} if none.`;

export type AddFactResult = { id: number; superseded: number[]; deduped: boolean };

/**
 * Stores a fact in `tag`. Near-duplicates return the existing row; otherwise the nearest same-tag active facts
 * are checked by the LLM for contradictions (those are marked superseded) and related ones are linked by edges.
 * A failing contradiction check never blocks the write (the fact is stored, nothing is superseded).
 */
export async function addFact(a: { tag: string; text: string; source: string; sourceRef?: string | null }): Promise<AddFactResult> {
  // Serialize writers per tag across processes so concurrent identical facts dedupe instead of double-inserting.
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [`memory:${a.tag}`]);
    return await addFactLocked(a);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [`memory:${a.tag}`]).catch(() => {});
    client.release();
  }
}

async function addFactLocked(a: { tag: string; text: string; source: string; sourceRef?: string | null }): Promise<AddFactResult> {
  const text = a.text.trim();
  if (!text) throw new Error("addFact: empty text");
  const [qv] = await embed([text]);
  const vec = vectorLiteral(qv!);
  const dist = sql`${memories.embedding} <=> ${vec}::vector`;
  const near = await db
    .select({ id: memories.id, text: memories.text, sim: sql<number>`1 - (${dist})` })
    .from(memories)
    .where(and(eq(memories.scopeTag, a.tag), eq(memories.status, "active"), eq(memories.kind, "fact")))
    .orderBy(dist)
    .limit(NEIGHBOURS);

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const dup = near.find((n) => Number(n.sim) >= DUPLICATE_SIMILARITY || norm(n.text) === norm(text));
  if (dup) return { id: dup.id, superseded: [], deduped: true };

  const related = near.filter((n) => Number(n.sim) >= RELATED_SIMILARITY);
  let contradicted: number[] = [];
  if (related.length) {
    try {
      const prompt = `NEW: ${text}\n\nEXISTING:\n${related.map((r) => `[${r.id}] ${r.text}`).join("\n")}`;
      const v = await completeJson({ system: SYSTEM, prompt }, verdict);
      const allowed = new Set(related.map((r) => r.id));
      contradicted = [...new Set(v.superseded)].filter((id) => allowed.has(id));
    } catch (e) {
      log.warn("memory contradiction check failed", { err: String(e) });
    }
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(memories)
      .values({ scopeTag: a.tag, text, embedding: qv!, source: a.source, sourceRef: a.sourceRef ?? null, kind: "fact" })
      .returning({ id: memories.id });
    const id = row!.id;
    if (contradicted.length) {
      await tx.update(memories).set({ status: "superseded", supersededBy: id })
        .where(and(inArray(memories.id, contradicted), eq(memories.scopeTag, a.tag)));
    }
    if (related.length) {
      await tx.insert(memoryEdges).values(related.map((r) => ({ fromId: id, toId: r.id, weight: Number(r.sim) })))
        .onConflictDoNothing();
    }
    return { id, superseded: contradicted, deduped: false };
  });
}
