import "./env";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { setModelResolverForTest } from "../../src/llm";
import { TurnBudget } from "../../src/limits/budget";
import { z } from "zod";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { turns } from "../../src/db/schema";
import { setLimits, getLimits } from "../../src/limits";
import { invalidateLimits } from "../../src/limits/settings";
import { setEmbedder } from "../../src/memory/embed";
import { heuristicDepth, routeDepth, setDepthClassifier, allowedFamilies } from "../../src/turn/depth";
import { runLoop, setLoopModel, toolError, wrapTools } from "../../src/turn/loop";
import { createProgressTools } from "../../src/turn/progress";
import { runTurn, type TurnInput } from "../../src/turn";
import { STATIC_SYSTEM, buildSystemMessages } from "../../src/turn/prompt";
import { fakeMcp, fakeSlack, seedUsers } from "./helpers";

const u = (i: number, o: number) => ({ inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: o, text: o, reasoning: 0 } });
const textStream = (text: string, usage = u(10, 5)): any => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ] as any,
  }),
});
const callStream = (name: string, input: unknown, id: string, usage = u(100, 20)): any => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
      { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
    ] as any,
  }),
});
const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  trigger: "mention", channelId: "C1", ts: "10.1", userId: "UASK", text: "what did we decide about pricing?", isPrivate: false, isIm: false, ...over,
});

describe("depth router table", () => {
  const rows: [string, Parameters<typeof heuristicDepth>[0], string | null][] = [
    ["greeting", { trigger: "mention", text: "hey!" }, "direct"],
    ["thanks", { trigger: "dm", text: "thanks so much" }, "direct"],
    ["emoji", { trigger: "dm", text: "👍" }, "direct"],
    ["memory question", { trigger: "mention", text: "who owns billing?" }, "memory"],
    ["url", { trigger: "mention", text: "summarise https://example.com/a" }, "tools"],
    ["live state", { trigger: "mention", text: "show me open issues on github" }, "tools"],
    ["research verb", { trigger: "mention", text: "research our competitors' pricing" }, "deep"],
    ["three questions", { trigger: "mention", text: "why? when? who?" }, "deep"],
    ["continue in thread", { trigger: "mention", text: "continue", hasHistory: true }, "deep"],
    ["research trigger", { trigger: "research", text: "x" }, "deep"],
    ["automation", { trigger: "automation", text: "daily digest" }, "tools"],
    ["chime", { trigger: "chime", text: "anyone know why deploys are slow?" }, "memory"],
    ["ambiguous", { trigger: "mention", text: "do the other one then" }, null],
  ];
  for (const [name, i, want] of rows) test(name, () => expect(heuristicDepth(i)).toBe(want as any));

  test("model only asked when ambiguous; failure falls back to memory", async () => {
    let calls = 0;
    setDepthClassifier(async () => { calls++; return "tools."; });
    expect(await routeDepth({ trigger: "mention", text: "hi" })).toEqual({ depth: "direct", by: "heuristic" });
    expect(calls).toBe(0);
    expect(await routeDepth({ trigger: "mention", text: "do the other one then" })).toEqual({ depth: "tools", by: "model" });
    setDepthClassifier(async () => { throw new Error("down"); });
    expect(await routeDepth({ trigger: "mention", text: "do the other one then" })).toEqual({ depth: "memory", by: "fallback" });
    setDepthClassifier();
  });

  test("unattended triggers never get write families", () => {
    expect(allowedFamilies("chime", false)).toEqual([]);
    expect(allowedFamilies("automation", false)).not.toContain("automations");
    expect(allowedFamilies("mention", true)).not.toContain("automations");
  });
});

describe("prompt", () => {
  test("static prompt has no volatile data and the system messages are identical across calls", () => {
    expect(STATIC_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(buildSystemMessages(["a"]))).toBe(JSON.stringify(buildSystemMessages(["a"])));
    expect(STATIC_SYSTEM.length / 4).toBeLessThan(1590); // compact: token budget (1590 after the status-question rule and the assign/update/notify task guidance; was 1545 / 1550 separately, 1520 before assign_task guidance, 1500 before the grounded-awareness rule)
  });
});

