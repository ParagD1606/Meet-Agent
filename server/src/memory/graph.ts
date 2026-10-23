import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { memories, memoryEdges } from "../db/schema";

export type GraphNode = { id: number; label: string; scope: string; kind: string };
export type GraphEdge = { source: number; target: number; weight: number };

export type MemoryRow = {
  id: number; text: string; scopeTag: string; source: string; sourceRef: string | null;
  kind: "fact" | "chunk"; status: "active" | "superseded"; createdAt: Date;
};

const cols = {
  id: memories.id, text: memories.text, scopeTag: memories.scopeTag, source: memories.source,
  sourceRef: memories.sourceRef, kind: memories.kind, status: memories.status, createdAt: memories.createdAt,
};

/** Newest active memories in `tags` plus the edges between them. Empty `tags` yields an empty graph. */
export async function getGraph(a: { tags: string[]; limit: number }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  if (!a.tags.length) return { nodes: [], edges: [] };
  const rows = await db.select({ id: memories.id, text: memories.text, scopeTag: memories.scopeTag, kind: memories.kind })
    .from(memories)
    .where(and(inArray(memories.scopeTag, a.tags), eq(memories.status, "active")))
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(Math.max(1, Math.min(a.limit, 2000)));
  if (!rows.length) return { nodes: [], edges: [] };
  const ids = rows.map((r) => r.id);
  const edges = await db.select().from(memoryEdges)
    .where(and(inArray(memoryEdges.fromId, ids), inArray(memoryEdges.toId, ids)));
  return {
    nodes: rows.map((r) => ({
      id: r.id, label: r.text.length > 80 ? `${r.text.slice(0, 77)}...` : r.text, scope: r.scopeTag, kind: r.kind,
    })),
    edges: edges.map((e) => ({ source: e.fromId, target: e.toId, weight: e.weight })),
  };
}

/** Paged active memories in `tags`, optionally filtered by a case-insensitive substring. */
export async function listMemories(a: { tags: string[]; q?: string; limit: number; offset: number }): Promise<{ items: MemoryRow[]; total: number }> {
  if (!a.tags.length) return { items: [], total: 0 };
  const q = a.q?.trim();
  const where = and(
    inArray(memories.scopeTag, a.tags),
    eq(memories.status, "active"),
    q ? sql`${memories.text} ilike ${`%${q.replace(/[\\%_]/g, "\\$&")}%`}` : undefined,
  );
  const [items, [count]] = await Promise.all([
    db.select(cols).from(memories).where(where).orderBy(desc(memories.createdAt), desc(memories.id))
      .limit(Math.max(1, Math.min(a.limit, 500))).offset(Math.max(0, a.offset)),
    db.select({ n: sql<number>`count(*)::int` }).from(memories).where(where),
  ]);
  return { items, total: count?.n ?? 0 };
}

/** Hard-deletes a memory and its edges; rows it superseded are left superseded but un-pointed. Returns whether it existed. */
export async function deleteMemory(id: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const del = await tx.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id });
    if (!del.length) return false;
    await tx.delete(memoryEdges).where(sql`${memoryEdges.fromId} = ${id} or ${memoryEdges.toId} = ${id}`);
    await tx.update(memories).set({ supersededBy: null }).where(eq(memories.supersededBy, id));
    return true;
  });
}
