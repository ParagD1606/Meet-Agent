import "./env";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { resetDb } from "../db";
import { invalidateLimits } from "../../src/limits/settings";
import { DEFAULT_LIMITS } from "../../src/limits/settings";
import { setEmbedder } from "../../src/memory/embed";
import { DEPTH_CONFIG, heuristicDepth, routeDepth, setDepthClassifier } from "../../src/turn/depth";
import { leaksToolCall, runLoop, setLoopModel, wrapTools } from "../../src/turn/loop";
import { askTeammateAliases } from "../../src/turn/ask-teammate";
import { runTurn, type TurnInput } from "../../src/turn";
import { isActionAck } from "../../src/slack/resolve";
import { fakeMcp, fakeSlack, seedUsers } from "./helpers";

const u = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const textStream = (text: string): any => ({
  stream: simulateReadableStream({ chunks: [
    { type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: u },
  ] as any }),
});
const callStream = (name: string, input: unknown, id: string): any => ({
  stream: simulateReadableStream({ chunks: [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: u },
  ] as any }),
});
const lastPrompt = (o: any) => JSON.stringify(o.prompt.at(-1));
const base = { system: "s", messages: [{ role: "user" as const, content: "go" }], turnId: "t1", depth: "tools" as const, maxOutputTokens: 500, maxSteps: 6 };
const input = (over: Partial<TurnInput> = {}): TurnInput => ({ trigger: "mention", channelId: "C1", ts: "10.1", userId: "UASK", text: "what did we decide about pricing?", isPrivate: false, isIm: false, ...over });

setDepthClassifier(async () => "memory");
afterAll(() => { setLoopModel(); setEmbedder(null); setDepthClassifier(); });

