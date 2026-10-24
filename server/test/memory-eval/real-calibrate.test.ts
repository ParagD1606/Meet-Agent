// Real-embedding calibration of the retrieval signal (needs Vertex/ADC creds; skipped without REAL_EMBED=1).
//   REAL_EMBED=1 DATABASE_URL=<throwaway> bun --env-file=<.env> test test/memory-eval/real-calibrate.test.ts
import "../turn/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetDb } from "../db";
import { setEmbedder } from "../../src/memory/embed";
import { setMemoryLlm } from "../../src/memory/llm";
import { removeFakes } from "../memory/helpers";
import { CASES } from "./cases";
import { installEvalFakes, runAll, seedCorpus, summarize } from "./run";

const on = !!process.env.REAL_EMBED;
let results: Awaited<ReturnType<typeof runAll>>;

beforeAll(async () => {
  if (!on) return;
  if (!/host=\/tmp\/claude-1000/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing: DATABASE_URL is not the throwaway db");
  installEvalFakes();
  setEmbedder(null); // real embeddings, scripted LLM stubs
  await resetDb();
  await seedCorpus();
  results = await runAll();
}, 600_000);
afterAll(removeFakes);

describe.skipIf(!on)("real embeddings", () => {
  test("signal per case", () => {
    for (const r of results) console.log(`${r.id.padEnd(14)} ${r.signal.padEnd(6)} ${r.wantsNone ? "ABSTAIN" : "answer "} ${r.recall.signal?.reason} ${JSON.stringify(r.recall.signal?.features)}`);
    const s = summarize(results);
    console.log(JSON.stringify(s.abstain), JSON.stringify(s.recall), s.failed);
    expect(CASES.length).toBeGreaterThan(0);
  }, 300_000);
});
