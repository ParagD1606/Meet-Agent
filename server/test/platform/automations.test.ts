import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { automations } from "../../src/db/schema";
import {
  type Actor, OWNER_CAP, createAutomation, cronMinGapSeconds, deleteAutomation, executeAutomation, findDue, listAutomations,
  runNow, updateAutomation, automationDeps,
} from "../../src/automations";
import { automationTools } from "../../src/automations/tools";
import { type Calls, fakeSlack, seedWorld } from "./helpers";

const owner: Actor = { userId: "UOWN", role: "owner", source: "api" };
const admin: Actor = { userId: "UADM", role: "admin", source: "api" };
const mia: Actor = { userId: "UMEM", role: "member", source: "api" };
const max: Actor = { userId: "UMEM2", role: "member", source: "api" };
const orig = { ...automationDeps };
let calls: Calls;
let info: () => any;

beforeEach(async () => {
  await resetDb();
  await seedWorld();
  calls = { posts: [], turns: [], research: [] };
  info = () => ({ ok: true, channel: { id: "CPUB", is_member: true, is_private: false } });
  automationDeps.slack = async () => fakeSlack(calls, () => info());
  automationDeps.runTurn = async (i) => void calls.turns.push(i);
  automationDeps.startResearch = async (a) => (calls.research.push(a), "rs_1");
});
afterEach(() => Object.assign(automationDeps, orig));

const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as { code?: string } | null)?.code ?? null;
const digest = (o: Record<string, unknown> = {}) => ({ kind: "digest" as const, prompt: "weekly recap", cron: "0 9 * * 1", ...o });
const future = (ms: number) => new Date(Date.now() + ms);
const row = async (id: string) => (await db.select().from(automations).where(eq(automations.id, id)))[0]!;

test("cron validation and minimum interval", async () => {
  expect(cronMinGapSeconds("0 9 * * 1-5")).toBe(86400);
  expect(cronMinGapSeconds("0 * * * *")).toBe(3600);
  expect(cronMinGapSeconds("not a cron")).toBeNull();
  expect(cronMinGapSeconds("* * * * * *")).toBeNull(); // 6 fields
  expect(cronMinGapSeconds("*/5 * * * *")).toBe(300);
  expect(cronMinGapSeconds("0,5 9 * * 1")).toBe(300); // sparse pattern with a tight pair later on
  expect(await code(createAutomation(digest({ cron: "*/5 * * * *" }), mia))).toBe("invalid");
  expect(await code(createAutomation(digest({ cron: "0,30 * * * *" }), mia))).toBe("invalid");
  expect(await code(createAutomation(digest({ cron: "garbage" }), mia))).toBe("invalid");
  expect(await code(createAutomation(digest({ cron: "0 * * * *" }), mia))).toBeNull();
});

test("timing: exactly one of cron/runAt, runAt in future, prompt required", async () => {
  expect(await code(createAutomation(digest({ runAt: future(3_600_000) }), mia))).toBe("invalid");
  expect(await code(createAutomation(digest({ cron: undefined }), mia))).toBe("invalid");
  expect(await code(createAutomation({ kind: "reminder", prompt: "x", runAt: new Date(Date.now() - 1000) }, mia))).toBe("invalid");
  expect(await code(createAutomation({ kind: "reminder", prompt: "  ", runAt: future(3_600_000) }, mia))).toBe("invalid");
  expect(await code(createAutomation({ kind: "reminder", prompt: "x", runAt: "nonsense" }, mia))).toBe("invalid");
});

test("per-owner cap of 20 for members; admins exempt; other owners unaffected", async () => {
  for (let i = 0; i < OWNER_CAP; i++) await createAutomation(digest(), mia);
  expect(await code(createAutomation(digest(), mia))).toBe("limit");
  expect(await code(createAutomation(digest(), max))).toBeNull();
  // admin creating for a capped member is exempt
  expect(await code(createAutomation(digest({ ownerUserId: "UMEM" }), admin))).toBeNull();
  expect(await code(createAutomation(digest({ ownerUserId: "UMEM" }), max))).toBe("forbidden");
});

test("list / update / delete respect ownership; admins manage others", async () => {
  const a = await createAutomation(digest(), mia);
  await createAutomation(digest(), max);
  expect(await listAutomations(mia)).toHaveLength(1);
  expect(await listAutomations(admin)).toHaveLength(2);
  expect(await code(updateAutomation(a.id, { prompt: "hijack" }, max))).toBe("forbidden");
  expect(await code(deleteAutomation(a.id, max))).toBe("forbidden");
  expect((await updateAutomation(a.id, { prompt: "new", enabled: false }, admin)).prompt).toBe("new");
  expect(await code(updateAutomation(a.id, { cron: "*/10 * * * *" }, mia))).toBe("invalid");
  await deleteAutomation(a.id, mia);
  expect(await code(deleteAutomation(a.id, mia))).toBe("not_found");
});

