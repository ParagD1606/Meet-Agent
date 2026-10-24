import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, resetDb } from "../db";
import { channels, consolidationLog, coreBlocks, entitySummaries, episodes, factEntities, memories, memoryReviews } from "../../src/db/schema";
import { consolidate, undoConsolidation } from "../../src/memory/consolidate";
import { forgetMemories } from "../../src/memory/facts";
import { deleteMemory } from "../../src/memory/graph";
import { setMemoryLlm } from "../../src/memory/llm";
import { searchMemory } from "../../src/memory/search";
import { addFact } from "../../src/memory/supersede";
import { fakeVector, installFakes, removeFakes, seedMemory } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(async () => { await resetDb(); installFakes(); });

const old = (days: number) => new Date(Date.now() - days * 86_400_000);
const row = async (id: number) => (await db.select().from(memories).where(eq(memories.id, id)))[0]!;
const logs = (action: string) => db.select().from(consolidationLog).where(eq(consolidationLog.action, action));

describe("cross-scope conflict resolution (within ACL)", () => {
  test("narrow duplicate of a shared fact is superseded by it; shared is never touched", async () => {
    const s = await seedMemory("shared", "The Orion renewal deadline is 2026-11-15");
    const n = await seedMemory("channel_C1", "The Orion renewal deadline is 2026-11-15");
    const only = await seedMemory("channel_C1", "Channel C1 standup is at nine quokka");
    const r = await consolidate();
    expect(r.crossScope).toBe(1);
    expect(await row(n)).toMatchObject({ status: "superseded", supersededBy: s });
    expect((await row(s)).status).toBe("active");
    expect((await row(only)).status).toBe("active");
  });

  test("a NEWER shared fact that contradicts an older private one wins; the reverse never changes shared", async () => {
    setMemoryLlm(async () => '{"superseded":[%ID%]}'.replace("%ID%", String(lastNarrow)));
    const narrowOld = await seedMemory("user_U1", "Titan launch date moves to October first", { validAt: old(30) });
    const shared = await seedMemory("shared", "Titan launch date moves to November third", { validAt: old(1) });
    var lastNarrow = narrowOld;
    await consolidate();
    expect(await row(narrowOld)).toMatchObject({ status: "superseded", supersededBy: shared });
    expect((await row(shared)).status).toBe("active");
    // older shared vs newer private: shared must stay
    await resetDb();
    const sharedOld = await seedMemory("shared", "Helix launch date moves to October first", { validAt: old(30) });
    const narrowNew = await seedMemory("user_U1", "Helix launch date moves to November third", { validAt: old(1) });
    lastNarrow = sharedOld;
    await consolidate();
    expect((await row(sharedOld)).status).toBe("active");
    expect((await row(narrowNew)).status).toBe("active");
  });
});

describe("continuous decay", () => {
  test("importance halves per half-life by fact type, access resets the clock, floor holds, second run is a no-op", async () => {
    const plain = await seedMemory("shared", "plain fact alpha", { validAt: old(120), importance: 0.8 });
    const decision = await seedMemory("shared", "decision fact beta", { validAt: old(120), importance: 0.8, factType: "decision" });
    const touched = await seedMemory("shared", "touched fact gamma", { validAt: old(400), importance: 0.8, lastAccessedAt: old(0.1) });
    const ancient = await seedMemory("shared", "ancient fact delta", { validAt: old(5000), importance: 0.8 });
    const r = await consolidate();
    expect(r.decayed).toBe(3);
    expect((await row(plain)).importance).toBeCloseTo(0.4, 1);
    expect((await row(decision)).importance).toBeCloseTo(0.8 * 0.5 ** (120 / 365), 1);
    expect((await row(touched)).importance).toBeCloseTo(0.8, 5);
    expect((await row(ancient)).importance).toBeCloseTo(0.05, 5);
    const again = await consolidate();
    expect(again.decayed).toBe(0);
    expect((await row(plain)).importance).toBeCloseTo(0.4, 1);
  });
});

