// Memory eval: deterministic recall quality gate. Fails if scope-leak failures > 0 or a category regresses > 0.02 below baseline.json.
//   DATABASE_URL=<throwaway db> bun test test/memory-eval
//   UPDATE_BASELINE=1 bun test test/memory-eval   # rewrite baseline.json from the current numbers
import "../turn/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { removeFakes } from "../memory/helpers";
import { resetDb } from "../db";
import { CASES, CATEGORIES } from "./cases";
import { installEvalFakes, runAll, seedCorpus, summarize } from "./run";

const BASELINE = new URL("./baseline.json", import.meta.url).pathname;
const TOLERANCE = 0.02;

let results: Awaited<ReturnType<typeof runAll>>;
let summary: ReturnType<typeof summarize>;

beforeAll(async () => {
  installEvalFakes();
  await resetDb();
  await seedCorpus();
  results = await runAll();
  summary = summarize(results);
  if (process.env.UPDATE_BASELINE) await Bun.write(BASELINE, `${JSON.stringify({ k: summary.k, recall: summary.recall }, null, 2)}\n`);
});
afterAll(removeFakes);

describe("memory eval", () => {
  test("covers every category with ids unique", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const cat of CATEGORIES) expect(summary.counts[cat]).toBeGreaterThanOrEqual(5);
  });

  test("scope-leak failures == 0", () => {
    expect(results.filter((r) => r.category === "scope-leak" && r.leaked).map((r) => r.id)).toEqual([]);
  });

  test("per-category recall has not regressed against baseline.json", async () => {
    const base = (await Bun.file(BASELINE).json()) as { recall: Record<string, number> };
    for (const cat of CATEGORIES) {
      expect(summary.recall[cat]!, `${cat} (failed: ${summary.failed.filter((id) => results.find((r) => r.id === id)?.category === cat).join(",")})`)
        .toBeGreaterThanOrEqual(base.recall[cat]! - TOLERANCE);
    }
  });
});