describe("bug 1: raw pseudo tool-call text", () => {
  test("detector", () => {
    for (const t of ['call:enable_tool_family family="slack_search" /', 'Sure\ncall:ask_teammate recipient="@x" /', "<tool_call>{}</tool_call>", "```tool_code\nfoo()\n```"]) expect(leaksToolCall(t)).toBe(true);
    for (const t of ["Please call me", "I'll call: the vendor tomorrow", "Done."]) expect(leaksToolCall(t)).toBe(false);
  });

  test("one repair step with a nudge; the raw text is never returned", async () => {
    const model = new MockLanguageModelV4({
      doStream: async (o: any) => (lastPrompt(o).includes("raw tool call") ? textStream("Here is the real answer.") : textStream('call:enable_tool_family family="slack_search" /')),
    });
    setLoopModel(model as any);
    const tools = { ping: tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" }) };
    const r = await runLoop({ ...base, tools });
    expect(r.text).toBe("Here is the real answer.");
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("ping"); // nudge lists the tools
  });

  test("still leaking after the repair -> plain-language fallback, never the raw text", async () => {
    setLoopModel(new MockLanguageModelV4({ doStream: async () => textStream('call:ask_teammate recipient="@Derpx06" message="All the tasks are done now." /') }) as any);
    const r = await runLoop({ ...base, tools: {} });
    expect(r.text).not.toContain("call:");
    expect(r.text).toContain("couldn't complete");
  });

  test("a repaired model can really call the tool", async () => {
    let n = 0;
    setLoopModel(new MockLanguageModelV4({
      doStream: async (o: any) => {
        n++;
        if (n === 1) return textStream('call:ping /');
        return lastPrompt(o).includes("pong") ? textStream("pong received") : callStream("ping", {}, "c1");
      },
    }) as any);
    const tools = { ping: tool({ description: "p", inputSchema: z.object({}), execute: async () => "pong" }) };
    const r = await runLoop({ ...base, tools });
    expect(r.text).toBe("pong received");
    expect(r.toolCalls.map((t) => t.name)).toEqual(["ping"]);
  });

  test("alias schema: ask_teammate accepts recipient/message", async () => {
    const schema = askTeammateAliases(z.object({ question: z.string().min(8), person: z.string().optional() }));
    const ok = (schema as any).safeParse({ recipient: "@Derpx06", message: "All the tasks are done now." });
    expect(ok.success).toBe(true);
    expect(ok.data).toMatchObject({ person: "@Derpx06", question: "All the tasks are done now." });
    expect((schema as any).safeParse({ to: "U1", text: "Is the launch done yet?" }).data).toMatchObject({ person: "U1", question: "Is the launch done yet?" });
  });
});

describe("bug 2: working-room message on simple questions", () => {
  test("memory depth gets 5 steps by default", () => {
    expect(DEPTH_CONFIG.memory.maxSteps).toBe(5);
    expect(DEFAULT_LIMITS.maxStepsByDepth.memory).toBe(5);
  });

  test("identical tool calls in one turn return the cached result with a hint", async () => {
    let runs = 0;
    const t = wrapTools({ look: tool({ description: "l", inputSchema: z.object({ q: z.string() }), execute: async () => { runs++; return "found X"; } }) }, "t1");
    const exec = (t.look as any).execute;
    expect(await exec({ q: "a" }, {})).toBe("found X");
    const again = await exec({ q: "a" }, {});
    expect(runs).toBe(1);
    expect(again).toContain("found X");
    expect(again).toContain("answer now");
  });

  test("a model that keeps searching still answers (no 'working room' text) at memory depth", async () => {
    await resetDb();
    await seedUsers();
    invalidateLimits();
    fakeSlack();
    fakeMcp();
    const slack = fakeSlack();
    const model = new MockLanguageModelV4({
      doStream: async (o: any) => (lastPrompt(o).includes("out of room") ? textStream("Based on what I found: pricing is unchanged.") : callStream("memory_search", { query: "pricing" }, `c${Math.random()}`)),
    });
    setLoopModel(model as any);
    await runTurn(input());
    const last = slack.of("update").at(-1)!.args.text as string;
    expect(last).toContain("pricing is unchanged");
    expect(last).not.toContain("working room");
    expect(model.doStreamCalls.at(-1)!.toolChoice).toMatchObject({ type: "none" });
  });
});

describe("bug 4: resolve buttons", () => {
  const sl = () => { fakeSlack(); };
  beforeEach(async () => { await resetDb(); await seedUsers(); invalidateLimits(); sl(); fakeMcp(); });

  test("no buttons on an action turn (ask_teammate called), buttons on a factual answer", async () => {
    let slack = fakeSlack();
    setLoopModel(new MockLanguageModelV4({
      doStream: async (o: any) => (JSON.stringify(o.prompt).includes("tool-result") ? textStream("I asked Owner.") : callStream("ask_teammate", { question: "Is the launch done yet?", person: "UOWN" }, "c1")),
    }) as any);
    await runTurn(input({ text: "ask Owner if the launch is done", channelId: "C1" }));
    expect(JSON.stringify(slack.calls)).not.toContain("brain_resolve_yes");

    slack = fakeSlack();
    setLoopModel(new MockLanguageModelV4({ doStream: async () => textStream("We decided pricing stays at 10 dollars.") }) as any);
    await runTurn(input({ ts: "11.1", text: "what did we decide about pricing?" }));
    expect(JSON.stringify(slack.calls)).toContain("brain_resolve_yes");
  });

  test("an action statement that is not a question gets no buttons", async () => {
    const slack = fakeSlack();
    setLoopModel(new MockLanguageModelV4({ doStream: async () => textStream("Got it, noted.") }) as any);
    await runTurn(input({ ts: "12.1", text: "the launch is delayed to friday" }));
    expect(JSON.stringify(slack.calls)).not.toContain("brain_resolve_yes");
  });

  test("acknowledgement detector", () => {
    for (const t of ["Got it, I'll let him know.", "I asked Parag. I'll bring the answer back.", "Done, task assigned to Priya.", "Waiting for your OK."]) expect(isActionAck(t)).toBe(true);
    expect(isActionAck("The billing database lives in eu-west-1.")).toBe(false);
  });
});

const rank = { direct: 0, memory: 1, tools: 2, deep: 3 } as const;

describe("A: action messages are never routed to direct", () => {
  const phrases = ["ok tell him i am not interested", "ok tell him that all the tasks are done now", "say hello to @Derpx06", "say hello to <@U123ABC>", "let Priya know the deploy is done", "ping him", "inform Dana", "remind me tomorrow", "follow up with Sam", "assign this to Priya", "forward that to Dana", "create a task for the launch", "mark it done", "schedule a sync"];
  for (const t of phrases) test(`dm: "${t}" -> at least tools`, async () => {
    expect(rank[heuristicDepth({ trigger: "dm", text: t }) ?? (await routeDepth({ trigger: "dm", text: t })).depth]).toBeGreaterThanOrEqual(rank.tools);
  });

  test("short replies after a tool-using turn inherit tools; continue resumes the previous depth", () => {
    const prev = { depth: "tools" as const, usedTools: true, openAsk: false };
    for (const t of ["ok", "yes", "do it", "continue", "ok tell him"]) expect(rank[heuristicDepth({ trigger: "dm", text: t, prev })!]).toBeGreaterThanOrEqual(rank.tools);
    expect(heuristicDepth({ trigger: "dm", text: "continue", prev: { depth: "deep", usedTools: true, openAsk: false } })).toBe("deep");
    expect(rank[heuristicDepth({ trigger: "dm", text: "yes", prev: { depth: "memory", usedTools: false, openAsk: true } })!]).toBeGreaterThanOrEqual(rank.tools);
  });

  test("pure greetings and thanks stay direct; the triage model cannot send a non-greeting to direct", async () => {
    for (const t of ["hey", "thanks!", "thank you so much"]) expect(heuristicDepth({ trigger: "dm", text: t })).toBe("direct");
    setDepthClassifier(async () => "direct");
    expect((await routeDepth({ trigger: "dm", text: "the vibes are interesting today" })).depth).not.toBe("direct");
    setDepthClassifier(async () => "memory");
  });
});

describe("B: claims of an action need a successful action tool", () => {
  const claim = "I've told him you're not interested.";
  test("claim with no tool -> one repair step; model then really calls the tool", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async (o: any) => {
        n++;
        if (n === 1) return textStream(claim);
        return JSON.stringify(o.prompt).includes("tool-result") ? textStream("Asked him.") : callStream("ask_teammate", { question: "Not interested, thanks." }, "c1");
      },
    });
    setLoopModel(model as any);
    const tools = { ask_teammate: tool({ description: "a", inputSchema: z.object({ question: z.string() }), execute: async () => "Posted a consent card" }) };
    const r = await runLoop({ ...base, tools });
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("claimed an action");
    expect(r.text).toBe("Asked him.");
  });

  test("claim persists -> honest line, never the claim", async () => {
    setLoopModel(new MockLanguageModelV4({ doStream: async () => textStream(claim) }) as any);
    const r = await runLoop({ ...base, tools: {} });
    expect(r.text).not.toContain("told him");
    expect(r.text).toContain("didn't actually");
  });

  test("a successful action tool makes the claim legitimate; a failed one does not", async () => {
    let n = 0;
    setLoopModel(new MockLanguageModelV4({ doStream: async () => (n++ % 2 === 0 ? callStream("notify_teammate", { x: 1 }, `c${n}`) : textStream("I've messaged Dana.")) }) as any);
    const ok = { notify_teammate: tool({ description: "n", inputSchema: z.object({ x: z.number() }), execute: async () => "sent" }) };
    expect((await runLoop({ ...base, tools: ok })).text).toBe("I've messaged Dana.");
    const bad = { notify_teammate: tool({ description: "n", inputSchema: z.object({ x: z.number() }), execute: async (): Promise<string> => { throw new Error("boom"); } }) };
    n = 0;
    expect((await runLoop({ ...base, tools: bad })).text).toContain("didn't actually");
  });
});

