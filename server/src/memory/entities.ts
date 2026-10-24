import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channels, entities, factEntities, memories, memoryEdges, users } from "../db/schema";
import { tuningEnv } from "../config";
import { log } from "../log";
import { embed } from "./embed";
import { completeJson } from "./llm";

/** An entity mention as written by the extractor (or a caller of addFact). */
export type Mention = { name: string; type?: string };

/** Cosine at/above which a mention is the same entity without asking the LLM (when the runner-up is clearly behind). */
export const AUTO_MERGE_SIM = 0.92;
/** Nearest neighbours at/above this (and sharing a name token) are candidates for the LLM tie-break. */
export const CANDIDATE_SIM = 0.45;
const MAX_ALIASES = 20;
const SKIP = new Set(["i", "you", "we", "he", "she", "they", "it", "me", "us", "them", "team", "company", "everyone", "someone", "bot", "assistant", "slack"]);
const QUESTION_WORDS = new Set(["what", "who", "whom", "whose", "when", "where", "why", "how", "which", "does", "did", "the", "and", "for", "has", "have", "are", "was", "were", "can", "could", "our", "any", "tell", "show", "list", "give", "find", "about"]);

/** Lowercase, punctuation-free, single-spaced form used for alias matching ("Dana S." -> "dana s"). */
export const normName = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (n: string) => n.split(" ").filter(Boolean);
const lit = (v: number[]) => `[${v.join(",")}]`;
/** drizzle expands a JS array in sql`` into a tuple; this builds a real text[] */
const arr = (xs: string[]) => sql`ARRAY[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::text[]`;
const compatible = (a: string, b: string) => a === "other" || b === "other" || a === b;
export const expansionEnabled = () => tuningEnv().entityExpansion;

const verdict = z.object({ match: z.number().int().nullable() });
const TIE_SYSTEM = `You resolve entity mentions in a company knowledge base. Given a MENTION (a name as written in a fact) and numbered CANDIDATE entities, decide whether the mention refers to one of the candidates (same person, customer, project, product or channel; "Dana" and "Dana S." can be the same person, two different people called Dana cannot).
Be conservative: answer null unless the context makes the match clear. Reply JSON only: {"match":<candidate number or null>}.`;

type Cand = { id: string; name: string; aliases: string[]; type: string; sim?: number };

/** Ask the LLM which candidate (if any) a mention refers to. Any failure means "none": a new entity is safer than a wrong merge. */
async function tieBreak(m: { name: string; type: string }, context: string, cands: Cand[]): Promise<Cand | null> {
  try {
    const prompt = `MENTION: ${m.name} (${m.type})\nCONTEXT: ${context.slice(0, 400)}\n\nCANDIDATES:\n${cands.map((c, i) => `${i + 1}. ${c.name} (${c.type}; also: ${c.aliases.slice(0, 5).join(", ")})`).join("\n")}`;
    const v = await completeJson({ system: TIE_SYSTEM, prompt, role: "extract", maxOutputTokens: 60 }, verdict);
    return v.match != null ? cands[v.match - 1] ?? null : null;
  } catch (e) {
    log.warn("entity tie-break failed", { err: String(e) });
    return null;
  }
}

const candCols = { id: entities.id, name: entities.canonicalName, aliases: entities.aliases, type: entities.type };
const byAlias = (n: string) => db.select(candCols).from(entities).where(sql`${entities.aliases} @> ARRAY[${n}]::text[]`).limit(5);

async function addAlias(id: string, n: string) {
  await db.update(entities).set({ aliases: sql`array_append(${entities.aliases}, ${n})` })
    .where(and(eq(entities.id, id), sql`not (${entities.aliases} @> ARRAY[${n}]::text[])`, sql`cardinality(${entities.aliases}) < ${MAX_ALIASES}`));
}

