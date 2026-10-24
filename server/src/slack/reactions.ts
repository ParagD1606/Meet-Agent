import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { messageFeedback } from "../db/schema";
import { log } from "../log";
import { addReaction, removeReaction } from "./client";
import { applyFeedback } from "./feedback";

// ---- circuit breaker: at most 30 acknowledgement reactions per hour, then the breaker opens for an hour ----
const HOUR_MS = 3_600_000;
export const ACK_BREAKER_MAX_PER_HOUR = 30;
export const ACK_BREAKER_OPEN_MS = HOUR_MS;
export type AckBreakerState = { bucket: number; count: number; openUntil: number };

/** Pure: given the previous state and now, may we add an ack reaction? */
export function evaluateAckBreaker(state: AckBreakerState | undefined, nowMs: number): { allowed: boolean; opened: boolean; next: AckBreakerState } {
  const bucket = Math.floor(nowMs / HOUR_MS);
  if (state && state.openUntil > nowMs) return { allowed: false, opened: false, next: state };
  const count = state?.bucket === bucket ? state.count : 0;
  if (count >= ACK_BREAKER_MAX_PER_HOUR) return { allowed: false, opened: true, next: { bucket, count, openUntil: nowMs + ACK_BREAKER_OPEN_MS } };
  return { allowed: true, opened: false, next: { bucket, count: count + 1, openUntil: 0 } };
}

let breaker: AckBreakerState | undefined;
export const resetAckBreaker = () => { breaker = undefined; acked.clear(); };

// ---- serial queue: reactions are cosmetic, so they are paced and dropped rather than allowed to pile up ----
const MAX_QUEUED = 25;
let gapMs = 300;
let queued = 0;
let tail: Promise<unknown> = Promise.resolve();
export const setReactionGap = (ms: number) => { gapMs = ms; };
function enqueueReaction(fn: () => Promise<unknown>): void {
  if (queued >= MAX_QUEUED) return; // backlog: drop, never block a turn on decoration
  queued++;
  const run = tail.then(async () => { await fn(); if (gapMs) await new Promise((r) => setTimeout(r, gapMs)); }).catch(() => undefined).finally(() => { queued--; });
  tail = run;
}
/** Resolves when queued reactions have been sent (tests, shutdown). */
export const flushReactions = async () => { await tail; };

const acked = new Set<string>();
const key = (channel: string, ts: string) => `${channel}:${ts}`;

/** 👀 on receipt, subject to the breaker. */
export async function ack(channel: string, ts: string): Promise<void> {
  const d = evaluateAckBreaker(breaker, Date.now());
  breaker = d.next;
  if (d.opened) log.warn("ack reaction breaker opened", { max: ACK_BREAKER_MAX_PER_HOUR });
  if (!d.allowed) return;
  acked.add(key(channel, ts));
  if (acked.size > 500) acked.delete(acked.values().next().value!);
  enqueueReaction(() => addReaction(channel, ts, "eyes"));
}

/** Swap 👀 for ✅/⚠️, but only on messages we actually acked. */
export async function done(channel: string, ts: string, ok = true): Promise<void> {
  if (!acked.delete(key(channel, ts))) return;
  enqueueReaction(async () => { await removeReaction(channel, ts, "eyes"); await addReaction(channel, ts, ok ? "white_check_mark" : "warning"); });
}

const UP = new Set(["+1", "thumbsup", "thumbsup_all"]);
const DOWN = new Set(["-1", "thumbsdown"]);

/** Maps a Slack reaction name (skin-tone suffix stripped) to a rating, or null if it isn't feedback. */
export function ratingFor(reaction: string): "up" | "down" | null {
  const base = reaction.replace(/::skin-tone-\d$/, "");
  return UP.has(base) ? "up" : DOWN.has(base) ? "down" : null;
}

export async function recordFeedback(a: { channelId: string; messageTs: string; userId: string; rating: "up" | "down"; threadTs?: string | null }) {
  const { threadTs, ...row } = a;
  const [prev] = await db.select({ rating: messageFeedback.rating }).from(messageFeedback)
    .where(and(eq(messageFeedback.channelId, a.channelId), eq(messageFeedback.messageTs, a.messageTs), eq(messageFeedback.userId, a.userId)));
  await db.insert(messageFeedback).values(row).onConflictDoUpdate({
    target: [messageFeedback.channelId, messageFeedback.messageTs, messageFeedback.userId],
    set: { rating: a.rating, createdAt: sql`now()` },
  });
  if (prev?.rating !== a.rating) await applyFeedback({ ...row, threadTs }); // a repeated identical reaction must not count twice
}
