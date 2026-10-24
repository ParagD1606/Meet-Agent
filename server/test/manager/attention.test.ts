// Exceptions: unassigned / no-due / due-soon / stale flags, digest sections, standup block, risks, chase cadence.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { channelMembers, channels, commitments, managerRisks, settings, users, workspace } from "../../src/db/schema";
import { encrypt } from "../../src/crypto";
import { setSlackClientForTest } from "../../src/slack/client";
import { setFeatureChannels } from "../../src/slack/proactive-features";
import { buildDailyStandup, buildWeeklyStatus, chaseTick, digestTick, riskTick, scanRisks, shouldChaseNoDue, shouldSurfaceUnassigned, taskFlags, taskListMessage } from "../../src/manager";
import { taskCommand } from "../../src/slack/task-commands";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes } from "../memory/helpers";

let quiet: string | undefined;
beforeAll(() => { installFakes(); quiet = process.env.QUIET_HOURS; delete process.env.QUIET_HOURS; }); // other files in this dir opt in to quiet hours; these tests assume the default (off)
afterAll(() => { removeFakes(); if (quiet !== undefined) process.env.QUIET_HOURS = quiet; });

const DAY = 86_400_000;
const NOW = new Date("2026-06-10T12:00:00Z"); // Wednesday
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
let fake: ReturnType<typeof fakeSlack>;
const posts = () => fake.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.args as any);
let n = 0;
const put = async (o: Partial<typeof commitments.$inferInsert>) => {
  const [r] = await db.insert(commitments).values({ id: `cm_${++n}`, text: `Task ${n}`, sourceType: "message", sourceRef: `t:${n}`, scopeTag: "shared", channelId: "C1", ownerId: "UBOB", ownerName: "Bob", assignerId: "UANN", createdAt: ago(1), ...o }).returning();
  return r!;
};

beforeEach(async () => {
  await resetDb();
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CHOME" });
  await db.insert(users).values([{ id: "UANN", name: "Ann" }, { id: "UBOB", name: "Bob" }, { id: "UEVE", name: "Eve" }]);
  await db.insert(channels).values([{ id: "C1", name: "pub", botIsMember: true }, { id: "GP", name: "priv", isPrivate: true, botIsMember: true }, { id: "CHOME", name: "home", botIsMember: true }]);
  await db.insert(channelMembers).values([{ channelId: "GP", userId: "UANN" }]);
  fake = fakeSlack();
  setSlackClientForTest(fake.client);
});

describe("taskFlags", () => {
  const base = { status: "open" as const, ownerId: "UBOB", dueAt: null as Date | null, priority: "normal" as const, createdAt: ago(1), lastNudgedAt: null as Date | null };
  test("each flag", () => {
    expect(taskFlags(base, NOW)).toEqual(["noDue"]);
    expect(taskFlags({ ...base, ownerId: null, dueAt: ago(1) }, NOW)).toEqual(["overdue", "unassigned"]);
    expect(taskFlags({ ...base, dueAt: new Date(NOW.getTime() + 2 * DAY) }, NOW)).toEqual(["dueSoon"]);
    expect(taskFlags({ ...base, dueAt: new Date(NOW.getTime() + 4 * DAY) }, NOW)).toEqual([]);
    expect(taskFlags({ ...base, createdAt: ago(15), priority: "urgent" }, NOW)).toEqual(["noDue", "stale", "urgent"]);
    expect(taskFlags({ ...base, createdAt: ago(15), lastNudgedAt: ago(2) }, NOW)).toEqual(["noDue"]); // touched recently: not stale
    expect(taskFlags({ ...base, status: "done", ownerId: null }, NOW)).toEqual([]); // closed tasks carry no flags
  });
});

