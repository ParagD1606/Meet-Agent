import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { consolidationLog, coreBlocks, memories, memoryReviews } from "../db/schema";
import { log } from "../log";
import { applyCoreBlockReview, BLOCK_LIMITS, scanMemoryText } from "./core-blocks";
import { seedSlackEntities } from "./entities";
import { completeJson } from "./llm";
import { clearRecallCache } from "./recall";
import { addFact, findContradicted } from "./supersede";

const MERGE_SIM = 0.95;
const CROSS_CONFLICT_SIM = 0.6;
const STALE_DAYS = 180;
const STALE_IMPORTANCE = 0.25;
const IMPORTANCE_FLOOR = 0.05;
const MIN_DECAY_GAP_DAYS = 1; // decay is applied from max(decayed_at, last access, valid_at); a second run within a day is a no-op
const EXPIRED_GRACE_DAYS = 30;
const CLUSTER_MIN = 8;
const CLUSTER_MAX = 30;
const MAX_TAGS_PER_RUN = 5;
const PROMOTE_MIN_ACCESS = 8;
const PROMOTE_MIN_IMPORTANCE = 0.5;
const DEMOTE_UNUSED_DAYS = 120;
const ABOUT_PREFIX = "About: ";
const SUMMARY_MIN_FACTS = 3;

const digest = z.object({ facts: z.array(z.string()) });
const SYSTEM = `You compress old, rarely used company facts. Given numbered facts from one scope, write 1-3 self-contained declarative sentences that preserve every still-useful name, owner, number and date. Drop trivia. Reply JSON only: {"facts":["..."]}.`;
const ENTITY_SYSTEM = `Summarise everything below about ONE entity (person, customer, project, product) in 2-4 plain declarative sentences (max 500 characters). Keep names, owners, numbers and dates. No preamble. Reply with the summary text only.`;
const ABOUT_SYSTEM = `From these summaries of past Slack threads in one channel, write ONE sentence (max 300 characters) saying what the channel is for and its recurring topics. No preamble. Reply with the sentence only.`;
const PROCEDURE_SYSTEM = `From these thread summaries, extract at most 3 reusable PROCEDURES: stable, multi-step how-to knowledge the team follows repeatedly (not one-off events, not decisions). Each is one self-contained sentence or two. Reply JSON only: {"facts":["..."]}; use {"facts":[]} when none.`;

export type ConsolidateResult = {
  runId: string; merged: number; crossScope: number; decayed: number; expired: number; summarised: number; promoted: number;
  demoted: number; aboutBlocks: number; entitySummaries: number; procedures: number; purged: number;
};

