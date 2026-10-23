import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { recallLog, skills } from "../../src/db/schema";
import { estimateTokens } from "../../src/memory/budget";
import { type Actor, coreMemoryEdit } from "../../src/memory/core-blocks";
import { setMemoryLlm } from "../../src/memory/llm";
import { clearRecallCache } from "../../src/memory/recall";
import { buildContext, cleanSlackText, logRecall, windowByTokens } from "../../src/turn/context";
import { setSlackClient } from "../../src/turn/slack";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
afterEach(() => setSlackClient(undefined));
beforeEach(async () => { await resetDb(); clearRecallCache(); });

const admin: Actor = { userId: "UA", role: "admin", agentContext: "primary" };
const scopeOf = (userId: string) => ({ channelId: "C1", isPrivate: false, isIm: false, userId });
const input = (userId: string, text = "what is the launch plan?", threadTs = "100.0") => ({
  trigger: "mention" as const, channelId: "C1", threadTs, ts: "200.0", userId, text, isPrivate: false, isIm: false,
});
const ctxOf = (userId: string, o: Record<string, unknown> = {}) => ({
  turnId: "T", userId, channelId: "C1", threadTs: "100.0", scope: scopeOf(userId), readOnly: false, orgConnectionsOnly: false, ...o,
}) as never;
const fakeSlack = (messages: unknown[]) => setSlackClient((async () => ({ conversations: { replies: async () => ({ messages }), history: async () => ({ messages }) } })) as never);

describe("buildContext", () => {
  test("shared prefix is byte-identical across users; only the trailing user block differs; no timestamps", async () => {
    await coreMemoryEdit({ scope: scopeOf("UA"), actor: admin, label: "company", op: "add", text: "Acme sells widgets to dentists" });
    await coreMemoryEdit({ scope: scopeOf("UA"), actor: admin, label: "channel", op: "add", text: "Channel C1 is the launch war room" });
    await coreMemoryEdit({ scope: scopeOf("U1"), actor: { userId: "U1", role: "member", agentContext: "primary" }, label: "user", op: "add", text: "U1 prefers terse replies" });
    await coreMemoryEdit({ scope: scopeOf("U2"), actor: { userId: "U2", role: "member", agentContext: "primary" }, label: "user", op: "add", text: "U2 likes long explanations" });
    fakeSlack([]);
    const a = await buildContext(input("U1"), ctxOf("U1", { skipRecall: true }));
    const b = await buildContext(input("U2"), ctxOf("U2", { skipRecall: true }));
    expect(a.sharedBlockCount).toBe(b.sharedBlockCount);
    expect(a.sharedBlockCount).toBe(2); // company + channel
    const sharedA = a.frozenPrefixBlocks.slice(0, a.sharedBlockCount).join("\n\n");
    expect(sharedA).toBe(b.frozenPrefixBlocks.slice(0, b.sharedBlockCount).join("\n\n"));
    expect(sharedA).toContain("Acme sells widgets");
    expect(a.frozenPrefixBlocks.at(-1)).toContain("U1 prefers terse");
    expect(b.frozenPrefixBlocks.at(-1)).toContain("U2 likes long");
    expect(a.frozenPrefixBlocks.join("")).not.toContain("U2 likes");
    expect(a.frozenPrefixBlocks.join("")).not.toMatch(/\d{4}-\d{2}-\d{2}T|\d{2}:\d{2}:\d{2}/);
    expect(a.sharedBlockCount).toBeLessThan(a.frozenPrefixBlocks.length);
  });

  test("org skills sit in the shared prefix; personal skills only in the asker's tail", async () => {
    await db.insert(skills).values([
      { id: "s1", name: "refunds", description: "How to process refunds", body: "b", scope: "org" },
      { id: "s2", name: "my-standup", description: "U1 standup template", body: "b", scope: "user", ownerUserId: "U1" },
    ]);
    fakeSlack([]);
    const a = await buildContext(input("U1"), ctxOf("U1", { skipRecall: true }));
    const b = await buildContext(input("U2"), ctxOf("U2", { skipRecall: true }));
    const shared = (c: typeof a) => c.frozenPrefixBlocks.slice(0, c.sharedBlockCount).join("\n\n");
    expect(shared(a)).toContain("refunds");
    expect(shared(a)).toBe(shared(b));
    expect(shared(a)).not.toContain("my-standup");
    expect(a.frozenPrefixBlocks.at(-1)).toContain("my-standup");
    expect(b.frozenPrefixBlocks.join("")).not.toContain("my-standup");
  });

  test("blocks are frozen per thread: mid-thread edits don't change the prefix, a new thread sees them", async () => {
    await coreMemoryEdit({ scope: scopeOf("UA"), actor: admin, label: "company", op: "add", text: "Original company profile" });
    fakeSlack([]);
    const first = await buildContext(input("U1"), ctxOf("U1", { skipRecall: true }));
    await coreMemoryEdit({ scope: scopeOf("UA"), actor: admin, label: "company", op: "replace", match: "Original", text: "Updated company profile" });
    const again = await buildContext(input("U2"), ctxOf("U2", { skipRecall: true }));
    expect(again.frozenPrefixBlocks.slice(0, again.sharedBlockCount)).toEqual(first.frozenPrefixBlocks.slice(0, first.sharedBlockCount));
    expect(again.frozenPrefixBlocks.join("")).toContain("Original company profile");
    const fresh = await buildContext(input("U1", "q", "300.0"), ctxOf("U1", { skipRecall: true }));
    expect(fresh.frozenPrefixBlocks.join("")).toContain("Updated company profile");
  });

  test("history: markup stripped, quotes and placeholders dropped, window sized by tokens, summary first", async () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({
      user: i % 2 ? "UBOT" : "U1", ts: `${101 + i}.0`,
      text: i === 3 ? "see <https://x.dev/a|the doc> &amp; <#C9|general> <!here>\n> old quoted text\nreal reply" : i === 5 ? "_Thinking..._" : `m${i} ${"word ".repeat(60)}`,
    }));
    setSlackClient((async () => ({ conversations: { replies: async () => ({ messages: msgs }) } })) as never);
    // botUserId() reads the workspace row; with none, bot messages are matched by absence of `user`
    const bc = await buildContext(input("U1"), ctxOf("U1", { skipRecall: true, historyTokens: 1000 }));
    const joined = bc.history.map((m) => m.content).join("\n");
    expect(estimateTokens(joined)).toBeLessThanOrEqual(1000 + 20);
    expect(bc.history.length).toBeLessThan(40);
    expect(joined).toContain("m39"); // newest survive
    expect(joined).not.toContain("m0 ");
    expect(bc.compactHistory.length).toBeGreaterThan(bc.history.length);
    const cleaned = cleanSlackText(msgs[3]!.text);
    expect(cleaned).toBe("see the doc (https://x.dev/a) & #general @here\nreal reply");
    expect(bc.breakdown.total).toBe(bc.tokens);
  });

  test("recall is skipped for direct depth and budgeted otherwise", async () => {
    await seedMemory("shared", "The launch plan is owned by Priya and ships in May");
    fakeSlack([]);
    const direct = await buildContext(input("U1"), ctxOf("U1", { skipRecall: true }));
    expect(direct.recallText).toBe("");
    const mem = await buildContext(input("U1", "who owns the launch plan?"), ctxOf("U1"));
    expect(mem.recallText).toContain("<memory-context>");
    expect(mem.recallText).toContain("Priya");
    expect(estimateTokens(mem.recallText)).toBeLessThanOrEqual(2500);
  });
});

