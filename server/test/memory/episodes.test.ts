import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { episodes } from "../../src/db/schema";
import { recordEpisode, searchThreads } from "../../src/memory/episodes";
import { setMemoryLlm } from "../../src/memory/llm";
import type { SlackScope } from "../../src/memory/scope";
import { installFakes, removeFakes, seedChannel } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(async () => {
  await resetDb();
  await seedChannel("C_P1", { isPrivate: true, members: ["U1"] });
  await seedChannel("C_P2", { isPrivate: true, members: ["U2"] });
});

const long = (s: string) => `${s} `.repeat(30);
const pub: SlackScope = { channelId: "C_PUB", isPrivate: false, isIm: false, userId: "U1" };
const priv1: SlackScope = { channelId: "C_P1", isPrivate: true, isIm: false, userId: "U1" };
const priv2: SlackScope = { channelId: "C_P2", isPrivate: true, isIm: false, userId: "U2" };
const dm1: SlackScope = { channelId: "D1", isPrivate: false, isIm: true, userId: "U1" };

describe("episodes", () => {
  test("recordEpisode upserts one row per thread under the write tag", async () => {
    setMemoryLlm(async () => "The team decided to migrate billing to Stripe and Dana owns the cutover by May.");
    expect(await recordEpisode({ scope: pub, channelId: "C_PUB", threadTs: "1.1", transcript: long("billing stripe migration dana") })).toBe(true);
    await recordEpisode({ scope: pub, channelId: "C_PUB", threadTs: "1.1", transcript: long("billing stripe migration dana update") });
    const rows = await db.select().from(episodes);
    expect(rows.length).toBe(1);
    expect(rows[0]!.scopeTag).toBe("shared");
    expect(await recordEpisode({ scope: pub, channelId: "C_PUB", threadTs: "2.2", transcript: "too short" })).toBe(false);
  });

  test("searchThreads is ACL-filtered: private/DM episodes never surface elsewhere", async () => {
    const summaries: Record<string, string> = {
      C_PUB: "Public: billing stripe migration owned by Dana",
      C_P1: "Private one: billing stripe migration secret acquisition budget",
      C_P2: "Private two: billing stripe migration layoffs plan",
      D1: "DM: billing stripe migration personal salary discussion",
    };
    let cur = "";
    setMemoryLlm(async () => summaries[cur]!);
    for (const [ch, scope] of [["C_PUB", pub], ["C_P1", priv1], ["C_P2", priv2], ["D1", dm1]] as const) {
      cur = ch;
      await recordEpisode({ scope, channelId: ch, threadTs: "9.9", transcript: long(`${ch} billing stripe migration`) });
    }
    setMemoryLlm(async () => "not json");
    const seen = async (scope: SlackScope) => (await searchThreads({ scope, query: "billing stripe migration", limit: 10 })).map((h) => h.channelId).sort();
    expect(await seen(pub)).toEqual(["C_PUB"]);
    expect(await seen(priv1)).toEqual(["C_P1", "C_PUB"]);
    expect(await seen(priv2)).toEqual(["C_P2", "C_PUB"]);
    expect(await seen(dm1)).toEqual(["C_P1", "C_PUB", "D1"]); // DM reads its own + member private channels
    expect(await seen({ ...dm1, userId: "U3" })).toEqual(["C_PUB"]);
  });

  test("stage two condenses and can drop irrelevant threads; failures fall back to stored summaries", async () => {
    let cur = "";
    const sums: Record<string, string> = { a: "billing stripe migration kickoff discussion with many details", b: "billing stripe migration vendor selection details" };
    setMemoryLlm(async () => sums[cur]!);
    for (const t of ["a", "b"]) { cur = t; await recordEpisode({ scope: pub, channelId: "C_PUB", threadTs: t, transcript: long(`billing stripe ${t}`) }); }
    setMemoryLlm(async () => '{"items":[{"n":1,"text":"skip"},{"n":2,"text":"Vendor chosen: Stripe."}]}');
    const hits = await searchThreads({ scope: pub, query: "billing stripe migration vendor" });
    expect(hits.map((h) => h.summary)).toEqual(["Vendor chosen: Stripe."]);
  });
});