test("destination rules: fail closed, private channels", async () => {
  expect(await code(createAutomation(digest({ destChannelId: "CUNKNOWN" }), mia))).toBe("forbidden");
  expect(await code(createAutomation(digest({ destChannelId: "CPUBNOBOT" }), mia))).toBe("invalid");
  expect(await code(createAutomation(digest({ destChannelId: "CPUB" }), mia))).toBeNull();
  // API: only admins may target private channels
  expect(await code(createAutomation(digest({ destChannelId: "CPRIV" }), mia))).toBe("forbidden");
  expect(await code(createAutomation(digest({ destChannelId: "CPRIV" }), admin))).toBeNull();
  // Slack: only channel members
  expect(await code(createAutomation(digest({ destChannelId: "CPRIV" }), { ...mia, source: "slack" }))).toBeNull();
  expect(await code(createAutomation(digest({ destChannelId: "CPRIV" }), { ...max, source: "slack" }))).toBe("forbidden");
  expect(await code(createAutomation(digest({ destChannelId: "CPRIV" }), { ...admin, source: "slack" }))).toBe("forbidden");
  // update to a private channel is checked too
  const a = await createAutomation(digest(), mia);
  expect(await code(updateAutomation(a.id, { destChannelId: "CPRIV" }, mia))).toBe("forbidden");
});

test("digest happy path: read-only, org connections only, private flag from Slack", async () => {
  const a = await createAutomation(digest({ destChannelId: "CPRIV" }), admin);
  info = () => ({ ok: true, channel: { id: "CPRIV", is_member: true, is_private: true } });
  expect(await executeAutomation(a.id, { manual: true })).toBe("ok");
  expect(calls.turns).toHaveLength(1);
  expect(calls.turns[0]).toMatchObject({
    trigger: "automation", channelId: "CPRIV", userId: "UADM", isPrivate: true, isIm: false, readOnly: true, orgConnectionsOnly: true,
  });
  expect(calls.turns[0].text).toContain("weekly recap");
  expect((await row(a.id)).lastStatus).toBe("ok");
});

test("digest into DM opens the owner's DM", async () => {
  const a = await createAutomation(digest(), mia);
  expect(await executeAutomation(a.id, { manual: true })).toBe("ok");
  expect(calls.turns[0]).toMatchObject({ channelId: "DDM", isIm: true, readOnly: true, orgConnectionsOnly: true });
});

test("digest fails closed on any ambiguity: nothing is run", async () => {
  const a = await createAutomation(digest({ destChannelId: "CPUB" }), mia);
  const cases: [string, () => any][] = [
    ["info not ok", () => ({ ok: false, error: "channel_not_found" })],
    ["no channel", () => ({ ok: true })],
    ["bot not member", () => ({ ok: true, channel: { is_member: false, is_private: false } })],
    ["member unknown", () => ({ ok: true, channel: { is_private: false } })],
    ["privacy unknown", () => ({ ok: true, channel: { is_member: true } })],
    ["archived", () => ({ ok: true, channel: { is_member: true, is_private: false, is_archived: true } })],
    ["is im", () => ({ ok: true, channel: { is_member: true, is_private: false, is_im: true } })],
    ["throws", () => { throw new Error("boom"); }],
  ];
  for (const [name, fn] of cases) {
    info = fn;
    const status = await executeAutomation(a.id, { manual: true });
    expect(status, name).toMatch(/^(skipped|error): /);
    expect(calls.turns, name).toHaveLength(0);
    expect((await row(a.id)).lastStatus, name).toBe(status);
  }
});

test("digest skipped when owner is deactivated/unknown; runTurn failure is recorded", async () => {
  const gone = await createAutomation(digest(), { userId: "UGONE", role: "member" });
  expect(await executeAutomation(gone.id, { manual: true })).toBe("skipped: owner inactive or unknown");
  await db.update(automations).set({ ownerUserId: "UNKNOWN" }).where(eq(automations.id, gone.id));
  expect(await executeAutomation(gone.id, { manual: true })).toBe("skipped: owner inactive or unknown");
  const a = await createAutomation(digest(), mia);
  automationDeps.runTurn = async () => { throw new Error("model down"); };
  expect(await executeAutomation(a.id, { manual: true })).toBe("error: model down");
  expect(calls.posts).toHaveLength(0);
});

test("research-prefixed digest starts research instead of a plain turn", async () => {
  const a = await createAutomation(digest({ prompt: "research: what did competitors ship?", destChannelId: "CPUB" }), mia);
  expect(await executeAutomation(a.id, { manual: true })).toBe("ok");
  expect(calls.turns).toHaveLength(0);
  expect(calls.research[0]).toMatchObject({ requesterId: "UMEM", channelId: "CPUB", question: "what did competitors ship?" });
});

