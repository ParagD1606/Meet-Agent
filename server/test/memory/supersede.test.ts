import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { memories, memoryEdges } from "../../src/db/schema";
import { setMemoryLlm } from "../../src/memory/llm";
import { addFact } from "../../src/memory/supersede";
import { installFakes, removeFakes } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

describe("addFact", () => {
  test("stores a first fact without calling the LLM", async () => {
    let calls = 0;
    setMemoryLlm(async () => { calls++; return "{}"; });
    const r = await addFact({ tag: "shared", text: "Launch is on March 3", source: "slack", sourceRef: "C1" });
    expect(r).toMatchObject({ superseded: [], deduped: false });
    expect(calls).toBe(0);
    const [row] = await db.select().from(memories).where(eq(memories.id, r.id));
    expect(row).toMatchObject({ scopeTag: "shared", kind: "fact", status: "active", sourceRef: "C1" });
  });

  test("dedupes exact and near-identical facts", async () => {
    const a = await addFact({ tag: "shared", text: "Launch is on March 3", source: "slack" });
    const b = await addFact({ tag: "shared", text: "  launch is on  MARCH 3 ", source: "slack" });
    expect(b).toEqual({ id: a.id, superseded: [], deduped: true });
    expect((await db.select().from(memories)).length).toBe(1);
  });

  test("marks contradicted facts superseded and links edges", async () => {
    setMemoryLlm(async ({ prompt }) => {
      const m = /\[(\d+)\] .*launch date/.exec(prompt);
      return `Sure: {"superseded":[${m ? m[1] : ""}]}`;
    });
    const old = await addFact({ tag: "shared", text: "The launch date is March 3", source: "slack" });
    const unrelated = await addFact({ tag: "shared", text: "Standup is at 10am daily", source: "slack" });
    const neu = await addFact({ tag: "shared", text: "The launch date moved to April 9", source: "slack" });
    expect(neu.superseded).toEqual([old.id]);
    const [o] = await db.select().from(memories).where(eq(memories.id, old.id));
    expect(o).toMatchObject({ status: "superseded", supersededBy: neu.id });
    const [u] = await db.select().from(memories).where(eq(memories.id, unrelated.id));
    expect(u!.status).toBe("active");
    const edges = await db.select().from(memoryEdges);
    expect(edges).toEqual([{ fromId: neu.id, toId: old.id, weight: expect.any(Number) }]);
    expect(edges[0]!.weight).toBeGreaterThan(0.4);
  });

  test("ignores ids the LLM invents or that belong to another tag", async () => {
    const other = await addFact({ tag: "user_U9", text: "The launch date is March 3", source: "slack" });
    const mine = await addFact({ tag: "shared", text: "The launch date is March 3", source: "slack" });
    setMemoryLlm(async () => `{"superseded":[${other.id},999999,${mine.id}]}`);
    const neu = await addFact({ tag: "shared", text: "The launch date moved to April 9", source: "slack" });
    expect(neu.superseded).toEqual([mine.id]);
    const [o] = await db.select().from(memories).where(eq(memories.id, other.id));
    expect(o!.status).toBe("active");
  });

  test("same text in a different tag is not a duplicate", async () => {
    const a = await addFact({ tag: "user_U1", text: "I prefer short answers", source: "slack" });
    const b = await addFact({ tag: "user_U2", text: "I prefer short answers", source: "slack" });
    expect(b.deduped).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  test("LLM failure or garbage still stores the fact and supersedes nothing", async () => {
    const old = await addFact({ tag: "shared", text: "The launch date is March 3", source: "slack" });
    for (const reply of ["not json at all", '{"superseded":"nope"}']) {
      setMemoryLlm(async () => reply);
      const r = await addFact({ tag: "shared", text: `The launch date is March ${reply.length}`, source: "slack" });
      expect(r.superseded).toEqual([]);
    }
    setMemoryLlm(async () => { throw new Error("boom"); });
    const r = await addFact({ tag: "shared", text: "The launch date is definitely June", source: "slack" });
    expect(r.deduped).toBe(false);
    const [o] = await db.select().from(memories).where(eq(memories.id, old.id));
    expect(o!.status).toBe("active");
  });

  test("rejects empty text", async () => {
    await expect(addFact({ tag: "shared", text: "  ", source: "slack" })).rejects.toThrow(/empty/);
  });
});
