import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { channels, commitments, managerRisks, memoryReviews, memories, workspace } from "../db/schema";
import { log } from "../log";
import { embed } from "../memory/embed";
import { SHARED_TAG } from "../memory/scope";
import { slackClient } from "../slack/client";
import { featureChannels } from "../slack/proactive-features";
import { sanitizeForSlack } from "../slack/sanitize";
import { ACTIVE } from "./commitments";

const DAY = 86_400_000;
/** Open commitments with different owners whose texts embed this close are flagged as duplicated work. */
export const DUPLICATE_WORK_SIMILARITY = 0.85;
const STALE_DAYS = 90;

export type Risk = { key: string; scopeTag: string; channelId: string | null; text: string };
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (d: Date) => d.toISOString().slice(0, 10);
const chanOf = (scopeTag: string) => (scopeTag.startsWith("channel_") ? scopeTag.slice(8) : null);

const cosine = (a: number[], b: number[]) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! * a[i]!; y += b[i]! * b[i]!; }
  return x && y ? d / Math.sqrt(x * y) : 0;
};

/** Every risk currently visible in the data (not yet de-duplicated against what was already posted). */
export async function scanRisks(now = new Date()): Promise<Risk[]> {
  const out: Risk[] = [];

  // 1. slipping / overdue commitments
  const slipping = await db.select().from(commitments).where(and(
    inArray(commitments.status, [...ACTIVE]),
    or(lt(commitments.dueAt, new Date(now.getTime() - 2 * DAY)), and(eq(commitments.status, "overdue"), sql`${commitments.nudgeCount} >= 2`)),
  )).limit(50);
  for (const c of slipping) {
    out.push({ key: `overdue:${c.id}`, scopeTag: c.scopeTag, channelId: c.channelId ?? chanOf(c.scopeTag),
      text: `:hourglass_flowing_sand: Slipping: ${c.ownerName ? `${c.ownerName}: ` : ""}${clip(c.text)}${c.dueAt ? ` (due ${day(c.dueAt)})` : ""}` });
  }

  // 1b. exceptions: unassigned for > 3 days, urgent task with no date for > 3 days (keys de-dup like every other risk)
  const aged = new Date(now.getTime() - 3 * DAY);
  const unowned = await db.select().from(commitments).where(and(inArray(commitments.status, [...ACTIVE]), sql`${commitments.ownerId} is null`, lt(commitments.createdAt, aged))).limit(50);
  for (const c of unowned) out.push({ key: `unassigned_aging:${c.id}`, scopeTag: c.scopeTag, channelId: c.channelId ?? chanOf(c.scopeTag), text: `:bust_in_silhouette: Unassigned for ${Math.floor((now.getTime() - c.createdAt.getTime()) / DAY)} days: ${clip(c.text)}` });
  const nodue = await db.select().from(commitments).where(and(inArray(commitments.status, [...ACTIVE]), eq(commitments.priority, "urgent"), sql`${commitments.dueAt} is null`, lt(commitments.createdAt, aged))).limit(50);
  for (const c of nodue) out.push({ key: `no_due_date:${c.id}`, scopeTag: c.scopeTag, channelId: c.channelId ?? chanOf(c.scopeTag), text: `:calendar: Urgent task with no due date: ${c.ownerName ? `${c.ownerName}: ` : ""}${clip(c.text)}` });

  // 2. contradictions: open reviews (supersede / doc conflict) and recent supersessions that cross sources
  const reviews = await db.select({ id: memoryReviews.id, text: memories.text, scopeTag: memories.scopeTag }).from(memoryReviews)
    .innerJoin(memories, eq(memories.id, memoryReviews.memoryId))
    .where(and(eq(memoryReviews.status, "pending"), inArray(memoryReviews.kind, ["supersede", "doc_conflict"]))).limit(20);
  for (const r of reviews) out.push({ key: `conflict:${r.id}`, scopeTag: r.scopeTag, channelId: chanOf(r.scopeTag), text: `:warning: Conflicting information awaiting review: ${clip(r.text)}` });
  const crossed = await db.execute(sql`
    select o.id, o.text as old_text, n.text as new_text, o.scope_tag from memories o join memories n on n.id = o.superseded_by
    where o.status = 'superseded' and n.status = 'active' and o.scope_tag = n.scope_tag and o.source <> n.source
      and o.invalid_at > ${new Date(now.getTime() - 7 * DAY).toISOString()}::timestamptz limit 20`);
  for (const r of crossed.rows as { id: number; old_text: string; new_text: string; scope_tag: string }[]) {
    out.push({ key: `contradiction:${r.id}`, scopeTag: r.scope_tag, channelId: chanOf(r.scope_tag), text: `:warning: Sources disagree. Was: "${clip(r.old_text, 100)}" Now: "${clip(r.new_text, 100)}"` });
  }

  // 3. stale decisions: old decision with a newer related fact in the same scope
  const stale = await db.execute(sql`
    select d.id, d.text, d.scope_tag, d.valid_at from memories d
    where d.kind = 'fact' and d.status = 'active' and d.fact_type = 'decision' and d.valid_at < ${new Date(now.getTime() - STALE_DAYS * DAY).toISOString()}::timestamptz
      and exists (select 1 from memory_edges e join memories n on n.id = case when e.from_id = d.id then e.to_id else e.from_id end
        where (e.from_id = d.id or e.to_id = d.id) and n.status = 'active' and n.kind = 'fact' and n.scope_tag = d.scope_tag and n.id <> d.id and n.valid_at > d.valid_at + interval '30 days')
    limit 20`);
  for (const r of stale.rows as { id: number; text: string; scope_tag: string; valid_at: Date }[]) {
    out.push({ key: `stale:${r.id}`, scopeTag: r.scope_tag, channelId: chanOf(r.scope_tag), text: `:file_cabinet: Possibly stale decision (newer related facts exist): ${clip(r.text)}` });
  }

  // 4. duplicated work: near-identical open commitments with different owners (same scope only)
  const open = await db.select().from(commitments).where(and(inArray(commitments.status, [...ACTIVE]), sql`${commitments.ownerId} is not null`)).limit(200);
  if (open.length > 1) {
    const vecs = await embed(open.map((c) => c.text));
    for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
      const a = open[i]!, b = open[j]!;
      if (a.ownerId === b.ownerId || a.scopeTag !== b.scopeTag || cosine(vecs[i]!, vecs[j]!) < DUPLICATE_WORK_SIMILARITY) continue;
      const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
      out.push({ key: `dup:${lo.id}:${hi.id}`, scopeTag: a.scopeTag, channelId: a.channelId ?? b.channelId ?? chanOf(a.scopeTag),
        text: `:busts_in_silhouette: Possible duplicated work: ${lo.ownerName ?? lo.ownerId} and ${hi.ownerName ?? hi.ownerId} both own "${clip(lo.text, 100)}"` });
    }
  }
  return out;
}

