import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { ambientMessages, channels, users } from "../db/schema";
import { log } from "../log";
import { postMessage, slackClient } from "../slack/client";
import { isTrivialMessage } from "./budget";
import { scanMemoryText } from "./core-blocks";
import { tuning } from "./freshness";
import { plain } from "./observe";
import { writeTag } from "./scope";
import { captureTurn } from "./writeback";

/**
 * Ambient capture: every human message in a channel the bot is in (public -> shared, private -> channel_X only) is buffered in
 * `ambient_messages` and extracted in debounced per-channel batches. (channel, ts) is the idempotency key shared with the
 * polling observe job, so events + poll never double-add. Messages bound for the bot (mentions, DMs) are left to the turn pipeline.
 */

/** Slack/GitHub/AWS/Google/Stripe-style tokens, key=value credentials, PEM blocks and card-number-looking digit runs. */
const SECRET_RE = new RegExp([
  String.raw`\b(?:xox[abposr]-|xapp-|ghp_|gho_|github_pat_|sk-[a-z]{0,4}-?|sk_live_|pk_live_|rk_live_|AKIA|AIza|ya29\.)[A-Za-z0-9_\-.]{8,}`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  String.raw`\b(?:password|passwd|pwd|passcode|secret|api[_ -]?key|token|bearer)\b\s*(?:is|=|:)\s*\S{4,}`,
  String.raw`\b(?:\d[ -]?){13,19}\b`,
].join("|"), "i");
export const hasSecret = (text: string): boolean => SECRET_RE.test(text);

/** Cleaned text worth remembering, or null (too short, trivial, emoji only, secret, injection-looking). */
export function ambientText(raw: string, names: Map<string, string> = new Map()): string | null {
  const text = plain(raw, names);
  if (text.length < 20 || isTrivialMessage(text)) return null;
  if (!text.replace(/:[a-z0-9_+-]+:/gi, "").replace(/[\p{P}\p{S}\s]/gu, "")) return null;
  if (hasSecret(text) || scanMemoryText(text)) return null;
  return text;
}

export const ambientIo = {
  post: (channel: string, text: string) => postMessage({ channel, text }).then(() => undefined),
  permalink: async (channel: string, ts: string): Promise<string | null> =>
    ((await (await slackClient()).chat.getPermalink({ channel, message_ts: ts })).permalink as string | undefined) ?? null,
};

export const NOTICE = "I learn from what's said in this channel so I can answer questions about it later. Admins can pause me here with `/brain-pause`.";

/** Posts the one-time notice (claimed atomically, so it never repeats). */
export async function announceAmbient(channelId: string): Promise<boolean> {
  const [row] = await db.update(channels).set({ ambientNoticeAt: new Date() })
    .where(and(eq(channels.id, channelId), isNull(channels.ambientNoticeAt), eq(channels.isIm, false))).returning({ id: channels.id });
  if (!row) return false;
  await ambientIo.post(channelId, NOTICE).catch((e) => log.warn("ambient notice failed", { channelId, err: String(e) }));
  return true;
}

// ---- hourly extraction budget (per process; ponytail: use rate_limits table if replicas > 1) ----
const calls: number[] = [];
export const resetAmbientRate = () => { calls.length = 0; };
function takeBudget(now: number): boolean {
  const max = Number(process.env.MEMORY_AMBIENT_MAX_PER_HOUR ?? 60);
  while (calls.length && now - calls[0]! >= 3_600_000) calls.shift();
  if (calls.length >= max) return false;
  calls.push(now);
  return true;
}

type Ev = { channel: string; ts: string; thread_ts?: string; user: string; text: string };
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Buffers one message for an observed channel. Returns true when it was stored. */
export async function recordAmbient(ev: Ev, now = Date.now()): Promise<boolean> {
  const [ch] = await db.select().from(channels).where(eq(channels.id, ev.channel));
  if (!ch || ch.isIm || !ch.botIsMember || ch.observe === false || ch.proactivity === "quiet") return false;
  const text = ambientText(ev.text);
  if (!text) return false;
  const ins = await db.insert(ambientMessages).values({ channelId: ev.channel, ts: ev.ts, threadTs: ev.thread_ts ?? null, userId: ev.user, text })
    .onConflictDoNothing().returning({ ts: ambientMessages.ts });
  if (!ins.length) return false;
  void announceAmbient(ev.channel);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(ambientMessages)
    .where(and(eq(ambientMessages.channelId, ev.channel), isNull(ambientMessages.flushedAt)));
  clearTimeout(timers.get(ev.channel));
  if (n >= tuning().ambientMax) { void flushAmbient(ev.channel, now).catch((e) => log.warn("ambient flush failed", { err: String(e) })); return true; }
  const t = setTimeout(() => { timers.delete(ev.channel); void flushAmbient(ev.channel).catch((e) => log.warn("ambient flush failed", { err: String(e) })); }, tuning().idleMs);
  (t as { unref?: () => void }).unref?.();
  timers.set(ev.channel, t);
  return true;
}

