import type { PoolClient } from "pg";
import { lockPool } from "../db";

const tails = new Map<string, Promise<unknown>>();
const inflight = new Set<Promise<unknown>>();
let draining = false;

export class ShuttingDownError extends Error {
  constructor() { super("server is shutting down"); this.name = "ShuttingDownError"; }
}

/** In-process FIFO per key. A failing job never blocks the next one. */
export function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LockOpts = { pollMs?: number; maxWaitMs?: number };

/**
 * Cross-process mutual exclusion via a session advisory lock held on a connection from the dedicated `lockPool`.
 * Waiting never parks a connection: we try the lock, and on contention hand the connection straight back and
 * poll, so waiters cost nothing and lock holders (who run their queries on the main pool) cannot deadlock it.
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>, opts: LockOpts = {}): Promise<T> {
  const { pollMs = 150, maxWaitMs = 10 * 60_000 } = opts;
  const deadline = Date.now() + maxWaitMs;
  let client!: PoolClient;
  for (;;) {
    const c = await lockPool.connect();
    let got = false;
    try {
      const { rows } = await c.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [key]);
      got = Boolean(rows[0]?.ok);
    } catch (e) { c.release(true); throw e; }
    if (got) { client = c; break; }
    c.release();
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${key}`);
    await sleep(pollMs + Math.random() * pollMs);
  }
  try {
    return await fn();
  } finally {
    // a failed unlock means the session is suspect: destroy the connection, which drops any lock it still holds
    const ok = await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).then(() => true, () => false);
    client.release(!ok);
  }
}

/** enqueue + advisory lock: one turn at a time per (channel, thread), across processes. Tracked for graceful drain. */
export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (draining) return Promise.reject(new ShuttingDownError());
  const p = enqueue(key, () => withAdvisoryLock(key, fn));
  const t = p.then(() => undefined, () => undefined);
  inflight.add(t);
  void t.then(() => inflight.delete(t));
  return p;
}

export const inflightCount = () => inflight.size;
/** Test hook. */
export const resetDraining = () => { draining = false; };

/** Stop accepting new turns and wait (up to deadlineMs) for running ones. Returns how many were still running. */
export async function drain(deadlineMs = 25_000): Promise<{ drained: boolean; remaining: number }> {
  draining = true;
  const all = Promise.allSettled([...inflight]);
  const timeout = sleep(deadlineMs).then(() => "timeout" as const);
  const r = await Promise.race([all.then(() => "done" as const), timeout]);
  return { drained: r === "done", remaining: r === "done" ? 0 : inflight.size };
}