type Row = Record<string, unknown>;
const rows = (r: unknown) => ((r as { rows?: Row[] }).rows ?? (r as Row[]));
const idList = (ids: number[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

type Snap = { id: number; status: string; supersededBy: number | null; invalidAt: string | null; importance: number; decayedAt: string | null };

async function snapshot(ids: number[]): Promise<Snap[]> {
  if (!ids.length) return [];
  return rows(await db.execute(sql`
    select id, status, superseded_by as "supersededBy", invalid_at as "invalidAt", importance, decayed_at as "decayedAt"
    from memories where id in (${idList(ids)})`)).map((r) => ({
    id: Number(r.id), status: String(r.status), supersededBy: r.supersededBy == null ? null : Number(r.supersededBy),
    invalidAt: r.invalidAt ? new Date(r.invalidAt as string).toISOString() : null, importance: Number(r.importance),
    decayedAt: r.decayedAt ? new Date(r.decayedAt as string).toISOString() : null,
  }));
}

async function record(runId: string, action: string, scopeTag: string | null, ids: number[], details: Record<string, unknown>) {
  await db.insert(consolidationLog).values({ runId, action, scopeTag, memoryIds: ids, details });
}

/** Status change that is fully restorable: snapshot first, log, then update. Returns the ids actually changed. */
async function retire(runId: string, action: string, scopeTag: string | null, ids: number[], status: "superseded" | "archived", by: number | null, extra: Record<string, unknown> = {}): Promise<number[]> {
  if (!ids.length) return [];
  const before = await snapshot(ids);
  const done = rows(await db.execute(sql`
    update memories set status = ${status}, superseded_by = ${by}, invalid_at = coalesce(invalid_at, now())
    where id in (${idList(ids)}) and status = 'active' returning id`)).map((r) => Number(r.id));
  if (!done.length) return [];
  await record(runId, action, scopeTag, done, { rows: before.filter((b) => done.includes(b.id)), ...extra });
  return done;
}

const LIVE = sql`kind = 'fact' and status = 'active' and invalid_at is null and review_state = 'ok'`;

/**
 * Nightly, idempotent maintenance (a second run changes nothing). Every change to knowledge is written to consolidation_log
 * with the data needed by undoConsolidation(); nothing is hard-deleted and no merge ever widens visibility.
 *  1. merge near-duplicate live facts within a scope (more-used / older survives; the rest are superseded);
 *  2. cross-scope conflicts within ACL: a narrower-scope fact (channel/DM) that duplicates or is contradicted by a NEWER shared
 *     fact is superseded by it (its readers can read shared); shared facts are never changed because of narrower ones;
 *  3. continuous importance decay by fact type (half-life), replacing the old clamp to 0.2;
 *  4. archive expired transient facts; summarise stale clusters into a digest fact and ARCHIVE (not purge) the originals;
 *  5. propose (via the admin review queue) promoting heavily used shared facts to the company block and demoting stale ones;
 *  6. per-channel "About:" line in the channel block; per-entity summaries; procedure extraction held for admin review;
 *  7. retention of spilled tool results / embedding cache / thread state (operational data, not knowledge).
 */
export async function consolidate(): Promise<ConsolidateResult> {
  const runId = newId("cr_");
  const out: ConsolidateResult = { runId, merged: 0, crossScope: 0, decayed: 0, expired: 0, summarised: 0, promoted: 0, demoted: 0, aboutBlocks: 0, entitySummaries: 0, procedures: 0, purged: 0 };
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { log.warn("consolidation step failed", { step: name, err: String(e) }); } };

  await step("seed-entities", async () => { await seedSlackEntities(); });

  // 1. merge within a scope
  await step("merge", async () => {
    const pairs = rows(await db.execute(sql`
      select a.id as keep_id, b.id as drop_id, a.scope_tag, a.access_count as keep_ac, b.access_count as drop_ac, a.importance as keep_imp, b.importance as drop_imp
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
      const dropWins = Number(p.drop_ac) > Number(p.keep_ac); // the more-used fact wins; ties go to the older one
      const [winner, loser] = dropWins ? [drop, keep] : [keep, drop];
      const [wSnap] = await snapshot([winner]);
      const done = await retire(runId, "merge", String(p.scope_tag), [loser], "superseded", winner, { winner: wSnap });
      if (!done.length) continue;
      gone.add(loser);
      await db.execute(sql`update memories set importance = greatest(importance, ${Math.max(Number(p.keep_imp), Number(p.drop_imp))}) where id = ${winner}`);
      out.merged++;
    }
  });

  // 2. cross-scope conflicts, within ACL
  await step("cross-scope", async () => {
    const pairs = rows(await db.execute(sql`
      select n.id as narrow_id, n.scope_tag as narrow_tag, n.text as narrow_text, n.valid_at as narrow_at,
             s.id as shared_id, s.text as shared_text, s.valid_at as shared_at, s.sim
      from memories n
      join lateral (
        select s.id, s.text, s.valid_at, 1 - (n.embedding <=> s.embedding) as sim from memories s
        where s.scope_tag = 'shared' and s.kind = 'fact' and s.status = 'active' and s.invalid_at is null and s.review_state = 'ok'
        order by n.embedding <=> s.embedding limit 1
      ) s on true
      where n.scope_tag <> 'shared' and n.kind = 'fact' and n.status = 'active' and n.invalid_at is null and n.review_state = 'ok'
        and s.sim >= ${CROSS_CONFLICT_SIM}
      order by n.id limit 300`));
    for (const p of pairs) {
      const dup = Number(p.sim) >= MERGE_SIM;
      // contradiction only counts when the shared fact is newer: an older shared fact must not override a newer private one
      const newer = new Date(p.shared_at as string) > new Date(p.narrow_at as string);
      if (!dup && !(newer && (await findContradicted(String(p.shared_text), [{ id: Number(p.narrow_id), text: String(p.narrow_text) }])).length)) continue;
      const done = await retire(runId, "cross_scope", String(p.narrow_tag), [Number(p.narrow_id)], "superseded", Number(p.shared_id), { reason: dup ? "duplicate" : "contradicted" });
      out.crossScope += done.length;
    }
  });

  // 3. continuous decay
  await step("decay", async () => {
    const hl = sql`(case fact_type when 'decision' then 365 when 'preference' then 365 when 'procedure' then 365 when 'opinion' then 60 else 120 end)`;
    const base = sql`greatest(coalesce(decayed_at, '-infinity'::timestamptz), coalesce(last_accessed_at, '-infinity'::timestamptz), valid_at)`;
    const cand = rows(await db.execute(sql`
      select id from memories where ${LIVE} and importance > ${IMPORTANCE_FLOOR + 0.001}
        and ${base} < now() - make_interval(days => ${MIN_DECAY_GAP_DAYS}) limit 5000`)).map((r) => Number(r.id));
    if (!cand.length) return;
    const before = await snapshot(cand);
    const done = rows(await db.execute(sql`
      update memories set importance = greatest(${IMPORTANCE_FLOOR}, importance * power(0.5, extract(epoch from (now() - ${base})) / 86400.0 / ${hl})), decayed_at = now()
      where id in (${idList(cand)}) returning id`)).map((r) => Number(r.id));
    out.decayed = done.length;
    await record(runId, "decay", null, done, { rows: before });
  });

  // 4a. archive expired transient facts (history kept, restorable)
  await step("expire", async () => {
    const ids = rows(await db.execute(sql`
      select id from memories where ${LIVE} and valid_until is not null and valid_until < now() - make_interval(days => ${EXPIRED_GRACE_DAYS}) limit 1000`)).map((r) => Number(r.id));
    out.expired = (await retire(runId, "expire", null, ids, "archived", null)).length;
  });

  // 4b. summarise stale clusters, archive the originals
  await step("summarise", async () => {
    const clusters = rows(await db.execute(sql`
      select scope_tag, count(*)::int as n from memories
      where ${LIVE} and importance <= ${STALE_IMPORTANCE} and access_count = 0 and valid_at < now() - make_interval(days => ${STALE_DAYS})
      group by scope_tag having count(*) >= ${CLUSTER_MIN} order by count(*) desc limit ${MAX_TAGS_PER_RUN}`));
    for (const c of clusters) {
      const tag = String(c.scope_tag);
      const olds = rows(await db.execute(sql`
        select id, text from memories
        where scope_tag = ${tag} and ${LIVE} and importance <= ${STALE_IMPORTANCE} and access_count = 0 and valid_at < now() - make_interval(days => ${STALE_DAYS})
        order by valid_at asc limit ${CLUSTER_MAX}`));
      if (olds.length < CLUSTER_MIN) continue;
      try {
        const v = await completeJson({ system: SYSTEM, prompt: olds.map((o, i) => `${i + 1}. ${String(o.text)}`).join("\n"), role: "summarize", maxOutputTokens: 400 }, digest);
        const texts = v.facts.map((f) => f.trim()).filter((f) => f.length >= 8).slice(0, 3);
        if (!texts.length) continue;
        const ids = olds.map((o) => Number(o.id));
        const created: number[] = [];
        for (const text of texts) {
          const r = await addFact({ tag, text, source: "consolidation", createdBy: "consolidation", importance: 0.3, agentContext: "consolidation" });
          if (!r.deduped && !ids.includes(r.id)) created.push(r.id);
        }
        if (!created.length) continue; // nothing was actually written: keep the originals
        out.summarised += (await retire(runId, "summarise", tag, ids, "archived", created[0]!, { created })).length;
      } catch (e) {
        log.warn("consolidation summary failed", { tag, err: String(e) });
      }
    }
  });

  // 5. promote / demote company-block lines, always through the admin review queue (consolidation may not edit the company profile)
  await step("promote-demote", async () => {
    const block = (await db.select().from(coreBlocks).where(and(eq(coreBlocks.scopeTag, "shared"), eq(coreBlocks.label, "company"))))[0]?.text ?? "";
    const lines = block ? block.split("\n") : [];
    const pendingText = new Set(
      (await db.select({ p: memoryReviews.payload }).from(memoryReviews).where(and(eq(memoryReviews.kind, "core_block"), eq(memoryReviews.status, "pending"))))
        .map((r) => `${(r.p as Row).op}:${String((r.p as Row).text ?? (r.p as Row).match ?? "")}`),
    );
    const propose = async (op: "add" | "remove", text: string, memoryId: number, action: "promote" | "demote") => {
      if (pendingText.has(`${op}:${text}`)) return false;
      const reviewId = newId("rv_");
      const payload = op === "add" ? { label: "company", tag: "shared", op, text, match: null, source: "consolidation" } : { label: "company", tag: "shared", op, text: null, match: text, source: "consolidation" };
      await db.insert(memoryReviews).values({ id: reviewId, kind: "core_block", payload, requestedBy: "consolidation" });
      await record(runId, action, "shared", [memoryId], { reviewId, line: text });
      pendingText.add(`${op}:${text}`);
      return true;
    };
    const hot = rows(await db.execute(sql`
      select id, text from memories where scope_tag = 'shared' and ${LIVE} and access_count >= ${PROMOTE_MIN_ACCESS} and importance >= ${PROMOTE_MIN_IMPORTANCE}
        and length(text) <= 200 order by access_count desc, id limit 3`));
    for (const h of hot) {
      const text = String(h.text);
      if (lines.includes(text) || scanMemoryText(text)) continue;
      if (await propose("add", text, Number(h.id), "promote")) out.promoted++;
    }
    for (const line of lines) {
      const stale = rows(await db.execute(sql`
        select id from memories where scope_tag = 'shared' and kind = 'fact' and text = ${line}
          and (status <> 'active' or coalesce(last_accessed_at, valid_at) < now() - make_interval(days => ${DEMOTE_UNUSED_DAYS}))
          and not exists (select 1 from memories m2 where m2.scope_tag = 'shared' and m2.text = ${line} and m2.status = 'active' and coalesce(m2.last_accessed_at, m2.valid_at) >= now() - make_interval(days => ${DEMOTE_UNUSED_DAYS}))
        limit 1`));
      if (stale[0] && (await propose("remove", line, Number(stale[0].id), "demote"))) out.demoted++;
    }
  });

  // 6a. per-channel "About:" line (channel block; only from episodes that channel's own readers can already see)
  await step("about", async () => {
    const chans = rows(await db.execute(sql`
      select e.channel_id, count(*)::int as n, max(e.ended_at) as latest from episodes e join channels c on c.id = e.channel_id
      where c.is_im = false and e.scope_tag in ('shared', 'channel_' || e.channel_id) and e.ended_at > now() - interval '30 days'
      group by e.channel_id having count(*) >= 3 order by max(e.ended_at) desc limit 20`));
    for (const c of chans) {
      const ch = String(c.channel_id);
      const tag = `channel_${ch}`;
      const [last] = await db.select({ at: consolidationLog.createdAt }).from(consolidationLog)
        .where(and(eq(consolidationLog.action, "about_block"), eq(consolidationLog.scopeTag, tag), sql`${consolidationLog.undoneAt} is null`))
        .orderBy(sql`${consolidationLog.createdAt} desc`).limit(1);
      if (last && new Date(c.latest as string) <= last.at) continue;
      const eps = rows(await db.execute(sql`
        select summary from episodes where channel_id = ${ch} and scope_tag in ('shared', ${tag}) order by ended_at desc limit 15`));
      try {
        const about = (await completeJsonText(ABOUT_SYSTEM, eps.map((e, i) => `${i + 1}. ${String(e.summary)}`).join("\n"))).replace(/\s+/g, " ").trim().slice(0, 300);
        if (about.length < 10 || scanMemoryText(about)) continue;
        const cur = (await db.select().from(coreBlocks).where(and(eq(coreBlocks.scopeTag, tag), eq(coreBlocks.label, "channel"))))[0]?.text ?? "";
        const old = cur.split("\n").find((l) => l.startsWith(ABOUT_PREFIX));
        const line = `${ABOUT_PREFIX}${about}`;
        if (old === line) continue;
        const next = [line, ...cur.split("\n").filter((l) => l && !l.startsWith(ABOUT_PREFIX))].join("\n");
        if (next.length > BLOCK_LIMITS.channel) continue;
        await ensureBlockRow(tag);
        const r = await applyCoreBlockReview({ label: "channel", tag, op: "set", text: next, match: null }, "consolidation");
        if (!r.ok) continue;
        await record(runId, "about_block", tag, [], { block: { scopeTag: tag, label: "channel", added: line, removed: old ?? null } });
        out.aboutBlocks++;
      } catch (e) {
        log.warn("about block failed", { channel: ch, err: String(e) });
      }
    }
  });

  // 6b. entity summaries, one per (entity, scope) from facts readable in that scope only
  await step("entity-summaries", async () => {
    const due = rows(await db.execute(sql`
      select fe.entity_id, m.scope_tag, e.canonical_name, max(m.created_at) as latest
      from fact_entities fe join memories m on m.id = fe.fact_id join entities e on e.id = fe.entity_id
      left join entity_summaries es on es.entity_id = fe.entity_id and es.scope_tag = m.scope_tag
      where m.kind = 'fact' and m.status = 'active' and m.invalid_at is null and m.review_state = 'ok'
      group by fe.entity_id, m.scope_tag, e.canonical_name, es.updated_at
      having count(*) >= ${SUMMARY_MIN_FACTS} and (es.updated_at is null or es.updated_at < max(m.created_at))
      order by max(m.created_at) desc limit 30`));
    for (const d of due) {
      const facts = rows(await db.execute(sql`
        select m.text from fact_entities fe join memories m on m.id = fe.fact_id
        where fe.entity_id = ${String(d.entity_id)} and m.scope_tag = ${String(d.scope_tag)} and m.kind = 'fact' and m.status = 'active' and m.invalid_at is null and m.review_state = 'ok'
        order by m.importance desc, m.valid_at desc limit 12`));
      try {
        const summary = (await completeJsonText(ENTITY_SYSTEM, `ENTITY: ${String(d.canonical_name)}\n${facts.map((f, i) => `${i + 1}. ${String(f.text)}`).join("\n")}`)).trim().slice(0, 600);
        if (summary.length < 10 || scanMemoryText(summary)) continue;
        await db.execute(sql`
          insert into entity_summaries (entity_id, scope_tag, summary, updated_at) values (${String(d.entity_id)}, ${String(d.scope_tag)}, ${summary}, now())
          on conflict (entity_id, scope_tag) do update set summary = excluded.summary, updated_at = now()`);
        out.entitySummaries++;
      } catch (e) {
        log.warn("entity summary failed", { entity: String(d.entity_id), err: String(e) });
      }
    }
  });

  // 6c. procedure extraction from recent shared episodes, held for admin review
  await step("procedures", async () => {
    const eps = rows(await db.execute(sql`select summary from episodes where scope_tag = 'shared' and ended_at > now() - interval '36 hours' order by ended_at desc limit 20`));
    if (eps.length < 2) return;
    // The model rewords the same procedures every night (36h window), so an unreviewed batch means: wait for the admin, do not pile on near-duplicates.
    const [open] = await db.select({ id: memoryReviews.id }).from(memoryReviews).where(and(eq(memoryReviews.kind, "procedure"), eq(memoryReviews.status, "pending"))).limit(1);
    if (open) return;
    const v = await completeJson({ system: PROCEDURE_SYSTEM, prompt: eps.map((e, i) => `${i + 1}. ${String(e.summary)}`).join("\n"), role: "summarize", maxOutputTokens: 500 }, digest);
    const created: number[] = [];
    const reviews: string[] = [];
    for (const text of v.facts.map((f) => f.trim()).filter((f) => f.length >= 15 && !scanMemoryText(f)).slice(0, 3)) {
      // confidence below the shared threshold parks the fact as pending + queues a review; we retag that review as a procedure
      const r = await addFact({ tag: "shared", text, source: "consolidation", createdBy: "consolidation", factType: "procedure", confidence: 0.4, importance: 0.6, agentContext: "consolidation" });
      if (r.deduped) continue;
      created.push(r.id);
      if (r.reviewId) { reviews.push(r.reviewId); await db.update(memoryReviews).set({ kind: "procedure" }).where(eq(memoryReviews.id, r.reviewId)); }
    }
    if (created.length) { await record(runId, "procedure", "shared", created, { created, reviews }); out.procedures = created.length; }
  });

  // 7. retention of operational data
  await step("retention", async () => {
    const purged = [
      sql`delete from tool_results where created_at < now() - interval '14 days' returning 1`,
      sql`delete from embedding_cache where created_at < now() - interval '90 days' returning 1`,
      sql`delete from thread_state where updated_at < now() - interval '60 days' returning 1`,
    ];
    for (const q of purged) out.purged += rows(await db.execute(q)).length;
  });
  clearRecallCache();
  return out;
}

async function completeJsonText(system: string, prompt: string): Promise<string> {
  const { completeText } = await import("./llm");
  return completeText({ system, prompt, role: "summarize", maxOutputTokens: 300 });
}

async function ensureBlockRow(tag: string) {
  await db.insert(coreBlocks).values({ id: newId("cb_"), scopeTag: tag, label: "channel", text: "", charLimit: BLOCK_LIMITS.channel }).onConflictDoNothing();
}

/**
 * Reverses one consolidation_log entry: restores the snapshotted rows (status, pointer, importance, decay clock), soft-deletes
 * facts the action created, rejects its still-pending review, and puts a block line back / takes it out. Idempotent.
 */
export async function undoConsolidation(logId: number, by = "admin"): Promise<{ ok: boolean; error?: string }> {
  const [entry] = await db.select().from(consolidationLog).where(eq(consolidationLog.id, logId));
  if (!entry) return { ok: false, error: "not_found" };
  if (entry.undoneAt) return { ok: false, error: "already_undone" };
  const d = entry.details as { rows?: Snap[]; winner?: Snap; created?: number[]; reviews?: string[]; reviewId?: string; block?: { scopeTag: string; label: "company" | "channel" | "user"; added?: string | null; removed?: string | null } };
  await db.transaction(async (tx) => {
    for (const r of [...(d.rows ?? []), ...(d.winner ? [d.winner] : [])]) {
      await tx.update(memories).set({
        status: r.status as "active", supersededBy: r.supersededBy, invalidAt: r.invalidAt ? new Date(r.invalidAt) : null,
        importance: r.importance, decayedAt: r.decayedAt ? new Date(r.decayedAt) : null,
      }).where(eq(memories.id, r.id));
    }
    if (d.created?.length) await tx.update(memories).set({ status: "deleted", invalidAt: new Date() }).where(sql`${memories.id} in (${idList(d.created)})`);
    const rv = [...(d.reviews ?? []), ...(d.reviewId ? [d.reviewId] : [])];
    for (const id of rv) await tx.update(memoryReviews).set({ status: "rejected", decidedBy: by, decidedAt: new Date() }).where(and(eq(memoryReviews.id, id), eq(memoryReviews.status, "pending")));
    if (d.reviews?.length) await tx.update(memories).set({ reviewState: "rejected" }).where(sql`${memories.id} in (${idList(entry.memoryIds)}) and ${memories.reviewState} = 'pending'`);
    await tx.update(consolidationLog).set({ undoneAt: new Date() }).where(eq(consolidationLog.id, logId));
  });
  // block lines: undo the line-level change (the block may have been edited since, so no wholesale restore)
  const b = d.block;
  if (b) {
    const blk = (await db.select().from(coreBlocks).where(and(eq(coreBlocks.scopeTag, b.scopeTag), eq(coreBlocks.label, b.label))))[0];
    if (blk) {
      let lines = blk.text ? blk.text.split("\n") : [];
      if (b.added) lines = lines.filter((l) => l !== b.added);
      if (b.removed && !lines.includes(b.removed)) lines.unshift(b.removed);
      await applyCoreBlockReview({ label: b.label, tag: b.scopeTag, op: "set", text: lines.join("\n"), match: null }, by);
    }
  }
  // a promote/demote that an admin already approved is reversed with the inverse core_block edit
  if (d.reviewId) {
    const [rv] = await db.select().from(memoryReviews).where(eq(memoryReviews.id, d.reviewId));
    const p = rv?.payload as { label: "company"; tag: string; op: string; text?: string | null; match?: string | null } | undefined;
    if (rv?.status === "approved" && p) {
      await applyCoreBlockReview(p.op === "add" ? { label: p.label, tag: p.tag, op: "remove", text: null, match: p.text ?? null } : { label: p.label, tag: p.tag, op: "add", text: p.match ?? null, match: null }, by);
    }
  }
  clearRecallCache();
  return { ok: true };
}
