// B5 (learn from feedback + corrections) and B8 (cost ledger + spend alert).
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { checkSpendAlert, costReport } from "../../src/cost";
import { encrypt } from "../../src/crypto";
import { channels, memories, memoryReviews, recallLog, settings, turns, workspace } from "../../src/db/schema";
import { estimateCostMicros } from "../../src/llm";
import { decideReview } from "../../src/memory/review";
import { setMemoryLlm } from "../../src/memory/llm";
import { captureTurn } from "../../src/memory/writeback";
import { setSlackClientForTest } from "../../src/slack/client";
import { recordFeedback } from "../../src/slack/reactions";
import { db, resetDb } from "../db";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(async () => { await resetDb(); });

const replyTs = () => (Date.now() / 1000).toFixed(6);
const imp = async (id: number) => (await db.select().from(memories).where(eq(memories.id, id)))[0]!.importance;

describe("B5 feedback learning", () => {
  async function recalled() {
    const a = await seedMemory("shared", "Refunds take thirty days", { importance: 0.5 });
    const b = await seedMemory("shared", "Support hours are nine to five", { importance: 0.5 });
    await db.insert(recallLog).values({ channelId: "C1", threadKey: "100.1", messageTs: "100.1", query: "refunds?", hitIds: [a, b] });
    return { a, b };
  }

  test("thumbs-down lowers importance of every recalled fact and queues one low_confidence review each", async () => {
    const { a, b } = await recalled();
    await recordFeedback({ channelId: "C1", messageTs: replyTs(), userId: "U1", rating: "down", threadTs: "100.1" });
    expect(await imp(a)).toBeCloseTo(0.35);
    expect(await imp(b)).toBeCloseTo(0.35);
    const reviews = await db.select().from(memoryReviews);
    expect(reviews.map((r) => `${r.kind}:${r.status}:${r.memoryId}`).sort()).toEqual([`low_confidence:pending:${a}`, `low_confidence:pending:${b}`].sort());
    expect(reviews[0]!.payload).toMatchObject({ reason: "thumbs_down", channelId: "C1" });
  });

  test("a repeated identical reaction counts once; a second person's thumbs-down does not duplicate the pending review", async () => {
    const { a } = await recalled();
    const ts = replyTs();
    await recordFeedback({ channelId: "C1", messageTs: ts, userId: "U1", rating: "down", threadTs: "100.1" });
    await recordFeedback({ channelId: "C1", messageTs: ts, userId: "U1", rating: "down", threadTs: "100.1" });
    expect(await imp(a)).toBeCloseTo(0.35);
    await recordFeedback({ channelId: "C1", messageTs: ts, userId: "U2", rating: "down", threadTs: "100.1" });
    expect(await imp(a)).toBeCloseTo(0.2);
    expect(await db.select().from(memoryReviews)).toHaveLength(2);
  });

  test("thumbs-up nudges importance up, capped at 1; no review", async () => {
    const { a } = await recalled();
    await recordFeedback({ channelId: "C1", messageTs: replyTs(), userId: "U1", rating: "up", threadTs: "100.1" });
    expect(await imp(a)).toBeCloseTo(0.55);
    expect(await db.select().from(memoryReviews)).toHaveLength(0);
    await db.update(memories).set({ importance: 0.99 }).where(eq(memories.id, a));
    await recordFeedback({ channelId: "C1", messageTs: replyTs(), userId: "U2", rating: "up", threadTs: "100.1" });
    expect(await imp(a)).toBe(1);
  });

  test("a rejected review hides the fact from recall; feedback on a turn with no recall is a no-op; no thread falls back to a time window", async () => {
    const { a } = await recalled();
    await recordFeedback({ channelId: "C1", messageTs: replyTs(), userId: "U1", rating: "down" }); // thread unknown
    const [rv] = await db.select().from(memoryReviews).where(eq(memoryReviews.memoryId, a));
    expect(await decideReview(rv!.id, "UADMIN", false)).toMatchObject({ ok: true });
    expect((await db.select().from(memories).where(eq(memories.id, a)))[0]!.reviewState).toBe("rejected");
    await recordFeedback({ channelId: "COTHER", messageTs: replyTs(), userId: "U1", rating: "down" });
    expect(await db.select().from(memoryReviews)).toHaveLength(2);
  });
});