describe("archive instead of purge, with undo", () => {
  test("expired transient facts are archived; summarised originals are archived; undo restores both and the digest is soft-deleted", async () => {
    setMemoryLlm(async () => '{"facts":["Historic vendor list: Acme, Bolt, Cirrus were evaluated."]}');
    const expired = await seedMemory("shared", "Code freeze until the quux release", { validUntil: old(60) });
    const stale: number[] = [];
    for (let i = 0; i < 9; i++) stale.push(await seedMemory("shared", `Vendor${i} note number${i} zork${i}`, { validAt: old(400), importance: 0.2 }));
    const r = await consolidate();
    expect(r.expired).toBe(1);
    expect(r.summarised).toBe(9);
    expect((await row(expired)).status).toBe("archived");
    expect((await row(stale[0]!)).status).toBe("archived");
    const [sum] = await logs("summarise");
    const created = (sum!.details as { created: number[] }).created;
    expect((await row(created[0]!)).status).toBe("active");
    expect(await undoConsolidation(sum!.id)).toEqual({ ok: true });
    for (const id of stale) expect(await row(id)).toMatchObject({ status: "active", supersededBy: null, invalidAt: null });
    expect((await row(created[0]!)).status).toBe("deleted");
    expect(await undoConsolidation(sum!.id)).toEqual({ ok: false, error: "already_undone" });
    const [ex] = await logs("expire");
    await undoConsolidation(ex!.id);
    expect((await row(expired)).status).toBe("active");
    expect(await undoConsolidation(999_999)).toEqual({ ok: false, error: "not_found" });
  });

  test("undo of a merge restores the loser and the winner's importance; undo of decay restores importance", async () => {
    const a = await seedMemory("shared", "The weekly sync with Acme happens every Tuesday at 10am", { importance: 0.3, validAt: old(2) });
    const b = await seedMemory("shared", "The weekly sync with Acme happens every Tuesday at 10am", { importance: 0.9, validAt: old(2) });
    await db.update(memories).set({ accessCount: 3 }).where(eq(memories.id, b));
    await consolidate();
    expect((await row(a)).status).toBe("superseded");
    const [m] = await logs("merge");
    await undoConsolidation(m!.id);
    expect(await row(a)).toMatchObject({ status: "active", supersededBy: null });
    const [d] = await logs("decay");
    await undoConsolidation(d!.id);
    expect((await row(b)).importance).toBeCloseTo(0.9, 5);
  });
});

describe("soft delete", () => {
  test("forget_memories and deleteMemory keep the row with status deleted and hide it from search", async () => {
    const id = await seedMemory("shared", "The vendor portal login hint is the dog name Rex");
    await forgetMemories({ tags: ["shared"], query: "vendor portal login hint dog", dryRun: false });
    expect(await row(id)).toMatchObject({ status: "deleted" });
    expect(await searchMemory({ tags: ["shared"], query: "vendor portal login hint" })).toHaveLength(0);
    expect(await deleteMemory(id)).toBe(false);
    // the same fact can be learned again afterwards
    expect((await addFact({ tag: "shared", text: "The vendor portal login hint is the dog name Rex", source: "t" })).deduped).toBe(false);
  });
});