describe("helpers", () => {
  test("windowByTokens keeps at least the newest message and never exceeds budget otherwise", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ ts: `${i}.0`, role: "user" as const, text: "w ".repeat(200) }));
    const w = windowByTokens(items, 250);
    expect(w.at(-1)!.ts).toBe("9.0");
    expect(w.reduce((n, m) => n + estimateTokens(m.text) + 4, 0)).toBeLessThanOrEqual(250);
    expect(windowByTokens(items, 1).length).toBe(1);
  });
  test("cleanSlackText caps long blobs and keeps quote-only messages", () => {
    expect(cleanSlackText("x".repeat(5000)).length).toBeLessThan(1300);
    expect(cleanSlackText("> only a quote")).toBe("> only a quote");
  });
});

describe("recall_log", () => {
  test("a turn that recalls memory logs query + hit ids; no hits, no row", async () => {
    const id = await seedMemory("shared", "The launch plan is to ship on Friday");
    await buildContext(input("U1"), ctxOf("U1"));
    const rows = await db.select().from(recallLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channelId: "C1", threadKey: "100.0", messageTs: "200.0", query: "what is the launch plan?", hitIds: [id] });
    await resetDb();
    await buildContext(input("U1", "zzz qqq unrelated"), ctxOf("U1"));
    expect(await db.select().from(recallLog)).toHaveLength(0);
  });

  test("a failing insert never throws", async () => {
    await logRecall({ ...input("U1"), channelId: null as never }, "100.0", [1]);
    expect(await db.select().from(recallLog)).toHaveLength(0);
  });
});
