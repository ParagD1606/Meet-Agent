import "./env";
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../../src/db";
import { rateLimits, settings, turns, usageDaily } from "../../src/db/schema";
import { checkRate } from "../../src/limits/rate";
import { activeTurnSlots, acquireTurnSlot, releaseTurnSlot, resetTurnSlots } from "../../src/limits/concurrency";
import { dailyCapStatus, recordUsage, underDailyCap } from "../../src/limits/usage";
import { DEFAULT_LIMITS, getLimits, invalidateLimits, maxStepsFor, setLimits } from "../../src/limits/settings";
import { TurnBudget, createTurnBudget } from "../../src/limits/budget";
import { usageReport } from "../../src/limits/report";
import { resetDb } from "../db";

beforeEach(async () => { await resetDb(); invalidateLimits(); resetTurnSlots(); });

describe("token buckets", () => {
  test("burst is allowed, then rejected with a friendly message and retry hint", async () => {
    const now = Date.now();
    const a = { userId: "U1", channelId: "C1", kind: "turn" as const };
    for (let i = 0; i < 10; i++) expect((await checkRate(a, now)).ok).toBe(true);
    const r = await checkRate(a, now);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.retryAfterSec).toBeGreaterThan(0); expect(r.message).toMatch(/try again/); }
    // another user in another channel is unaffected
    expect((await checkRate({ userId: "U2", channelId: "C2", kind: "turn" }, now)).ok).toBe(true);
  });
  test("tokens refill over time", async () => {
    const now = Date.now();
    const a = { userId: "U1", channelId: "C1", kind: "turn" as const };
    for (let i = 0; i < 10; i++) await checkRate(a, now);
    expect((await checkRate(a, now)).ok).toBe(false);
    expect((await checkRate(a, now + 25_000)).ok).toBe(true); // ~2 tokens back at 1 per 12s
  });
  test("per-channel triage budget is tiny and does not charge when rejected", async () => {
    const now = Date.now();
    const t = { userId: "U", channelId: "CT", kind: "triage" as const };
    for (let i = 0; i < 6; i++) expect((await checkRate(t, now)).ok).toBe(true);
    expect((await checkRate(t, now)).ok).toBe(false);
    const rows = await db.select().from(rateLimits);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.tokens)).toBeLessThan(1);
  });
  test("a rejected user bucket does not burn the channel bucket", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) await checkRate({ userId: "U1", channelId: "CX", kind: "turn" }, now);
    const before = Number((await db.select().from(rateLimits)).find((r) => r.key === "channel:CX:turn")!.tokens);
    expect((await checkRate({ userId: "U1", channelId: "CX", kind: "turn" }, now)).ok).toBe(false);
    const after = Number((await db.select().from(rateLimits)).find((r) => r.key === "channel:CX:turn")!.tokens);
    expect(after).toBeCloseTo(before, 3);
  });
  test("concurrent calls never over-grant", async () => {
    const now = Date.now();
    const r = await Promise.all(Array.from({ length: 30 }, () => checkRate({ userId: "UC", channelId: "CC", kind: "mcp" }, now)));
    expect(r.filter((x) => x.ok)).toHaveLength(30); // mcp capacity is 30
    expect((await checkRate({ userId: "UC", channelId: "CC", kind: "mcp" }, now)).ok).toBe(false);
  });
});

describe("daily caps", () => {
  test("per-user cap blocks further turns and says when it resets", async () => {
    await setLimits({ ...DEFAULT_LIMITS, perUserDailyTokens: 1000 });
    expect(await underDailyCap("U1")).toBe(true);
    await recordUsage({ userId: "U1", inputTokens: 700, outputTokens: 300 });
    expect(await underDailyCap("U1")).toBe(false);
    expect(await underDailyCap("U2")).toBe(true);
    const s = await dailyCapStatus("U1");
    expect(s.ok === false && s.message).toMatch(/daily usage limit/);
  });
  test("org cap pauses everyone", async () => {
    await setLimits({ ...DEFAULT_LIMITS, orgDailyTokens: 500 });
    await recordUsage({ userId: "A", inputTokens: 300, outputTokens: 300 });
    const s = await dailyCapStatus("B");
    expect(s).toMatchObject({ ok: false, scope: "org" });
  });
  test("0 means unlimited; yesterday's usage does not count", async () => {
    await setLimits({ ...DEFAULT_LIMITS, perUserDailyTokens: 0, orgDailyTokens: 0 });
    await recordUsage({ userId: "U1", inputTokens: 9e9, outputTokens: 0 });
    expect(await underDailyCap("U1")).toBe(true);
    await setLimits({ ...DEFAULT_LIMITS, perUserDailyTokens: 10 });
    await db.update(usageDaily).set({ day: "2000-01-01" });
    expect(await underDailyCap("U1")).toBe(true);
  });
  test("recordUsage accumulates turns and tokens", async () => {
    await recordUsage({ userId: "U1", inputTokens: 10, outputTokens: 5 });
    await recordUsage({ userId: "U1", inputTokens: 1, outputTokens: 1 });
    const [r] = await db.select().from(usageDaily);
    expect(r).toMatchObject({ turns: 2, inputTokens: 11, outputTokens: 6 });
  });
});