describe("loop", () => {
  const baseArgs = { system: "s", messages: [{ role: "user" as const, content: "go" }], turnId: "t1", depth: "tools" as const, maxOutputTokens: 500 };
  afterAll(() => { setLoopModel(); setModelResolverForTest(undefined); });

  test("aggregates usage over all steps and counts steps/tool calls", async () => {
    await resetDb();
    let n = 0;
    setLoopModel(new MockLanguageModelV4({ doStream: async () => (n++ === 0 ? callStream("ping", {}, "c1", u(100, 20)) : textStream("done", u(150, 30))) }) as any);
    const tools = { ping: tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" }) };
    const r = await runLoop({ ...baseArgs, tools, maxSteps: 10 });
    expect(r).toMatchObject({ text: "done", inputTokens: 250, outputTokens: 50, steps: 2 });
    expect(r.toolCalls).toHaveLength(1);
  });

  test("retries one textless memory response with the triage model and combines usage", async () => {
    const primary = new MockLanguageModelV4({ doStream: async () => textStream("") });
    const recovery = new MockLanguageModelV4({ doStream: async () => textStream("VHSMO makes a screen-free pocket camera.") });
    setLoopModel(primary as any);
    setModelResolverForTest((role) => role === "triage" ? recovery as any : undefined);

    const r = await runLoop({ ...baseArgs, depth: "memory", tools: {}, role: "main", maxSteps: 3, budget: new TurnBudget(0) });

    expect(r.text).toBe("VHSMO makes a screen-free pocket camera.");
    expect(r).toMatchObject({ inputTokens: 20, outputTokens: 10, steps: 2 });
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(recovery.doStreamCalls).toHaveLength(1);
    expect(recovery.doStreamCalls[0]!.tools ?? []).toHaveLength(0);
  });

  test("step cap forces a tool-free wrap-up that tells the user", async () => {
    await resetDb();
    const model = new MockLanguageModelV4({
      doStream: async (o: any) => {
        const last = JSON.stringify(o.prompt.at(-1));
        return last.includes("out of room") ? textStream("Here is what I have so far.") : callStream("ping", { n: Math.random() }, `c${Math.random()}`);
      },
    });
    setLoopModel(model as any);
    const tools = { ping: tool({ description: "p", inputSchema: z.object({ n: z.number() }), execute: async () => "pong" }) };
    const r = await runLoop({ ...baseArgs, tools, maxSteps: 3 });
    expect(r.text).toBe("Here is what I have so far.");
    expect(r.stopped).toBe("step_cap");
    expect(r.steps).toBe(3);
    expect(model.doStreamCalls.at(-1)!.toolChoice).toMatchObject({ type: "none" });
  });

  test("per-turn token ceiling stops the loop", async () => {
    await resetDb();
    invalidateLimits();
    await setLimits({ ...(await getLimits()), perTurnTokenCeiling: 150 });
    setLoopModel(new MockLanguageModelV4({ doStream: async () => callStream("ping", { n: Math.random() }, `c${Math.random()}`, u(200, 10)) }) as any);
    const tools = { ping: tool({ description: "p", inputSchema: z.object({ n: z.number() }), execute: async () => "pong" }) };
    const r = await runLoop({ ...baseArgs, tools, maxSteps: 20 });
    expect(r.stopped).toBe("ceiling");
    expect(r.steps).toBeLessThanOrEqual(2);
    invalidateLimits();
  });

  test("tool exceptions become structured errors; identical failing calls are refused", async () => {
    await resetDb();
    const tools = wrapTools({ boom: tool({ description: "b", inputSchema: z.object({}), execute: async (): Promise<string> => { throw new Error("401 unauthorized token"); } }) }, "t1");
    const exec = (tools.boom as any).execute;
    const first = await exec({}, {});
    expect(first).toMatchObject({ status: "error", kind: "auth_required", retryable: false, tool: "boom" });
    expect(await exec({}, {})).toMatchObject({ kind: "duplicate_call" });
    expect(toolError("x", new Error("timed out"))).toMatchObject({ kind: "timeout", retryable: true });
  });
});

describe("post_update", () => {
  test("posts real content, drops duplicates and anything past the cap", async () => {
    const sent: string[] = [];
    const t: any = createProgressTools(async (x) => { sent.push(x); return true; }).post_update;
    expect(await t.execute({ message: "Checking the tracker now" }, {})).toEqual({ posted: true });
    expect((await t.execute({ message: "checking the  tracker now" }, {})).posted).toBe(false);
    for (let i = 0; i < 6; i++) await t.execute({ message: `finding ${i}` }, {});
    expect(sent.length).toBe(4);
    expect(createProgressTools(undefined)).toEqual({});
  });
});

describe("runTurn replies", () => {
  let slack: ReturnType<typeof fakeSlack>;
  beforeEach(async () => { await resetDb(); invalidateLimits(); await seedUsers(); slack = fakeSlack(); fakeMcp(); });
  afterAll(() => { setLoopModel(); setEmbedder(null); });

  test("broadcast mentions are neutralised and long replies are chunked (no raw truncation)", async () => {
    const long = `<!channel> **big** news. ${"word ".repeat(2500)}END`;
    setLoopModel(new MockLanguageModelV4({ doStream: async () => textStream(long) }) as any);
    await runTurn(input());
    const posted = [...slack.of("update"), ...slack.of("postMessage")].map((c) => c.args.text as string);
    const all = posted.join(" ");
    expect(all).not.toContain("<!channel>");
    expect(all).toContain("END");
    expect(posted.every((p) => p.length <= 3000 || p === "_Thinking..._")).toBe(true);
    expect(slack.of("postMessage").length).toBeGreaterThan(1);
  });

  test("records model, steps, depth, cache fields, cost and a prompt breakdown", async () => {
    setLoopModel(new MockLanguageModelV4({ doStream: async () => textStream("ok", u(40, 8)) }) as any);
    await runTurn(input());
    const [t] = await db.select().from(turns);
    expect(t).toMatchObject({ status: "done", depth: "memory", steps: 1, inputTokens: 40, outputTokens: 8 });
    expect(t!.model).toBeTruthy();
    expect((t!.promptBreakdown as any).system).toBeGreaterThan(0);
  });

  test("step-capped reply tells the user how to continue", async () => {
    await setLimits({ ...(await getLimits()), maxStepsByDepth: { direct: 1, memory: 2, tools: 2, deep: 2 } });
    invalidateLimits();
    setLoopModel(new MockLanguageModelV4({
      doStream: async (o: any) => (JSON.stringify(o.prompt.at(-1)).includes("out of room") ? textStream("Partial answer.") : callStream("people_search", { query: "x" }, `c${Math.random()}`)),
    }) as any);
    await runTurn(input({ text: "show me open issues on github" }));
    const last = slack.of("update").at(-1)!.args.text as string;
    expect(last).toContain("Partial answer.");
    expect(last).toContain("continue");
    invalidateLimits();
  });
});
