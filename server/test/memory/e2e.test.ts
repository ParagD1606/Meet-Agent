// END-TO-END memory scenario through the real pipeline: Slack event -> handleEventCallback -> runTurn -> buildContext/recall ->
// model -> reply -> scheduleCapture/captureTurn/addFact -> episodes -> consolidate -> admin HTTP API.
// Only the LLM (answer model via setLoopModel, memory LLM via setMemoryLlm) and the embedder are faked, deterministically;
// Slack is the recording fake from test/slack/helpers.ts. Postgres is real.
//   DATABASE_URL=<throwaway db> bun test test/memory/e2e.test.ts
import "../turn/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { and, eq, sql } from "drizzle-orm";
import { config } from "../../src/config";
import { channelMembers, episodes, memories, memoryEdges, memoryReviews } from "../../src/db/schema";
import { setEmbedder } from "../../src/memory/embed";
import { consolidate } from "../../src/memory/consolidate";
import { setMemoryLlm } from "../../src/memory/llm";
import { clearRecallCache } from "../../src/memory/recall";
import { EXTRACT_SYSTEM, flushIdleCaptures } from "../../src/memory/writeback";
import { deps } from "../../src/slack/deps";
import { handleEventCallback } from "../../src/slack/events";
import { flushReactions, resetAckBreaker, setReactionGap } from "../../src/slack/reactions";
import { heuristicDepth } from "../../src/turn/depth";
import { setLoopModel } from "../../src/turn/loop";
import { app, call, db, login } from "../api/helpers";
import { addChannel, BOT, evt, nextTs, setup, TEAM } from "../slack/helpers";
import { fakeVector, seedMemory } from "./helpers";

