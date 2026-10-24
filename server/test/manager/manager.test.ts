// Manager behaviours: commitment extraction, chase timing / quiet hours / caps, scope isolation, risk dedupe.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { channelMembers, channels, commitments, meetings, users, workspace } from "../../src/db/schema";
import { encrypt } from "../../src/crypto";
import { setSlackClientForTest } from "../../src/slack/client";
import { setFeatureChannels } from "../../src/slack/proactive-features";
import { setMemoryLlm } from "../../src/memory/llm";
import { readTags } from "../../src/memory/scope";
import {
  addCommitment, buildDailyStandup, buildWeeklyStatus, chaseTick, extractFromText, handleCommitmentAction, inWorkingHours,
  listCommitments, riskTick, runExtraction, shouldNudge, standupTick,
} from "../../src/manager";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

process.env.QUIET_HOURS = "1"; // quiet hours are opt-in; these tests cover the opt-in behaviour

beforeAll(installFakes);
afterAll(removeFakes);

const NOW = new Date("2026-06-10T12:00:00Z"); // a Wednesday
const hrs = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
let fake: ReturnType<typeof fakeSlack>;
const posts = () => fake.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.args);

beforeEach(async () => {
  await resetDb();
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CHOME" });
  await db.insert(users).values([{ id: "UPRIYA", name: "Priya" }, { id: "UBOB", name: "Bob" }]);
  await db.insert(channels).values([
    { id: "C1", name: "pub", botIsMember: true },
    { id: "GP", name: "priv", isPrivate: true, botIsMember: true },
    { id: "CHOME", name: "home", botIsMember: true },
  ]);
  fake = fakeSlack();
  setSlackClientForTest(fake.client);
  setMemoryLlm(async () => '{"commitments":[]}');
});

const base = { sourceType: "message" as const, scopeTag: "shared", channelId: "C1", threadTs: "1.1" };
let n = 0;
const mk = (o: Partial<Parameters<typeof addCommitment>[0]> = {}) => addCommitment({ ...base, ownerId: "UPRIYA", ownerName: "Priya", text: `Ship thing ${++n}`, sourceRef: `t:${n}`, ...o });

describe("extraction", () => {
  test("decision fact -> commitment with resolved owner and due date; private fact keeps its scope; re-run is idempotent", async () => {
    setMemoryLlm(async () => '{"commitments":[{"owner":"Priya","text":"Ship the migration","due":"2026-06-12"}]}');
    await seedMemory("shared", "We decided Priya will ship the migration by Friday", { factType: "decision", sourceRef: "C1", createdAt: hrs(-1) });
    await seedMemory("channel_GP", "We decided Bob will fix the secret leak by Monday", { factType: "decision", createdAt: hrs(-1) });
    await seedMemory("shared", "We will do something by Friday", { factType: "fact", sourceRef: "C1", createdAt: hrs(-1) }); // plain facts are not scanned
    expect(await runExtraction(NOW)).toEqual({ created: 2, failed: 0 });
    const rows = await db.select().from(commitments);
    const pub = rows.find((r) => r.scopeTag === "shared")!;
    expect(pub).toMatchObject({ ownerId: "UPRIYA", channelId: "C1", sourceType: "fact", text: "Ship the migration" });
    expect(pub.dueAt!.toISOString().slice(0, 10)).toBe("2026-06-12");
    expect(rows.find((r) => r.scopeTag === "channel_GP")!.channelId).toBe("GP");
    expect((await runExtraction(NOW)).created).toBe(0);
  });

  test("meeting tasks become commitments scoped by the channel's privacy", async () => {
    await db.insert(meetings).values({
      id: "m1", sourceFileId: "F1", channelId: "GP", title: "Sync", transcript: "t", status: "ready", updatedAt: hrs(-1),
      tasks: [{ title: "Draft the plan", assigneeName: "Bob", dueDate: "2026-06-15" }, { title: "Unowned thing" }],
    });
    await runExtraction(NOW);
    const rows = await db.select().from(commitments);
    expect(rows).toHaveLength(1); // an item with nobody to assign stays proposed on the Meeting notes page: it is not a task
    expect(rows.every((r) => r.scopeTag === "channel_GP" && r.sourceType === "meeting")).toBe(true);
    expect(rows.find((r) => r.text === "Draft the plan")!.ownerId).toBe("UBOB");
    const [m] = await db.select().from(meetings);
    expect((m!.tasks as any[]).find((t) => t.title === "Unowned thing")).toMatchObject({ approval: "proposed" });
  });

  test("text without a promise cue never reaches the model; a failing model leaves the cursor so the run retries", async () => {
    let calls = 0;
    setMemoryLlm(async () => { calls++; return "not json"; });
    expect(await extractFromText("The sky is blue", { sourceRef: "x", sourceType: "message", scopeTag: "shared" })).toBe(0);
    expect(calls).toBe(0);
    await seedMemory("shared", "Priya will ship it by Friday", { factType: "decision", createdAt: hrs(-1) });
    expect((await runExtraction(NOW)).failed).toBe(1);
    setMemoryLlm(async () => '{"commitments":[{"owner":"U1234","text":"Ship it","due":null}]}');
    expect((await runExtraction(NOW)).created).toBe(1);
  });
});

