import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { memories, threadState } from "../../src/db/schema";
import { estimateTokens } from "../../src/memory/budget";
import { setMemoryLlm } from "../../src/memory/llm";
import { getThreadSummary, type HistoryItem, maybeCompact, renderSummary, SUMMARY_PREFIX } from "../../src/turn/compact";
import { installFakes, removeFakes } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

const msgs = (from: number, n: number, words = 120): HistoryItem[] =>
  Array.from({ length: n }, (_, i) => ({ ts: `${1000 + from + i}.0`, role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `msg${from + i} ${"detail ".repeat(words)}` }));

const GOOD = "## Active Task\nUser asked: finish the billing migration plan\n\n## Goal\nMigrate billing\n\n## Pending Asks\nNone.";

describe("maybeCompact", () => {
  test("does nothing under the threshold; compacts above it, keeps a verbatim tail, stores the summary", async () => {
    setMemoryLlm(async () => GOOD);
    expect(await maybeCompact({ channelId: "C1", threadTs: "1.0", messages: msgs(0, 4) })).toBeNull();
    const all = msgs(0, 26); // ~26 * 215 tokens, above the 4.5k threshold
    const r = await maybeCompact({ channelId: "C1", threadTs: "1.0", messages: all });
    expect(r).not.toBeNull();
    expect(r!.summary).toBe(GOOD);
    const kept = all.filter((m) => Number(m.ts) >= Number(r!.keptFromTs));
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.reduce((n, m) => n + estimateTokens(m.text), 0)).toBeLessThanOrEqual(1700);
    const st = await getThreadSummary("C1", "1.0");
    expect(st.summary).toBe(GOOD);
    expect(Number(st.uptoTs)).toBeLessThan(Number(r!.keptFromTs));
    expect(renderSummary(st.summary).startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(SUMMARY_PREFIX).toContain("REFERENCE ONLY");
    // compacted messages are no longer "live": same input is below threshold now
    expect(await maybeCompact({ channelId: "C1", threadTs: "1.0", messages: all })).toBeNull();
  });

  test("iterative: the second compaction feeds the previous summary back in", async () => {
    const prompts: string[] = [];
    setMemoryLlm(async ({ prompt }) => { prompts.push(prompt); return GOOD; });
    await maybeCompact({ channelId: "C1", threadTs: "1.0", messages: msgs(0, 26) });
    await maybeCompact({ channelId: "C1", threadTs: "1.0", messages: msgs(0, 50) });
    expect(prompts.length).toBe(2);
    expect(prompts[0]).not.toContain("PREVIOUS SUMMARY");
    expect(prompts[1]).toContain("PREVIOUS SUMMARY");
    expect(prompts[1]).toContain(GOOD);
    expect(prompts[0]).toContain("## Active Task");
  });

  test("anti-thrash: after two compactions saving <10% it stops until the history doubles", async () => {
    let calls = 0;
    // a "summary" as long as the input saves nothing
    setMemoryLlm(async ({ prompt }) => { calls++; return `## Active Task\n${prompt}`; });
    await maybeCompact({ channelId: "C1", threadTs: "1.0", messages: msgs(0, 14, 400) });
    expect((await getThreadSummary("C1", "1.0")).state.ineffective).toBe(1);
    await maybeCompact({ channelId: "C1", threadTs: "1.0", messages: msgs(0, 30, 400) });
    expect((await getThreadSummary("C1", "1.0")).state.ineffective).toBe(2);
    expect(calls).toBe(2);
    expect(await maybeCompact({ channelId: "C1", threadTs: "1.0", messages: msgs(0, 36, 400) })).toBeNull();
    expect(calls).toBe(2);
  });

  test("secrets are redacted; LLM failure leaves the thread untouched; pre-compaction extraction stores facts", async () => {
    const seen: string[] = [];
    setMemoryLlm(async ({ system, prompt }) => {
      seen.push(prompt);
      if (system.includes("extract durable")) return '{"facts":["Dana owns the billing migration plan"]}';
      return GOOD;
    });
    const leaky = msgs(0, 26);
    leaky[0]!.text += " my key is sk-abcdefghijklmnopqrstuvwxyz123456";
    await maybeCompact({ channelId: "C1", threadTs: "2.0", messages: leaky, scope: { channelId: "C1", isPrivate: false, isIm: false, userId: "U1" } });
    await Bun.sleep(150);
    expect(seen.join("\n")).not.toContain("sk-abcdefghij");
    expect((await db.select().from(memories)).some((m) => m.createdBy === "compaction")).toBe(true);

    setMemoryLlm(async () => { throw new Error("down"); });
    expect(await maybeCompact({ channelId: "C1", threadTs: "3.0", messages: msgs(0, 26) })).toBeNull();
    expect((await db.select().from(threadState).where(eq(threadState.threadTs, "3.0"))).length).toBe(0);
  });
});
