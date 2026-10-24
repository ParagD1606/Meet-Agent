import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { channels, commitments, episodes, meetings, memories, users } from "../db/schema";
import { log } from "../log";
import { SHARED_TAG } from "../memory/scope";
import { slackClient } from "../slack/client";
import { featureChannels } from "../slack/proactive-features";
import { sanitizeForSlack } from "../slack/sanitize";
import { canRead, type Commitment } from "./commitments";
import { taskFlags } from "./tasks";

const DAY = 86_400_000;
type Ch = { id: string; isPrivate: boolean };

/** Scope tags a channel's post may draw from: a public channel sees "shared" only; a private one adds its own tag. Never other private channels, never DMs. */
export const channelTags = (ch: Ch) => (ch.isPrivate ? [SHARED_TAG, `channel_${ch.id}`] : [SHARED_TAG]);

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (d: Date) => d.toISOString().slice(0, 10);
const BLOCKED = /\b(blocked|waiting on|stuck)\b/i;

async function channelCommitments(ch: Ch, since: Date): Promise<Commitment[]> {
  return db.select().from(commitments).where(and(
    eq(commitments.channelId, ch.id), inArray(commitments.scopeTag, channelTags(ch)),
    or(inArray(commitments.status, ["open", "overdue"]), gte(commitments.completedAt, since)),
  )).orderBy(commitments.dueAt).limit(300);
}

const line = (c: Commitment) => `• ${clip(c.text)}${c.dueAt ? ` (due ${day(c.dueAt)})` : ""}${c.permalink ? ` <${c.permalink}|source>` : ""}`;

/** "@owner" only when the owner can read the task's scope (a private-channel task never pings an outsider); otherwise the plain name. */
const who = async (c: Commitment) => (c.ownerId && (await canRead(c, c.ownerId)) ? `<@${c.ownerId}>` : c.ownerName ?? "no owner");

/**
 * Team-level exception block from already scope-filtered rows: unassigned, no due date, top-5 overdue with owners, stale.
 * `weekly` adds the stale line and the overdue top 5 (the daily standup already lists overdue per person as Blocked).
 */
export async function exceptionBlock(rows: Commitment[], now: Date, weekly = false): Promise<string> {
  const f = rows.map((c) => ({ c, fl: taskFlags(c, now) }));
  const pick = (k: string) => f.filter((x) => x.fl.includes(k as never)).map((x) => x.c);
  const unassigned = pick("unassigned"), noDue = pick("noDue"), stale = pick("stale");
  const overdue = pick("overdue").sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
  const sec = async (t: string, l: Commitment[], withOwner: boolean) => l.length
    ? `*${t}* (${l.length})\n${(await Promise.all(l.slice(0, 5).map(async (c) => `${line(c)}${withOwner ? ` - ${await who(c)}` : ""}`))).join("\n")}${l.length > 5 ? `\n_...and ${l.length - 5} more._` : ""}` : "";
  const parts = [await sec("Unassigned", unassigned, false), await sec("No due date", noDue, true),
    ...(weekly ? [await sec("Overdue (oldest first)", overdue, true), await sec("Stale (open > 14 days, untouched)", stale, true)] : [])].filter(Boolean);
  return parts.length ? `:rotating_light: *Needs attention*\n${parts.join("\n\n")}` : "";
}

/** Per-person daily summary (done in the last 24h / in progress / blocked) for one channel, or null when there is nothing to say. */
export async function buildDailyStandup(ch: Ch, now = new Date()): Promise<string | null> {
  const rows = await channelCommitments(ch, new Date(now.getTime() - DAY));
  if (!rows.length) return null;
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users)).map((u) => [u.id, u.name]));
  const byPerson = new Map<string, Commitment[]>();
  for (const c of rows) {
    const name = (c.ownerId && names.get(c.ownerId)) || c.ownerName || "Unassigned";
    byPerson.set(name, [...(byPerson.get(name) ?? []), c]);
  }
  const sections: string[] = [];
  for (const [name, list] of [...byPerson].sort(([a], [b]) => a.localeCompare(b))) {
    const done = list.filter((c) => c.status === "done");
    const blocked = list.filter((c) => c.status === "overdue" || (c.status === "open" && BLOCKED.test(c.text)));
    const prog = list.filter((c) => c.status === "open" && !blocked.includes(c));
    const part = (t: string, l: Commitment[]) => (l.length ? `_${t}_\n${l.map(line).join("\n")}` : "");
    sections.push(`*${name}*\n${[part("Done", done), part("In progress", prog), part("Blocked", blocked)].filter(Boolean).join("\n")}`);
  }
  const attention = await exceptionBlock(rows, now);
  return sanitizeForSlack(`:sunrise: *Daily standup*\n\n${[...sections, attention].filter(Boolean).join("\n\n")}`);
}

