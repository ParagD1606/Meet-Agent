import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { estimateTokens, packToBudget } from "../../src/memory/budget";
import { buildRecall, clearRecallCache } from "../../src/memory/recall";
import type { SlackScope } from "../../src/memory/scope";
import { resetDb } from "../db";
import { installFakes, removeFakes, seedMemory } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);

const scope: SlackScope = { channelId: "C_PUB", isPrivate: false, isIm: false, userId: "U1" };

describe("recall token budget", () => {
  beforeEach(async () => {
    await resetDb();
    clearRecallCache();
    // 120 distinct long-ish facts that all match the query
    for (let i = 0; i < 120; i++) {
      await seedMemory("shared", `Launch plan item ${i}: the billing migration owner is team ${i} and the deadline is day ${i * 3} with notes ${"detail ".repeat(12 + (i % 7))}`);
    }
  });

  for (const budget of [150, 400, 1000, 2500]) {
    test(`never exceeds ${budget} tokens`, async () => {
      const r = await buildRecall({ scope, query: "launch plan billing migration owner deadline", budgetTokens: budget });
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.tokens).toBeLessThanOrEqual(budget);
      expect(estimateTokens(r.text)).toBeLessThanOrEqual(budget);
      expect(r.text).toContain("<memory-context>");
    });
  }

  test("a budget too small for the wrapper yields nothing rather than overflowing", async () => {
    const r = await buildRecall({ scope, query: "launch plan billing", budgetTokens: 5 });
    expect(r.text).toBe("");
    expect(r.tokens).toBe(0);
  });

  test("default budget is 2500", async () => {
    const r = await buildRecall({ scope, query: "launch plan billing migration owner deadline" });
    expect(r.tokens).toBeLessThanOrEqual(2500);
  });
});

describe("packToBudget", () => {
  test("never exceeds the budget for any budget; keeps order", () => {
    const items = Array.from({ length: 50 }, (_, i) => `item ${i} ${"word ".repeat(i % 13)}`);
    for (const budget of [0, 1, 10, 50, 200, 1000]) {
      const r = packToBudget(items, budget, (s) => s);
      expect(r.tokens).toBeLessThanOrEqual(budget);
      expect(r.packed).toEqual(items.filter((x) => r.packed.includes(x))); // subsequence: original order kept
    }
  });
});
