import { afterAll, beforeAll, expect, test } from "bun:test";
import { pool, resetDb } from "../db";
import { enqueueAskDelivery, getBoss, startJobs, stopJobs, sweepAskDeliveries } from "../../src/jobs";
import { attemptDelivery } from "../../src/slack/teammate";

const FUTURE = new Date("2026-10-26T09:00:00Z");
const ask = (id: string, status: string, createdAt = new Date().toISOString()) =>
  pool.query("insert into settings (key, value) values ($1, $2)", [`ask:${id}`, { id, status, asker: "UA", owner: "UO", question: "q", origin: { channelId: "C", isPrivate: false, isIm: false }, createdAt }]);
const job = async (id: string) => (await pool.query("select state, start_after from pgboss.job where name='ask-deliver' and data->>'id'=$1", [id])).rows[0];
const queue = (id: string) => getBoss().sendAfter("ask-deliver", { id }, { singletonKey: `${id}:old` }, FUTURE);

beforeAll(async () => { await resetDb(); await startJobs(); });
afterAll(stopJobs);

test("attemptDelivery is a no-op for an ask that is no longer confirmed", async () => {
  await ask("done1", "answered");
  expect(await attemptDelivery("done1")).toBe("skipped");
  expect(await attemptDelivery("missing")).toBe("skipped");
});

test("with quiet hours off a deferred delivery is enqueued to run now, not at the future window", async () => {
  await enqueueAskDelivery("now1", FUTURE);
  expect(new Date((await job("now1")).start_after).getTime()).toBeLessThan(Date.now() + 5_000);
});

test("boot sweep cancels stale/finished asks and releases deliverable ones", async () => {
  await ask("stale", "confirmed", new Date(Date.now() - 48 * 3_600_000).toISOString());
  await ask("answered", "answered");
  await ask("live", "confirmed");
  for (const id of ["stale", "answered", "live", "ghost"]) await queue(id);
  const r = await sweepAskDeliveries();
  expect(r).toEqual({ cancelled: 4, released: 1 }); // incl. the now1 job of the previous test (its ask does not exist)
  for (const id of ["stale", "answered", "ghost"]) expect((await job(id)).state).toBe("cancelled");
  const live = await job("live");
  expect(["created", "active", "completed", "failed"]).toContain(live.state); // released: the worker may already have picked it up
  expect(new Date(live.start_after).getTime()).toBeLessThan(Date.now() + 5_000);
  expect(await sweepAskDeliveries()).toEqual({ cancelled: 0, released: 0 }); // idempotent
});
