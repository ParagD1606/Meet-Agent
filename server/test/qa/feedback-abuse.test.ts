// QA M5: reaction feedback can't be farmed by flipping or by a single drive-by.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { memories, memoryReviews, recallLog, turns } from "../../src/db/schema";
import { recordFeedback } from "../../src/slack/reactions";
import { db, resetDb } from "../db";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
beforeEach(resetDb);
const replyTs = () => (Date.now() / 1000).toFixed(6);
const imp = async (id: number) => (await db.select().from(memories).where(eq(memories.id, id)))[0]!.importance;

async function recalled() {
  const a = await seedMemory("shared", "Refunds take thirty days", { importance: 0.5 });
  await db.insert(recallLog).values({ channelId: "C1", threadKey: "100.1", messageTs: "100.1", query: "refunds?", hitIds: [a] });
  await db.insert(turns).values({ id: "t1", channelId: "C1", threadTs: "100.1", userId: "UASK", trigger: "mention" });
  return a;
}

test("flipping down/up/down never re-applies the penalty", async () => {
  const a = await recalled();
  const ts = replyTs();
  for (const rating of ["down", "up", "down", "up", "down"] as const) await recordFeedback({ channelId: "C1", messageTs: ts, userId: "UASK", rating, threadTs: "100.1" });
  expect(await imp(a)).toBeCloseTo(0.35); // exactly one down, nothing else
});

test("a bystander's lone thumbs-down is ignored; the asker's counts; two bystanders count", async () => {
  const a = await recalled();
  await recordFeedback({ channelId: "C1", messageTs: replyTs(), userId: "UDRIVEBY", rating: "down", threadTs: "100.1" });
  expect(await imp(a)).toBeCloseTo(0.5);
  expect(await db.select().from(memoryReviews)).toHaveLength(0);
  const ts = replyTs();
  await recordFeedback({ channelId: "C1", messageTs: ts, userId: "UB1", rating: "down", threadTs: "100.1" });
  await recordFeedback({ channelId: "C1", messageTs: ts, userId: "UB2", rating: "down", threadTs: "100.1" });
  expect(await imp(a)).toBeCloseTo(0.35);
});

test("without a thread, an ambiguous window (two recalling turns) blames nobody", async () => {
  const a = await recalled();
  const b = await seedMemory("shared", "Unrelated other turn fact", { importance: 0.5 });
  await db.insert(recallLog).values({ channelId: "C1", threadKey: "200.1", messageTs: "200.1", query: "other?", hitIds: [b] });
  await recordFeedback({ channelId: "C1", messageTs: replyTs(), userId: "UASK", rating: "down" });
  expect(await imp(a)).toBeCloseTo(0.5);
  expect(await imp(b)).toBeCloseTo(0.5);
});
