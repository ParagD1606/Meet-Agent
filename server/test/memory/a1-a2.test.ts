// A1 (typed, bi-temporal facts) + A2 (contextual prefix, query rewrite, rerank, depth budget) behaviour.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { memories } from "../../src/db/schema";
import { backfillContextPrefixes } from "../../src/memory/context-prefix";
import { setMemoryLlm } from "../../src/memory/llm";
import { buildRecall, clearRecallCache, HALF_LIFE_DAYS, rankScore, recallBudget, selectDiverse } from "../../src/memory/recall";
import { rerank } from "../../src/memory/rerank";
import { rewriteQuery } from "../../src/memory/rewrite";
import type { SlackScope } from "../../src/memory/scope";
import { lookupTokens, searchMemory, type MemoryHit } from "../../src/memory/search";
import { captureTurn, EXTRACT_SYSTEM, parseFacts } from "../../src/memory/writeback";
import { DEPTH_CONFIG } from "../../src/turn/depth";
import { memoryTools } from "../../src/turn/memory-tools";
import { installFakes, removeFakes, seedMemory } from "./helpers";

beforeAll(installFakes);
afterAll(() => { removeFakes(); delete process.env.MEMORY_RERANK; });
beforeEach(async () => { await resetDb(); clearRecallCache(); });

