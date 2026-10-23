import { and, desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { episodes } from "../db/schema";
import { log } from "../log";
import { estimateTokens } from "./budget";
import { embed } from "./embed";
import { completeJson, completeText } from "./llm";
import { readTags, type SlackScope, writeTag } from "./scope";
import { vectorLiteral } from "./search";

const MAX_TRANSCRIPT = 20_000;
const SUMMARY_CHARS = 900;
const MIN_TRANSCRIPT = 120;

const SUMMARY_SYSTEM = `Summarise this Slack thread for later recall. 3-6 plain sentences: what was asked or discussed, decisions made, owners, deadlines, outcome, open items. Name people and things explicitly. No preamble.`;

export type EpisodeHit = { summary: string; permalink: string | null; endedAt: Date; channelId: string };

/**
 * Summarises a finished (or long-idle) thread and upserts it as one episode in the scope's write tag
 * (public -> shared, private -> channel_X, DM -> user_X). One row per (channel, thread). Returns false when skipped.
 */
export async function recordEpisode(a: { scope: SlackScope; channelId: string; threadTs: string; transcript: string; permalink?: string | null }): Promise<boolean> {
  const tag = writeTag(a.scope);
  const transcript = a.transcript.trim();
  if (!tag || transcript.length < MIN_TRANSCRIPT) return false;
  let summary: string;
  try {
    summary = (await completeText({ system: SUMMARY_SYSTEM, prompt: transcript.slice(-MAX_TRANSCRIPT), role: "summarize", maxOutputTokens: 300 })).trim();
  } catch (e) {
    log.warn("episode summary failed", { err: String(e) });
    return false;
  }
  if (summary.length < 20) return false;
  summary = summary.slice(0, SUMMARY_CHARS);
  const [vec] = await embed([summary]);
  await db.insert(episodes).values({
    id: newId("ep_"), scopeTag: tag, channelId: a.channelId, threadTs: a.threadTs, summary, embedding: vec!,
    permalink: a.permalink ?? null,
  }).onConflictDoUpdate({
    target: [episodes.channelId, episodes.threadTs],
    set: { summary, embedding: vec!, scopeTag: tag, permalink: a.permalink ?? null, endedAt: new Date() },
  });
  return true;
}

const STAGE2 = `You are given numbered past-thread summaries and a QUERY. For each thread, write ONE sentence containing only what is relevant to the QUERY (or the single word "skip" if nothing is). Reply JSON only: {"items":[{"n":1,"text":"..."}]}`;
const stage2 = z.object({ items: z.array(z.object({ n: z.number().int(), text: z.string() })) });

/**
 * Two-stage thread recall (Hermes session_search): (1) vector + keyword retrieve over episodes the scope may read
 * (ACL = readTags, so DM episodes never surface in channels), rank by similarity x recency; (2) one cheap-model call
 * condenses the top N to what matters for the query. Stage 2 is skipped when summaries are already short.
 */
export async function searchThreads(a: { scope: SlackScope; query: string; limit?: number; excludeThreadTs?: string }): Promise<EpisodeHit[]> {
  const query = a.query.trim();
  if (!query) return [];
  const tags = await readTags(a.scope);
  const limit = Math.max(1, Math.min(a.limit ?? 3, 10));
  const [qv] = await embed([query]);
  const dist = sql`${episodes.embedding} <=> ${vectorLiteral(qv!)}::vector`;
  const rows = await db.select({
    summary: episodes.summary, permalink: episodes.permalink, endedAt: episodes.endedAt, channelId: episodes.channelId,
    threadTs: episodes.threadTs, sim: sql<number>`1 - (${dist})`,
  }).from(episodes).where(and(inArray(episodes.scopeTag, tags))).orderBy(dist).limit(25);

  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];
  const now = Date.now();
  const ranked = rows
    .filter((r) => !(a.excludeThreadTs && r.threadTs === a.excludeThreadTs))
    .map((r) => {
      const lower = r.summary.toLowerCase();
      const kw = words.length ? words.filter((w) => lower.includes(w)).length / words.length : 0;
      const ageDays = Math.max(0, (now - r.endedAt.getTime()) / 86_400_000);
      return { r, score: (0.7 * Number(r.sim) + 0.3 * kw) * (0.7 + 0.3 * 2 ** (-ageDays / 120)) };
    })
    .filter((x) => Number(x.r.sim) >= 0.3 || x.score >= 0.25)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((x) => x.r);
  if (!ranked.length) return [];

  const out: EpisodeHit[] = ranked.map((r) => ({ summary: r.summary, permalink: r.permalink, endedAt: r.endedAt, channelId: r.channelId }));
  if (out.length < 2 && estimateTokens(out[0]!.summary) < 250) return out;
  try {
    const prompt = `QUERY: ${query}\n\n${out.map((o, i) => `${i + 1}. ${o.summary}`).join("\n")}`;
    const v = await completeJson({ system: STAGE2, prompt, role: "summarize", maxOutputTokens: 400 }, stage2);
    const cond = new Map(v.items.map((i) => [i.n, i.text.trim()]));
    return out.flatMap((o, i) => {
      const t = cond.get(i + 1);
      if (t === undefined || t === "") return [o];
      return t.toLowerCase() === "skip" ? [] : [{ ...o, summary: t }];
    });
  } catch {
    return out; // stage 2 is an optimisation; stored summaries are already usable
  }
}

/** Newest episodes the scope can read (web "Episodes" list). */
export async function listEpisodes(a: { tags: string[]; limit?: number }) {
  if (!a.tags.length) return [];
  return db.select({
    id: episodes.id, summary: episodes.summary, permalink: episodes.permalink, endedAt: episodes.endedAt,
    channelId: episodes.channelId, threadTs: episodes.threadTs, scopeTag: episodes.scopeTag,
  }).from(episodes).where(inArray(episodes.scopeTag, a.tags)).orderBy(desc(episodes.endedAt)).limit(a.limit ?? 50);
}
