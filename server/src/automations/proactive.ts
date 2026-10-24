import { and, desc, eq, gt, gte, inArray, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { db } from "../db";
import { channels, episodes, meetings, memories, memoryReminders } from "../db/schema";
import { log } from "../log";
import { SHARED_TAG } from "../memory/scope";
import { featureChannels } from "../slack/proactive-features";
import { sanitizeForSlack } from "../slack/sanitize";
import { slackClient } from "../slack/client";

const DAY = 86_400_000;
export const PROACTIVE_Q = { digest: "digest-weekly", deadlines: "deadline-reminders" } as const;
type Ch = { id: string; isPrivate: boolean };

/**
 * Facts that belong to one channel. Private channel: its own scope tag. Public channel: "shared" facts whose source is the
 * channel (observe) or one of its threads. A private channel's facts are never selected for another channel, and a public
 * channel never selects anything but "shared".
 * ponytail: shared facts carry no channel column, so attribution is by source_ref; add a source_channel column if this misses facts.
 */
function channelFacts(ch: Ch): SQL {
  if (ch.isPrivate) return eq(memories.scopeTag, `channel_${ch.id}`);
  return and(
    eq(memories.scopeTag, SHARED_TAG),
    or(
      eq(memories.sourceRef, ch.id),
      inArray(memories.sourceRef, sql`(select thread_ts from turns where channel_id = ${ch.id} and thread_ts is not null union select thread_ts from episodes where channel_id = ${ch.id})`),
    ),
  )!;
}

const live = (ch: Ch) => and(channelFacts(ch), eq(memories.kind, "fact"), eq(memories.status, "active"), eq(memories.reviewState, "ok"));
const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (d: Date) => d.toISOString().slice(0, 10);
const OPEN = "(todo|to-do|action item|follow[- ]up|pending|blocked|open question|needs? to|waiting on)";

/** Weekly digest text for one channel, or null when the week was quiet. */
export async function buildDigest(ch: Ch, now = new Date()): Promise<string | null> {
  const week = new Date(now.getTime() - 7 * DAY);
  const sel = { id: memories.id, text: memories.text, validUntil: memories.validUntil };
  const [decisions, deadlines, open, fresh, threads, meets] = await Promise.all([
    db.select(sel).from(memories).where(and(live(ch), eq(memories.factType, "decision"), gte(memories.createdAt, week))).orderBy(desc(memories.createdAt)).limit(8),
    db.select(sel).from(memories).where(and(live(ch), gt(memories.validUntil, now), lte(memories.validUntil, new Date(now.getTime() + 14 * DAY)))).orderBy(memories.validUntil).limit(8),
    db.select(sel).from(memories).where(and(live(ch), gte(memories.createdAt, new Date(now.getTime() - 30 * DAY)), sql`${memories.text} ~* ${OPEN}`)).orderBy(desc(memories.createdAt)).limit(8),
    db.select(sel).from(memories).where(and(live(ch), gte(memories.createdAt, week), sql`${memories.factType} <> 'decision'`)).orderBy(desc(memories.createdAt)).limit(30),
    db.select({ summary: episodes.summary }).from(episodes).where(and(eq(episodes.channelId, ch.id), gte(episodes.endedAt, week), eq(episodes.scopeTag, ch.isPrivate ? `channel_${ch.id}` : SHARED_TAG))).orderBy(desc(episodes.endedAt)).limit(4),
    db.select({ title: meetings.title, summary: meetings.summary }).from(meetings).where(and(eq(meetings.channelId, ch.id), eq(meetings.status, "ready"), gte(meetings.endedAt, week))).orderBy(desc(meetings.endedAt)).limit(4),
  ]);
  const shown = new Set([...decisions, ...deadlines, ...open].map((r) => r.id));
  const newFacts = fresh.filter((r) => !shown.has(r.id)).slice(0, 8);
  const section = (title: string, lines: string[]) => (lines.length ? `*${title}*\n${lines.map((l) => `• ${clip(l)}`).join("\n")}` : "");
  const parts = [
    section("Decisions", decisions.map((r) => r.text)),
    section("Open items", open.map((r) => r.text)),
    section("Deadlines", deadlines.map((r) => `${r.text} (by ${day(r.validUntil!)})`)),
    section("New facts", newFacts.map((r) => r.text)),
    section("Discussions", threads.map((r) => r.summary)),
    section("Meetings", meets.map((m) => (m.summary ? `${m.title}: ${m.summary}` : m.title))),
  ].filter(Boolean);
  if (!parts.length) return null;
  return sanitizeForSlack(`:newspaper: *Weekly digest*\n\n${parts.join("\n\n")}`);
}

async function optedIn(feature: "digest" | "deadlines"): Promise<Ch[]> {
  const ids = await featureChannels(feature);
  if (!ids.length) return [];
  return db.select({ id: channels.id, isPrivate: channels.isPrivate }).from(channels)
    .where(and(inArray(channels.id, ids), eq(channels.botIsMember, true), eq(channels.isIm, false)));
}

/** Posts the digest to every opted-in channel. Returns the channel ids posted to. */
export async function digestTick(now = new Date()): Promise<string[]> {
  const sent: string[] = [];
  for (const ch of await optedIn("digest")) {
    try {
      const text = await buildDigest(ch, now);
      if (!text) continue;
      await (await slackClient()).chat.postMessage({ channel: ch.id, text });
      sent.push(ch.id);
    } catch (e) { log.warn("digest failed", { channel: ch.id, error: String(e) }); }
  }
  return sent;
}

/** One reminder per fact whose valid_until falls in the next 24h, posted to the (opted-in) channel it belongs to. */
export async function deadlineTick(now = new Date()): Promise<number> {
  let n = 0;
  for (const ch of await optedIn("deadlines")) {
    const done = db.select({ id: memoryReminders.memoryId }).from(memoryReminders);
    const due = await db.select({ id: memories.id, text: memories.text, validUntil: memories.validUntil }).from(memories)
      .where(and(live(ch), gt(memories.validUntil, now), lte(memories.validUntil, new Date(now.getTime() + DAY)), notInArray(memories.id, done)))
      .orderBy(memories.validUntil).limit(10);
    for (const f of due) {
      const claimed = await db.insert(memoryReminders).values({ memoryId: f.id, channelId: ch.id }).onConflictDoNothing().returning({ id: memoryReminders.memoryId });
      if (!claimed.length) continue; // another worker got it
      try {
        await (await slackClient()).chat.postMessage({ channel: ch.id, text: sanitizeForSlack(`:alarm_clock: Heads up, due by ${f.validUntil!.toISOString().slice(0, 16).replace("T", " ")} UTC: ${clip(f.text)}`) });
        n++;
      } catch (e) {
        await db.delete(memoryReminders).where(eq(memoryReminders.memoryId, f.id)); // let the next tick retry
        log.warn("deadline reminder failed", { channel: ch.id, error: String(e) });
      }
    }
  }
  return n;
}

export async function registerProactiveJobs(b: PgBoss): Promise<void> {
  for (const q of Object.values(PROACTIVE_Q)) await b.createQueue(q, { name: q, retryLimit: 0, policy: "short" });
  await b.work(PROACTIVE_Q.digest, async () => { log.info("weekly digest", { channels: await digestTick() }); });
  await b.work(PROACTIVE_Q.deadlines, async () => { log.info("deadline reminders", { sent: await deadlineTick() }); });
  await b.schedule(PROACTIVE_Q.digest, "0 9 * * 1");
  await b.schedule(PROACTIVE_Q.deadlines, "17 * * * *");
}
