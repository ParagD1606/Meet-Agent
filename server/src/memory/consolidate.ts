import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { log } from "../log";
import { completeJson } from "./llm";
import { addFact } from "./supersede";

const MERGE_SIM = 0.95;
const STALE_DAYS = 180;
const DECAY_DAYS = 90;
const DECAYED_IMPORTANCE = 0.2;
const CLUSTER_MIN = 8;
const CLUSTER_MAX = 30;
const MAX_TAGS_PER_RUN = 5;

const digest = z.object({ facts: z.array(z.string()) });
const SYSTEM = `You compress old, rarely used company facts. Given numbered facts from one scope, write 1-3 self-contained declarative sentences that preserve every still-useful name, owner, number and date. Drop trivia. Reply JSON only: {"facts":["..."]}.`;

export type ConsolidateResult = { merged: number; decayed: number; summarised: number; purged: number };

type Row = Record<string, unknown>;
const rows = (r: unknown) => ((r as { rows?: Row[] }).rows ?? (r as Row[]));

/**
 * Nightly, idempotent maintenance (running it twice changes nothing the second time):
 *  1. merge near-duplicate live facts per scope (older / more-used survives; the rest are superseded, history kept);
 *  2. clamp importance of facts unused for 90 days to 0.2 (recall ranks them lower);
 *  3. summarise clusters of >=8 stale (180d), low-importance, never-used facts of a scope into a digest fact;
 *  4. purge spilled tool results, embedding cache and thread state past retention.
 */
export async function consolidate(): Promise<ConsolidateResult> {
  const out: ConsolidateResult = { merged: 0, decayed: 0, summarised: 0, purged: 0 };

  // 1. merge
  const pairs = rows(await db.execute(sql`
    select a.id as keep_id, b.id as drop_id, a.access_count as keep_ac, b.access_count as drop_ac, a.importance as keep_imp, b.importance as drop_imp
    from memories a
    join lateral (
      select b.id, b.access_count, b.importance from memories b
      where b.scope_tag = a.scope_tag and b.id > a.id and b.kind = 'fact' and b.status = 'active'
        and b.invalid_at is null and b.review_state = 'ok' and 1 - (a.embedding <=> b.embedding) >= ${MERGE_SIM}
      order by a.embedding <=> b.embedding limit 3
    ) b on true
    where a.kind = 'fact' and a.status = 'active' and a.invalid_at is null and a.review_state = 'ok'
    order by a.id limit 2000`));
  const gone = new Set<number>();
  for (const p of pairs) {
    const keep = Number(p.keep_id);
    const drop = Number(p.drop_id);
    if (gone.has(keep) || gone.has(drop)) continue;
    // the more-used fact wins; ties go to the older one
    const dropWins = Number(p.drop_ac) > Number(p.keep_ac);
    const [winner, loser] = dropWins ? [drop, keep] : [keep, drop];
    const res = rows(await db.execute(sql`
      update memories set status = 'superseded', superseded_by = ${winner}, invalid_at = now()
      where id = ${loser} and status = 'active' returning id`));
    if (!res.length) continue;
    gone.add(loser);
    await db.execute(sql`update memories set importance = greatest(importance, ${Math.max(Number(p.keep_imp), Number(p.drop_imp))}) where id = ${winner}`);
    out.merged++;
  }

  // 2. decay (clamp, so repeated runs are no-ops)
  out.decayed = rows(await db.execute(sql`
    update memories set importance = ${DECAYED_IMPORTANCE}
    where kind = 'fact' and status = 'active' and invalid_at is null and importance > ${DECAYED_IMPORTANCE + 0.01}
      and coalesce(last_accessed_at, valid_at) < now() - make_interval(days => ${DECAY_DAYS})
    returning id`)).length;

  // 3. summarise stale clusters
  const clusters = rows(await db.execute(sql`
    select scope_tag, count(*)::int as n from memories
    where kind = 'fact' and status = 'active' and invalid_at is null and review_state = 'ok'
      and importance <= ${DECAYED_IMPORTANCE + 0.01} and access_count = 0
      and valid_at < now() - make_interval(days => ${STALE_DAYS})
    group by scope_tag having count(*) >= ${CLUSTER_MIN} order by count(*) desc limit ${MAX_TAGS_PER_RUN}`));
  for (const c of clusters) {
    const tag = String(c.scope_tag);
    const olds = rows(await db.execute(sql`
      select id, text from memories
      where scope_tag = ${tag} and kind = 'fact' and status = 'active' and invalid_at is null and review_state = 'ok'
        and importance <= ${DECAYED_IMPORTANCE + 0.01} and access_count = 0 and valid_at < now() - make_interval(days => ${STALE_DAYS})
      order by valid_at asc limit ${CLUSTER_MAX}`));
    if (olds.length < CLUSTER_MIN) continue;
    try {
      const v = await completeJson({ system: SYSTEM, prompt: olds.map((o, i) => `${i + 1}. ${String(o.text)}`).join("\n"), role: "summarize", maxOutputTokens: 400 }, digest);
      const texts = v.facts.map((f) => f.trim()).filter((f) => f.length >= 8).slice(0, 3);
      if (!texts.length) continue;
      const ids = olds.map((o) => Number(o.id));
      let first: number | null = null;
      for (const text of texts) {
        const r = await addFact({ tag, text, source: "consolidation", createdBy: "consolidation", importance: 0.3, agentContext: "consolidation" });
        if (!r.deduped && !ids.includes(r.id)) first ??= r.id;
      }
      if (first == null) continue; // nothing was actually written: keep the originals
      const done = rows(await db.execute(sql`
        update memories set status = 'superseded', superseded_by = ${first}, invalid_at = now()
        where id = any(${ids}::bigint[]) and status = 'active' returning id`));
      out.summarised += done.length;
    } catch (e) {
      log.warn("consolidation summary failed", { tag, err: String(e) });
    }
  }

  // 4. retention
  const purged = [
    sql`delete from tool_results where created_at < now() - interval '14 days' returning 1`,
    sql`delete from embedding_cache where created_at < now() - interval '90 days' returning 1`,
    sql`delete from thread_state where updated_at < now() - interval '60 days' returning 1`,
  ];
  for (const q of purged) out.purged += rows(await db.execute(q)).length;
  return out;
}
