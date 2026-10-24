import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, resetDb } from "../db";
import { memories, toolResults } from "../../src/db/schema";
import { consolidate } from "../../src/memory/consolidate";
import { setMemoryLlm } from "../../src/memory/llm";
import { installFakes, removeFakes, seedMemory } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

const old = (days: number) => new Date(Date.now() - days * 86_400_000);

describe("consolidate", () => {
  test("merges near-duplicates, decays stale importance, summarises stale clusters, and is idempotent", async () => {
    setMemoryLlm(async () => '{"facts":["Historic vendor list: Acme, Bolt, Cirrus and Delta were evaluated in 2024."]}');
    const a = await seedMemory("shared", "The weekly sync with Acme happens every Tuesday at 10am");
    const b = await seedMemory("shared", "The weekly sync with Acme happens every Tuesday at 10am");
    await db.update(memories).set({ accessCount: 5 }).where(eq(memories.id, b));
    await seedMemory("user_U1", "The weekly sync with Acme happens every Tuesday at 10am"); // other tag: untouched
    const stale: number[] = [];
    for (let i = 0; i < 9; i++) stale.push(await seedMemory("shared", `Vendor${i} evaluation note number${i} zork${i}`, { validAt: old(400), importance: 0.2 }));
    const decayMe = await seedMemory("shared", "Rarely used but recent enough standing fact quux", { validAt: old(120), importance: 0.9 });

    const r1 = await consolidate();
    expect(r1.merged).toBe(1);
    expect(r1.decayed).toBeGreaterThanOrEqual(1);
    expect(r1.summarised).toBe(9);
    const [ra] = await db.select().from(memories).where(eq(memories.id, a));
    const [rb] = await db.select().from(memories).where(eq(memories.id, b));
    expect(ra).toMatchObject({ status: "superseded", supersededBy: b }); // more-used survives
    expect(rb!.status).toBe("active");
    const [d] = await db.select().from(memories).where(eq(memories.id, decayMe));
    // continuous decay (120d half-life for plain facts, 120 days idle): 0.9 * 0.5 = 0.45, not a clamp
    expect(d!.importance).toBeCloseTo(0.45, 1);
    expect(d!.decayedAt).not.toBeNull();
    const live = await db.select().from(memories).where(sql`status = 'active' and scope_tag = 'shared'`);
    expect(live.some((m) => m.createdBy === "consolidation")).toBe(true);
    for (const id of stale) expect((await db.select().from(memories).where(eq(memories.id, id)))[0]!.status).toBe("archived"); // archived, not purged

    const before = await db.select().from(memories).orderBy(memories.id);
    expect(await consolidate()).toMatchObject({ merged: 0, decayed: 0, summarised: 0, purged: 0, crossScope: 0 });
    expect(await db.select().from(memories).orderBy(memories.id)).toEqual(before);
  });

  test("an LLM failure keeps the originals; old spilled tool results are purged", async () => {
    setMemoryLlm(async () => { throw new Error("llm down"); });
    for (let i = 0; i < 9; i++) await seedMemory("shared", `Stale thing ${i} blorp${i}`, { validAt: old(400), importance: 0.2 });
    await db.insert(toolResults).values({ id: "tr_old", turnId: "t", toolName: "x", content: "c", bytes: 1 });
    await db.execute(sql`update tool_results set created_at = now() - interval '30 days'`);
    const r = await consolidate();
    expect(r.summarised).toBe(0);
    expect(r.purged).toBe(1);
    expect((await db.select().from(memories).where(eq(memories.status, "active"))).length).toBe(9);
  });
});