describe("B5 corrections supersede end to end", () => {
  test("'actually X' in a turn transcript supersedes the old fact and keeps it as history", async () => {
    const old = await seedMemory("shared", "The launch date is Monday June 15", { factType: "fact" });
    setMemoryLlm(async ({ system, prompt }) => {
      if (system.includes("CONTRADICTS")) return JSON.stringify({ superseded: [old] });
      return JSON.stringify({ facts: [{ text: "The launch date is Friday June 19", type: "fact" }] });
    });
    try {
      const stored = await captureTurn({
        scope: { channelId: "C1", isPrivate: false, isIm: false, userId: "U1" },
        transcript: "<@U1>: Actually the launch date is Friday June 19, not Monday\n\nAssistant: Got it, updating that.",
      });
      expect(stored).toBe(1);
      const rows = await db.select().from(memories);
      const oldRow = rows.find((r) => r.id === old)!;
      const fresh = rows.find((r) => r.id !== old)!;
      expect(oldRow).toMatchObject({ status: "superseded", supersededBy: fresh.id });
      expect(oldRow.invalidAt).not.toBeNull();
      expect(fresh).toMatchObject({ status: "active", text: "The launch date is Friday June 19" });
    } finally { installFakes(); }
  });
});

describe("B8 cost ledger", () => {
  test("price table covers the Vertex Gemini models (flash-lite is not billed as flash)", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostMicros("google/gemini-3.5-flash-lite", u)).toBe(500_000); // $0.10 + $0.40
    expect(estimateCostMicros("google/gemini-3.5-flash", u)).toBe(3_500_000);
    expect(estimateCostMicros("google/gemini-3.8-flash", u)).toBeGreaterThan(0);
    expect(estimateCostMicros("unknown-local", u)).toBe(0);
  });

  const seed = (id: string, model: string, micros: number, at: string) =>
    db.insert(turns).values({ id, channelId: "C1", trigger: "mention", status: "done", model, costMicros: micros, inputTokens: 100, outputTokens: 10, startedAt: new Date(at) });

  test("costReport groups by day and model", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await seed("t1", "google/gemini-3.5-flash", 2_000_000, `${today}T01:00:00Z`);
    await seed("t2", "google/gemini-3.5-flash-lite", 500_000, `${today}T02:00:00Z`);
    await seed("t3", "google/gemini-3.5-flash", 1_000_000, `${today}T03:00:00Z`);
    await seed("t4", "google/gemini-3.5-flash", 9_000_000, "2020-01-01T00:00:00Z");
    const r = await costReport(30);
    expect(r.totalUsd).toBeCloseTo(3.5);
    expect(r.byModel.map((m) => [m.model, m.usd, m.turns])).toEqual([["google/gemini-3.5-flash", 3, 2], ["google/gemini-3.5-flash-lite", 0.5, 1]]);
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0]).toMatchObject({ day: today, turns: 3 });
    expect(r.byDay[0]!.models["google/gemini-3.5-flash"]).toBeCloseTo(3);
  });

  test("spend alert posts once per month to the home channel when crossed; below the threshold or unset it stays silent", async () => {
    await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CHOME" });
    await db.insert(channels).values({ id: "CHOME", name: "company-brain" });
    const fake = fakeSlack();
    setSlackClientForTest(fake.client);
    const now = new Date("2026-06-15T12:00:00Z");
    await seed("t1", "google/gemini-3.5-flash", 4_000_000, "2026-06-10T00:00:00Z");
    expect(await checkSpendAlert(now, undefined)).toBe(false);
    expect(await checkSpendAlert(now, 5)).toBe(false);
    expect(fake.count("chat.postMessage")).toBe(0);
    await seed("t2", "google/gemini-3.5-flash", 2_000_000, "2026-06-12T00:00:00Z");
    expect(await checkSpendAlert(now, 5)).toBe(true);
    expect(await checkSpendAlert(now, 5)).toBe(false);
    expect(fake.count("chat.postMessage")).toBe(1);
    expect(fake.calls.find((c) => c.method === "chat.postMessage")!.args).toMatchObject({ channel: "CHOME" });
    expect(fake.calls[0]!.args.text).toContain("$6.00");
    expect(await checkSpendAlert(new Date("2026-07-02T00:00:00Z"), 5)).toBe(false); // new month, nothing spent yet
    expect(await db.select().from(settings).where(eq(settings.key, "spend_alert_2026-06"))).toHaveLength(1);
  });

  test("a failed post releases the claim so the next turn retries", async () => {
    await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CHOME" });
    await seed("t1", "google/gemini-3.5-flash", 6_000_000, "2026-06-10T00:00:00Z");
    const now = new Date("2026-06-15T12:00:00Z");
    setSlackClientForTest(fakeSlack({ "chat.postMessage": () => { throw new Error("down"); } }).client);
    expect(await checkSpendAlert(now, 5)).toBe(false);
    setSlackClientForTest(fakeSlack().client);
    expect(await checkSpendAlert(now, 5)).toBe(true);
  });
});