describe("chase timing", () => {
  const c = (dueH: number | null, last: number | null = null, count = 0, status: "open" | "overdue" = "open") =>
    ({ status, ownerId: "U", dueAt: dueH === null ? null : hrs(dueH), lastNudgedAt: last === null ? null : hrs(last), nudgeCount: count });
  test("pure rules", () => {
    expect(shouldNudge(c(48), NOW)).toBe(false); // far away
    expect(shouldNudge(c(20), NOW)).toBe(true); // due within 24h
    expect(shouldNudge(c(null), NOW)).toBe(false); // no due date
    expect(shouldNudge(c(20, -1, 1), NOW)).toBe(false); // already nudged while not yet due
    expect(shouldNudge(c(-1, -5, 1, "overdue"), NOW)).toBe(true); // first overdue tick after a due-soon nudge
    expect(shouldNudge(c(-30, -2, 2, "overdue"), NOW)).toBe(false); // nudged 2h ago
    expect(shouldNudge(c(-30, -25, 2, "overdue"), NOW)).toBe(true); // daily
    expect(shouldNudge(c(-30, -25, 3, "overdue"), NOW)).toBe(false); // max nudges
    expect(shouldNudge({ ...c(-1), status: "done" as never }, NOW)).toBe(false);
  });

  test("quiet hours: weekday window in the workspace timezone", () => {
    const h = { tz: "UTC", start: 9, end: 18 };
    expect(inWorkingHours(NOW, h)).toBe(true);
    expect(inWorkingHours(new Date("2026-06-10T20:00:00Z"), h)).toBe(false);
    expect(inWorkingHours(new Date("2026-06-13T12:00:00Z"), h)).toBe(false); // Saturday
    expect(inWorkingHours(NOW, { ...h, tz: "Asia/Kolkata" })).toBe(true); // 17:30 local
    expect(inWorkingHours(NOW, { ...h, tz: "Pacific/Auckland" })).toBe(false); // midnight local
    expect(inWorkingHours(NOW, { ...h, tz: "Not/AZone" })).toBe(true); // falls back to UTC
  });

  test("members are @mentioned in the thread (with buttons), others get a DM; marks overdue", async () => {
    await db.insert(channelMembers).values({ channelId: "C1", userId: "UPRIYA" });
    await mk({ dueAt: hrs(2) });
    await mk({ ownerId: "UBOB", ownerName: "Bob", dueAt: hrs(-3) });
    expect(await chaseTick(NOW)).toBe(2);
    const [thread, dm] = posts();
    expect(thread).toMatchObject({ channel: "C1", thread_ts: "1.1" });
    expect(thread.text).toContain("<@UPRIYA>");
    expect(thread.blocks[1].elements.map((e: any) => e.action_id)).toEqual(["brain_commit_done", "brain_commit_drop"]);
    expect(dm.channel).toBe("D_UBOB");
    expect((await db.select().from(commitments)).map((r) => r.status).sort()).toEqual(["open", "overdue"]);
    expect(await chaseTick(NOW)).toBe(0); // not nudged twice
  });

  test("nothing is sent outside working hours", async () => {
    await mk({ dueAt: hrs(2) });
    expect(await chaseTick(new Date("2026-06-10T22:00:00Z"))).toBe(0);
    expect(posts()).toHaveLength(0);
  });

  test("per-person cap: a fourth nudge in a burst is held back and not counted", async () => {
    for (let i = 0; i < 5; i++) await mk({ dueAt: hrs(2) });
    expect(await chaseTick(NOW)).toBe(3);
    const held = await db.select().from(commitments);
    expect(held.filter((r) => r.nudgeCount === 0)).toHaveLength(2);
  });

  test("a failed send restores the claim", async () => {
    setSlackClientForTest(fakeSlack({ "chat.postMessage": () => { throw new Error("boom"); } }).client);
    await mk({ dueAt: hrs(2) });
    expect(await chaseTick(NOW)).toBe(0);
    expect((await db.select().from(commitments))[0]).toMatchObject({ nudgeCount: 0, lastNudgedAt: null });
  });

  test("Done button: owner can close, someone else cannot", async () => {
    await mk({ dueAt: hrs(2) });
    const id = (await db.select().from(commitments))[0]!.id;
    const click = (user: string) => handleCommitmentAction({ user: { id: user }, container: { channel_id: "C1", message_ts: "5.5" } }, { action_id: "brain_commit_done", value: id });
    expect(await click("UBOB")).toBe(true);
    expect((await db.select().from(commitments))[0]!.status).toBe("open");
    await click("UPRIYA");
    expect((await db.select().from(commitments))[0]!.status).toBe("done");
    expect(fake.calls.some((c) => c.method === "chat.update")).toBe(true);
    expect(await handleCommitmentAction({}, { action_id: "journey_quiet" })).toBe(false);
  });
});

