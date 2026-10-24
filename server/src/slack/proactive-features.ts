import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";
import { checkRate } from "../limits";
import { log } from "../log";
import { embed } from "../memory/embed";
import { readTags } from "../memory/scope";
import { searchMemory, type MemoryHit } from "../memory/search";
import { slackClient } from "./client";
import { sanitizeForSlack } from "./sanitize";

/**
 * Per-channel proactive features, all OPT-IN (admin settings): one `settings` row per feature holding the channel ids.
 *  digest    weekly summary post          nudge      private "this relates to a past decision"
 *  deadlines reminders before valid_until autoreply  confidence gate on public auto-replies (suggest first)
 *  standup   daily/weekly status summaries   risks      daily risk note (overdue, conflicts, stale, duplicated work)
 */
export const FEATURES = ["digest", "nudge", "deadlines", "autoreply", "standup", "risks"] as const;
export type Feature = (typeof FEATURES)[number];
export type ChannelFeatures = Record<Feature, boolean>;

const key = (f: Feature) => `proactive_${f}`;

export async function featureChannels(f: Feature): Promise<string[]> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key(f)));
  return Array.isArray(row?.value) ? (row.value as unknown[]).filter((x): x is string => typeof x === "string") : [];
}

export async function setFeatureChannels(f: Feature, ids: string[]): Promise<void> {
  const value = [...new Set(ids)];
  await db.insert(settings).values({ key: key(f), value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function channelFeatures(channelId: string): Promise<ChannelFeatures> {
  const lists = await Promise.all(FEATURES.map(featureChannels));
  return Object.fromEntries(FEATURES.map((f, i) => [f, lists[i]!.includes(channelId)])) as ChannelFeatures;
}

/** Cosine similarity of a message to a past decision above which we speak up privately. */
export const NUDGE_MIN_SIMILARITY = 0.75;
/** A public auto-reply needs a memory hit at least this close; below it the asker only gets an ephemeral suggestion. */
export const AUTOREPLY_MIN_SIMILARITY = 0.8;

const cosine = (a: number[], b: number[]) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! * a[i]!; y += b[i]! * b[i]!; }
  return x && y ? d / Math.sqrt(x * y) : 0;
};

export type ScoredHit = MemoryHit & { similarity: number };

/**
 * Memory the channel itself may read (a public channel reads "shared" only, a private one adds its own tag; never DMs or
 * other private channels), each hit scored by embedding cosine against the message. Never throws.
 */
export async function consultMemory(a: { channelId: string; isPrivate: boolean; text: string; limit?: number }): Promise<ScoredHit[]> {
  try {
    const tags = await readTags({ channelId: a.channelId, isPrivate: a.isPrivate, isIm: false, userId: null });
    const hits = await searchMemory({ tags, query: a.text, limit: a.limit ?? 5 });
    const facts = hits.filter((h) => h.kind === "fact");
    if (!facts.length) return [];
    const [q, ...vs] = await embed([a.text, ...facts.map((h) => h.text)]);
    return facts.map((h, i) => ({ ...h, similarity: cosine(q!, vs[i]!) })).sort((x, y) => y.similarity - x.similarity);
  } catch (e) {
    log.warn("proactive memory consult failed", { error: String(e) });
    return [];
  }
}

export const strongDecision = (hits: ScoredHit[]) => hits.find((h) => h.factType === "decision" && h.similarity >= NUDGE_MIN_SIMILARITY);
export const bestSimilarity = (hits: ScoredHit[]) => hits[0]?.similarity ?? 0;

/** Ephemeral (only `user` sees it), rate limited per user. Returns whether it was sent. */
export async function sendEphemeral(a: { channelId: string; userId: string; threadTs?: string; text: string }): Promise<boolean> {
  const rate = await checkRate({ userId: a.userId, channelId: a.channelId, kind: "nudge" });
  if (!rate.ok) return false;
  try {
    await (await slackClient()).chat.postEphemeral({ channel: a.channelId, user: a.userId, thread_ts: a.threadTs, text: sanitizeForSlack(a.text) });
    return true;
  } catch (e) {
    log.warn("ephemeral post failed", { channel: a.channelId, error: String(e) });
    return false;
  }
}

export const nudgeText = (h: MemoryHit) =>
  `:bulb: This looks related to a past decision: "${h.text.slice(0, 280)}"${h.permalink ? ` (<${h.permalink}|source>)` : ""} Only you can see this.`;

export const SUGGESTION_TEXT = ":bulb: I may be able to help with this. @mention me in a thread and I'll answer. Only you can see this.";
