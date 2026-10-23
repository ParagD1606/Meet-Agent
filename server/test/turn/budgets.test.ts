import "./env";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { coreBlocks, turns, usageDaily } from "../../src/db/schema";
import { getLimits, setLimits } from "../../src/limits";
import { invalidateLimits } from "../../src/limits/settings";
import { recordUsage } from "../../src/limits";
import { setEmbedder } from "../../src/memory/embed";
import { setLoopModel } from "../../src/turn/loop";
import { buildContext } from "../../src/turn/context";
import { buildSystemMessages } from "../../src/turn/prompt";
import { runTurn, type TurnInput } from "../../src/turn";
import { fakeVector } from "../memory/helpers";
import { fakeMcp, fakeSlack, seedUsers } from "./helpers";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const reply = (text: string): any => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ] as any,
  }),
});
const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  trigger: "mention", channelId: "C1", ts: "10.1", userId: "UASK", text: "hello", isPrivate: false, isIm: false, ...over,
});

let slack: ReturnType<typeof fakeSlack>;
beforeEach(async () => {
  await resetDb();
  invalidateLimits();
  await seedUsers();
  slack = fakeSlack();
  fakeMcp();
});
afterAll(() => { setEmbedder(null); setLoopModel(); invalidateLimits(); });

describe("prompt prefix is cache-stable", () => {
  test("frozen prefix is byte-identical across users until the asker's own block", async () => {
    await db.insert(coreBlocks).values([
      { id: "cb1", scopeTag: "shared", label: "company", text: "We sell widgets", charLimit: 1500 },
      { id: "cb2", scopeTag: "channel_C1", label: "channel", text: "Billing channel", charLimit: 1000 },
      { id: "cb3", scopeTag: "user_UASK", label: "user", text: "Asker likes bullets", charLimit: 1000 },
      { id: "cb4", scopeTag: "user_UOTH", label: "user", text: "Other prefers prose", charLimit: 1000 },
    ]);
    const ctxFor = (userId: string) => ({
      turnId: "t", userId, channelId: "C1", threadTs: "10.1", scope: { channelId: "C1", isPrivate: false, isIm: false, userId },
      readOnly: false, orgConnectionsOnly: false, agentContext: "primary" as const, trigger: "mention" as const, depth: "memory" as const, skipRecall: true,
    });
    const a = await buildContext(input({ userId: "UASK" }), ctxFor("UASK") as any);
    const b = await buildContext(input({ userId: "UOTH" }), ctxFor("UOTH") as any);
    const sa = buildSystemMessages(a.frozenPrefixBlocks).map((m) => m.content as string);
    const sb = buildSystemMessages(b.frozenPrefixBlocks).map((m) => m.content as string);
    expect(sa.length).toBe(sb.length);
    // everything except the final (user) block is identical
    expect(sa.slice(0, -1)).toEqual(sb.slice(0, -1));
    expect(sa.at(-1)).toContain("Asker likes bullets");
    expect(sb.at(-1)).toContain("Other prefers prose");
    // and the shared blocks come before the personal one
    expect(sa.findIndex((t) => t.includes("We sell widgets"))).toBeLessThan(sa.findIndex((t) => t.includes("Asker likes")));
    // no timestamps / ids in the prefix
    expect(sa.join("\n")).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("with empty user blocks the whole prefix is identical across users", async () => {
    const mk = (userId: string) => ({
      turnId: "t", userId, channelId: "C1", threadTs: "10.1", scope: { channelId: "C1", isPrivate: false, isIm: false, userId },
      readOnly: false, orgConnectionsOnly: false, agentContext: "primary" as const, trigger: "mention" as const, depth: "memory" as const, skipRecall: true,
    });
    const a = await buildContext(input({ userId: "UASK" }), mk("UASK") as any);
    const b = await buildContext(input({ userId: "UOTH" }), mk("UOTH") as any);
    expect(JSON.stringify(buildSystemMessages(a.frozenPrefixBlocks))).toBe(JSON.stringify(buildSystemMessages(b.frozenPrefixBlocks)));
  });
});

describe("depth router budget behaviour", () => {
  test("direct depth: one model call, zero tools, no embedding/recall call", async () => {
    let embeds = 0;
    setEmbedder(async (t) => { embeds++; return t.map(fakeVector); });
    const model = new MockLanguageModelV4({ doStream: async () => reply("Hi!") });
    setLoopModel(model as any);
    await runTurn(input({ text: "thanks!" }));
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]!.tools ?? []).toHaveLength(0);
    expect(embeds).toBe(0);
    const [t] = await db.select().from(turns);
    expect(t).toMatchObject({ depth: "direct", status: "done" });
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain("memory-context");
  });
});

describe("daily caps abort turns", () => {
  test("per-user daily cap: model never called, user told, turn recorded as denied", async () => {
    await setLimits({ ...(await getLimits()), perUserDailyTokens: 100 });
    await recordUsage({ userId: "UASK", inputTokens: 90, outputTokens: 20 });
    const model = new MockLanguageModelV4({ doStream: async () => reply("should not run") });
    setLoopModel(model as any);
    await runTurn(input({ text: "what did we decide about pricing last week?" }));
    expect(model.doStreamCalls).toHaveLength(0);
    expect(slack.of("postMessage").at(-1)!.args.text).toContain("daily usage limit");
    const [t] = await db.select().from(turns);
    expect(t).toMatchObject({ depth: "denied", status: "done" });
    // another user is unaffected
    setLoopModel(new MockLanguageModelV4({ doStream: async () => reply("ok") }) as any);
    await runTurn(input({ userId: "UOTH", ts: "11.1", text: "hello" }));
    expect(slack.of("postMessage").at(-1)!.args.text).toBe("ok");
  });

  test("org daily cap blocks everyone", async () => {
    await setLimits({ ...(await getLimits()), perUserDailyTokens: 0, orgDailyTokens: 50 });
    await recordUsage({ userId: "UOWN", inputTokens: 60, outputTokens: 0 });
    const model = new MockLanguageModelV4({ doStream: async () => reply("nope") });
    setLoopModel(model as any);
    await runTurn(input({ text: "hello" }));
    expect(model.doStreamCalls).toHaveLength(0);
    expect(slack.of("postMessage").at(-1)!.args.text).toContain("workspace has reached");
  });

  test("a finished turn adds its tokens to usage_daily", async () => {
    setLoopModel(new MockLanguageModelV4({ doStream: async () => reply("ok") }) as any);
    await runTurn(input({ text: "hello" }));
    const [u] = await db.select().from(usageDaily).where(eq(usageDaily.userId, "UASK"));
    expect(u).toMatchObject({ turns: 1, inputTokens: 10, outputTokens: 5 });
  });
});