config.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
const json = (r: Response) => r.json() as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, f: () => Promise<boolean>, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await f()) return; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- deterministic LLM doubles ---------------------------------------------------------------------------
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const streamOf = (text: string): any => ({ stream: simulateReadableStream({ chunks: [
  { type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
] as any }) });
/** Answers from recalled memory only: echoes the first recalled bullet, else says it has nothing. */
const model = new MockLanguageModelV4({
  doStream: async (o: any) => {
    const last = JSON.stringify(o.prompt.at(-1));
    const m = /<memory-context>[\s\S]*?\\n- ([^\\]+?) \(slack/.exec(last);
    return streamOf(m ? `From memory: ${m[1]}` : "I do not have that on record.");
  },
});
const promptOf = (i: number) => JSON.stringify(model.doStreamCalls[i]!.prompt);

const userOnly = (prompt: string) => prompt.replace(/Assistant: [^\n]*/g, ""); // facts come from what people said, not from what the bot echoed
const llmLog: string[] = [];
const memoryLlm = async (a: { system: string; prompt: string }) => {
  if (a.system === EXTRACT_SYSTEM) {
    const p = userOnly(a.prompt);
    const facts: string[] = [];
    if (/billing owner is Priya/i.test(p)) facts.push("The billing owner is Priya Sharma");
    if (/renewal deadline is 2026-11-15/i.test(p)) facts.push("The Acme renewal deadline is 2026-11-15");
    if (/billing owner is now Dana/i.test(p)) facts.push("The billing owner is Dana Lee");
    if (/Falcon acquisition budget is two million/i.test(p)) facts.push("The Falcon acquisition budget is two million dollars");
    llmLog.push(`extract:${facts.length}`);
    return JSON.stringify({ facts });
  }
  if (a.system.startsWith("You maintain a company knowledge base")) { // contradiction check
    const existing = /EXISTING:\n([\s\S]*)$/.exec(a.prompt)?.[1] ?? "";
    const neu = /NEW: (.*)/.exec(a.prompt)?.[1] ?? "";
    const old = /\[(\d+)\] The billing owner is Priya/.exec(existing);
    llmLog.push("contradiction");
    return JSON.stringify({ superseded: old && /Dana/.test(neu) ? [Number(old[1])] : [] });
  }
  if (a.system.startsWith("Summarise this Slack thread")) return "The team discussed the topic in this thread, named owners and deadlines, and agreed on next steps for the quarter.";
  if (a.system.startsWith("You compress old")) return '{"facts":["Historic vendor evaluations from 2024 covered Acme, Bolt and Cirrus before the current contracts were signed."]}';
  return '{"superseded":[]}';
};

// ---- Slack driver ----------------------------------------------------------------------------------------
type Fake = Awaited<ReturnType<typeof setup>>["fake"];
let fake: Fake;
const say = async (o: { channel: string; user: string; text: string; thread?: string; type?: "channel" | "group" | "im" }) => {
  const ts = nextTs();
  await handleEventCallback(evt({ type: "message", user: o.user, text: o.type === "im" ? o.text : `<@${BOT}> ${o.text}`, ts, channel: o.channel, channel_type: o.type ?? "channel", ...(o.thread ? { thread_ts: o.thread } : {}) }));
  return ts;
};
/** Three turns in one thread (the 3rd flushes the debounced capture + records the episode). Returns the thread root ts. */
async function thread(channel: string, user: string, texts: [string, string, string], type: "channel" | "group" = "channel") {
  const root = await say({ channel, user, text: texts[0], type });
  await say({ channel, user, text: texts[1], thread: root, type });
  await say({ channel, user, text: texts[2], thread: root, type });
  return root;
}
const repliesText = () => fake.calls.filter((c) => ["chat.postMessage", "chat.update"].includes(c.method)).map((c) => String(c.args.text ?? "")).join("\n");
const shared = () => db.select().from(memories).where(eq(memories.scopeTag, "shared")).orderBy(memories.id);

let admin: string;
let danaId = 0, priyaId = 0;

beforeAll(async () => {
  const s = await setup();
  fake = s.fake;
  deps.runTurn = async (i) => (await import("../../src/turn")).runTurn(i); // the REAL turn pipeline (setup() stubs it)
  setReactionGap(0); resetAckBreaker();
  setEmbedder(async (t) => t.map(fakeVector));
  setMemoryLlm(memoryLlm);
  setLoopModel(model as any);
  clearRecallCache();
  await addChannel("CPUB", { name: "general" });
  await addChannel("CPRIV", { name: "exec", isPrivate: true });
  await db.insert(channelMembers).values({ channelId: "CPRIV", userId: "U1" });
  admin = await login("UA", "admin");
});
afterAll(async () => {
  setMemoryLlm(async () => '{"facts":[],"superseded":[]}');
  await flushIdleCaptures(0); // drop buffered DM turn so other test files see no pending captures
  setMemoryLlm(null); setEmbedder(null); setLoopModel(undefined);
});

describe("e2e: Slack turn -> capture -> recall -> supersede -> isolation -> consolidate -> admin API", () => {
  test("0. the scripted turns take the memory-depth path (recall on, no live tools)", () => {
    for (const t of [
      "Heads up: the billing owner is Priya Sharma and the Acme renewal deadline is 2026-11-15.", "Who owns the Acme renewal and when is it due?",
      "Just to confirm, the renewal deadline is 2026-11-15 and Priya owns billing, correct?", "Who is the billing owner right now?",
      "Correction: the billing owner is now Dana Lee, effective today.", "Who owns billing at this point?", "So just to be sure, the billing owner changed to Dana Lee and the earlier owner no longer handles billing questions, right?",
      "Who is the billing owner these days?", "Confidential: the Falcon acquisition budget is two million dollars and the owner is Dana.",
      "Who owns the Falcon acquisition budget?", "Confirming the Falcon acquisition budget is two million dollars and that only the exec group may discuss it outside this room, right?", "What is the Falcon acquisition budget and who owns it?",
    ]) expect(heuristicDepth({ trigger: "mention", text: t, hasHistory: false })).toBe("memory");
  });

  test("1. a public-channel thread (3 turns) captures durable facts into 'shared' and records an episode", async () => {
    await thread("CPUB", "U1", [
      "Heads up: the billing owner is Priya Sharma and the Acme renewal deadline is 2026-11-15.",
      "Who owns the Acme renewal and when is it due?",
      "Just to confirm, the renewal deadline is 2026-11-15 and Priya owns billing, correct?",
    ]);
    await waitFor("facts + episode", async () => (await shared()).length >= 2 && (await db.select().from(episodes)).length >= 1);
    const rows = await shared();
    expect(rows.map((r) => r.text)).toEqual(["The billing owner is Priya Sharma", "The Acme renewal deadline is 2026-11-15"]);
    expect(rows.every((r) => r.status === "active" && r.invalidAt === null && r.reviewState === "ok" && r.source === "slack" && r.createdBy === "U1")).toBe(true);
    priyaId = rows[0]!.id;
    expect((await db.select().from(episodes))[0]).toMatchObject({ scopeTag: "shared", channelId: "CPUB" });
    // turn 1 ran before anything was known: no memory block in its prompt
    expect(promptOf(0)).not.toContain("<memory-context>");
  });

  test("2. a later question in a DIFFERENT thread by a DIFFERENT user recalls them (fenced block, bumped counters, answer posted)", async () => {
    const before = model.doStreamCalls.length;
    await say({ channel: "CPUB", user: "U2", text: "Who is the billing owner right now?" });
    const p = promptOf(before);
    expect(p).toContain("<memory-context>");
    expect(p).toContain("The billing owner is Priya Sharma");
    expect(p).toContain("</memory-context>");
    await flushReactions();
    expect(repliesText()).toContain("From memory: The billing owner is Priya Sharma");
    const [m] = await db.select().from(memories).where(eq(memories.id, priyaId));
    expect(m!.accessCount).toBeGreaterThanOrEqual(1);
    expect(m!.lastAccessedAt).not.toBeNull();
  });

  test("3. a contradicting statement supersedes the old fact; history is kept and an admin review is queued", async () => {
    await thread("CPUB", "U2", [
      "Correction: the billing owner is now Dana Lee, effective today.",
      "Who owns billing at this point?",
      "So just to be sure, the billing owner changed to Dana Lee and the earlier owner no longer handles billing questions, right?",
    ]);
    await waitFor("supersede + 2nd episode", async () => (await db.select().from(memories).where(eq(memories.id, priyaId)))[0]!.status === "superseded" && (await db.select().from(episodes)).length >= 2);
    const all = await shared();
    const dana = all.find((r) => r.text === "The billing owner is Dana Lee")!;
    danaId = dana.id;
    const priya = all.find((r) => r.id === priyaId)!;
    expect(priya).toMatchObject({ status: "superseded", supersededBy: danaId });
    expect(priya.invalidAt).not.toBeNull();
    expect(dana).toMatchObject({ status: "active", invalidAt: null, reviewState: "ok" });
    expect(all.find((r) => r.text.includes("renewal deadline"))!.status).toBe("active"); // untouched
    const rv = await db.select().from(memoryReviews);
    expect(rv).toHaveLength(1);
    expect(rv[0]).toMatchObject({ kind: "supersede", status: "pending", memoryId: danaId });
    expect((rv[0]!.payload as any).supersededIds).toEqual([priyaId]);
    expect((await db.select().from(memoryEdges).where(and(eq(memoryEdges.fromId, danaId), eq(memoryEdges.toId, priyaId)))).length).toBe(1);
  });

  test("4. a new asker now gets the NEW owner only", async () => {
    const before = model.doStreamCalls.length;
    await say({ channel: "CPUB", user: "U2", text: "Who is the billing owner these days?" });
    const p = promptOf(before);
    expect(p).toContain("The billing owner is Dana Lee");
    expect(p).not.toContain("Priya Sharma");
  });

  test("5. a private-channel fact never reaches a public asker, but does reach the member's DM", async () => {
    await thread("CPRIV", "U1", [
      "Confidential: the Falcon acquisition budget is two million dollars and the owner is Dana.",
      "Who owns the Falcon acquisition budget?",
      "Confirming the Falcon acquisition budget is two million dollars and that only the exec group may discuss it outside this room, right?",
    ], "group");
    await waitFor("private fact + episode", async () => (await db.select().from(memories).where(eq(memories.scopeTag, "channel_CPRIV"))).length >= 1 && (await db.select().from(episodes).where(eq(episodes.scopeTag, "channel_CPRIV"))).length >= 1);
    const priv = await db.select().from(memories).where(eq(memories.scopeTag, "channel_CPRIV"));
    expect(priv.map((r) => r.text)).toEqual(["The Falcon acquisition budget is two million dollars"]);
    expect((await shared()).some((r) => /Falcon/.test(r.text))).toBe(false);
    expect((await db.select().from(episodes)).some((e) => e.scopeTag === "channel_CPRIV")).toBe(true);

    clearRecallCache();
    const n0 = model.doStreamCalls.length;
    await say({ channel: "CPUB", user: "U2", text: "What is the Falcon acquisition budget and who owns it?" });
    expect(promptOf(n0)).not.toContain("Falcon acquisition budget is two million");
    expect(promptOf(n0)).not.toContain("<memory-context>");
    await flushReactions();
    expect(fake.calls.filter((c) => c.args?.channel === "CPUB").map((c) => String(c.args.text ?? "")).join("\n")).not.toContain("two million");

    const n1 = model.doStreamCalls.length;
    await say({ channel: "D1", user: "U1", type: "im", text: "What is the Falcon acquisition budget?" });
    expect(promptOf(n1)).toContain("The Falcon acquisition budget is two million dollars");
    // a DM asker who is NOT a member of the private channel gets nothing
    const n2 = model.doStreamCalls.length;
    await say({ channel: "D2", user: "U2", type: "im", text: "What is the Falcon acquisition budget?" });
    expect(promptOf(n2)).not.toContain("Falcon acquisition budget is two million");
  });

  test("6. nightly consolidate: merges/summarises stale facts, leaves live ones, second run is a no-op", async () => {
    for (let i = 0; i < 9; i++) await seedMemory("shared", `Vendor${i} evaluation note number${i} zork${i}`, { validAt: new Date(Date.now() - 400 * 86_400_000), importance: 0.2 });
    await seedMemory("shared", "The Acme renewal deadline is 2026-11-15"); // exact duplicate of a live fact
    const r1 = await consolidate();
    expect(r1.merged).toBe(1);
    expect(r1.summarised).toBe(9);
    const live = (await shared()).filter((r) => r.status === "active");
    expect(live.map((r) => r.text)).toEqual(expect.arrayContaining(["The billing owner is Dana Lee", "The Acme renewal deadline is 2026-11-15"]));
    expect(live.filter((r) => r.text === "The Acme renewal deadline is 2026-11-15")).toHaveLength(1);
    expect(live.some((r) => r.createdBy === "consolidation")).toBe(true);
    expect(live.some((r) => r.text.startsWith("Vendor"))).toBe(false);
    expect(await consolidate()).toMatchObject({ merged: 0, decayed: 0, summarised: 0, purged: 0 });
  });

  test("7. admin/API view shows the right active / superseded rows, history, review, export; private data is invisible", async () => {
    const active = await json(await call("GET", "/api/memories?status=active&limit=200", { cookie: admin }));
    const texts: string[] = active.items.map((i: any) => i.text);
    expect(texts).toContain("The billing owner is Dana Lee");
    expect(texts).toContain("The Acme renewal deadline is 2026-11-15");
    expect(texts).not.toContain("The billing owner is Priya Sharma");
    expect(texts.some((t) => /Falcon/.test(t))).toBe(false);
    expect(active.items.every((i: any) => i.status === "active" && i.scopeTag === "shared")).toBe(true);

    const sup = await json(await call("GET", "/api/memories?status=superseded&limit=200", { cookie: admin }));
    const priya = sup.items.find((i: any) => i.text === "The billing owner is Priya Sharma");
    expect(priya).toMatchObject({ status: "superseded", supersededBy: danaId });
    expect(priya.invalidAt).toBeTruthy();
    const all = await json(await call("GET", "/api/memories?status=all&limit=200", { cookie: admin }));
    expect(all.items.filter((i: any) => i.text.startsWith("Vendor") && i.status === "archived").length).toBe(9); // consolidated away, archived as history

    const hist = await json(await call("GET", `/api/memories/${danaId}/history`, { cookie: admin }));
    expect(hist.map((h: any) => h.text)).toEqual(["The billing owner is Priya Sharma", "The billing owner is Dana Lee"]);

    const reviews = await json(await call("GET", "/api/reviews?status=pending", { cookie: admin }));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ kind: "supersede", memoryId: danaId });
    expect(reviews[0].memory.text).toBe("The billing owner is Dana Lee");

    const g = await json(await call("GET", "/api/graph?limit=500", { cookie: admin }));
    expect(g.nodes.map((n: any) => n.label)).not.toContain("The billing owner is Priya Sharma");
    expect(JSON.stringify(g)).not.toContain("Falcon");

    const eps = await json(await call("GET", "/api/episodes", { cookie: admin }));
    expect(eps.length).toBeGreaterThanOrEqual(2); // two public threads
    expect(eps.every((e: any) => e.scopeTag === "shared")).toBe(true);

    const md = await (await call("GET", "/api/export/memories", { cookie: admin })).text();
    expect(md).toContain("Dana Lee");
    expect(md).not.toContain("Priya Sharma");
    expect(md).not.toContain("Falcon");

    // admin rejects the supersede review: Priya is restored, the Dana fact is rejected
    expect((await call("POST", `/api/reviews/${reviews[0].id}/decide`, { cookie: admin, body: { approve: false } })).status).toBe(200);
    const [p2] = await db.select().from(memories).where(eq(memories.id, priyaId));
    const [d2] = await db.select().from(memories).where(eq(memories.id, danaId));
    expect(p2).toMatchObject({ status: "active", supersededBy: null, invalidAt: null });
    expect(d2!.reviewState).toBe("rejected");
  });
});
