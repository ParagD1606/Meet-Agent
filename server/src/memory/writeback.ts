import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { threadState } from "../db/schema";
import { log } from "../log";
import { isTrivialMessage } from "./budget";
import { type AgentContext, scanMemoryText } from "./core-blocks";
import { embed } from "./embed";
import { recordEpisode } from "./episodes";
import { completeJson } from "./llm";
import { type SlackScope, writeTag } from "./scope";
import { addFact } from "./supersede";

const MAX_FACTS = 8;
const MAX_TRANSCRIPT = 24_000;
const schema = z.object({ facts: z.array(z.string()) });

export const EXTRACT_SYSTEM = `You extract durable company knowledge from a Slack conversation between teammates and an AI assistant.
Extract only facts worth remembering weeks from now: decisions made, owners/assignees, deadlines and dates, commitments, customer or project status, preferences, stable how-things-work knowledge.
Each fact must be ONE self-contained declarative sentence understandable alone: name people and things explicitly, resolve "he/it/that/tomorrow" into names and absolute dates when the conversation allows, and never include Slack user ids or @-mention tokens.
Skip greetings, small talk, questions, transient results, speculation, instructions to the assistant, task progress, secrets (passwords, tokens, keys) and anything trivial.
Return at most ${MAX_FACTS} facts. Reply with JSON only: {"facts":["..."]}. Use {"facts":[]} when nothing is durable ("Nothing to save").`;

export type CaptureArgs = {
  scope: SlackScope; transcript: string; sourceRef?: string; createdBy?: string | null; permalink?: string | null;
  agentContext?: AgentContext; confidence?: number; importance?: number;
};

/**
 * Single-pass, add-only extraction: ONE cheap-model call lists durable facts; each is stored via addFact (which dedupes and
 * reconciles contradictions separately). Embeddings are batched in one call. Returns #new facts stored. Never throws.
 */
export async function captureTurn(a: CaptureArgs): Promise<number> {
  const tag = writeTag(a.scope);
  if (!tag) return 0;
  const transcript = a.transcript.trim();
  if (!transcript) return 0;
  let facts: string[];
  try {
    const out = await completeJson(
      { system: EXTRACT_SYSTEM, prompt: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nCONVERSATION:\n${transcript.slice(-MAX_TRANSCRIPT)}`, role: "extract", maxOutputTokens: 500 },
      schema,
    );
    facts = [...new Set(out.facts.map((f) => f.trim()).filter((f) => f.length >= 8 && !/^nothing to save/i.test(f)))]
      .filter((f) => {
        const bad = scanMemoryText(f);
        if (bad) log.warn("dropped extracted fact", { reason: bad.slice(0, 80) });
        return !bad;
      })
      .slice(0, MAX_FACTS);
  } catch (e) {
    log.warn("captureTurn extraction failed", { err: String(e) });
    return 0;
  }
  if (!facts.length) return 0;
  let vectors: number[][];
  try {
    vectors = await embed(facts);
  } catch (e) {
    log.warn("captureTurn embedding failed", { err: String(e) });
    return 0;
  }
  let stored = 0;
  for (const [i, text] of facts.entries()) {
    try {
      const r = await addFact({
        tag, text, source: "slack", sourceRef: a.sourceRef ?? a.scope.channelId, embedding: vectors[i],
        createdBy: a.createdBy ?? a.scope.userId, permalink: a.permalink, agentContext: a.agentContext,
        confidence: a.confidence, importance: a.importance,
      });
      if (!r.deduped) stored++;
    } catch (e) {
      log.warn("captureTurn addFact failed", { err: String(e) });
    }
  }
  return stored;
}

// ---------- debounced thread capture (write-path diet) ----------
const CAPTURE_EVERY_N = 3;
const IDLE_MS = 5 * 60_000;
type Pending = { scope: SlackScope; channelId: string; threadTs: string; chunks: string[]; lastAt: number; permalink?: string | null; timer?: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const keyOf = (channelId: string, threadTs: string) => `${channelId}:${threadTs}`;

async function flush(key: string): Promise<number> {
  const p = pending.get(key);
  if (!p) return 0;
  pending.delete(key);
  if (p.timer) clearTimeout(p.timer);
  await db.insert(threadState).values({ channelId: p.channelId, threadTs: p.threadTs, turnsSinceReflect: 0 })
    .onConflictDoUpdate({ target: [threadState.channelId, threadState.threadTs], set: { turnsSinceReflect: 0, updatedAt: new Date() } })
    .catch(() => {});
  return captureTurn({ scope: p.scope, transcript: p.chunks.join("\n\n"), sourceRef: p.channelId, permalink: p.permalink });
}

/**
 * Call after every answered turn instead of captureTurn. Extraction runs once per thread after N=3 turns, after 5 minutes
 * idle (timer + sweep), or when `final` is set; trivial turns (greetings, thanks, acks) never count. Buffered text lives in
 * memory, so a restart loses at most the last two turns of an unfinished thread.
 */
export async function scheduleCapture(a: {
  scope: SlackScope; channelId: string; threadTs: string; transcript: string; userText?: string; permalink?: string | null;
  final?: boolean; every?: number; idleMs?: number;
}): Promise<{ stored: number; deferred: boolean; skipped?: "trivial" | "no-scope" }> {
  if (!writeTag(a.scope)) return { stored: 0, deferred: false, skipped: "no-scope" };
  const key = keyOf(a.channelId, a.threadTs);
  if (!a.final && isTrivialMessage(a.userText ?? a.transcript)) return { stored: 0, deferred: false, skipped: "trivial" };
  const p = pending.get(key) ?? { scope: a.scope, channelId: a.channelId, threadTs: a.threadTs, chunks: [], lastAt: 0 };
  p.chunks.push(a.transcript);
  p.lastAt = Date.now();
  p.permalink = a.permalink ?? p.permalink;
  pending.set(key, p);

  const [row] = await db.insert(threadState).values({ channelId: a.channelId, threadTs: a.threadTs, turnsSinceReflect: 1 })
    .onConflictDoUpdate({
      target: [threadState.channelId, threadState.threadTs],
      set: { turnsSinceReflect: sql`${threadState.turnsSinceReflect} + 1`, updatedAt: new Date() },
    }).returning({ n: threadState.turnsSinceReflect });
  if (a.final || (row?.n ?? 1) >= (a.every ?? CAPTURE_EVERY_N)) return { stored: await flush(key), deferred: false };

  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => { void flush(key).catch((e) => log.warn("idle capture failed", { err: String(e) })); }, a.idleMs ?? IDLE_MS);
  (p.timer as { unref?: () => void }).unref?.();
  return { stored: 0, deferred: true };
}

/** Flush every buffered thread idle for >= idleMs (reflection sweep; belt and braces for lost timers). */
export async function flushIdleCaptures(idleMs = IDLE_MS, now = Date.now()): Promise<number> {
  let n = 0;
  for (const [key, p] of [...pending]) if (now - p.lastAt >= idleMs) n += await flush(key);
  return n;
}

/** Thread finished: flush buffered facts and store the thread as a searchable episode. */
export async function endThread(a: { scope: SlackScope; channelId: string; threadTs: string; transcript: string; permalink?: string | null }): Promise<{ stored: number; episode: boolean }> {
  const stored = await flush(keyOf(a.channelId, a.threadTs));
  const episode = await recordEpisode(a).catch((e) => { log.warn("recordEpisode failed", { err: String(e) }); return false; });
  return { stored, episode };
}

export const pendingCaptureCount = () => pending.size;
