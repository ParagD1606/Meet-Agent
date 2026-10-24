import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { memories } from "../db/schema";
import { embed } from "./embed";
import { entityFactIds, expansionEnabled, queryEntities } from "./entities";

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
  validUntil: Date | null;
  factType: "fact" | "preference" | "decision" | "procedure" | "opinion";
  lastAccessedAt: Date | null;
  createdBy: string | null;
  permalink: string | null;
  /** Cosine to the query when the hit came from the vector list (undefined for keyword/entity-only hits). Feeds the retrieval-confidence signal. */
  sim?: number;
  /** true when the hit matched the query by keyword (AND tsquery) or by name/id trigram. */
  lexical?: boolean;
  /** Set by recall for rendering: canonical names of the entities the fact mentions, and the channel name its scope maps to. */
  entities?: string[];
  channel?: string;
};

export const DEFAULT_LIMIT = 40;
/** Per-list candidate pool (vector, keyword, trigram) before RRF fusion. */
export const CANDIDATE_POOL = 100;
/** Minimum cosine similarity for a vector-only hit. Keyword (tsvector) matches are always eligible. */
export const SIMILARITY_THRESHOLD = 0.3;
/** A vector-only hit below this similarity must also share a (stemmed) content word with the query, else it is topical noise. */
export const STRONG_SIMILARITY = 0.6;
const RRF_K = 60;

/** OR-of-terms tsquery used only as a lexical-overlap check for vector hits (stopwords are dropped by the english config). */
function orTsQuery(q: string): string | null {
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 24);
  return words.length ? words.join(" | ") : null;
}

export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

const QUESTION_WORDS = new Set(["what", "who", "whom", "whose", "when", "where", "why", "how", "which", "the", "does", "did", "do", "is", "are", "was", "were", "can", "could", "our", "and", "for", "has", "have", "any", "tell", "show", "list", "give", "find"]);

/** Names and ids worth a fuzzy (trigram) lookup: ids with digits/dashes/underscores, capitalised words not starting the sentence. */
export function lookupTokens(q: string): string[] {
  const out = new Set<string>();
  for (const m of q.matchAll(/[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)+|[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*|\p{Lu}[\p{L}]{2,}/gu)) {
    const t = m[0];
    const first = m.index === 0 && !/[\p{N}_-]/u.test(t);
    if (t.length >= 3 && !first && !QUESTION_WORDS.has(t.toLowerCase())) out.add(t);
  }
  return [...out].slice(0, 5);
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
  const pool = Math.max(limit * 2, CANDIDATE_POOL);
  const validity = a.asOf
    ? and(
        sql`${memories.validAt} <= ${a.asOf}`,
        or(sql`${memories.invalidAt} > ${a.asOf}`, and(isNull(memories.invalidAt), eq(memories.status, "active"))),
        or(isNull(memories.validUntil), sql`${memories.validUntil} > ${a.asOf}`),
      )
    : and(eq(memories.status, "active"), isNull(memories.invalidAt), or(isNull(memories.validUntil), sql`${memories.validUntil} > now()`));
  const where = and(inArray(memories.scopeTag, a.tags), eq(memories.reviewState, "ok"), validity);
  const cols = {
    id: memories.id, text: memories.text, scopeTag: memories.scopeTag, source: memories.source,
    sourceRef: memories.sourceRef, createdAt: memories.createdAt, kind: memories.kind, importance: memories.importance,
    confidence: memories.confidence, accessCount: memories.accessCount, validAt: memories.validAt,
    validUntil: memories.validUntil, factType: memories.factType,
    lastAccessedAt: memories.lastAccessedAt, createdBy: memories.createdBy, permalink: memories.permalink,
  };

  const [qv] = await embed([query]);
  const vec = vectorLiteral(qv!);
  const dist = sql`${memories.embedding} <=> ${vec}::vector`;
  const orq = orTsQuery(query);
  const overlap = orq ? sql<boolean>`${memories.tsv} @@ to_tsquery('english', ${orq})` : sql<boolean>`false`;
  const vectorRows = await db.select({ ...cols, sim: sql<number>`1 - (${dist})`, lex: overlap }).from(memories).where(where)
    .orderBy(dist).limit(pool);

  // websearch_to_tsquery: AND semantics, quoted phrases, "-" negation; unlike the old OR query one stray common word can't match everything.
  const tsq = sql`websearch_to_tsquery('english', ${query})`;
  const ftsRows = await db.select(cols).from(memories)
    .where(and(where, sql`${memories.tsv} @@ ${tsq}`))
    .orderBy(sql`ts_rank_cd(${memories.tsv}, ${tsq}) desc`, memories.id)
    .limit(pool);

  // pg_trgm: typo-tolerant lookup of names and ids ("Priya", "SUP-4412") that stemming and embeddings blur.
  const tokens = lookupTokens(query);
  const trgmRows = tokens.length
    ? await db.select(cols).from(memories)
        .where(and(where, or(...tokens.map((t) => sql`${t} <% ${memories.text}`))))
        .orderBy(sql`greatest(${sql.join(tokens.map((t) => sql`word_similarity(${t}, ${memories.text})`), sql`, `)}) desc`, memories.id)
        .limit(pool)
    : [];

  // Entity expansion: facts mentioning an entity the query names (hop 1) and facts bridged to those via a shared entity or
  // typed edge (hop 2, e.g. "who manages the team that owns Kestrel"). Candidates come from entityFactIds (scope-filtered
  // at every join); the select below re-applies the full `where` (tags + validity/asOf), so expansion can never widen access.
  // ponytail: each hop list is capped (20 / 10) and ordered by query similarity, hub entities are bounded by those caps only.
  type Row = (typeof ftsRows)[number];
  const expanded: Row[][] = [];
  const ents = expansionEnabled() ? await queryEntities(query).catch(() => []) : [];
  if (ents.length) {
    const { hop1, hop2 } = await entityFactIds({ tags: a.tags, entityIds: ents });
    for (const [ids, n] of [[hop1, 20], [hop2, 10]] as const) {
      if (ids.length) expanded.push(await db.select(cols).from(memories).where(and(where, inArray(memories.id, ids))).orderBy(dist).limit(n));
    }
  }

  const fused = new Map<number, { row: Row; s: number }>();
  const lexical = new Set<number>();
  const add = (row: Row, rank: number) => {
    const cur = fused.get(row.id);
    const s = 1 / (RRF_K + rank + 1);
    if (cur) cur.s += s;
    else fused.set(row.id, { row, s });
  };
  const sims = new Map(vectorRows.map((r) => [r.id, Number(r.sim)]));
  vectorRows.forEach((r, i) => { const sim = Number(r.sim); if (sim >= STRONG_SIMILARITY || (sim >= SIMILARITY_THRESHOLD && r.lex)) add(r, i); });
  ftsRows.forEach((r, i) => { lexical.add(r.id); add(r, i); });
  trgmRows.forEach((r, i) => { lexical.add(r.id); add(r, i); });
  for (const list of expanded) list.forEach((r, i) => add(r, i));

  const max = 2 / (RRF_K + 1);
  return [...fused.values()]
    .sort((x, y) => y.s - x.s || y.row.id - x.row.id)
    .slice(0, limit)
    .map(({ row, s }) => {
      const { sim: _sim, lex: _lex, ...rest } = row as typeof row & { sim?: number; lex?: boolean };
      return { ...rest, score: Math.min(1, s / max), sim: sims.get(row.id), lexical: lexical.has(row.id) };
    });
}
