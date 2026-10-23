import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { memories } from "../db/schema";
import { embed } from "./embed";

export type MemoryHit = {
  id: number;
  text: string;
  scopeTag: string;
  source: string;
  sourceRef: string | null;
  /** Reciprocal-rank-fusion score normalised to 0..1 (1 = top of both the vector and keyword lists). */
  score: number;
  createdAt: Date;
  kind: "fact" | "chunk";
  importance: number;
  confidence: number;
  accessCount: number;
  validAt: Date;
  lastAccessedAt: Date | null;
  createdBy: string | null;
  permalink: string | null;
};

export const DEFAULT_LIMIT = 40;
/** Minimum cosine similarity for a vector-only hit. Keyword (tsvector) matches are always eligible. */
export const SIMILARITY_THRESHOLD = 0.3;
const RRF_K = 60;

export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function tsQueryOf(q: string): string | null {
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 24);
  return words.length ? words.join(" | ") : null;
}

/**
 * Hybrid search restricted to `tags`. Throws if `tags` is empty (no implicit scope). Default: facts that are currently
 * valid (status active, not invalidated, review ok). With `asOf`: what was true at that instant (bi-temporal, history included).
 */
export async function searchMemory(a: { tags: string[]; query: string; limit?: number; asOf?: Date }): Promise<MemoryHit[]> {
  if (!a.tags?.length) throw new Error("searchMemory requires a non-empty tags list");
  const limit = Math.max(1, Math.min(a.limit ?? DEFAULT_LIMIT, 200));
  const query = a.query.trim();
  if (!query) return [];
  const pool = Math.max(limit * 2, 50);
  const validity = a.asOf
    ? and(
        sql`${memories.validAt} <= ${a.asOf}`,
        or(sql`${memories.invalidAt} > ${a.asOf}`, and(isNull(memories.invalidAt), eq(memories.status, "active"))),
      )
    : and(eq(memories.status, "active"), isNull(memories.invalidAt));
  const where = and(inArray(memories.scopeTag, a.tags), eq(memories.reviewState, "ok"), validity);
  const cols = {
    id: memories.id, text: memories.text, scopeTag: memories.scopeTag, source: memories.source,
    sourceRef: memories.sourceRef, createdAt: memories.createdAt, kind: memories.kind, importance: memories.importance,
    confidence: memories.confidence, accessCount: memories.accessCount, validAt: memories.validAt,
    lastAccessedAt: memories.lastAccessedAt, createdBy: memories.createdBy, permalink: memories.permalink,
  };

  const [qv] = await embed([query]);
  const vec = vectorLiteral(qv!);
  const dist = sql`${memories.embedding} <=> ${vec}::vector`;
  const vectorRows = await db.select({ ...cols, sim: sql<number>`1 - (${dist})` }).from(memories).where(where)
    .orderBy(dist).limit(pool);

  const tsq = tsQueryOf(query);
  const ftsRows = tsq
    ? await db.select(cols).from(memories)
        .where(and(where, sql`${memories.tsv} @@ to_tsquery('english', ${tsq})`))
        .orderBy(sql`ts_rank_cd(${memories.tsv}, to_tsquery('english', ${tsq})) desc`, memories.id)
        .limit(pool)
    : [];

  type Row = (typeof ftsRows)[number];
  const fused = new Map<number, { row: Row; s: number }>();
  const add = (row: Row, rank: number) => {
    const cur = fused.get(row.id);
    const s = 1 / (RRF_K + rank + 1);
    if (cur) cur.s += s;
    else fused.set(row.id, { row, s });
  };
  vectorRows.forEach((r, i) => { if (Number(r.sim) >= SIMILARITY_THRESHOLD) add(r, i); });
  ftsRows.forEach((r, i) => add(r, i));

  const max = 2 / (RRF_K + 1);
  return [...fused.values()]
    .sort((x, y) => y.s - x.s || y.row.id - x.row.id)
    .slice(0, limit)
    .map(({ row, s }) => {
      const { sim: _sim, ...rest } = row as typeof row & { sim?: number };
      return { ...rest, score: Math.min(1, s / max) };
    });
}