/** message_changed: only a still-buffered message can be edited. message_deleted: drops it if still buffered (already-extracted facts stay: gap). */
export async function editAmbient(channelId: string, ts: string, raw: string): Promise<void> {
  const text = ambientText(raw);
  const where = and(eq(ambientMessages.channelId, channelId), eq(ambientMessages.ts, ts), isNull(ambientMessages.flushedAt));
  if (text) await db.update(ambientMessages).set({ text }).where(where);
  else await db.delete(ambientMessages).where(where);
}
export const dropAmbient = (channelId: string, ts: string) => editAmbient(channelId, ts, "");

/** Records (channel, ts) pairs the poll already handled so late events skip them. */
export async function markPolled(channelId: string, tss: string[]): Promise<void> {
  if (tss.length) await db.insert(ambientMessages).values(tss.map((ts) => ({ channelId, ts, flushedAt: new Date() }))).onConflictDoNothing();
}
export async function alreadySeen(channelId: string, tss: string[]): Promise<Set<string>> {
  if (!tss.length) return new Set();
  const rows = await db.select({ ts: ambientMessages.ts }).from(ambientMessages).where(and(eq(ambientMessages.channelId, channelId), inArray(ambientMessages.ts, tss)));
  return new Set(rows.map((r) => r.ts));
}

const BATCH_CHARS = 12_000;

/** Extracts a channel's buffered messages (claim-then-extract; batches beyond the hourly budget stay buffered). */
export async function flushAmbient(channelId: string, now = Date.now()): Promise<{ messages: number; facts: number; deferred: number }> {
  clearTimeout(timers.get(channelId));
  timers.delete(channelId);
  const out = { messages: 0, facts: 0, deferred: 0 };
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  const scope = ch && { channelId, isPrivate: ch.isPrivate, isIm: false, userId: null };
  if (!ch || ch.isIm || ch.observe === false || !scope || !writeTag(scope)) {
    await db.delete(ambientMessages).where(and(eq(ambientMessages.channelId, channelId), isNull(ambientMessages.flushedAt)));
    return out;
  }
  const rows = await db.update(ambientMessages).set({ flushedAt: new Date(now) })
    .where(and(eq(ambientMessages.channelId, channelId), isNull(ambientMessages.flushedAt))).returning();
  if (!rows.length) return out;
  rows.sort((a, b) => Number(a.ts) - Number(b.ts));
  const ids = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const names = new Map(people.map((p) => [p.id, p.name ?? p.id]));

  const batches: (typeof rows)[] = [[]];
  let size = 0;
  for (const r of rows) {
    const len = r.text.length + 40;
    if (size + len > BATCH_CHARS && batches.at(-1)!.length) { batches.push([]); size = 0; }
    batches.at(-1)!.push(r);
    size += len;
  }
  for (const b of batches) {
    if (!takeBudget(now)) {
      out.deferred += b.length;
      await db.update(ambientMessages).set({ flushedAt: null }).where(and(eq(ambientMessages.channelId, channelId), inArray(ambientMessages.ts, b.map((r) => r.ts))));
      continue;
    }
    const transcript = b.map((r) => `${names.get(r.userId ?? "") ?? r.userId ?? "someone"}: ${r.text.slice(0, 1500)}`).join("\n");
    const permalink = await ambientIo.permalink(channelId, b[0]!.threadTs ?? b[0]!.ts).catch(() => null);
    out.facts += await captureTurn({
      scope, transcript, sourceRef: `${channelId}/${b[0]!.threadTs ?? b[0]!.ts}`, permalink, createdBy: "observe", confidence: 0.8, importance: 0.4,
      at: new Date(Number(b.at(-1)!.ts) * 1000),
    });
    out.messages += b.length;
  }
  // text is only needed until extracted; keep the (channel, ts) rows as the dedupe ledger
  await db.update(ambientMessages).set({ text: "" }).where(and(eq(ambientMessages.channelId, channelId), sql`${ambientMessages.flushedAt} is not null and ${ambientMessages.text} <> ''`));
  return out;
}

/** Sweep: flush every channel with buffered messages older than idleMs (covers timers lost to a restart). */
export async function flushIdleAmbient(idleMs = tuning().idleMs, now = Date.now()): Promise<number> {
  const rows = await db.selectDistinct({ c: ambientMessages.channelId }).from(ambientMessages)
    .where(and(isNull(ambientMessages.flushedAt), sql`${ambientMessages.createdAt} <= ${new Date(now - idleMs)}`));
  let n = 0;
  for (const r of rows) n += (await flushAmbient(r.c, now)).facts;
  return n;
}

/** Pause/resume (admins; also /brain-pause, /brain-resume). Pausing drops anything still buffered. */
export async function setObserve(channelId: string, observe: boolean): Promise<boolean> {
  const rows = await db.update(channels).set({ observe }).where(eq(channels.id, channelId)).returning({ id: channels.id });
  if (!rows.length) return false;
  if (!observe) await db.delete(ambientMessages).where(and(eq(ambientMessages.channelId, channelId), isNull(ambientMessages.flushedAt)));
  return true;
}