describe("C: search thrash", () => {
  const mk = (name: string, out = "found something") => tool({ description: name, inputSchema: z.object({ q: z.string() }), execute: async () => out });
  test("the 4th call of the same read tool is refused", async () => {
    const t: any = wrapTools({ read_thread: mk("r") }, "t1");
    for (let i = 0; i < 3; i++) expect(await t.read_thread.execute({ q: `a${i}` }, {})).toBe("found something");
    expect(await t.read_thread.execute({ q: "a4" }, {})).toMatch(/enough searching/i);
  });

  test("a clear find_tasks answer skips live Slack search", async () => {
    const t: any = wrapTools({ find_tasks: mk("f", "- [open] Ship it | owner: <@U1>"), search_slack_live: mk("s") }, "t1");
    await t.find_tasks.execute({ q: "ship" }, {});
    expect(await t.search_slack_live.execute({ q: "ship" }, {})).toContain("already answered");
  });

  test("an empty find_tasks does not block Slack search", async () => {
    const t: any = wrapTools({ find_tasks: mk("f", "No matching task found"), search_slack_live: mk("s") }, "t1");
    await t.find_tasks.execute({ q: "x" }, {});
    expect(await t.search_slack_live.execute({ q: "x" }, {})).toBe("found something");
  });
});
