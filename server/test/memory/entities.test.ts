import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { channels, entities, factEntities, memories, memoryEdges, users } from "../../src/db/schema";
import { entityLookup, queryEntities, seedSlackEntities } from "../../src/memory/entities";
import { setMemoryLlm } from "../../src/memory/llm";
import { searchMemory } from "../../src/memory/search";
import { addFact } from "../../src/memory/supersede";
import { captureTurn, parseFacts } from "../../src/memory/writeback";
import { installFakes, removeFakes } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(async () => { await resetDb(); installFakes(); });

const names = async () => (await db.select().from(entities)).map((e) => e.canonicalName).sort();
/** Tie-break stub: picks the candidate whose name contains the mention (or null). */
const tie = (calls?: { n: number }) => setMemoryLlm(async (a) => {
  if (!a.system.includes("resolve entity mentions")) return '{"superseded":[],"facts":[]}';
  if (calls) calls.n++;
  const m = /MENTION: (.*) \(/.exec(a.prompt)?.[1]?.toLowerCase().replace(/[^a-z ]/g, "").trim() ?? "";
  const c = [...a.prompt.matchAll(/^(\d+)\. (.*?) \(/gm)].find((x) => x[2]!.toLowerCase().replace(/[^a-z ]/g, "").includes(m));
  return JSON.stringify({ match: c ? Number(c[1]) : null });
});

describe("entity resolution", () => {
  test("exact alias match reuses the entity; no LLM call", async () => {
    const calls = { n: 0 }; tie(calls);
    const a = await addFact({ tag: "shared", text: "Priya Sharma owns Zephyr billing", source: "t", entities: [{ name: "Priya Sharma", type: "person" }] });
    const b = await addFact({ tag: "shared", text: "priya sharma approved the Zephyr budget", source: "t", entities: [{ name: "PRIYA  SHARMA." }] });
    expect(await names()).toEqual(["Priya Sharma"]);
    const links = await db.select().from(factEntities);
    expect(new Set(links.map((l) => l.entityId)).size).toBe(1);
    expect(links.map((l) => l.factId).sort()).toEqual([a.id, b.id].sort());
    expect(calls.n).toBe(0);
  });

  test("'Dana' vs 'Dana S.': embedding neighbour + LLM tie-break merges, alias is remembered", async () => {
    const calls = { n: 0 }; tie(calls);
    await addFact({ tag: "shared", text: "Dana Schmidt owns the Orchid vendor contract", source: "t", entities: [{ name: "Dana Schmidt", type: "person" }] });
    await addFact({ tag: "shared", text: "Dana S. signed the Orchid renewal", source: "t", entities: [{ name: "Dana S.", type: "person" }] });
    expect(await names()).toEqual(["Dana Schmidt"]);
    expect(calls.n).toBe(1);
    const [e] = await db.select().from(entities);
    expect(e!.aliases).toEqual(expect.arrayContaining(["dana schmidt", "dana s"]));
    await addFact({ tag: "shared", text: "Dana S. attends the Orchid review", source: "t", entities: [{ name: "Dana S." }] });
    expect(calls.n).toBe(1); // third mention is an exact alias hit
  });

  test("LLM says no / fails: a new entity is created, never a wrong merge", async () => {
    tie();
    await addFact({ tag: "shared", text: "Dana Schmidt owns Orchid", source: "t", entities: [{ name: "Dana Schmidt" }] });
    await addFact({ tag: "shared", text: "Dana Whitfield sponsors Mercury", source: "t", entities: [{ name: "Dana Whitfield" }] });
    expect(await names()).toEqual(["Dana Schmidt", "Dana Whitfield"]);
    setMemoryLlm(async () => { throw new Error("llm down"); });
    await addFact({ tag: "shared", text: "Dana Kim joined Helix", source: "t", entities: [{ name: "Dana Kim" }] });
    expect((await names()).length).toBe(3);
  });

  test("slack users and public channels are seeded; private channels and DMs never are", async () => {
    await db.insert(users).values([{ id: "U1", name: "Priya Sharma" }, { id: "UB", name: "Botty", isBot: true }]);
    await db.insert(channels).values([
      { id: "C1", name: "billing" }, { id: "C2", name: "secret-merger", isPrivate: true }, { id: "D1", name: "dm", isIm: true },
    ]);
    expect(await seedSlackEntities()).toBe(2);
    expect(await names()).toEqual(["Priya Sharma", "billing"]);
    expect(await seedSlackEntities()).toBe(0); // idempotent
  });

  test("queryEntities: alias n-grams and first-name prefix", async () => {
    tie();
    await addFact({ tag: "shared", text: "Dana Schmidt owns Orchid", source: "t", entities: [{ name: "Dana Schmidt" }, { name: "Orchid Vendor", type: "org" }] });
    expect((await queryEntities("what does Dana do?")).length).toBe(1);
    expect((await queryEntities("status of the orchid vendor deal")).length).toBe(1);
    expect(await queryEntities("what is the weather")).toEqual([]);
  });
});

describe("entity expansion in search", () => {
  test("hop 1 finds a fact that never mentions the query text; hop 2 bridges via a shared entity", async () => {
    tie();
    await addFact({ tag: "shared", text: "D. Schmidt signed the Orchid renewal for 2027", source: "t", entities: [{ name: "Dana Schmidt" }] });
    await addFact({ tag: "shared", text: "Tamsin Okafor manages the mobile platform team", source: "t", entities: [{ name: "Tamsin Okafor" }, { name: "Mobile Platform Team", type: "org" }] });
    await addFact({ tag: "shared", text: "The mobile platform team owns the Kestrel app", source: "t", entities: [{ name: "Mobile Platform Team", type: "org" }, { name: "Kestrel", type: "product" }] });
    const hop1 = await searchMemory({ tags: ["shared"], query: "What has Dana done?" });
    expect(hop1.map((h) => h.text)).toContain("D. Schmidt signed the Orchid renewal for 2027");
    const hop2 = await searchMemory({ tags: ["shared"], query: "Who is responsible for Kestrel?" });
    expect(hop2.map((h) => h.text)).toContain("Tamsin Okafor manages the mobile platform team");
    process.env.MEMORY_ENTITY_EXPANSION = "0";
    try {
      expect((await searchMemory({ tags: ["shared"], query: "Who is responsible for Kestrel?" })).map((h) => h.text)).not.toContain("Tamsin Okafor manages the mobile platform team");
    } finally { delete process.env.MEMORY_ENTITY_EXPANSION; }
  });

  test("ACL: expansion never returns, or bridges through, facts outside the readable tags", async () => {
    tie();
    await addFact({ tag: "shared", text: "Project Falcon is a codename the public knows", source: "t", entities: [{ name: "Falcon", type: "project" }] });
    await addFact({ tag: "channel_CPRIV", text: "Falcon acquisition price is nine million dollars", source: "t", entities: [{ name: "Falcon", type: "project" }, { name: "Vault Holdings", type: "org" }] });
    await addFact({ tag: "shared", text: "Vault Holdings office is in Oslo", source: "t", entities: [{ name: "Vault Holdings", type: "org" }] });
    const pub = await searchMemory({ tags: ["shared"], query: "Tell me about Falcon" });
    expect(pub.map((h) => h.text).join("|")).not.toContain("nine million");
    // hop 2 must not pivot through the private fact: Oslo is only linked to Falcon via the private bridge
    expect(pub.map((h) => h.text).join("|")).not.toContain("Oslo");
    const member = await searchMemory({ tags: ["shared", "channel_CPRIV"], query: "Tell me about Falcon" });
    expect(member.map((h) => h.text).join("|")).toContain("nine million");
    expect(member.map((h) => h.text).join("|")).toContain("Oslo");
  });

  test("entity_lookup is scope-filtered and reports unknown for names with nothing readable", async () => {
    tie();
    await addFact({ tag: "channel_CPRIV", text: "Falcon acquisition price is nine million dollars", source: "t", entities: [{ name: "Falcon", type: "project" }] });
    await addFact({ tag: "shared", text: "Kestrel launches in March", source: "t", entities: [{ name: "Kestrel", type: "product" }] });
    const none = await entityLookup({ tags: ["shared"], name: "Falcon" });
    expect(none).toEqual({ entities: [], facts: [], related: [] });
    const ok = await entityLookup({ tags: ["shared", "channel_CPRIV"], name: "falcon" });
    expect(ok.facts.map((f) => f.text)).toEqual(["Falcon acquisition price is nine million dollars"]);
    expect((await entityLookup({ tags: ["shared"], name: "Kestrel" })).facts.length).toBe(1);
  });

  test("soft-deleted facts are not expanded", async () => {
    tie();
    const a = await addFact({ tag: "shared", text: "Kestrel launches in March", source: "t", entities: [{ name: "Kestrel" }] });
    await db.update(memories).set({ status: "deleted" }).where(eq(memories.id, a.id));
    expect((await searchMemory({ tags: ["shared"], query: "Kestrel" })).length).toBe(0);
    expect((await entityLookup({ tags: ["shared"], name: "Kestrel" })).facts).toEqual([]);
  });
});

describe("extractor: entities and typed relations", () => {
  test("plain-string facts still work; object facts carry entities; relations become typed edges", async () => {
    const parsed = parseFacts((["Plain sentence fact one", { text: "Object fact two", entities: ["Kestrel", { name: "Mobile Team", type: "org" }], relations: [{ relation: "part_of", to: 0 }, { relation: "Bad Rel!", to: 0 }] }]) as Parameters<typeof parseFacts>[0]);
    expect(parsed.map((f) => [f.text, f.entities?.length ?? 0, f.relations?.length ?? 0])).toEqual([["Plain sentence fact one", 0, 0], ["Object fact two", 2, 1]]);
    tie();
    setMemoryLlm(async (a) => a.system.includes("extract durable")
      ? JSON.stringify({ facts: [
        { text: "The mobile team owns the Kestrel app", entities: [{ name: "Mobile Team", type: "org" }, { name: "Kestrel", type: "product" }], relations: [{ relation: "owns", to: 1 }] },
        { text: "Kestrel is part of the Aurora suite", entities: [{ name: "Kestrel" }, { name: "Aurora" }] },
        "Legacy plain fact stays supported",
      ] })
      : '{"superseded":[]}');
    expect(await captureTurn({ scope: { channelId: "C1", isPrivate: false, isIm: false, userId: "U1" }, transcript: "x" })).toBe(3);
    const edges = await db.select().from(memoryEdges);
    expect(edges.filter((e) => e.relation === "owns").length).toBe(1);
    expect(await names()).toEqual(["Aurora", "Kestrel", "Mobile Team"]);
  });
});