describe("/brain-tasks and the daily digest", () => {
  test("sections Overdue / Unassigned / No due date / Due soon with counts and buttons; a task shows once", async () => {
    const real = Date.now();
    await put({ text: "late one", ownerId: "UANN", assignerId: "UANN", dueAt: new Date(real - 2 * DAY), status: "overdue" });
    await put({ text: "orphan", ownerId: null, ownerName: null, assignerId: "UANN" });
    await put({ text: "dateless", ownerId: "UANN", assignerId: "UBOB" });
    await put({ text: "soon", ownerId: "UANN", assignerId: "UBOB", dueAt: new Date(real + DAY) });
    await put({ text: "waiting", ownerId: "UBOB", assignerId: "UANN", dueAt: new Date(real + 10 * DAY) });
    const r = (await taskCommand({ command: "/brain-tasks", user_id: "UANN" }))!;
    const txt = JSON.stringify(r.blocks);
    for (const h of ["*Overdue* (1)", "*Unassigned (you assigned, no owner)* (1)", "*No due date* (1)", "*Due soon* (1)", "*You assigned* (1)"]) expect(txt).toContain(h);
    expect(txt.match(/orphan/g)).toHaveLength(1);
    expect(txt).toContain("brain_task_done");
  });

  test("digest carries Overdue (n), No due date (n), Waiting on others (n)", async () => {
    await put({ text: "late one", ownerId: "UANN", dueAt: ago(2), status: "overdue" });
    await put({ text: "dateless", ownerId: "UANN" });
    await put({ text: "delegated", ownerId: "UBOB", assignerId: "UANN" });
    const m = await taskListMessage("UANN", { heading: "Digest", now: NOW });
    expect(JSON.stringify(m.blocks)).toContain("*Overdue (1)* | *No due date (2)* | *Waiting on others (1)*");
    await db.insert(settings).values({ key: "followprefs:UANN", value: { digest: { on: true, time: "09:00", days: [3] } } });
    expect((await digestTick(NOW)).digests).toBe(1);
    expect(JSON.stringify(posts()[0].blocks)).toContain("Waiting on others (1)");
  });

  test("a private-channel task never reaches someone outside the channel", async () => {
    await put({ text: "secret plan", scopeTag: "channel_GP", channelId: "GP", ownerId: null, ownerName: null, assignerId: "UEVE" });
    const m = await taskListMessage("UEVE");
    expect(m.count).toBe(0);
    expect(JSON.stringify(m)).not.toContain("secret plan");
  });
});

describe("standup exception block", () => {
  const ch = { id: "C1", isPrivate: false };
  test("daily lists Unassigned and No due date; mentions readers", async () => {
    await put({ text: "orphan", ownerId: null, ownerName: null });
    await put({ text: "dateless", ownerId: "UBOB" });
    const s = (await buildDailyStandup(ch, NOW))!;
    expect(s).toContain("Needs attention");
    expect(s).toMatch(/Unassigned\* \(1\)/);
    expect(s).toMatch(/No due date\* \(2\)[\s\S]*dateless/); // the orphan has no date either
    expect(s).toContain("<@UBOB>");
  });
  test("private channel: owner outside the channel is named, not @mentioned; public standup never sees private tasks", async () => {
    await put({ text: "priv dateless", scopeTag: "channel_GP", channelId: "GP", ownerId: "UBOB", ownerName: "Bob" });
    await put({ text: "priv orphan", scopeTag: "channel_GP", channelId: "GP", ownerId: null, ownerName: null });
    const s = (await buildDailyStandup({ id: "GP", isPrivate: true }, NOW))!;
    expect(s).not.toContain("<@UBOB>");
    expect(s).toContain("Bob");
    expect(s).toContain("priv orphan");
    expect(await buildDailyStandup(ch, NOW)).toBeNull();
  });
  test("weekly adds top-5 overdue with owners, counts and stale", async () => {
    for (let i = 0; i < 6; i++) await put({ text: `late ${i}`, dueAt: ago(10 - i), status: "overdue" });
    await put({ text: "ancient", createdAt: ago(30), ownerId: "UBOB" });
    const w = (await buildWeeklyStatus(ch, NOW))!;
    expect(w).toMatch(/Overdue \(oldest first\)\* \(6\)/);
    expect(w).toContain("...and 1 more");
    expect(w).toMatch(/Stale[^\n]*\* \(1\)[\s\S]*ancient/);
  });
});

