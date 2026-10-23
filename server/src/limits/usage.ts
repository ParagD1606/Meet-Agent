import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { usageDaily } from "../db/schema";
import { getLimits } from "./settings";

const today = (now = new Date()) => now.toISOString().slice(0, 10);

/** Adds one finished turn's tokens to the user's row for today (UTC). */
export async function recordUsage(a: { userId: string; inputTokens: number; outputTokens: number }, now = new Date()): Promise<void> {
  const inTok = Math.max(0, Math.round(a.inputTokens || 0));
  const outTok = Math.max(0, Math.round(a.outputTokens || 0));
  await db.insert(usageDaily).values({ userId: a.userId, day: today(now), turns: 1, inputTokens: inTok, outputTokens: outTok })
    .onConflictDoUpdate({
      target: [usageDaily.userId, usageDaily.day],
      set: {
        turns: sql`${usageDaily.turns} + 1`,
        inputTokens: sql`${usageDaily.inputTokens} + ${inTok}`,
        outputTokens: sql`${usageDaily.outputTokens} + ${outTok}`,
      },
    });
}

export type CapStatus = { ok: true } | { ok: false; scope: "user" | "org"; message: string };

/** Detailed check; `underDailyCap` is the boolean form. 0 in limits = unlimited. */
export async function dailyCapStatus(userId: string, now = new Date()): Promise<CapStatus> {
  const limits = await getLimits();
  const day = today(now);
  if (limits.perUserDailyTokens > 0) {
    const [r] = await db.select({ t: sql<number>`coalesce(${usageDaily.inputTokens} + ${usageDaily.outputTokens}, 0)` })
      .from(usageDaily).where(and(eq(usageDaily.userId, userId), eq(usageDaily.day, day)));
    if (Number(r?.t ?? 0) >= limits.perUserDailyTokens) {
      return { ok: false, scope: "user", message: "You've reached your daily usage limit for me. It resets at midnight UTC. An admin can raise it under Usage & limits." };
    }
  }
  if (limits.orgDailyTokens > 0) {
    const [r] = await db.select({ t: sql<number>`coalesce(sum(${usageDaily.inputTokens} + ${usageDaily.outputTokens}), 0)` })
      .from(usageDaily).where(eq(usageDaily.day, day));
    if (Number(r?.t ?? 0) >= limits.orgDailyTokens) {
      return { ok: false, scope: "org", message: "The workspace has reached its daily usage limit, so I'm paused until midnight UTC. An admin can raise it under Usage & limits." };
    }
  }
  return { ok: true };
}

export const underDailyCap = async (userId: string): Promise<boolean> => (await dailyCapStatus(userId)).ok;
