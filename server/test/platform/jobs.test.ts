import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, pool, resetDb } from "../db";
import { automations, researchRuns } from "../../src/db/schema";
import { automationDeps, createAutomation, type Actor } from "../../src/automations";
import { automationTick, enqueueAutomation, getBoss, startJobs, stopJobs } from "../../src/jobs";
import { deps as researchDeps, startResearch } from "../../src/research";
import { type Calls, fakeSlack, seedWorld } from "./helpers";

const mia: Actor = { userId: "UMEM", role: "member", source: "api" };
const calls: Calls = { posts: [], turns: [], research: [] };
const origAuto = { ...automationDeps };
const origResearch = { ...researchDeps };

async function until<T>(fn: () => Promise<T | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(200);
  }
  throw new Error("timed out");
}

beforeAll(async () => {
  await resetDb();
  await seedWorld();
  automationDeps.slack = async () => fakeSlack(calls);
  automationDeps.runTurn = async (i) => void calls.turns.push(i);
  researchDeps.llm = { plan: async () => ["q1"], investigate: async () => "found", synthesize: async () => "BRIEF" };
  researchDeps.tools = async () => ({});
  researchDeps.post = async (channel, thread, text) => void calls.posts.push({ channel, thread, text });
  await startJobs();
});
afterAll(async () => {
  await stopJobs();
  Object.assign(automationDeps, origAuto);
  Object.assign(researchDeps, origResearch);
});

test("startJobs is idempotent and creates the queues", async () => {
  await startJobs();
  const names = (await getBoss().getQueues()).map((q) => q.name);
  expect(names).toEqual(expect.arrayContaining(["automation-tick", "automation-run", "research-run"]));
});

test("creating a one-off reminder schedules an exact-time pg-boss job", async () => {
  const runAt = new Date(Date.now() + 10 * 60_000);
  const a = await createAutomation({ kind: "reminder", prompt: "call mom", runAt }, mia);
  const { rows } = await pool.query(
    "select start_after, state from pgboss.job where name='automation-run' and data->>'id'=$1",
    [a.id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].state).toBe("created");
  expect(Math.abs(new Date(rows[0].start_after).getTime() - runAt.getTime())).toBeLessThan(1000);
  // same fire time enqueued again (e.g. by the tick) is deduplicated by singletonKey
  await enqueueAutomation(a.id, runAt);
  const again = await pool.query("select 1 from pgboss.job where name='automation-run' and data->>'id'=$1", [a.id]);
  expect(again.rows).toHaveLength(1);
});

test("an overdue reminder is picked up by the tick and delivered by the worker exactly once", async () => {
  const a = await createAutomation({ kind: "reminder", prompt: "overdue ping", runAt: new Date(Date.now() + 60_000) }, mia);
  await db.update(automations).set({ runAt: new Date(Date.now() - 5000) }).where(eq(automations.id, a.id));
  expect(await automationTick()).toBeGreaterThanOrEqual(1);
  const row = await until(async () => {
    const [r] = await db.select().from(automations).where(eq(automations.id, a.id));
    return r!.lastStatus === "ok" ? r! : false;
  });
  expect(row.enabled).toBe(false);
  expect(calls.posts.filter((p) => String(p.text).includes("overdue ping"))).toHaveLength(1);
  expect(await automationTick()).toBe(0);
});

test("startResearch enqueues and the worker runs it to completion", async () => {
  const id = await startResearch({ requesterId: "UMEM", channelId: "CPUB", threadTs: "9.9", question: "why?" });
  const r = await until(async () => {
    const [x] = await db.select().from(researchRuns).where(eq(researchRuns.id, id));
    return x!.status === "done" ? x! : false;
  });
  expect(r.result).toBe("BRIEF");
  expect(calls.posts).toContainEqual({ channel: "CPUB", thread: "9.9", text: "BRIEF" });
});
