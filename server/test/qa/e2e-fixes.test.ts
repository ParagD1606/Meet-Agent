// Regressions for bugs found by the live e2e run (docs/qa/e2e-report.md).
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { channels } from "../../src/db/schema";
import { buildDigest, deadlineTick } from "../../src/automations";
import { setSlackClientForTest } from "../../src/slack/client";
import { setFeatureChannels } from "../../src/slack/proactive-features";
import { captureTurn } from "../../src/memory/writeback";
import { setMemoryLlm } from "../../src/memory/llm";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(async () => {
  await resetDb();
  await db.insert(channels).values({ id: "CPUB", name: "pub", botIsMember: true });
});

describe("ambient facts (source_ref '<channel>/<ts>') feed digests and deadline reminders", () => {
  test("weekly digest and deadline reminder include them for the right public channel only", async () => {
    const fake = fakeSlack();
    setSlackClientForTest(fake.client);
    await db.insert(channels).values({ id: "COTHER", name: "other", botIsMember: true });
    await seedMemory("shared", "Staging freeze for Titan runs until tomorrow", { sourceRef: "CPUB/1700000000.000100", validUntil: new Date(Date.now() + 6 * 3600_000), factType: "decision" });
    await seedMemory("shared", "OTHERCHANNEL decision about lunch", { sourceRef: "COTHER/1700000000.000100", factType: "decision" });
    const d = await buildDigest({ id: "CPUB", isPrivate: false });
    expect(d).toContain("Staging freeze");
    expect(d).not.toContain("OTHERCHANNEL");
    await setFeatureChannels("deadlines", ["CPUB"]);
    expect(await deadlineTick(new Date())).toBe(1);
    expect(fake.calls.some((c) => c.method === "chat.postMessage" && c.args.channel === "CPUB" && /Staging freeze/.test(c.args.text))).toBe(true);
  });
});

describe("/remember and memory_remember refuse credentials", () => {
  test("rememberFact rejects passwords, tokens and keys, accepts ordinary facts", async () => {
    const { rememberFact } = await import("../../src/memory/facts");
    for (const t of ["the prod password is hunter2-secret-9 remember it", "deploy token: ghp_abcdefghijklmnop1234", "AWS key AKIAABCDEFGHIJKLMNOP is for staging"]) {
      await expect(rememberFact({ tag: "shared", text: t, source: "slack_command" })).rejects.toThrow(/password, token or key/);
    }
    expect((await rememberFact({ tag: "shared", text: "Standup is at 09:15 every weekday", source: "slack_command" })).deduped).toBe(false);
  });
});

describe("MCP schema minifier keeps arguments named like decoration keys", () => {
  test("a 'title' / 'examples' / '$id' property survives (Gemini 400s when `required` names a missing property)", async () => {
    const { minSchema } = await import("../../src/mcp/tools");
    const s: any = minSchema({ title: "Create", type: "object", required: ["title"], properties: { title: { type: "string", title: "Title" }, examples: { type: "array", examples: [1] }, $id: { type: "string" } } });
    expect(s.title).toBeUndefined();
    expect(Object.keys(s.properties).sort()).toEqual(["$id", "examples", "title"]);
    expect(s.properties.title).toEqual({ type: "string" });
    expect(s.properties.examples.examples).toBeUndefined();
    expect(s.required).toEqual(["title"]);
  });
});

describe("one-word classifiers leave room for the word", () => {
  test("steering classifier lets 'REPLACE' through (Gemini cut it to 'RE' at 5 tokens, so REPLACE never fired)", async () => {
    const { MockLanguageModelV4 } = await import("ai/test");
    const { setModelResolverForTest } = await import("../../src/llm");
    const { classifySteer } = await import("../../src/turn/steering");
    let cap = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (o: any) => {
        cap = o.maxOutputTokens;
        const word = "REPLACE".slice(0, Math.max(0, cap < 7 ? 2 : 7)); // what a 5-token cap did to the real model
        return { content: [{ type: "text", text: word }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } }, warnings: [] } as any;
      },
    });
    setModelResolverForTest(() => model as never);
    try {
      expect(await classifySteer("summarize Titan", { text: "Actually forget that, who owns the checklist?" })).toBe("REPLACE");
      expect(cap).toBeGreaterThanOrEqual(8);
    } finally { setModelResolverForTest(undefined); }
  });
});

describe("fact extractor knows the weekday of 'today'", () => {
  test("prompt carries 'Wednesday 2026-06-10' so 'by Friday' resolves forward", async () => {
    const prompts: string[] = [];
    setMemoryLlm(async (a) => { prompts.push(a.prompt); return '{"facts":[]}'; });
    await captureTurn({ scope: { channelId: "CPUB", isPrivate: false, isIm: false, userId: null }, transcript: "Alice: report due by Friday", at: new Date("2026-06-10T12:00:00Z") });
    expect(prompts[0]).toContain("Today is Wednesday 2026-06-10.");
  });
});