/** Creates an entity unless one with this alias appeared meanwhile (per-name advisory lock; no LLM inside the transaction). */
async function createEntity(name: string, n: string, type: string, vec: number[]): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`entity:${n}`}))`);
    const [hit] = await tx.select({ id: entities.id, type: entities.type }).from(entities).where(sql`${entities.aliases} @> ARRAY[${n}]::text[]`).limit(1);
    if (hit && compatible(hit.type, type)) return hit.id;
    const id = newId("en_");
    await tx.insert(entities).values({ id, canonicalName: name.slice(0, 120), aliases: [n], type, embedding: vec });
    return id;
  });
}

/**
 * Resolves one mention to an entity id: (1) exact normalised alias match, (2) embedding nearest neighbour that shares a name
 * token, auto-merged when clearly the best, else (3) one LLM tie-break among the candidates. Unresolved -> new entity.
 * The surface form is added as an alias of the match, so later mentions hit step 1.
 */
async function resolveOne(m: { name: string; type: string }, vec: number[], context: string): Promise<string> {
  const n = normName(m.name);
  const exact = (await byAlias(n)).filter((c) => compatible(c.type, m.type));
  let pick: Cand | null = exact.length === 1 ? exact[0]! : null;
  let cands: Cand[] = exact;
  if (!exact.length) {
    const near = await db.select({ ...candCols, sim: sql<number>`1 - (${entities.embedding} <=> ${lit(vec)}::vector)` })
      .from(entities).orderBy(sql`${entities.embedding} <=> ${lit(vec)}::vector`).limit(5);
    const mine = new Set(tokens(n));
    cands = near.map((c) => ({ ...c, sim: Number(c.sim) }))
      .filter((c) => c.sim >= CANDIDATE_SIM && compatible(c.type, m.type) && c.aliases.some((a) => tokens(a).some((t) => mine.has(t))));
    if (cands[0] && cands[0].sim! >= AUTO_MERGE_SIM && (!cands[1] || cands[0].sim! - cands[1].sim! >= 0.05)) pick = cands[0];
  }
  if (!pick && cands.length) pick = await tieBreak(m, context, cands);
  if (pick) {
    if (!exact.length) await addAlias(pick.id, n);
    return pick.id;
  }
  return createEntity(m.name, n, m.type, vec);
}

const clean = (ms: Mention[]): { name: string; type: string }[] => {
  const seen = new Set<string>();
  const out: { name: string; type: string }[] = [];
  for (const m of ms) {
    const name = m.name?.trim().slice(0, 80);
    const n = name ? normName(name) : "";
    if (!name || n.length < 2 || SKIP.has(n) || seen.has(n) || /<[@#!][^>]*>|\b[UWC](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/.test(name)) continue;
    seen.add(n);
    out.push({ name, type: (m.type ?? "other").toLowerCase().replace(/[^a-z]/g, "").slice(0, 20) || "other" });
  }
  return out.slice(0, 6);
};

/** Resolves mentions (see resolveOne) and links them to `factId`. Best effort: never throws, never blocks a write. */
export async function attachMentions(factId: number, mentions: Mention[], context: string): Promise<string[]> {
  try {
    const ms = clean(mentions);
    if (!ms.length) return [];
    const vecs = await embed(ms.map((m) => m.name));
    const ids: string[] = [];
    for (const [i, m] of ms.entries()) ids.push(await resolveOne(m, vecs[i]!, context));
    await db.insert(factEntities).values([...new Set(ids)].map((entityId) => ({ factId, entityId }))).onConflictDoNothing();
    return ids;
  } catch (e) {
    log.warn("entity linking failed", { factId, err: String(e) });
    return [];
  }
}

/** Typed fact-to-fact edge written by the extractor (relation e.g. owns, part_of, depends_on); upgrades an existing cosine link. */
export async function linkFacts(fromId: number, toId: number, relation: string, weight = 1): Promise<void> {
  if (fromId === toId) return;
  await db.insert(memoryEdges).values({ fromId, toId, weight, relation })
    .onConflictDoUpdate({ target: [memoryEdges.fromId, memoryEdges.toId], set: { relation } });
}

/** Mirrors Slack users and public channels into entities (names only, never private channels or DMs). Idempotent. */
export async function seedSlackEntities(): Promise<number> {
  const us = await db.select({ name: users.name }).from(users).where(and(eq(users.isBot, false), eq(users.deactivated, false)));
  const cs = await db.select({ name: channels.name }).from(channels).where(and(eq(channels.isPrivate, false), eq(channels.isIm, false)));
  const want = [
    ...us.flatMap((u) => (u.name ? [{ name: u.name, type: "person" }] : [])),
    ...cs.flatMap((c) => (c.name ? [{ name: c.name, type: "channel" }] : [])),
  ].filter((w) => normName(w.name).length >= 2);
  let made = 0;
  for (let i = 0; i < want.length; i += 50) {
    const batch = want.slice(i, i + 50);
    const todo: typeof batch = [];
    for (const w of batch) if (!(await byAlias(normName(w.name))).some((c) => compatible(c.type, w.type))) todo.push(w);
    if (!todo.length) continue;
    const vecs = await embed(todo.map((w) => w.name));
    for (const [j, w] of todo.entries()) { await createEntity(w.name, normName(w.name), w.type, vecs[j]!); made++; }
  }
  return made;
}

/**
 * Entities a query talks about: any 1-3 word n-gram equal to an alias, plus capitalised first names that start an alias
 * ("Dana" -> "dana schmidt", "dana s"). Entities are only join keys; facts are always filtered by the caller's scope.
 */
export async function queryEntities(query: string, max = 8): Promise<string[]> {
  const words = tokens(normName(query));
  const grams = new Set<string>();
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n);
      if (g.every((w) => QUESTION_WORDS.has(w) || w.length < 2)) continue;
      grams.add(g.join(" "));
    }
  }
  const firsts = [...new Set((query.match(/\p{Lu}[\p{L}]{2,}/gu) ?? []).map(normName))].filter((w) => !QUESTION_WORDS.has(w) && w.length >= 3);
  if (!grams.size) return [];
  const g = [...grams].slice(0, 60);
  const prefix = firsts.length ? sql` or exists (select 1 from unnest(${entities.aliases}) a where a like any(${arr(firsts.map((f) => `${f} %`))}))` : sql``;
  const rows = await db.select({ id: entities.id, exact: sql<boolean>`${entities.aliases} && ${arr(g)}` }).from(entities)
    .where(sql`${entities.aliases} && ${arr(g)}${prefix}`).limit(max * 3);
  return rows.sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, max).map((r) => r.id);
}

/**
 * Facts that mention `entityIds` (hop 1) and facts that share an entity or a typed edge with a hop-1 fact (hop 2).
 * ACL: every row touched, including the hop-1 facts we pivot through, must be in `tags` and review-ok, so a fact in a scope
 * the caller cannot read can neither be returned nor used as a bridge. Validity (active / asOf) is applied by the caller.
 */
export async function entityFactIds(a: { tags: string[]; entityIds: string[]; limit1?: number; limit2?: number }): Promise<{ hop1: number[]; hop2: number[] }> {
  if (!a.entityIds.length || !a.tags.length) return { hop1: [], hop2: [] };
  const ok = sql`m.scope_tag = any(${arr(a.tags)}) and m.review_state = 'ok' and m.kind = 'fact' and m.status in ('active', 'superseded')`;
  const res = await db.execute(sql`
    with h1 as (
      select distinct fe.fact_id as id from fact_entities fe join memories m on m.id = fe.fact_id
      where fe.entity_id = any(${arr(a.entityIds)}) and ${ok} limit 200
    ), via_entity as (
      select distinct fe2.fact_id as id from fact_entities fe
      join fact_entities fe2 on fe2.entity_id = fe.entity_id and fe2.entity_id <> all(${arr(a.entityIds)})
      join memories m on m.id = fe2.fact_id
      where fe.fact_id in (select id from h1) and ${ok} limit 400
    ), via_edge as (
      select distinct case when e.from_id in (select id from h1) then e.to_id else e.from_id end as id
      from memory_edges e join memories m on m.id = case when e.from_id in (select id from h1) then e.to_id else e.from_id end
      where e.relation is not null and (e.from_id in (select id from h1) or e.to_id in (select id from h1)) and ${ok} limit 200
    )
    select id, 1 as hop from h1
    union all select id, 2 as hop from (select id from via_entity union select id from via_edge) h2 where id not in (select id from h1)`);
  const rows = ((res as unknown as { rows?: { id: string | number; hop: number }[] }).rows ?? (res as unknown as { id: string | number; hop: number }[]));
  const pick = (hop: number) => rows.filter((r) => Number(r.hop) === hop).map((r) => Number(r.id));
  return { hop1: pick(1), hop2: pick(2) };
}

export type EntityInfo = {
  entities: { id: string; name: string; type: string; summary: string | null }[];
  facts: { id: number; text: string; scopeTag: string; source: string; validAt: Date; factType: string }[];
  related: string[];
};

/** Everything known about a name, readable by `tags` only: matching entities, their scope-filtered summaries and facts, co-mentioned entities. */
export async function entityLookup(a: { tags: string[]; name: string; limit?: number }): Promise<EntityInfo> {
  const none: EntityInfo = { entities: [], facts: [], related: [] };
  const name = a.name.trim();
  if (!name || !a.tags.length) return none;
  const n = normName(name);
  let ids = [...new Set([...(await byAlias(n)).map((c) => c.id), ...(await queryEntities(name.replace(/^\p{Ll}/u, (c) => c.toUpperCase()), 3))])];
  if (!ids.length) {
    const [qv] = await embed([name]);
    const mine = new Set(tokens(n));
    const near = await db.select({ ...candCols, sim: sql<number>`1 - (${entities.embedding} <=> ${lit(qv!)}::vector)` })
      .from(entities).orderBy(sql`${entities.embedding} <=> ${lit(qv!)}::vector`).limit(3);
    ids = near.filter((c) => Number(c.sim) >= 0.75 && c.aliases.some((x) => tokens(x).some((t) => mine.has(t)))).map((c) => c.id);
  }
  if (!ids.length) return none;
  const live = and(
    inArray(memories.scopeTag, a.tags), eq(memories.reviewState, "ok"), eq(memories.status, "active"), eq(memories.kind, "fact"),
    sql`${memories.invalidAt} is null and (${memories.validUntil} is null or ${memories.validUntil} > now())`,
  );
  const facts = await db.selectDistinct({
    id: memories.id, text: memories.text, scopeTag: memories.scopeTag, source: memories.source, validAt: memories.validAt,
    factType: memories.factType, importance: memories.importance,
  }).from(memories).innerJoin(factEntities, eq(factEntities.factId, memories.id))
    .where(and(live, inArray(factEntities.entityId, ids))).orderBy(sql`${memories.importance} desc`, sql`${memories.validAt} desc`).limit(a.limit ?? 15);
  const ents = await db.select(candCols).from(entities).where(inArray(entities.id, ids));
  const sums = await db.execute(sql`select entity_id, string_agg(summary, ' ') as s from entity_summaries where entity_id = any(${arr(ids)}) and scope_tag = any(${arr(a.tags)}) group by entity_id`);
  const sumRows = ((sums as unknown as { rows?: { entity_id: string; s: string }[] }).rows ?? []);
  const rel = facts.length
    ? await db.selectDistinct({ name: entities.canonicalName }).from(factEntities).innerJoin(entities, eq(entities.id, factEntities.entityId))
        .where(and(inArray(factEntities.factId, facts.map((f) => f.id)), sql`${factEntities.entityId} <> all(${arr(ids)})`)).limit(10)
    : [];
  return {
    // an entity with nothing readable by the caller is reported as unknown: names from other scopes must not leak
    entities: facts.length || sumRows.length ? ents.map((e) => ({ id: e.id, name: e.name, type: e.type, summary: sumRows.find((s) => s.entity_id === e.id)?.s ?? null })) : [],
    facts: facts.map(({ importance: _i, ...f }) => f),
    related: rel.map((r) => r.name),
  };
}
