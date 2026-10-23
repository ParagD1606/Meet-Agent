import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { memories, memoryReviews } from "../../src/db/schema";
import { getMemoryHistory } from "../../src/memory/facts";
import { listMemories } from "../../src/memory/graph";
import { setMemoryLlm } from "../../src/memory/llm";
import { decideReview, listReviews } from "../../src/memory/review";
import { searchMemory } from "../../src/memory/search";
import { addFact } from "../../src/memory/supersede";
import { installFakes, removeFakes } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

const supersedeAll = () => setMemoryLlm(async ({ prompt }) => `{"superseded":[${[...prompt.matchAll(/\[(\d+)\]/g)].map((m) => m[1]).join(",")}]}`);

describe("bi-temporal facts", () => {
  test("supersede keeps history, sets invalid_at, and asOf queries see the past", async () => {
    supersedeAll();
    const t0 = new Date(Date.now() - 10 * 86_400_000);
    const t1 = new Date(Date.now() - 2 * 86_400_000);
    const old = await addFact({ tag: "user_U1", text: "The launch date is March 3", source: "slack", validAt: t0, createdBy: "U1" });
    const neu = await addFact({ tag: "user_U1", text: "The launch date moved to April 9", source: "slack", validAt: t1 });
    expect(neu.superseded).toEqual([old.id]);
    const [o] = await db.select().from(memories).where(eq(memories.id, old.id));
    expect(o).toMatchObject({ status: "superseded", supersededBy: neu.id });
    expect(o!.invalidAt!.getTime()).toBe(t1.getTime());

    const now = await searchMemory({ tags: ["user_U1"], query: "launch date" });
    expect(now.map((h) => h.id)).toEqual([neu.id]);
    const before = await searchMemory({ tags: ["user_U1"], query: "launch date", asOf: new Date(Date.now() - 5 * 86_400_000) });
    expect(before.map((h) => h.id)).toEqual([old.id]);
    const beforeAny = await searchMemory({ tags: ["user_U1"], query: "launch date", asOf: new Date(Date.now() - 20 * 86_400_000) });
    expect(beforeAny).toEqual([]);

    const chain = await getMemoryHistory(neu.id);
    expect(chain.map((m) => m.id)).toEqual([old.id, neu.id]);
    expect((await getMemoryHistory(old.id)).map((m) => m.id)).toEqual([old.id, neu.id]);
    expect(chain[0]!.createdBy).toBe("U1");
  });

  test("listMemories status filter and totals", async () => {
    supersedeAll();
    await addFact({ tag: "shared", text: "Standup is at 10am daily", source: "slack" });
    await addFact({ tag: "shared", text: "Standup moved to 11am daily", source: "slack" });
    expect((await listMemories({ tags: ["shared"], limit: 10, offset: 0 })).total).toBe(1);
    const sup = await listMemories({ tags: ["shared"], limit: 10, offset: 0, status: "superseded" });
    expect(sup.items[0]).toMatchObject({ status: "superseded", reviewState: "ok" });
    expect(sup.items[0]!.supersededBy).not.toBeNull();
    expect((await listMemories({ tags: ["shared"], limit: 10, offset: 0, status: "all" })).total).toBe(2);
  });

  test("shared LLM-supersede creates a review; rejecting restores the old fact", async () => {
    supersedeAll();
    const old = await addFact({ tag: "shared", text: "The launch date is March 3", source: "slack" });
    const neu = await addFact({ tag: "shared", text: "The launch date moved to April 9", source: "slack" });
    const [rv] = await listReviews("pending");
    expect(rv).toMatchObject({ kind: "supersede", memoryId: neu.id });
    expect(await decideReview(rv!.id, "UA", false)).toMatchObject({ ok: true, status: "rejected" });
    const [o] = await db.select().from(memories).where(eq(memories.id, old.id));
    const [n] = await db.select().from(memories).where(eq(memories.id, neu.id));
    expect(o).toMatchObject({ status: "active", supersededBy: null, invalidAt: null });
    expect(n!.reviewState).toBe("rejected");
    expect((await searchMemory({ tags: ["shared"], query: "launch date" })).map((h) => h.id)).toEqual([old.id]);
  });

  test("private scopes never create reviews; low-confidence shared facts are held until approved", async () => {
    supersedeAll();
    await addFact({ tag: "user_U1", text: "The launch date is March 3", source: "slack" });
    await addFact({ tag: "user_U1", text: "The launch date moved to April 9", source: "slack" });
    expect((await db.select().from(memoryReviews)).length).toBe(0);

    const held = await addFact({ tag: "shared", text: "Maybe the CEO is leaving next month", source: "slack", confidence: 0.3 });
    expect(held.heldForReview).toBe(true);
    expect(await searchMemory({ tags: ["shared"], query: "CEO leaving" })).toEqual([]);
    const [rv] = await listReviews("pending");
    expect(rv!.kind).toBe("low_confidence");
    await decideReview(rv!.id, "UA", true);
    expect((await searchMemory({ tags: ["shared"], query: "CEO leaving" })).map((h) => h.id)).toEqual([held.id]);
  });

  test("non-primary agent contexts writing shared are held (write-permission matrix)", async () => {
    for (const [i, ctx] of (["automation", "research", "reflection"] as const).entries()) {
      const r = await addFact({ tag: "shared", text: `Fact number ${i} from ${ctx}`, source: "slack", agentContext: ctx });
      expect(r.heldForReview).toBe(true);
    }
    const ok = await addFact({ tag: "shared", text: "Primary writes go live", source: "slack", agentContext: "primary" });
    expect(ok.heldForReview).toBeUndefined();
    const priv = await addFact({ tag: "user_U1", text: "Research context writes private notes", source: "slack", agentContext: "research" });
    expect(priv.heldForReview).toBeUndefined();
    expect((await listReviews("pending")).length).toBe(3);
  });

  test("concurrent identical writes dedupe via the short transaction lock", async () => {
    const rs = await Promise.all([1, 2, 3, 4].map(() => addFact({ tag: "shared", text: "Our fiscal year starts in April", source: "slack" })));
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
    expect((await db.select().from(memories)).length).toBe(1);
  });
});
