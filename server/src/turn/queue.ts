import { pool } from "../db";

const tails = new Map<string, Promise<unknown>>();

/** In-process FIFO per key. A failing job never blocks the next one. */
export function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}

/** Cross-process mutual exclusion on a dedicated connection (session-level advisory lock). */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try { return await fn(); }
    finally { await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => { broken = true; }); }
  } catch (e) { broken = true; throw e; }
  finally { client.release(broken); } // destroying the session drops any lock it still holds
}

/** enqueue + advisory lock: one turn at a time per (channel, thread), across processes. */
export const serialize = <T>(key: string, fn: () => Promise<T>) => enqueue(key, () => withAdvisoryLock(key, fn));