test("reminder posts the owner's text; one-off disables itself; duplicate fire is a no-op", async () => {
  const at = future(60_000);
  const a = await createAutomation({ kind: "reminder", prompt: "ship the release", runAt: at, destChannelId: "CPUB" }, mia);
  const fireAt = a.runAt!;
  expect(await executeAutomation(a.id, { fireAt })).toBe("ok");
  expect(calls.posts).toHaveLength(1);
  expect(calls.posts[0]).toMatchObject({ channel: "CPUB" });
  expect(calls.posts[0].text).toContain("ship the release");
  const r = await row(a.id);
  expect(r.enabled).toBe(false);
  expect(r.lastRunAt).not.toBeNull();
  expect(await executeAutomation(a.id, { fireAt })).toBe("not-run");
  expect(calls.posts).toHaveLength(1);
});

test("reminder without destination DMs the owner", async () => {
  const a = await createAutomation({ kind: "reminder", prompt: "stretch", runAt: future(60_000) }, mia);
  await executeAutomation(a.id, { manual: true });
  expect(calls.posts[0]).toMatchObject({ channel: "UMEM" });
  expect((await row(a.id)).enabled).toBe(true); // manual run does not consume a one-off
});

test("findDue: cron fires once per slot, one-offs once, disabled never", async () => {
  const H = 3_600_000;
  const now = new Date();
  const topOfHour = (d: Date) => new Date(Math.floor(d.getTime() / H) * H);
  const cron = await createAutomation(digest({ cron: "0 * * * *" }), mia);
  const oneOff = await createAutomation({ kind: "reminder", prompt: "x", runAt: future(2 * H) }, mia);
  const off = await createAutomation(digest({ cron: "0 * * * *", enabled: false }), mia);
  for (const a of [cron, off]) await db.update(automations).set({ createdAt: new Date(now.getTime() - 3 * H) }).where(eq(automations.id, a.id));
  expect(await findDue(now)).toEqual([{ id: cron.id, fireAt: topOfHour(now) }]);
  expect(await executeAutomation(cron.id, { fireAt: topOfHour(now) })).toBe("ok");
  expect(await executeAutomation(cron.id, { fireAt: topOfHour(now) })).toBe("not-run");
  expect(await findDue(now)).toEqual([]);
  const later = new Date(now.getTime() + 3 * H);
  expect((await findDue(later)).map((d) => d.id).sort()).toEqual([cron.id, oneOff.id].sort());
});

test("runNow checks ownership", async () => {
  const a = await createAutomation(digest(), mia);
  expect(await code(runNow(a.id, max))).toBe("forbidden");
  expect(await runNow(a.id, mia)).toEqual({ ok: true, status: "ok" });
  expect(await runNow(a.id)).toMatchObject({ ok: true });
  expect(await code(runNow("missing"))).toBe("not_found");
});

test("ai tools: schedule/list/cancel go through the same rules", async () => {
  const t: any = automationTools({ turnId: "t", userId: "UMEM", channelId: "CPRIV", scope: {} as any, readOnly: false, orgConnectionsOnly: false });
  const run = (name: string, input: unknown) => t[name].execute(input, { toolCallId: "x", messages: [] });
  expect(await run("schedule_automation", { kind: "digest", prompt: "recap", cron: "*/5 * * * *" })).toMatch(/too often/);
  expect(await run("schedule_automation", { kind: "digest", prompt: "recap", cron: "0 9 * * 1", destination: "here" })).toMatch(/^Scheduled: /); // member of CPRIV
  const listed: string = await run("list_automations", {});
  const id = /au_[\w-]+/.exec(listed)![0];
  expect(listed).toContain("<#CPRIV>");
  expect(await run("cancel_automation", { id })).toBe(`Cancelled ${id}.`);
  expect(await run("cancel_automation", { id })).toMatch(/not found/);
  const stranger: any = automationTools({ turnId: "t", userId: "UMEM2", channelId: "CPRIV", scope: {} as any, readOnly: false, orgConnectionsOnly: false });
  // in-channel proof is accepted because the asker is talking in that channel
  expect(await stranger.schedule_automation.execute({ kind: "digest", prompt: "r", cron: "0 9 * * 1", destination: "CPRIV" }, { toolCallId: "x", messages: [] })).toMatch(/^Scheduled/);
  const noUser: any = automationTools({ turnId: "t", userId: null, channelId: "CPUB", scope: {} as any, readOnly: false, orgConnectionsOnly: false });
  expect(await noUser.list_automations.execute({}, { toolCallId: "x", messages: [] })).toMatch(/identity/);
});
