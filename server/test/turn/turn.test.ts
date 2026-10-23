import "./env";
import { beforeEach, describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { turns } from "../../src/db/schema";
import { createConnection } from "../../src/mcp/connections";
import { setModelResolverForTest } from "../../src/llm";
import { setLoopModel } from "../../src/turn/loop";
import { runTurn, type TurnInput } from "../../src/turn";
import { fakeMcp, fakeSlack, seedUsers } from "./helpers";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const reply = (text: string, delayMs = 0): any => ({
  stream: simulateReadableStream({
    initialDelayInMs: delayMs,
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
  setLoopModel(undefined);
  setModelResolverForTest(undefined);
  await resetDb();
  await seedUsers();
  slack = fakeSlack();
  fakeMcp();
});

describe("runTurn", () => {
  test("recovers once when a memory answer stream contains no visible text", async () => {
    const primary = new MockLanguageModelV4({ doStream: async () => reply("") });
    const recovery = new MockLanguageModelV4({ doStream: async () => reply("VHSMO makes a screen-free pocket camera for authentic retro photos, transferred wirelessly to your phone.") });
    setLoopModel(primary as any);
    setModelResolverForTest((role) => role === "triage" ? recovery as any : undefined);

    await runTurn(input({ text: "what our company does" }));

    expect(primary.doStreamCalls).toHaveLength(1);
    expect(recovery.doStreamCalls).toHaveLength(1);
    expect(slack.of("update").at(-1)!.args.text).toContain("VHSMO makes a screen-free pocket camera");
    expect(slack.of("update").at(-1)!.args.text).not.toContain("Try rephrasing");
    const [turn] = await db.select().from(turns);
    expect(turn).toMatchObject({ status: "done", depth: "memory", inputTokens: 20, outputTokens: 10 });
  });

  test("direct depth (greeting): no placeholder, one in-thread post, one model call", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => reply("Hi there") });
    setLoopModel(model as any);
    await runTurn(input({ text: "hello" }));
    expect(slack.of("postMessage")).toHaveLength(1);
    expect(slack.of("postMessage")[0]!.args).toMatchObject({ channel: "C1", thread_ts: "10.1", text: "Hi there" });
    expect(slack.of("update")).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
    expect((model.doStreamCalls[0]!.tools ?? []).length).toBe(0);
    const [t] = await db.select().from(turns);
    expect(t).toMatchObject({ status: "done", depth: "direct" });
  });

  test("posts a placeholder in-thread, replaces it with the answer, records the turn", async () => {
    setLoopModel(new MockLanguageModelV4({ doStream: async () => reply("The answer is 42") }) as any);
    await runTurn(input({ text: "what did we decide about the pricing change last week?" }));
    expect(slack.of("postMessage")[0]!.args).toMatchObject({ channel: "C1", thread_ts: "10.1" });
    expect(slack.of("update").at(-1)!.args.text).toBe("The answer is 42");
    const [t] = await db.select().from(turns);
    expect(t).toMatchObject({ status: "done", trigger: "mention", userId: "UASK", inputTokens: 10, outputTokens: 5 });
    expect(t!.finishedAt).toBeTruthy();
  });

  test("turns in the same thread are serialized; different threads are not blocked", async () => {
    const order: string[] = [];
    setLoopModel(new MockLanguageModelV4({
      doStream: async (o: any) => {
        const last = JSON.stringify(o.prompt.at(-1));
        const tag = last.includes("first") ? "first" : last.includes("second") ? "second" : "other";
        order.push(`start ${tag}`);
        const r = reply(`done ${tag}`, tag === "first" ? 60 : 0);
        return { stream: r.stream.pipeThrough(new TransformStream({ flush() { order.push(`end ${tag}`); } })) };
      },
    }) as any);
    await Promise.all([
      runTurn(input({ ts: "20.1", text: "first" })),
      runTurn(input({ ts: "20.2", threadTs: "20.1", text: "second" })),
      runTurn(input({ ts: "30.1", text: "other" })),
    ]);
    // `second` replies in thread 20.1, which `first` opened: same key, so it must wait
    expect(order.indexOf("end first")).toBeLessThan(order.indexOf("start second"));
    expect(order.indexOf("start other")).toBeLessThan(order.indexOf("end first"));
  });

  test("readOnly + orgConnectionsOnly: the model is never offered write, memory-write or personal tools", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    await createConnection({ provider: "linear", scope: "org", token: "t" });
    const model = new MockLanguageModelV4({ doStream: async () => reply("digest") });
    setLoopModel(model as any);
    await runTurn(input({ trigger: "automation", readOnly: true, orgConnectionsOnly: true, userId: "UASK", text: "daily digest" }));
    const names = (model.doStreamCalls[0]!.tools ?? []).map((t: any) => t.name).sort();
    expect(names).toContain("linear__list_issues");
    expect(names).toContain("memory_search");
    for (const banned of ["github__list_issues", "github__create_issue", "linear__create_issue", "memory_remember", "request_connection", "request_teammate_access"]) {
      expect(names).not.toContain(banned);
    }
    expect(slack.of("postMessage")[0]!.args.text).toBe("digest"); // automation: no placeholder, posted top-level
    expect(slack.of("postMessage")[0]!.args.thread_ts).toBeUndefined();
  });

  test("chime with NO_REPLY stays silent", async () => {
    setLoopModel(new MockLanguageModelV4({ doStream: async () => reply("NO_REPLY") }) as any);
    await runTurn(input({ trigger: "chime" }));
    expect(slack.of("postMessage")).toHaveLength(0);
    expect((await db.select().from(turns))[0]!.status).toBe("done");
  });

  test("model failure marks the turn errored and tells the user", async () => {
    setLoopModel(new MockLanguageModelV4({ doStream: async () => { throw new Error("provider down"); } }) as any);
    await runTurn(input({ text: "what did we decide about the pricing change last week?" }));
    const [t] = await db.select().from(turns).where(eq(turns.channelId, "C1"));
    expect(t!.status).toBe("error");
    expect(t!.error).toContain("provider down");
    expect(slack.of("update").at(-1)!.args.text).toContain("went wrong");
  });

  test("model failure on a direct turn (no placeholder) posts the apology as a new message", async () => {
    setLoopModel(new MockLanguageModelV4({ doStream: async () => { throw new Error("provider down"); } }) as any);
    await runTurn(input({ text: "hello" }));
    const [t] = await db.select().from(turns);
    expect(t!.status).toBe("error");
    expect(slack.of("postMessage").at(-1)!.args.text).toContain("went wrong");
  });
});
