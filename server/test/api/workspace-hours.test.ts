import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerManagerJobs, workingHours, quietHoursOn } from "../../src/manager";
import { nextWindow } from "../../src/slack/teammate";
import { call, db, login, resetDb } from "./helpers";
import { memories } from "../../src/db/schema";
import { fakeVector } from "../memory/helpers";

const sched: { name: string; tz?: string }[] = [];
const fakeBoss: any = {
  createQueue: async () => {}, work: async () => {},
  schedule: async (name: string, _cron: string, _d: unknown, o?: { tz?: string }) => void sched.push({ name, tz: o?.tz }),
};
const body = { timezone: "Asia/Kolkata", start: 10, end: 19, quietHours: true, backfillDays: 14 };
const prev = process.env.QUIET_HOURS;

beforeAll(async () => { await resetDb(); delete process.env.QUIET_HOURS; await registerManagerJobs(fakeBoss); });
afterAll(() => { if (prev !== undefined) process.env.QUIET_HOURS = prev; });

describe("workspace hours", () => {
  test("non-admin is forbidden, admin reads defaults", async () => {
    const member = await login("UM", "member");
    const admin = await login("UA", "admin");
    expect((await call("GET", "/api/settings/workspace-hours", { cookie: member })).status).toBe(403);
    expect((await call("PUT", "/api/settings/workspace-hours", { cookie: member, body })).status).toBe(403);
    expect(await (await call("GET", "/api/settings/workspace-hours", { cookie: admin })).json()).toEqual({ timezone: "UTC", start: 9, end: 18, quietHours: false, backfillDays: 30 });
  });

  test("invalid input is rejected and nothing is saved", async () => {
    const admin = await login("UA2", "admin");
    for (const bad of [{ timezone: "Mars/Olympus" }, { start: 18, end: 9 }, { start: 9, end: 9 }, { end: 25 }, { start: -1 }, { backfillDays: 0 }, { backfillDays: 91 }, { quietHours: "yes" }]) {
      expect((await call("PUT", "/api/settings/workspace-hours", { cookie: admin, body: { ...body, ...bad } })).status).toBe(400);
    }
    expect((await workingHours()).tz).toBe("UTC");
  });

  test("save persists, drives quiet hours and nextWindow, and re-applies the manager cron schedules", async () => {
    const admin = await login("UA3", "admin");
    sched.length = 0;
    const r = await call("PUT", "/api/settings/workspace-hours", { cookie: admin, body });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(body);
    expect(await (await call("GET", "/api/settings/workspace-hours", { cookie: admin })).json()).toEqual(body);
    expect(sched.length).toBe(5);
    expect(sched.every((s) => s.tz === "Asia/Kolkata")).toBe(true);
    expect(quietHoursOn()).toBe(true);
    // 10:00-19:00 IST = 04:30-13:30 UTC. Tue 03:00 UTC is outside, next window starts 10:00 IST (04:30 UTC, hour grid: 05:00 IST-aligned scan)
    await workingHours();
    expect(nextWindow(new Date("2026-10-27T05:00:00Z"))).toBeNull();
    expect(nextWindow(new Date("2026-10-27T15:00:00Z"))).not.toBeNull();
    // switching quiet hours off releases it again
    await call("PUT", "/api/settings/workspace-hours", { cookie: admin, body: { ...body, quietHours: false } });
    expect(quietHoursOn()).toBe(false);
    expect(nextWindow(new Date("2026-10-27T15:00:00Z"))).toBeNull();
  });
});

test("overview memory count equals the Memories page filter (ok + still valid)", async () => {
  await resetDb();
  const admin = await login("UAO", "admin");
  const row = (text: string, o: Partial<typeof memories.$inferInsert> = {}) => ({ scopeTag: "shared", text, embedding: fakeVector(text), ...o });
  await db.insert(memories).values([
    row("counted"), row("pending", { reviewState: "pending" }), row("rejected", { reviewState: "rejected" }),
    row("invalid", { invalidAt: new Date() }), row("superseded", { status: "superseded" }), row("private", { scopeTag: "user_UAO" }),
  ]);
  expect(((await (await call("GET", "/api/overview", { cookie: admin })).json()) as any).memoryCount).toBe(1);
});
