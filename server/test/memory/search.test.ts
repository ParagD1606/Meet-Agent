import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setEmbedder } from "../../src/memory/embed";
import { searchMemory } from "../../src/memory/search";
import { resetDb } from "../db";
import { fakeVector, installFakes, removeFakes, seedMemory } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

describe("searchMemory", () => {
  test("ranks semantically closer text first and drops below-threshold vector-only hits", async () => {
    await seedMemory("shared", "The quarterly budget review is owned by Priya");
    await seedMemory("shared", "Quarterly budget numbers were approved on Friday");
    await seedMemory("shared", "Office plants get watered on Mondays");
    const hits = await searchMemory({ tags: ["shared"], query: "who owns the quarterly budget review" });
    expect(hits.length).toBe(2);
    expect(hits[0]!.text).toContain("Priya");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits.every((h) => h.score > 0 && h.score <= 1)).toBe(true);
    expect(hits.some((h) => h.text.includes("plants"))).toBe(false);
  });

  test("keyword matches are found even when cosine similarity is below threshold", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    await seedMemory("shared", `${filler} refunds`);
    await seedMemory("shared", "completely unrelated gardening note");
    expect(fakeVector("refunds").reduce((s, x, i) => s + x * fakeVector(`${filler} refunds`)[i]!, 0)).toBeLessThan(0.3);
    const hits = await searchMemory({ tags: ["shared"], query: "refunds" });
    expect(hits.map((h) => h.text)).toEqual([`${filler} refunds`]);
  });

  test("honours limit, ignores superseded rows, returns metadata", async () => {
    for (let i = 0; i < 5; i++) await seedMemory("shared", `deploy checklist item ${i}`, { sourceRef: `ref${i}`, source: "upload" });
    await seedMemory("shared", "deploy checklist old", { status: "superseded" });
    const hits = await searchMemory({ tags: ["shared"], query: "deploy checklist", limit: 3 });
    expect(hits.length).toBe(3);
    expect(hits.every((h) => h.source === "upload" && h.sourceRef?.startsWith("ref") && h.createdAt instanceof Date)).toBe(true);
    expect(hits.some((h) => h.text.includes("old"))).toBe(false);
  });

  test("blank query returns nothing; punctuation-only query does not crash", async () => {
    await seedMemory("shared", "anything");
    expect(await searchMemory({ tags: ["shared"], query: "   " })).toEqual([]);
    expect(await searchMemory({ tags: ["shared"], query: "'); drop table memories; -- !!" })).toBeInstanceOf(Array);
  });

  test("embedding dimension mismatch is a clear error", async () => {
    setEmbedder(async (t) => t.map(() => [1, 2, 3]));
    await expect(searchMemory({ tags: ["shared"], query: "x" })).rejects.toThrow(/EMBEDDING_DIM/);
    installFakes();
  });
});