describe("scope isolation", () => {
  beforeEach(async () => {
    await mk({ text: "Public launch checklist", scopeTag: "shared", channelId: "C1" });
    await mk({ text: "SECRET acquisition prep", scopeTag: "channel_GP", channelId: "GP" });
    await mk({ text: "SECRET misfiled", scopeTag: "channel_GP", channelId: "C1" }); // even with a wrong channel id
    await seedMemory("channel_GP", "SECRET private roadmap decision", { factType: "decision", sourceRef: "GP", createdAt: hrs(-2) });
  });

  test("a public channel's standup and weekly status never contain private-channel content", async () => {
    const daily = (await buildDailyStandup({ id: "C1", isPrivate: false }, NOW))!;
    const weekly = (await buildWeeklyStatus({ id: "C1", isPrivate: false }, NOW))!;
    expect(daily).toContain("Public launch checklist");
    for (const t of [daily, weekly]) expect(t).not.toContain("SECRET");
  });

  test("the private channel sees its own and shared items", async () => {
    const daily = (await buildDailyStandup({ id: "GP", isPrivate: true }, NOW))!;
    expect(daily).toContain("SECRET acquisition prep");
    const weekly = (await buildWeeklyStatus({ id: "GP", isPrivate: true }, NOW))!;
    expect(weekly).toContain("SECRET private roadmap decision");
  });

  test("standupTick only posts to opted-in channels", async () => {
    expect(await standupTick("daily", NOW)).toEqual([]);
    await setFeatureChannels("standup", ["C1"]);
    expect(await standupTick("daily", NOW)).toEqual(["C1"]);
    expect(posts()[0].text).not.toContain("SECRET");
  });

  test("API listing follows the requester's read tags: member of GP sees it, a non-member does not", async () => {
    await db.insert(channelMembers).values({ channelId: "GP", userId: "UBOB" });
    const tagsFor = (u: string) => readTags({ channelId: "", isPrivate: false, isIm: true, userId: u });
    const bob = (await listCommitments({ tags: await tagsFor("UBOB") })).map((r) => r.text);
    const priya = (await listCommitments({ tags: await tagsFor("UPRIYA") })).map((r) => r.text);
    expect(bob).toContain("SECRET acquisition prep");
    expect(priya).not.toContain("SECRET acquisition prep");
    expect(priya).toContain("Public launch checklist");
  });
});

describe("risk scan", () => {
  const old = (o: Partial<Parameters<typeof addCommitment>[0]> = {}) => mk({ dueAt: hrs(-24 * 5), ...o });

  test("overdue commitment is posted once to home (de-duplicated across runs); private-scope risks stay out of home", async () => {
    await old({ text: "Fix billing bug" });
    await old({ text: "SECRET merger memo", scopeTag: "channel_GP", channelId: "GP" });
    let r = await riskTick(NOW);
    expect(r).toEqual({ posted: 1, channels: ["CHOME"] });
    expect(posts()[0].text).toContain("Fix billing bug");
    expect(posts()[0].text).not.toContain("SECRET");
    r = await riskTick(NOW);
    expect(r.posted).toBe(0);
    expect(posts()).toHaveLength(1);
  });

  test("private risk goes only to its own opted-in private channel", async () => {
    await old({ text: "SECRET merger memo", scopeTag: "channel_GP", channelId: "GP" });
    expect((await riskTick(NOW)).posted).toBe(0);
    await setFeatureChannels("risks", ["GP"]);
    expect(await riskTick(NOW)).toEqual({ posted: 1, channels: ["GP"] });
  });

  test("duplicated work: near-identical commitments, different owners, same scope", async () => {
    await mk({ text: "Migrate the billing service to Stripe", dueAt: hrs(100) });
    await mk({ ownerId: "UBOB", ownerName: "Bob", text: "Migrate the billing service to Stripe", dueAt: hrs(100) });
    await mk({ ownerId: "UBOB", ownerName: "Bob", text: "Order team lunch", dueAt: hrs(100) });
    await riskTick(NOW);
    expect(posts()[0].text).toContain("duplicated work");
    expect(posts()[0].text).not.toContain("lunch");
  });

  test("stale decision with a newer related fact", async () => {
    const d = await seedMemory("shared", "Decision: use MySQL for reports", { factType: "decision", validAt: new Date("2025-10-01") });
    const f = await seedMemory("shared", "Reports now run on Postgres", { validAt: new Date("2026-05-01") });
    const { memoryEdges } = await import("../../src/db/schema");
    await db.insert(memoryEdges).values({ fromId: d, toId: f });
    await riskTick(NOW);
    expect(posts()[0].text).toContain("stale decision");
  });
});

test("quiet hours are off by default: chases and routed questions are not held to a working window", async () => {
  const { nextWindow } = await import("../../src/slack/teammate");
  const night = new Date("2026-10-24T22:30:00Z"); // Saturday night UTC
  process.env.QUIET_HOURS = "";
  try {
    expect(nextWindow(night)).toBeNull();
    process.env.QUIET_HOURS = "1";
    expect(nextWindow(night)).not.toBeNull();
  } finally { process.env.QUIET_HOURS = "1"; }
});
