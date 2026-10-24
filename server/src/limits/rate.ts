import { sql } from "drizzle-orm";
import { db } from "../db";

export type RateKind = "turn" | "triage" | "mcp" | "nudge";
type Bucket = { key: string; capacity: number; perSec: number };

/** Burst capacity + sustained refill. Per-user and per-channel buckets must both have a token. */
export const BUCKETS: Record<RateKind, (a: { userId: string; channelId: string }) => Bucket[]> = {
  turn: ({ userId, channelId }) => [
    { key: `user:${userId}:turn`, capacity: 10, perSec: 1 / 12 }, // ~5/min sustained
    { key: `channel:${channelId}:turn`, capacity: 25, perSec: 1 / 4 },
  ],
  // triage runs on every channel message: tiny sustained budget per channel
  triage: ({ channelId }) => [{ key: `channel:${channelId}:triage`, capacity: 6, perSec: 1 / 120 }],
  mcp: ({ userId }) => [{ key: `user:${userId}:mcp`, capacity: 30, perSec: 1 }],
  // private nudges/suggestions to one person: 2 in a burst, then one per 30 minutes
  nudge: ({ userId }) => [{ key: `user:${userId}:nudge`, capacity: 2, perSec: 1 / 1800 }],
};

export type RateResult = { ok: true } | { ok: false; message: string; retryAfterSec: number };

const MESSAGES: Record<RateKind, string> = {
  turn: "You're sending requests faster than I can keep up. Give me about {s} seconds and try again.",
  triage: "rate limited",
  mcp: "Rate limit exceeded. Retry in {s} seconds.",
  nudge: "rate limited",
};

/**
 * Token buckets stored in `rate_limits` (so they hold across processes). All buckets for the call are locked in
 * key order inside one transaction: either every bucket has a token and all are charged, or nothing is.
 */
export async function checkRate(a: { userId: string; channelId: string; kind: RateKind }, now = Date.now()): Promise<RateResult> {
  const buckets = BUCKETS[a.kind](a).sort((x, y) => (x.key < y.key ? -1 : 1));
  return db.transaction(async (tx) => {
    let wait = 0;
    const next: { key: string; tokens: number }[] = [];
    for (const b of buckets) {
      await tx.execute(sql`insert into rate_limits (key, tokens, updated_at) values (${b.key}, ${b.capacity}, to_timestamp(${now / 1000}::double precision)) on conflict (key) do nothing`);
      const res = await tx.execute(sql`select tokens, extract(epoch from updated_at) * 1000 as at from rate_limits where key = ${b.key} for update`);
      const row = res.rows[0] as { tokens: number; at: string };
      const elapsed = Math.max(0, now - Number(row.at)) / 1000;
      const tokens = Math.min(b.capacity, Number(row.tokens) + elapsed * b.perSec);
      if (tokens < 1) wait = Math.max(wait, Math.ceil((1 - tokens) / b.perSec));
      next.push({ key: b.key, tokens });
    }
    if (wait > 0) {
      // persist the refill so repeated rejected calls do not reset the clock
      for (const n of next) await tx.execute(sql`update rate_limits set tokens = ${n.tokens}, updated_at = to_timestamp(${now / 1000}::double precision) where key = ${n.key}`);
      return { ok: false as const, retryAfterSec: wait, message: MESSAGES[a.kind].replace("{s}", String(wait)) };
    }
    for (const n of next) await tx.execute(sql`update rate_limits set tokens = ${n.tokens - 1}, updated_at = to_timestamp(${now / 1000}::double precision) where key = ${n.key}`);
    return { ok: true as const };
  });
}