const scope: SlackScope = { channelId: "C1", isPrivate: false, isIm: false, userId: "U1" };
const NOW = new Date("2026-06-10T12:00:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);

describe("A1 extraction parsing", () => {
  test("strings still work; eventDate is clamped to now; forgetAfter in the past is ignored; slack ids dropped", () => {
    const out = parseFacts([
      "Plain old string fact about the launch",
      { text: "The pricing decision was made", type: "decision", eventDate: "2026-04-08", forgetAfter: "2026-07-01", context: "Dana in #pricing on 2026-04-08" },
      { text: "Renewal deadline is 2026-12-01", eventDate: "2026-12-01", forgetAfter: "2026-01-01" },
      { text: "Ping <@U01ABCDEF> about the budget" },
      { text: "C0123ABCD4 owns the budget review" },
      { text: "Bad type falls back to fact", type: "banana" as never },
    ], NOW);
    expect(out.map((f) => f.text)).toEqual(["Plain old string fact about the launch", "The pricing decision was made", "Renewal deadline is 2026-12-01", "Bad type falls back to fact"]);
    expect(out[0]).toMatchObject({ type: "fact" });
    expect(out[1]).toMatchObject({ type: "decision", context: "Dana in #pricing on 2026-04-08" });
    expect(out[1]!.validAt).toEqual(day("2026-04-08"));
    expect(out[1]!.validUntil!.toISOString()).toBe("2026-07-01T23:59:59.999Z");
    expect(out[2]!.validAt).toBeUndefined(); // future event date is not when it became true
    expect(out[2]!.validUntil).toBeUndefined();
  });

  test("prompt carries the rules and resolves against the message timestamp", () => {
    for (const needle of ["absolute dates", "forgetAfter", "Update, don't duplicate", "raw Slack ids", "connected tool owns"]) expect(EXTRACT_SYSTEM).toContain(needle);
  });

  test("captureTurn stores type, valid_at, valid_until, context prefix and source scope; 'Today' is the message time", async () => {
    let prompt = "";
    setMemoryLlm(async (a) => {
      if (a.system === EXTRACT_SYSTEM) {
        prompt = a.prompt;
        return JSON.stringify({ facts: [{ text: "The Titan launch moved to 2026-06-12", type: "decision", eventDate: "2026-06-09", forgetAfter: "2026-06-20", context: "Priya in #launch on 2026-06-09 about Titan" }] });
      }
      return '{"superseded":[]}';
    });
    expect(await captureTurn({ scope, transcript: "Priya: launch is moving to Friday", at: NOW })).toBe(1);
    expect(prompt).toContain("Today is Wednesday 2026-06-10");
    const [row] = await db.select().from(memories);
    expect(row).toMatchObject({ factType: "decision", contextPrefix: "Priya in #launch on 2026-06-09 about Titan", sourceScope: "shared" });
    expect(row!.validAt).toEqual(day("2026-06-09"));
    expect(row!.validUntil!.toISOString()).toBe("2026-06-20T23:59:59.999Z");
  });
});

describe("A1 expiry + asOf", () => {
  test("a fact past valid_until is not recalled by default but is visible as of a date before it expired", async () => {
    await seedMemory("shared", "Dana is out of office until the Henley offsite", { validAt: day("2026-01-01"), validUntil: day("2026-02-01") });
    await seedMemory("shared", "Dana prefers async updates over meetings", { validAt: day("2026-01-01") });
    const now = await searchMemory({ tags: ["shared"], query: "Dana out of office" });
    expect(now.map((h) => h.text)).not.toContain("Dana is out of office until the Henley offsite");
    const then = await searchMemory({ tags: ["shared"], query: "Dana out of office", asOf: day("2026-01-15") });
    expect(then.map((h) => h.text)).toContain("Dana is out of office until the Henley offsite");
    const after = await searchMemory({ tags: ["shared"], query: "Dana out of office", asOf: day("2026-03-01") });
    expect(after.map((h) => h.text)).not.toContain("Dana is out of office until the Henley offsite");
  });

  test("memory_search tool exposes asOf and rejects a malformed date", async () => {
    await seedMemory("shared", "The Orpheus lead is Valentina Cruz", { validAt: day("2026-01-01"), invalidAt: day("2026-06-01"), status: "superseded" });
    await seedMemory("shared", "The Orpheus lead is Henrik Dahl", { validAt: day("2026-06-01") });
    const t = memoryTools({ turnId: "t", userId: "U1", channelId: "C1", scope, readOnly: true, orgConnectionsOnly: false }).memory_search as unknown as { execute: (a: unknown) => Promise<string>; inputSchema: { safeParse: (v: unknown) => { success: boolean } } };
    expect(await t.execute({ query: "Orpheus lead", asOf: "2026-03-01" })).toContain("Valentina Cruz");
    expect(await t.execute({ query: "Orpheus lead" })).toContain("Henrik Dahl");
    expect(t.inputSchema.safeParse({ query: "x", asOf: "last march" }).success).toBe(false);
  });
});

describe("A1 type-specific decay", () => {
  const h = (o: Partial<MemoryHit>): MemoryHit => ({
    id: 1, text: "t", scopeTag: "shared", source: "s", sourceRef: null, score: 1, createdAt: NOW, kind: "fact", importance: 0.5, confidence: 1,
    accessCount: 0, validAt: new Date(NOW.getTime() - 180 * 86_400_000), validUntil: null, factType: "fact", lastAccessedAt: null, createdBy: null, permalink: null, ...o,
  });
  test("decisions/preferences decay slower than facts, opinions faster", () => {
    const r = (t: MemoryHit["factType"]) => rankScore(h({ factType: t }), NOW.getTime());
    expect(r("decision")).toBeGreaterThan(r("fact"));
    expect(r("preference")).toBeGreaterThan(r("fact"));
    expect(r("fact")).toBeGreaterThan(r("opinion"));
    expect(HALF_LIFE_DAYS.fact).toBe(90);
  });
});

describe("A2 retrieval", () => {
  test("lookupTokens picks ids and names, not question words or the sentence-initial word", () => {
    expect(lookupTokens("What does Bartholomew Quigly own?")).toEqual(["Bartholomew", "Quigly"]);
    expect(lookupTokens("what happened in ENG-9081")).toEqual(["ENG-9081"]);
    expect(lookupTokens("who owns billing")).toEqual([]);
  });

  test("trigram finds a misspelt name; unrelated queries return nothing", async () => {
    await seedMemory("shared", "Bartholomew Quigley owns the ledger reconciliation");
    await seedMemory("shared", "The cafeteria menu changes weekly");
    expect((await searchMemory({ tags: ["shared"], query: "what does Bartholomew Quigly own" }))[0]?.text).toContain("Quigley");
    expect(await searchMemory({ tags: ["shared"], query: "zebra giraffe habitat" })).toEqual([]);
  });

  test("context prefix is keyword-indexed and embedded with the fact", async () => {
    await seedMemory("shared", "Renewal is due in December", { contextPrefix: "Zephyr Corp contract, owner Priya, 2026-03-01" });
    const hits = await searchMemory({ tags: ["shared"], query: "Zephyr Priya" });
    expect(hits.map((x) => x.text)).toEqual(["Renewal is due in December"]);
  });

  test("backfill adds prefixes lazily, re-embeds, and leaves rows alone when the LLM fails", async () => {
    const a = await seedMemory("shared", "Renewal is due in December");
    const b = await seedMemory("shared", "Staging runs on Postgres 16");
    setMemoryLlm(async () => { throw new Error("down"); });
    expect(await backfillContextPrefixes()).toBe(0);
    expect((await db.select().from(memories).where(eq(memories.id, a)))[0]!.contextPrefix).toBeNull();
    setMemoryLlm(async () => JSON.stringify({ contexts: [{ id: a, context: "Zephyr Corp contract renewal, 2026-03-01" }] }));
    expect(await backfillContextPrefixes()).toBe(2);
    const rows = await db.select().from(memories);
    expect(rows.find((r) => r.id === a)!.contextPrefix).toContain("Zephyr");
    expect(rows.find((r) => r.id === b)!.contextPrefix).toBe(""); // skipped by the model: not retried
    expect((await searchMemory({ tags: ["shared"], query: "Zephyr" })).map((x) => x.id)).toEqual([a]);
    installFakes();
  });

  test("selectDiverse drops near-duplicate embeddings and keeps distinct ones", () => {
    const items = [
      { id: 1, text: "alpha beta", rank: 1 }, { id: 2, text: "gamma delta", rank: 0.9 }, { id: 3, text: "epsilon zeta", rank: 0.8 },
    ];
    const v = new Map([[1, [1, 0, 0]], [2, [0.99, 0.05, 0]], [3, [0, 1, 0]]]);
    expect(selectDiverse(items, 3, v).map((x) => x.id)).toEqual([1, 3]);
  });
});

describe("A2 query rewrite", () => {
  const rewriteLlm = (reply: string) => setMemoryLlm(async (a) => (a.system.includes("standalone search query") ? reply : '{"superseded":[]}'));

  test("uses the thread tail to resolve a follow-up and parses the time constraint", async () => {
    rewriteLlm('{"query":"Who signed the Kepler contract?","asOf":"2026-03-31"}');
    const r = await rewriteQuery({ query: "and who signed it?", threadTail: ["user: When does the Kepler contract renew?"], now: NOW });
    expect(r).toMatchObject({ query: "Who signed the Kepler contract?", rewritten: true });
    expect(r.asOf?.toISOString()).toBe("2026-03-31T23:59:59.999Z");
  });

  test("falls back to the raw text on garbage, errors, and standalone messages (no LLM call)", async () => {
    rewriteLlm("not json");
    expect(await rewriteQuery({ query: "and the second one?", threadTail: ["user: x"] })).toEqual({ query: "and the second one?", rewritten: false });
    setMemoryLlm(async () => { throw new Error("timeout"); });
    expect(await rewriteQuery({ query: "and the second one?", threadTail: ["user: x"] })).toEqual({ query: "and the second one?", rewritten: false });
    let calls = 0;
    setMemoryLlm(async () => { calls++; return "{}"; });
    expect(await rewriteQuery({ query: "Who owns the billing system?" })).toEqual({ query: "Who owns the billing system?", rewritten: false });
    expect(calls).toBe(0);
  });

  test("a future asOf from the model is ignored", async () => {
    rewriteLlm('{"query":"x y z","asOf":"2030-01-01"}');
    expect((await rewriteQuery({ query: "and then?", threadTail: ["user: x"], now: NOW })).asOf).toBeUndefined();
  });
});

describe("A2 rerank (behind MEMORY_RERANK)", () => {
  test("keeps only the model's ids in its order; failure keeps the input order", async () => {
    const items = [1, 2, 3].map((id) => ({ id, text: `t${id}` }));
    setMemoryLlm(async () => '{"ranked":[3,1,99]}');
    expect((await rerank("q", items)).map((x) => x.id)).toEqual([3, 1]);
    setMemoryLlm(async () => { throw new Error("down"); });
    expect((await rerank("q", items)).map((x) => x.id)).toEqual([1, 2, 3]);
  });

  test("default off: recall never calls the reranker; on: an empty ranking abstains", async () => {
    await seedMemory("shared", "The Nimbus API rate limit is 1200 requests per minute");
    await seedMemory("shared", "The Nimbus API key rotation happens quarterly");
    let reranks = 0;
    setMemoryLlm(async (a) => { if (a.system.includes("rerank")) { reranks++; return '{"ranked":[]}'; } return '{"superseded":[]}'; });
    expect((await buildRecall({ scope, query: "Nimbus API rate limit", rewrite: false })).hits.length).toBeGreaterThan(0);
    expect(reranks).toBe(0);
    process.env.MEMORY_RERANK = "true";
    clearRecallCache();
    expect((await buildRecall({ scope, query: "Nimbus API rate limit", rewrite: false })).hits).toEqual([]);
    expect(reranks).toBe(1);
    delete process.env.MEMORY_RERANK;
  });
});

describe("A2 depth", () => {
  test("recall budget scales with depth; memory depth gets memory_search only", () => {
    expect(recallBudget("direct")).toBe(0);
    expect(recallBudget("memory")).toBeGreaterThan(recallBudget("tools"));
    expect(recallBudget("deep")).toBeGreaterThan(recallBudget("memory"));
    expect(recallBudget()).toBe(2500);
    expect(DEPTH_CONFIG.memory).toMatchObject({ tools: false, memorySearch: true });
    expect(DEPTH_CONFIG.tools.memorySearch).toBeUndefined();
  });
});
