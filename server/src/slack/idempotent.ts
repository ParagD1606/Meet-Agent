import { createHash } from "node:crypto";
import { claimEvent, releaseEvent } from "./dedupe";

/** Deterministic UUID-shaped client_msg_id for a logical bot message (same key => same id on every retry). */
export function clientMsgId(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Run a side effect (posting one bot message) at most once per key, even across retries and restarts: the key is claimed
 * in the `events` table first and given back if `fn` throws, so a failed post can be retried but a posted one never repeats.
 * ponytail: a crash between claim and post loses that one message (at-most-once); the user can just ask again.
 */
export async function once<T>(key: string, fn: () => Promise<T>): Promise<{ replayed: true } | { replayed: false; value: T }> {
  const id = `post:${key}`;
  if (!(await claimEvent(id))) return { replayed: true };
  try { return { replayed: false, value: await fn() }; }
  catch (e) { await releaseEvent(id).catch(() => {}); throw e; }
}
