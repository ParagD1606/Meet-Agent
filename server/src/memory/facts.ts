import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { memories } from "../db/schema";
import { deleteMemory, type MemoryRow } from "./graph";
import { hasSecret } from "./ambient";
import { scanMemoryText } from "./core-blocks";
import { clearRecallCache } from "./recall";
import { searchMemory } from "./search";
import { addFact, type AddFactInput, type AddFactResult } from "./supersede";

export { addFact, type AddFactInput, type AddFactResult } from "./supersede";

const MAX_CHAIN = 50;

/** Every version of a fact: all ancestors it replaced and the successors that replaced it, oldest first. */
export async function getMemoryHistory(id: number): Promise<MemoryRow[]> {
  const seen = new Set<number>([id]);
  let frontier = [id];
  // ancestors: rows whose superseded_by points into the chain
  while (frontier.length && seen.size < MAX_CHAIN) {
    const older = await db.select({ id: memories.id }).from(memories).where(inArray(memories.supersededBy, frontier));
    frontier = older.map((o) => o.id).filter((x) => !seen.has(x));
    frontier.forEach((x) => seen.add(x));
  }
  // successors: follow superseded_by forward
  let cur: number | null = id;
  while (cur != null && seen.size < MAX_CHAIN) {
    const [r] = await db.select({ next: memories.supersededBy }).from(memories).where(eq(memories.id, cur));
    cur = r?.next ?? null;
    if (cur != null) seen.add(cur);
  }
  const rows = await db.select().from(memories).where(inArray(memories.id, [...seen])).orderBy(asc(memories.validAt), asc(memories.id));
  return rows.map((r) => ({
    id: r.id, text: r.text, scopeTag: r.scopeTag, source: r.source, sourceRef: r.sourceRef, kind: r.kind, status: r.status,
    createdAt: r.createdAt, supersededBy: r.supersededBy, validAt: r.validAt, invalidAt: r.invalidAt, learnedAt: r.learnedAt,
    createdBy: r.createdBy, permalink: r.permalink, confidence: r.confidence, importance: r.importance, reviewState: r.reviewState,
  }));
}

/** Scans (injection / invisible unicode) then stores a fact with provenance. Throws on unsafe text. */
export async function rememberFact(a: AddFactInput): Promise<AddFactResult> {
  const bad = scanMemoryText(a.text);
  if (bad) throw new Error(bad);
  if (hasSecret(a.text)) throw new Error("That looks like it contains a password, token or key, so I won't store it.");
  return addFact(a);
}

/**
 * Finds (and, unless dryRun, soft-deletes: status 'deleted', history kept) facts matching `query` within `tags` only. Hard matches: similarity-ranked top hits
 * with a high score floor, so a vague query cannot wipe unrelated memories. Returns what matched.
 */
export async function forgetMemories(a: { tags: string[]; query: string; dryRun?: boolean; max?: number }): Promise<{ id: number; text: string; scopeTag: string }[]> {
  if (!a.tags.length) return [];
  const hits = await searchMemory({ tags: a.tags, query: a.query, limit: a.max ?? 5 });
  const matched = hits.filter((h) => h.kind === "fact" && h.score >= 0.45).slice(0, a.max ?? 5);
  if (!(a.dryRun ?? true)) {
    for (const h of matched) await deleteMemory(h.id);
    clearRecallCache();
  }
  return matched.map((h) => ({ id: h.id, text: h.text, scopeTag: h.scopeTag }));
}