/** Weekly per-project (channel) status from commitments, recent facts, thread summaries, meetings and GitHub/Linear facts. Null when quiet. */
export async function buildWeeklyStatus(ch: Ch, now = new Date()): Promise<string | null> {
  const week = new Date(now.getTime() - 7 * DAY);
  const tags = channelTags(ch);
  const live = and(inArray(memories.scopeTag, tags), eq(memories.kind, "fact"), eq(memories.status, "active"), eq(memories.reviewState, "ok"), gte(memories.createdAt, week));
  const external = sql`(${memories.source} in ('github','linear') or ${memories.permalink} ~* 'github\\.com|linear\\.app')`;
  // a public channel only claims shared facts sourced from itself or its threads; a private one's own tag is already specific
  const attrib = ch.isPrivate ? undefined : sql`(${memories.sourceRef} in (select ${ch.id}::text union select thread_ts from episodes where channel_id = ${ch.id}) or ${memories.sourceRef} like ${ch.id + "/%"})`;
  const [cs, decisions, ext, threads, meets] = await Promise.all([
    channelCommitments(ch, week),
    db.select({ text: memories.text }).from(memories).where(and(live, eq(memories.factType, "decision"), attrib)).orderBy(desc(memories.createdAt)).limit(5),
    db.select({ text: memories.text, permalink: memories.permalink }).from(memories).where(and(live, external)).orderBy(desc(memories.createdAt)).limit(5),
    db.select({ summary: episodes.summary }).from(episodes).where(and(eq(episodes.channelId, ch.id), inArray(episodes.scopeTag, tags), gte(episodes.endedAt, week))).orderBy(desc(episodes.endedAt)).limit(4),
    db.select({ title: meetings.title, summary: meetings.summary }).from(meetings).where(and(eq(meetings.channelId, ch.id), eq(meetings.status, "ready"), gte(meetings.endedAt, week))).orderBy(desc(meetings.endedAt)).limit(4),
  ]);
  const done = cs.filter((c) => c.status === "done");
  const overdue = cs.filter((c) => c.status === "overdue");
  const open = cs.filter((c) => c.status === "open");
  const sec = (t: string, l: string[]) => (l.length ? `*${t}*\n${l.map((x) => `• ${clip(x)}`).join("\n")}` : "");
  const owner = (c: Commitment) => `${c.ownerName ? `${c.ownerName}: ` : ""}${c.text}`;
  const attention = await exceptionBlock(cs, now, true);
  const parts = [
    cs.length ? `${done.length} done, ${open.length} in progress, ${overdue.length} overdue` : "",
    sec("Done", done.map(owner)), sec("Overdue", overdue.map(owner)), sec("In progress", open.map(owner)),
    sec("Decisions", decisions.map((d) => d.text)),
    sec("GitHub / Linear", ext.map((e) => e.text)),
    sec("Discussions", threads.map((t) => t.summary)),
    sec("Meetings", meets.map((m) => (m.summary ? `${m.title}: ${m.summary}` : m.title))),
    attention,
  ].filter(Boolean);
  if (!parts.length) return null;
  return sanitizeForSlack(`:bar_chart: *Weekly project status*\n\n${parts.join("\n\n")}`);
}

/** Posts the daily standup or weekly status to every opted-in ("standup") channel the bot is in. Returns channels posted to. */
export async function standupTick(kind: "daily" | "weekly", now = new Date()): Promise<string[]> {
  const ids = await featureChannels("standup");
  if (!ids.length) return [];
  const chs = await db.select({ id: channels.id, isPrivate: channels.isPrivate }).from(channels)
    .where(and(inArray(channels.id, ids), eq(channels.botIsMember, true), eq(channels.isIm, false)));
  const sent: string[] = [];
  for (const ch of chs) {
    try {
      const text = await (kind === "daily" ? buildDailyStandup(ch, now) : buildWeeklyStatus(ch, now));
      if (!text) continue;
      await (await slackClient()).chat.postMessage({ channel: ch.id, text });
      sent.push(ch.id);
    } catch (e) { log.warn("standup failed", { channel: ch.id, error: String(e) }); }
  }
  return sent;
}
