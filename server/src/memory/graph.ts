import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { memories, memoryEdges } from "../db/schema";
import { clearRecallCache } from "./recall";

export type GraphNode = { id: number; label: string; scope: string; kind: string; source: string };
export type GraphEdge = { source: number; target: number; weight: number; relation: string | null };

export type MemoryRow = {
  id: number; text: string; scopeTag: string; source: string; sourceRef: string | null;
  kind: "fact" | "chunk"; status: "active" | "superseded" | "archived" | "deleted"; createdAt: Date;
  supersededBy: number | null; validAt: Date; invalidAt: Date | null; learnedAt: Date;
  createdBy: string | null; permalink: string | null; confidence: number; importance: number;
  reviewState: "ok" | "pending" | "rejected";
};

const cols = {
  id: memories.id, text: memories.text, scopeTag: memories.scopeTag, source: memories.source,
  sourceRef: memories.sourceRef, kind: memories.kind, status: memories.status, createdAt: memories.createdAt,
  supersededBy: memories.supersededBy, validAt: memories.validAt, invalidAt: memories.invalidAt, learnedAt: memories.learnedAt,
  createdBy: memories.createdBy, permalink: memories.permalink, confidence: memories.confidence,
  importance: memories.importance, reviewState: memories.reviewState,
};

const like = (q: string) => sql`${memories.text} ilike ${`%${q.replace(/[\\%_]/g, "\\$&")}%`}`;

export const MAX_GRAPH_NODES = 5000;

/**
 * Newest live memories in `tags` (optionally filtered by kind/source/text) plus the edges between them.
 * `total` is the number of matching memories; `truncated` says whether `limit` cut the list.
 */
export async function getGraph(a: { tags: string[]; limit: number; kind?: "fact" | "chunk"; source?: string; q?: string }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; total: number; truncated: boolean }> {
  if (!a.tags.length) return { nodes: [], edges: [], total: 0, truncated: false };
  const q = a.q?.trim();
  const where = and(
    inArray(memories.scopeTag, a.tags), eq(memories.status, "active"), isNull(memories.invalidAt), eq(memories.reviewState, "ok"),
    a.kind ? eq(memories.kind, a.kind) : undefined,
    a.source ? eq(memories.source, a.source) : undefined,
    q ? like(q) : undefined,
  );
  const [rows, [count]] = await Promise.all([
    db.select({ id: memories.id, text: memories.text, scopeTag: memories.scopeTag, kind: memories.kind, source: memories.source })
      .from(memories).where(where).orderBy(desc(memories.createdAt), desc(memories.id))
      .limit(Math.max(1, Math.min(a.limit, MAX_GRAPH_NODES))),
    db.select({ n: sql<number>`count(*)::int` }).from(memories).where(where),
  ]);
  const total = count?.n ?? 0;
  if (!rows.length) return { nodes: [], edges: [], total, truncated: false };
  const ids = rows.map((r) => r.id);
  const edges = await db.select().from(memoryEdges)
    .where(and(inArray(memoryEdges.fromId, ids), inArray(memoryEdges.toId, ids)));
  return {
    nodes: rows.map((r) => ({
      id: r.id, label: r.text.length > 80 ? `${r.text.slice(0, 77)}...` : r.text, scope: r.scopeTag, kind: r.kind, source: r.source,
    })),
    edges: edges.map((e) => ({ source: e.fromId, target: e.toId, weight: e.weight, relation: e.relation })),
    total,
    truncated: total > rows.length,
  };
}

/** Paged memories in `tags` (status default "active"), optionally filtered by a case-insensitive substring. */
export async function listMemories(a: { tags: string[]; q?: string; limit: number; offset: number; status?: "active" | "superseded" | "archived" | "deleted" | "all"; includeHeld?: boolean }): Promise<{ items: MemoryRow[]; total: number }> {
  if (!a.tags.length) return { items: [], total: 0 };
  const q = a.q?.trim();
  const status = a.status ?? "active";
  const where = and(
    inArray(memories.scopeTag, a.tags),
    a.includeHeld ? undefined : eq(memories.reviewState, "ok"),
    status === "all" ? sql`${memories.status} <> 'deleted'` : eq(memories.status, status),
    q ? like(q) : undefined,
  );
  const [items, [count]] = await Promise.all([
    db.select(cols).from(memories).where(where).orderBy(desc(memories.createdAt), desc(memories.id))
      .limit(Math.max(1, Math.min(a.limit, 500))).offset(Math.max(0, a.offset)),
    db.select({ n: sql<number>`count(*)::int` }).from(memories).where(where),
  ]);
  return { items, total: count?.n ?? 0 };
}

/**
 * Forgets a memory: soft delete (status 'deleted', invalid_at set, row + edges + history kept, invisible to recall, graph and
 * lists). Rows it superseded are restored (if reviewed ok) or at least un-pointed. Returns whether a live row was deleted.
 */
export async function deleteMemory(id: number): Promise<boolean> {
  const existed = await db.transaction(async (tx) => {
    const del = await tx.update(memories).set({ status: "deleted", invalidAt: new Date() })
      .where(and(eq(memories.id, id), sql`${memories.status} <> 'deleted'`)).returning({ id: memories.id });
    if (!del.length) return false;
    await tx.update(memories).set({ status: "active", invalidAt: null, supersededBy: null })
      .where(and(eq(memories.supersededBy, id), eq(memories.status, "superseded"), eq(memories.reviewState, "ok")));
    await tx.update(memories).set({ supersededBy: null }).where(eq(memories.supersededBy, id));
    return true;
  });
  if (existed) clearRecallCache(); // a cached recall may still contain the deleted or the restored fact
  return existed;
}
