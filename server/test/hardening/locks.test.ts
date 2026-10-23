import "./env";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { db, lockPool, pool } from "../../src/db";
import { sql } from "drizzle-orm";
import { drain, inflightCount, resetDraining, serialize, ShuttingDownError, withAdvisoryLock } from "../../src/turn/queue";
import { sweepStaleTurns } from "../../src/lifecycle";
import { resetDb } from "../db";
import { turns } from "../../src/db/schema";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeAll(async () => { await resetDb(); });
afterEach(() => resetDraining());

describe("pool exhaustion regression", () => {
  test("many lock holders that each need main-pool queries never deadlock, even with a tiny pool", async () => {
    expect(pool.options.max).toBe(4);
    expect(lockPool.options.max).toBe(4);
    // 24 distinct keys: far more holders than lock connections (4) and more than main connections (4).
    // Old design: every holder pinned a main-pool connection while waiting for another one => deadlock.
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      serialize(`pool-test:${i}`, async () => {
        const r = await db.execute(sql`select ${i}::int as n, pg_sleep(0.02)`);
        await db.execute(sql`select 1`);
        return Number((r.rows[0] as { n: number }).n);
      })));
    expect(results).toEqual(Array.from({ length: 24 }, (_, i) => i));
  }, 20_000);

  test("contending waiters do not hold connections while waiting", async () => {
    // 12 waiters on ONE key with a lock pool of 4: only the holder owns a connection, the rest poll.
    let concurrent = 0, max = 0;
    await Promise.all(Array.from({ length: 12 }, () => withAdvisoryLock("same-key", async () => {
      concurrent++; max = Math.max(max, concurrent); await sleep(15); concurrent--;
    }, { pollMs: 10 })));
    expect(max).toBe(1);
  }, 20_000);

  test("lock is released when the callback throws", async () => {
    await expect(withAdvisoryLock("boom", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await withAdvisoryLock("boom", async () => "again", { maxWaitMs: 500 })).toBe("again");
  });

  test("waiting longer than maxWaitMs fails instead of hanging", async () => {
    const hold = withAdvisoryLock("busy", () => sleep(300));
    await sleep(30);
    await expect(withAdvisoryLock("busy", async () => 1, { pollMs: 20, maxWaitMs: 100 })).rejects.toThrow(/timed out/);
    await hold;
  });

  test("a pool 'error' event is handled (does not crash the process)", () => {
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(lockPool.listenerCount("error")).toBeGreaterThan(0);
  });
});

describe("graceful shutdown", () => {
  test("drain waits for in-flight turns, then refuses new ones", async () => {
    let done = false;
    const running = serialize("drain:1", async () => { await sleep(150); done = true; });
    await sleep(20);
    expect(inflightCount()).toBe(1);
    const r = await drain(2_000);
    expect(r).toEqual({ drained: true, remaining: 0 });
    expect(done).toBe(true);
    await running;
    await expect(serialize("drain:2", async () => 1)).rejects.toBeInstanceOf(ShuttingDownError);
  });

  test("drain gives up at the deadline and reports what is left", async () => {
    const running = serialize("drain:slow", () => sleep(400));
    await sleep(20);
    const r = await drain(80);
    expect(r.drained).toBe(false);
    expect(r.remaining).toBe(1);
    await running;
  });

  test("boot sweep closes stale running turns and leaves fresh ones", async () => {
    await db.insert(turns).values([
      { id: "old", channelId: "C", trigger: "mention", status: "running", startedAt: new Date(Date.now() - 3600_000) },
      { id: "fresh", channelId: "C", trigger: "mention", status: "running" },
    ]);
    expect(await sweepStaleTurns()).toBe(1);
    const rows = Object.fromEntries((await db.select().from(turns)).map((t) => [t.id, t.status]));
    expect(rows).toMatchObject({ old: "error", fresh: "running" });
  });
});