describe("limits settings", () => {
  test("defaults, partial rows merge, invalid rows fall back, steps by depth", async () => {
    expect(await getLimits()).toEqual(DEFAULT_LIMITS);
    await db.insert(settings).values({ key: "limits", value: { concurrentTurns: 3, maxStepsByDepth: { deep: 9 } } });
    invalidateLimits();
    const l = await getLimits();
    expect(l.concurrentTurns).toBe(3);
    expect(l.maxStepsByDepth).toEqual({ ...DEFAULT_LIMITS.maxStepsByDepth, deep: 9 });
    expect(await maxStepsFor("deep")).toBe(9);
    await expect(setLimits({ ...DEFAULT_LIMITS, concurrentTurns: 0 })).rejects.toThrow();
  });
});

describe("per-turn ceiling and concurrency cap", () => {
  test("the turn aborts the model call when the ceiling is reached", async () => {
    const b = new TurnBudget(1000);
    expect(b.add({ inputTokens: 400, outputTokens: 100 })).toBe(false);
    expect(b.signal.aborted).toBe(false);
    expect(b.add({ totalTokens: 600 })).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(b.exceeded).toBe(true);
    expect(new TurnBudget(0).add({ totalTokens: 1e9 })).toBe(false); // 0 = unlimited
  });
  test("createTurnBudget reads the admin ceiling", async () => {
    await setLimits({ ...DEFAULT_LIMITS, perTurnTokenCeiling: 50 });
    const b = await createTurnBudget();
    b.add({ totalTokens: 60 });
    expect(b.signal.aborted).toBe(true);
  });
  test("global cap: waiters get a slot as soon as one is released; timeout returns false", async () => {
    await setLimits({ ...DEFAULT_LIMITS, concurrentTurns: 2 });
    expect(await acquireTurnSlot()).toBe(true);
    expect(await acquireTurnSlot()).toBe(true);
    expect(activeTurnSlots()).toBe(2);
    expect(await acquireTurnSlot(30)).toBe(false); // busy
    const third = acquireTurnSlot(2_000);
    releaseTurnSlot();
    expect(await third).toBe(true);
    expect(activeTurnSlots()).toBe(2);
    releaseTurnSlot(); releaseTurnSlot();
    expect(activeTurnSlots()).toBe(0);
  });
});

describe("usage report", () => {
  test("aggregates by day/user/model/trigger, cache hit rate, avg prompt breakdown and top turns", async () => {
    await db.insert(turns).values([
      { id: "t1", channelId: "C", userId: "U1", trigger: "mention", model: "m1", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600, costMicros: 5000, promptBreakdown: { system: 100, user: 20 }, status: "done" },
      { id: "t2", channelId: "C", userId: "U2", trigger: "chime", model: "m2", inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, costMicros: 1000, promptBreakdown: { system: 300, user: 40 }, status: "done" },
    ]);
    const r: any = await usageReport("7d");
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0]).toMatchObject({ turns: 2, inputTokens: 1500, outputTokens: 150, costMicros: 6000 });
    expect(r.byUser.map((u: any) => u.userId)).toEqual(["U1", "U2"]);
    expect(r.byModel).toHaveLength(2);
    expect(r.byRole.map((x: any) => x.role).sort()).toEqual(["chime", "mention"]);
    expect(r.cacheHitRate).toBeCloseTo(0.4, 5);
    expect(r.avgBreakdown).toEqual({ system: 200, user: 30 });
    expect(r.topTurns[0]!.id).toBe("t1");
  });
});
