import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { memories, memoryEdges } from "../../src/db/schema";
import { deleteMemory, getGraph, listMemories } from "../../src/memory/graph";
import { installFakes, removeFakes, seedMemory } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

describe("graph / list / delete", () => {
  test("getGraph returns active nodes and only edges between them; labels are truncated", async () => {
    const a = await seedMemory("shared", "alpha ".repeat(40));
    const b = await seedMemory("shared", "beta");
    const c = await seedMemory("shared", "gamma", { status: "superseded" });
    const d = await seedMemory("user_U1", "delta");
    await db.insert(memoryEdges).values([{ fromId: a, toId: b, weight: 0.7 }, { fromId: a, toId: c }, { fromId: b, toId: d }]);
    const g = await getGraph({ tags: ["shared"], limit: 10 });
    expect(g.nodes.map((n) => n.id).sort()).toEqual([a, b]);
    expect(g.nodes.find((n) => n.id === a)!.label.length).toBeLessThanOrEqual(80);
    expect(g.edges).toEqual([{ source: a, target: b, weight: 0.7 }]);
    expect((await getGraph({ tags: ["shared"], limit: 1 })).nodes.length).toBe(1);
  });

  test("listMemories filters (literal wildcards), pages and counts", async () => {
    for (let i = 0; i < 5; i++) await seedMemory("shared", `item ${i}`);
    await seedMemory("shared", "100% done");
    await seedMemory("shared", "1000 done");
    const page = await listMemories({ tags: ["shared"], limit: 2, offset: 2 });
    expect(page.total).toBe(7);
    expect(page.items.length).toBe(2);
    const pct = await listMemories({ tags: ["shared"], q: "100%", limit: 10, offset: 0 });
    expect(pct.items.map((i) => i.text)).toEqual(["100% done"]);
    expect((await listMemories({ tags: ["shared"], q: "ITEM", limit: 10, offset: 0 })).total).toBe(5);
  });

  test("deleteMemory removes row and edges, unlinks superseded_by, reports missing ids", async () => {
    const newer = await seedMemory("shared", "new");
    const older = await seedMemory("shared", "old", { status: "superseded", supersededBy: newer });
    await db.insert(memoryEdges).values({ fromId: newer, toId: older });
    expect(await deleteMemory(newer)).toBe(true);
    expect((await db.select().from(memoryEdges)).length).toBe(0);
    const [o] = await db.select().from(memories).where(eq(memories.id, older));
    expect(o!.supersededBy).toBeNull();
    expect(await deleteMemory(newer)).toBe(false);
  });
});
