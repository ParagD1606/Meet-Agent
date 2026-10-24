import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { threadState } from "../db/schema";
import { getSetting } from "../manager/commitments";

/**
 * "New chat": only conversation history is dropped. thread_state.context_reset_at (key: (channel, threadTs) or (channel, 'dm'))
 * is a cutoff that history, rolling summaries and the frozen core snapshot respect. Memories, tasks, core notes and open asks
 * are never touched.
 */
export const FRESH_START_REPLY = "Fresh start. I still remember our company knowledge, tasks and your notes; I only dropped this conversation's chat history.";
export const LONG_CHAT_HINT = 'This chat is getting long: say "new chat" for a fresh start.';

/** The whole message must be one of these (a request that merely contains "reset" is not a reset). */
const RESET_RE = /^\s*(new chat|\/new|reset|start over)\s*[.!]?\s*$/i;
export const isResetText = (text: string) => RESET_RE.test(text);

/** thread_state key of a conversation: its thread, or 'dm' for the top level of a DM. */
export const resetKeyOf = (threadTs: string | undefined, isIm: boolean): string | undefined => threadTs ?? (isIm ? "dm" : undefined);

/** Starts a fresh conversation at `at`: sets the cutoff and drops the stored summary and frozen snapshot of that key. */
export async function resetContext(channelId: string, key: string, at = new Date()): Promise<void> {
  const set = { contextResetAt: at, summary: "", summaryUptoTs: null, coreSnapshot: null, updatedAt: new Date() };
  await db.insert(threadState).values({ channelId, threadTs: key, ...set })
    .onConflictDoUpdate({ target: [threadState.channelId, threadState.threadTs], set });
}

/** Latest reset cutoff among `keys` of a channel (summary rows of a DM live under the message ts, so callers pass both). */
export async function resetCutoff(channelId: string, keys: string[]): Promise<Date | null> {
  const rows = await db.select({ at: threadState.contextResetAt }).from(threadState)
    .where(and(eq(threadState.channelId, channelId), inArray(threadState.threadTs, keys)));
  const ms = rows.map((r) => r.at?.getTime() ?? 0).filter(Boolean);
  return ms.length ? new Date(Math.max(...ms)) : null;
}

export const DEFAULT_DM_IDLE_HOURS = 6;
export const MAX_DM_IDLE_HOURS = 72;
export async function getDmIdleHours(): Promise<number> {
  const v = await getSetting<number>("dm_idle_reset_hours").catch(() => undefined);
  return typeof v === "number" && Number.isFinite(v) ? Math.min(MAX_DM_IDLE_HOURS, Math.max(0, v)) : DEFAULT_DM_IDLE_HOURS;
}

/** Keeps only the messages after the last idle gap longer than `hours` (the current message at `nowTs` counts as the newest). 0 disables. */
export function afterIdleGap<T extends { ts: string }>(items: T[], nowTs: string, hours: number): T[] {
  if (!hours) return items;
  const gap = hours * 3600;
  let next = Number(nowTs);
  for (let i = items.length - 1; i >= 0; i--) {
    const t = Number(items[i]!.ts);
    if (next - t > gap) return items.slice(i + 1);
    next = t;
  }
  return items;
}

export const HISTORY_CAP: Record<"direct" | "memory" | "tools" | "deep", number> = { direct: 6, memory: 12, tools: 30, deep: 30 };

// ponytail: in-memory per process; a restart only means one extra hint. Move to thread_state if multi-process hints matter.
const HINT_EVERY = 20;
const turnsSeen = new Map<string, { n: number; last: number }>();
const due = new Set<string>();

/** Counts a turn; when history exceeds 70% of its budget, flags the hint at most once per 20 turns. */
export function noteHistorySize(key: string, historyTokens: number, budget: number): void {
  const s = turnsSeen.get(key) ?? { n: 0, last: -HINT_EVERY };
  s.n++;
  if (historyTokens > budget * 0.7 && s.n - s.last >= HINT_EVERY) { s.last = s.n; due.add(key); }
  turnsSeen.set(key, s);
}
/** True once after the hint was flagged for this conversation. */
export const takeHint = (key: string): boolean => due.delete(key);

export const hintKey = (channelId: string, threadKey: string) => `${channelId}:${threadKey}`;