describe("risks", () => {
  test("unassigned_aging (> 3 days) and no_due_date (urgent, > 3 days); fresh or normal ones are not risks", async () => {
    await put({ text: "old orphan", ownerId: null, ownerName: null, createdAt: ago(5) });
    await put({ text: "new orphan", ownerId: null, ownerName: null, createdAt: ago(1) });
    await put({ text: "old urgent dateless", priority: "urgent", createdAt: ago(5) });
    await put({ text: "old normal dateless", createdAt: ago(5) });
    const keys = (await scanRisks(NOW)).map((r) => r.key.split(":")[0]).sort();
    expect(keys).toEqual(["no_due_date", "unassigned_aging"]);
  });
  test("de-dup by key across ticks; private-channel risk only to its own channel; DM risk nowhere", async () => {
    await setFeatureChannels("risks", ["C1", "GP"]).catch(() => undefined);
    await put({ text: "old orphan", ownerId: null, ownerName: null, createdAt: ago(5) });
    await put({ text: "priv orphan", scopeTag: "channel_GP", channelId: "GP", ownerId: null, ownerName: null, createdAt: ago(5) });
    await put({ text: "dm orphan", scopeTag: "user_UANN", channelId: null, ownerId: null, ownerName: null, createdAt: ago(5) });
    const r = await riskTick(NOW);
    expect(r.posted).toBe(2);
    const by = Object.fromEntries(posts().map((p) => [p.channel, p.text as string]));
    expect(by.C1 ?? by.CHOME).toContain("old orphan");
    expect(by.C1 ?? by.CHOME).not.toContain("priv orphan");
    expect(by.GP).toContain("priv orphan");
    expect(JSON.stringify(posts())).not.toContain("dm orphan");
    expect((await riskTick(NOW)).posted).toBe(0);
    expect((await db.select().from(managerRisks)).every((k) => /^(unassigned_aging|no_due_date):/.test(k.key))).toBe(true);
  });
});

describe("chase cadence", () => {
  const dm = () => posts().filter((p) => p.text.includes("No due date yet") || p.text.includes("Nobody owns"));
  test("pure rules: dateless chased only if urgent or > 14d, weekly, max 3; ownerless every 3 days to the assigner", () => {
    const c = { status: "open" as const, ownerId: "UBOB", dueAt: null, priority: "normal" as const, createdAt: ago(20), lastNudgedAt: null as Date | null, nudgeCount: 0 };
    expect(shouldChaseNoDue({ ...c, createdAt: ago(5) }, NOW)).toBe(false);
    expect(shouldChaseNoDue({ ...c, createdAt: ago(5), priority: "urgent" }, NOW)).toBe(true);
    expect(shouldChaseNoDue(c, NOW)).toBe(true);
    expect(shouldChaseNoDue({ ...c, lastNudgedAt: ago(6) }, NOW)).toBe(false);
    expect(shouldChaseNoDue({ ...c, lastNudgedAt: ago(7) }, NOW)).toBe(true);
    expect(shouldChaseNoDue({ ...c, nudgeCount: 3 }, NOW)).toBe(false);
    const u = { status: "open" as const, ownerId: null, assignerId: "UANN", lastNudgedAt: null as Date | null, nudgeCount: 0 };
    expect(shouldSurfaceUnassigned(u, NOW)).toBe(true);
    expect(shouldSurfaceUnassigned({ ...u, lastNudgedAt: ago(2) }, NOW)).toBe(false);
    expect(shouldSurfaceUnassigned({ ...u, lastNudgedAt: ago(3) }, NOW)).toBe(true);
    expect(shouldSurfaceUnassigned({ ...u, assignerId: null }, NOW)).toBe(false);
  });
  test("tick: old dateless task DMs its owner weekly up to 3 times; ownerless goes to the assigner only", async () => {
    const t = await put({ text: "dateless old", createdAt: ago(20) });
    const o = await put({ text: "orphan", ownerId: null, ownerName: null, assignerId: "UANN" });
    await chaseTick(NOW);
    expect(dm()).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === "conversations.open").map((c) => (c.args as any).users).sort()).toEqual(["UANN", "UBOB"]);
    await chaseTick(new Date(NOW.getTime() + DAY)); // inside both windows: silent
    expect(dm()).toHaveLength(2);
    await chaseTick(new Date(NOW.getTime() + 3 * DAY)); // orphan again, dateless not yet
    expect(dm()).toHaveLength(3);
    for (const d of [7, 14, 21, 30]) await chaseTick(new Date(NOW.getTime() + d * DAY));
    const rows = await db.select().from(commitments);
    expect(rows.find((r) => r.id === t.id)!.nudgeCount).toBe(3);
    expect(rows.find((r) => r.id === o.id)!.nudgeCount).toBe(3);
  });
  test("a private-channel orphan is never surfaced to an assigner who cannot read the channel", async () => {
    await put({ text: "secret orphan", scopeTag: "channel_GP", channelId: "GP", ownerId: null, ownerName: null, assignerId: "UEVE" });
    await chaseTick(NOW);
    expect(dm()).toHaveLength(0);
  });
});
