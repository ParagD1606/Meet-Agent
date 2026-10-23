import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { memories } from "../../src/db/schema";
import { setMemoryLlm } from "../../src/memory/llm";
import type { SlackScope } from "../../src/memory/scope";
import { captureTurn } from "../../src/memory/writeback";
import { installFakes, removeFakes } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);

const scope = (o: Partial<SlackScope>): SlackScope => ({ channelId: "C1", isPrivate: false, isIm: false, userId: "U1", ...o });
const facts = (...f: string[]) => async () => JSON.stringify({ facts: f });

describe("captureTurn", () => {
  test("writes extracted facts to the scope's tag", async () => {
    setMemoryLlm(facts("Priya owns the budget review", "Budget review is due on May 5"));
    expect(await captureTurn({ scope: scope({}), transcript: "U1: who owns budget?\nbot: Priya" })).toBe(2);
    setMemoryLlm(facts("Dana prefers async updates"));
    expect(await captureTurn({ scope: scope({ isPrivate: true, channelId: "C9" }), transcript: "x" })).toBe(1);
    setMemoryLlm(facts("I like dark mode"));
    expect(await captureTurn({ scope: scope({ isIm: true, channelId: "D1" }), transcript: "x" })).toBe(1);
    const rows = await db.select({ t: memories.scopeTag, text: memories.text }).from(memories);
    expect(rows.filter((r) => r.t === "shared").length).toBe(2);
    expect(rows.find((r) => r.t === "channel_C9")?.text).toContain("Dana");
    expect(rows.find((r) => r.t === "user_U1")?.text).toContain("dark mode");
  });

  test("no-op without a write tag and never calls the LLM", async () => {
    let calls = 0;
    setMemoryLlm(async () => { calls++; return '{"facts":["should not be stored ever"]}'; });
    expect(await captureTurn({ scope: scope({ isIm: true, userId: null }), transcript: "hello" })).toBe(0);
    expect(calls).toBe(0);
    expect((await db.select().from(memories)).length).toBe(0);
  });

  test("blank transcript, junk facts and duplicates", async () => {
    setMemoryLlm(facts("ok", "   ", "Launch is on March 3", "Launch is on March 3"));
    expect(await captureTurn({ scope: scope({}), transcript: "   " })).toBe(0);
    expect(await captureTurn({ scope: scope({}), transcript: "t" })).toBe(1);
    expect(await captureTurn({ scope: scope({}), transcript: "t" })).toBe(0); // second turn: deduped
  });

  test("LLM failure is swallowed", async () => {
    setMemoryLlm(async () => { throw new Error("rate limited"); });
    expect(await captureTurn({ scope: scope({}), transcript: "t" })).toBe(0);
    setMemoryLlm(async () => "```json\nnope\n```");
    expect(await captureTurn({ scope: scope({}), transcript: "t" })).toBe(0);
  });
});

describe("debounced thread capture (write-path diet)", () => {
  test("extracts once per N turns, skips trivial turns, flushes on final", async () => {
    const { scheduleCapture, flushIdleCaptures } = await import("../../src/memory/writeback");
    const { setMemoryLlm } = await import("../../src/memory/llm");
    let extractions = 0;
    setMemoryLlm(async ({ system }) => { if (system.includes("extract durable")) extractions++; return '{"facts":["Dana owns the billing migration"],"superseded":[]}'; });
    const scope = { channelId: "C_DEB", isPrivate: false, isIm: false, userId: "U1" };
    const base = { scope, channelId: "C_DEB", threadTs: "1.0" };
    expect((await scheduleCapture({ ...base, transcript: "hi\nAssistant: hello", userText: "hi" })).skipped).toBe("trivial");
    expect((await scheduleCapture({ ...base, transcript: "Dana owns billing\nAssistant: noted", userText: "Dana owns billing migration now" })).deferred).toBe(true);
    expect((await scheduleCapture({ ...base, transcript: "deadline is May\nAssistant: ok", userText: "the deadline is May 5th" })).deferred).toBe(true);
    expect(extractions).toBe(0);
    const third = await scheduleCapture({ ...base, transcript: "and finance approves\nAssistant: ok", userText: "finance approves the spend" });
    expect(third.deferred).toBe(false);
    expect(extractions).toBe(1);
    // idle sweep
    await scheduleCapture({ ...base, threadTs: "2.0", transcript: "another real fact here\nAssistant: ok", userText: "another real fact is here" });
    expect(await flushIdleCaptures(0)).toBeGreaterThanOrEqual(0);
    expect(extractions).toBe(2);
  });
});
