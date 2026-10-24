import "./env";
import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { commitments, memories, settings, threadState, users } from "../../src/db/schema";
import { getThreadSummary } from "../../src/turn/compact";
import {
  afterIdleGap, getDmIdleHours, hintKey, HISTORY_CAP, isResetText, noteHistorySize, resetContext, resetCutoff, resetKeyOf, takeHint,
} from "../../src/turn/reset";
import { seedMemory } from "../memory/helpers";
import { installFakes } from "../memory/helpers";

beforeEach(async () => { await resetDb(); installFakes(); });

describe("reset commands: exact match only", () => {
  test("variants", () => {
    for (const t of ["new chat", "New Chat", "  NEW CHAT  ", "/new", "reset", "Reset.", "start over", "Start over!"]) expect(isResetText(t)).toBe(true);
    for (const t of ["can you reset my password", "reset my password", "please start over with the report", "new chat about tasks", "new chats", "/news", "reset\nand tell me the weather", ""]) expect(isResetText(t)).toBe(false);
  });
  test("keys", () => {
    expect(resetKeyOf(undefined, true)).toBe("dm");
    expect(resetKeyOf("1.1", true)).toBe("1.1");
    expect(resetKeyOf("1.1", false)).toBe("1.1");
    expect(resetKeyOf(undefined, false)).toBeUndefined();
  });
});

describe("cutoff", () => {
  test("a summary older than the reset is ignored, one made after it is kept", async () => {
    await db.insert(threadState).values({ channelId: "D1", threadTs: "100.1", summary: "OLD TOPIC", summaryUptoTs: "100.5" });
    expect((await getThreadSummary("D1", "100.1")).summary).toBe("OLD TOPIC");
    await resetContext("D1", "dm", new Date(Date.now() + 1000));
    expect(await resetCutoff("D1", ["dm"])).not.toBeNull();
    const s = await getThreadSummary("D1", "100.1");
    expect(s.summary).toBe("");
    expect(s.uptoTs).toBeNull();
    // a fresh compaction after the reset is used again
    await db.update(threadState).set({ summary: "NEW", summaryUptoTs: String(Date.now() / 1000 + 50), updatedAt: new Date(Date.now() + 5000) }).where(eq(threadState.threadTs, "100.1"));
    expect((await getThreadSummary("D1", "100.1")).summary).toBe("NEW");
  });

  test("reset clears the row's own summary and snapshot, only for that key", async () => {
    await db.insert(threadState).values([
      { channelId: "C1", threadTs: "5.5", summary: "A", coreSnapshot: { prefix: { at: 1 } } },
      { channelId: "C1", threadTs: "6.6", summary: "B" },
    ]);
    await resetContext("C1", "5.5");
    const rows = await db.select().from(threadState).where(eq(threadState.channelId, "C1"));
    const a = rows.find((r) => r.threadTs === "5.5")!;
    expect(a.summary).toBe("");
    expect(a.coreSnapshot).toBeNull();
    expect(a.contextResetAt).not.toBeNull();
    expect(rows.find((r) => r.threadTs === "6.6")!.summary).toBe("B");
  });

  test("memories, tasks and open asks are untouched", async () => {
    await db.insert(users).values({ id: "U1", name: "Una" });
    await seedMemory("user_U1", "Una prefers Friday demos");
    const [c] = await db.insert(commitments).values({ id: "c1", text: "ship it", sourceType: "message", sourceRef: "m:1", ownerId: "U1", assignerId: "U1", status: "open", scopeTag: "user_U1" } as never).returning();
    await db.insert(settings).values({ key: "ask:a1", value: { id: "a1", status: "sent" } });
    await resetContext("D1", "dm");
    expect((await db.select().from(memories)).filter((m) => m.status === "active")).toHaveLength(1);
    expect((await db.select().from(commitments).where(eq(commitments.id, c!.id)))[0]!.status).toBe("open");
    expect((await db.select().from(settings).where(eq(settings.key, "ask:a1")))[0]!.value).toMatchObject({ status: "sent" });
  });
});

describe("idle auto-reset", () => {
  const h = (ts: number) => ({ ts: String(ts) });
  test("keeps only messages after the last gap longer than the window", () => {
    const now = 1_000_000;
    const items = [h(now - 40 * 3600), h(now - 39.9 * 3600), h(now - 7.5 * 3600), h(now - 7.4 * 3600), h(now - 2 * 3600)];
    expect(afterIdleGap(items, String(now), 6).map((x) => x.ts)).toEqual([String(now - 7.5 * 3600), String(now - 7.4 * 3600), String(now - 2 * 3600)]);
  });
  test("previous message older than the window: starts fresh; within it: all kept; 0 disables", () => {
    const now = 1_000_000;
    expect(afterIdleGap([h(now - 7 * 3600)], String(now), 6)).toEqual([]);
    expect(afterIdleGap([h(now - 5 * 3600)], String(now), 6)).toHaveLength(1);
    expect(afterIdleGap([h(now - 70 * 3600)], String(now), 0)).toHaveLength(1);
  });
  test("setting: default 6, stored value wins, clamped to 0..72", async () => {
    expect(await getDmIdleHours()).toBe(6);
    await db.insert(settings).values({ key: "dm_idle_reset_hours", value: 500 });
    expect(await getDmIdleHours()).toBe(72);
    await db.update(settings).set({ value: 0 }).where(eq(settings.key, "dm_idle_reset_hours"));
    expect(await getDmIdleHours()).toBe(0);
  });
});

describe("history caps and long-chat hint", () => {
  test("caps per depth", () => expect(HISTORY_CAP).toEqual({ direct: 6, memory: 12, tools: 30, deep: 30 }));
  test("hint only above 70% of the budget, at most once per 20 turns", () => {
    const k = hintKey("D1", "dm");
    for (let i = 0; i < 5; i++) { noteHistorySize(k, 100, 3000); expect(takeHint(k)).toBe(false); } // small chat: never
    const fired: number[] = [];
    for (let turn = 1; turn <= 45; turn++) { noteHistorySize(k, 2500, 3000); if (takeHint(k)) fired.push(turn); }
    expect(fired.length).toBe(3); // first big turn, then every 20 turns
    expect(fired[1]! - fired[0]!).toBe(20);
    expect(fired[2]! - fired[1]!).toBe(20);
    noteHistorySize(k, 2099, 3000); // 2099 < 70%: no hint
    expect(takeHint(k)).toBe(false);
  });
});