describe("promotion, demotion, about blocks, entity summaries, procedures", () => {
  test("hot shared facts are proposed for the company block via the review queue (idempotent); stale lines are proposed for removal", async () => {
    const id = await seedMemory("shared", "Support SLA is four business hours", { importance: 0.8 });
    await db.update(memories).set({ accessCount: 12 }).where(eq(memories.id, id));
    const r1 = await consolidate();
    expect(r1.promoted).toBe(1);
    const [rv] = await db.select().from(memoryReviews);
    expect(rv).toMatchObject({ kind: "core_block", status: "pending", requestedBy: "consolidation" });
    expect(rv!.payload).toMatchObject({ op: "add", text: "Support SLA is four business hours", label: "company" });
    expect((await consolidate()).promoted).toBe(0);
    expect(await db.select().from(memoryReviews)).toHaveLength(1);
    // demote: a block line equal to a fact that was superseded
    await db.insert(coreBlocks).values({ id: "cb_x", scopeTag: "shared", label: "company", text: "Old policy line stale", charLimit: 1500 });
    await seedMemory("shared", "Old policy line stale", { status: "superseded" });
    const r2 = await consolidate();
    expect(r2.demoted).toBe(1);
    expect((await db.select().from(memoryReviews)).find((x) => (x.payload as { op: string }).op === "remove")).toBeTruthy();
    expect((await consolidate()).demoted).toBe(0);
    // undo of a pending proposal rejects it
    const [pl] = await logs("promote");
    await undoConsolidation(pl!.id);
    expect((await db.select().from(memoryReviews).where(eq(memoryReviews.id, (pl!.details as { reviewId: string }).reviewId)))[0]!.status).toBe("rejected");
  });

  test("per-channel About line: written from that channel's episodes only, replaced not duplicated, regenerated only on news, undoable", async () => {
    setMemoryLlm(async (a) => (a.system.startsWith("From these summaries") ? "Billing channel for invoicing questions and refunds." : '{"facts":[]}'));
    await db.insert(channels).values([{ id: "CB", name: "billing" }, { id: "D9", isIm: true }]);
    for (let i = 0; i < 3; i++) {
      await db.insert(episodes).values([
        { id: `ep${i}`, scopeTag: "shared", channelId: "CB", threadTs: `${i}.0`, summary: `Invoice thread ${i}`, embedding: fakeVector("x") },
        { id: `dm${i}`, scopeTag: "user_U1", channelId: "D9", threadTs: `${i}.0`, summary: `DM thread ${i}`, embedding: fakeVector("y") },
      ]);
    }
    await db.insert(coreBlocks).values({ id: "cb_ch", scopeTag: "channel_CB", label: "channel", text: "Pricing questions go in thread", charLimit: 1000 });
    expect((await consolidate()).aboutBlocks).toBe(1);
    const text = async () => (await db.select().from(coreBlocks).where(eq(coreBlocks.scopeTag, "channel_CB")))[0]!.text;
    expect(await text()).toBe("About: Billing channel for invoicing questions and refunds.\nPricing questions go in thread");
    expect((await db.select().from(coreBlocks).where(eq(coreBlocks.scopeTag, "channel_D9"))).length).toBe(0);
    expect((await consolidate()).aboutBlocks).toBe(0);
    const [l] = await logs("about_block");
    await undoConsolidation(l!.id);
    expect(await text()).toBe("Pricing questions go in thread");
  });

  test("entity summaries are generated per (entity, scope) from readable facts only", async () => {
    setMemoryLlm(async (a) => (a.system.startsWith("Summarise everything") ? `Summary of ${/ENTITY: (.*)/.exec(a.prompt)![1]}: ${a.prompt.includes("secret") ? "LEAK" : "ok"}.` : '{"facts":[]}'));
    await db.execute(sql`insert into entities (id, canonical_name, aliases, type, embedding) values ('en_k', 'Kestrel', ARRAY['kestrel'], 'product', ${`[${fakeVector("kestrel").join(",")}]`}::vector)`);
    for (const [tag, t] of [["shared", "Kestrel one"], ["shared", "Kestrel two"], ["shared", "Kestrel three"], ["channel_P", "Kestrel secret a"], ["channel_P", "Kestrel secret b"]] as const) {
      const id = await seedMemory(tag, t);
      await db.insert(factEntities).values({ factId: id, entityId: "en_k" });
    }
    expect((await consolidate()).entitySummaries).toBe(1); // channel_P has only 2 facts
    const sums = await db.select().from(entitySummaries);
    expect(sums).toHaveLength(1);
    expect(sums[0]).toMatchObject({ scopeTag: "shared", summary: "Summary of Kestrel: ok." });
    expect((await consolidate()).entitySummaries).toBe(0);
  });

  test("procedures from recent shared episodes are parked as pending facts + a procedure review", async () => {
    setMemoryLlm(async (a) => (a.system.startsWith("From these thread summaries") ? '{"facts":["To rotate the API key: create a new key, update the vault, then revoke the old key."]}' : '{"superseded":[],"facts":[]}'));
    for (let i = 0; i < 2; i++) await db.insert(episodes).values({ id: `e${i}`, scopeTag: "shared", channelId: "C1", threadTs: `${i}.0`, summary: `Key rotation thread ${i}`, embedding: fakeVector("k") });
    expect((await consolidate()).procedures).toBe(1);
    const [fact] = await db.select().from(memories).where(eq(memories.factType, "procedure"));
    expect(fact).toMatchObject({ reviewState: "pending", scopeTag: "shared" });
    expect((await db.select().from(memoryReviews))[0]).toMatchObject({ kind: "procedure", status: "pending", memoryId: fact!.id });
    expect(await searchMemory({ tags: ["shared"], query: "rotate the API key" })).toHaveLength(0); // not live until approved
    const [l] = await logs("procedure");
    await undoConsolidation(l!.id);
    expect((await row(fact!.id)).status).toBe("deleted");
  });
});
