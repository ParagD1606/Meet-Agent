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
import { addFact, embedText } from "./supersede";

const MAX_FACTS = 8;
const MAX_TRANSCRIPT = 24_000;
const FACT_TYPES = ["fact", "preference", "decision", "procedure", "opinion"] as const;
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}/);
/** A fact is a plain sentence (older/simpler models) or an object with temporal + type metadata. */
const factSchema = z.union([
  z.string(),
  z.object({
    text: z.string(),
    type: z.enum(FACT_TYPES).optional().catch(undefined),
    eventDate: iso.nullish().catch(undefined),
    forgetAfter: iso.nullish().catch(undefined),
    context: z.string().nullish().catch(undefined),
  }),
]);
const schema = z.object({ facts: z.array(factSchema) });

export const EXTRACT_SYSTEM = `You extract durable company knowledge from a Slack conversation between teammates and an AI assistant.
Extract only facts worth remembering weeks from now: decisions made, owners/assignees, deadlines and dates, commitments, customer or project status, preferences, stable how-things-work knowledge.
Each fact must be ONE self-contained declarative sentence understandable alone: name people and things explicitly and resolve "he/it/that/tomorrow" into names and absolute dates when the conversation allows.
Rules:
- Dates: write absolute dates (YYYY-MM-DD) inside the sentence. Resolve relative dates ("tomorrow", "next Friday", "last week") against the message timestamp given as "Today is ...". Set "eventDate" to the date the thing happened or was decided when known (omit it for deadlines and future events).
- Transient facts (this week's on-call, a temporary freeze, "out until Monday", a one-off plan) get "forgetAfter": the YYYY-MM-DD after which the fact is no longer useful. Omit it for durable facts.
- Update, don't duplicate: when the conversation changes or corrects something ("actually", "moved to", "now owned by"), state ONLY the new value as a complete sentence ("The Titan launch date moved to 2026-09-15"), never the old one.
- Never include raw Slack ids (U0123ABCD, C0123ABCD) or <@...> / <#...> tokens; use the person's or channel's name, or skip the fact if you cannot name them.
- Never store state a connected tool owns and that changes under us: PR, issue or ticket status, build/deploy results, who is assigned right now in Jira/Linear/GitHub. Tools are queried live. A decision or reason about them is fine.
- "type" is one of fact, preference, decision, procedure, opinion.
- "context" is a short one-line note (under 20 words) naming who said it, the channel or topic, and the date, e.g. "Priya Sharma in #billing on 2026-03-02 about Zephyr Corp invoicing".
Skip greetings, small talk, questions, transient results, speculation, instructions to the assistant, task progress, secrets (passwords, tokens, keys) and anything trivial.
Return at most ${MAX_FACTS} facts. Reply with JSON only: {"facts":[{"text":"...","type":"fact","eventDate":"YYYY-MM-DD","forgetAfter":"YYYY-MM-DD","context":"..."}]} (omit unknown optional keys). Use {"facts":[]} when nothing is durable ("Nothing to save").`;

type Parsed = { text: string; type: (typeof FACT_TYPES)[number]; validAt?: Date; validUntil?: Date; context?: string };
const SLACK_ID = /<[@#!][^>]*>|\b[UWC](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/;
const asDate = (s?: string | null) => { const d = s ? new Date(s.slice(0, 10)) : null; return d && !Number.isNaN(d.getTime()) ? d : undefined; };

/** Normalises raw extractor output: dedupes, drops junk, clamps eventDate to <= now (a future date is not when it became true) and ignores a forgetAfter in the past. */
export function parseFacts(raw: z.infer<typeof schema>["facts"], now = new Date()): Parsed[] {
  const seen = new Set<string>();
  const out: Parsed[] = [];
  for (const f of raw) {
    const o = typeof f === "string" ? { text: f } : f;
    const text = o.text.trim();
    if (text.length < 8 || /^nothing to save/i.test(text) || seen.has(text)) continue;
    if (SLACK_ID.test(text)) { log.warn("dropped extracted fact with slack id", { text: text.slice(0, 60) }); continue; }
    seen.add(text);
    const ctx = ("context" in o && o.context?.trim().slice(0, 200)) || undefined;
    const ev = asDate("eventDate" in o ? o.eventDate : null);
    const until = asDate("forgetAfter" in o ? o.forgetAfter : null);
    out.push({
      text, type: ("type" in o && o.type) || "fact",
      validAt: ev && ev <= now ? ev : undefined,
      validUntil: until && until > now ? new Date(until.getTime() + 86_400_000 - 1) : undefined, // inclusive of the named day
      context: ctx && !SLACK_ID.test(ctx) ? ctx : undefined,
    });
  }
  return out;
}

export type CaptureArgs = {
  scope: SlackScope; transcript: string; sourceRef?: string; createdBy?: string | null; permalink?: string | null;
  agentContext?: AgentContext; confidence?: number; importance?: number;
  /** Message timestamp relative dates resolve against (default: now). */
  at?: Date;
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
  const at = a.at ?? new Date();
  let facts: Parsed[];
  try {
    const out = await completeJson(
      { system: EXTRACT_SYSTEM, prompt: `Today is ${at.toISOString().slice(0, 10)}.\n\nCONVERSATION:\n${transcript.slice(-MAX_TRANSCRIPT)}`, role: "extract", maxOutputTokens: 900 },
      schema,
    );
    facts = parseFacts(out.facts, at)
      .filter((f) => {
        const bad = scanMemoryText(f.text);
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
    vectors = await embed(facts.map((f) => embedText(f.text, f.context)));
  } catch (e) {
    log.warn("captureTurn embedding failed", { err: String(e) });
    return 0;
  }
  let stored = 0;
  for (const [i, f] of facts.entries()) {
    try {
      const r = await addFact({
        tag, text: f.text, source: "slack", sourceRef: a.sourceRef ?? a.scope.channelId, embedding: vectors[i],
        factType: f.type, validAt: f.validAt, validUntil: f.validUntil, contextPrefix: f.context,
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
  const transcript = p.chunks.join("\n\n");
  const stored = await captureTurn({ scope: p.scope, transcript, sourceRef: p.channelId, permalink: p.permalink });
  await recordEpisode({ scope: p.scope, channelId: p.channelId, threadTs: p.threadTs, transcript: transcript.slice(-12_000), permalink: p.permalink })
    .catch((e) => log.warn("recordEpisode failed", { err: String(e) }));
  return stored;
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