/**
 * Scans, drops risks already posted, and posts one note per destination. A private-scope risk goes only to its own (opted-in)
 * private channel; a shared risk goes to its public opted-in channel, else the admin home channel; DM-scope risks are never posted.
 */
export async function riskTick(now = new Date()): Promise<{ posted: number; channels: string[] }> {
  const risks = await scanRisks(now);
  if (!risks.length) return { posted: 0, channels: [] };
  const optedIds = await featureChannels("risks");
  const chans = new Map((await db.select({ id: channels.id, p: channels.isPrivate, im: channels.isIm, bot: channels.botIsMember }).from(channels)).map((c) => [c.id, c]));
  const [ws] = await db.select({ home: workspace.homeChannelId }).from(workspace).limit(1);
  const postable = (id: string | null | undefined) => { const c = id ? chans.get(id) : null; return !!c && c.bot && !c.im && optedIds.includes(c.id); };

  const byDest = new Map<string, Risk[]>();
  for (const r of risks) {
    let dest: string | null = null;
    if (r.scopeTag === SHARED_TAG) dest = r.channelId && postable(r.channelId) && !chans.get(r.channelId)!.p ? r.channelId : ws?.home ?? null;
    else if (r.scopeTag.startsWith("channel_")) dest = postable(chanOf(r.scopeTag)) ? chanOf(r.scopeTag) : null;
    if (dest) byDest.set(dest, [...(byDest.get(dest) ?? []), r]);
  }

  let posted = 0;
  const sentTo: string[] = [];
  for (const [dest, list] of byDest) {
    const claimed = await db.insert(managerRisks).values(list.map((r) => ({ key: r.key }))).onConflictDoNothing().returning({ key: managerRisks.key });
    const keys = new Set(claimed.map((c) => c.key));
    const fresh = list.filter((r) => keys.has(r.key)).slice(0, 10);
    // anything beyond the cap is released so tomorrow's scan picks it up
    const overflow = list.filter((r) => keys.has(r.key)).slice(10).map((r) => r.key);
    if (overflow.length) await db.delete(managerRisks).where(inArray(managerRisks.key, overflow));
    if (!fresh.length) continue;
    try {
      await (await slackClient()).chat.postMessage({ channel: dest, text: sanitizeForSlack(`*Risk watch*\n${fresh.map((r) => r.text).join("\n")}`) });
      posted += fresh.length;
      sentTo.push(dest);
    } catch (e) {
      await db.delete(managerRisks).where(inArray(managerRisks.key, fresh.map((r) => r.key))); // retry tomorrow
      log.warn("risk post failed", { channel: dest, err: String(e) });
    }
  }
  return { posted, channels: sentTo };
}
