import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encrypt } from "../../src/crypto";
import { channelMembers, channels, commitments, workspace } from "../../src/db/schema";
import { buildTaskFilter } from "../../src/manager/routes";
import { flagSql, taskFlags } from "../../src/manager";
import { setMemoryLlm } from "../../src/memory/llm";
import { setSlackClientForTest } from "../../src/slack/client";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes } from "../memory/helpers";
import { db, call, login, mkUser, resetDb } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);

const DAY = 86_400_000;
let alice: string, bob: string, admin: string;
let n = 0;
const put = (o: Partial<typeof commitments.$inferInsert>) =>
  db.insert(commitments).values({ id: `cm_${++n}`, text: `Task ${n}`, sourceType: "message", sourceRef: `t:${n}`, scopeTag: "shared", channelId: "C1", ownerId: "UBOB", ownerName: "Bob", assignerId: "UALICE", ...o });
const get = async (cookie: string, qs = "") => (await (await call("GET", `/api/tasks${qs}`, { cookie })).json()) as any;
const titles = async (cookie: string, qs: string) => (await get(cookie, qs)).tasks.map((t: any) => t.title).sort();

beforeEach(async () => {
  await resetDb();
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CH" });
  setSlackClientForTest(fakeSlack().client);
  setMemoryLlm(async () => '{"superseded":[]}');
  alice = await login("UALICE", "member");
  bob = await login("UBOB", "member");
  admin = await login("UADMIN", "admin");
  await mkUser("UCARL");
  await db.insert(channels).values([{ id: "C1", name: "pub", botIsMember: true }, { id: "GP", name: "secret", isPrivate: true, botIsMember: true }]);
  await db.insert(channelMembers).values([{ channelId: "GP", userId: "UALICE" }, { channelId: "C1", userId: "UALICE" }]);
  const now = Date.now();
  await put({ text: "late", dueAt: new Date(now - DAY), status: "overdue" });
  await put({ text: "orphan", ownerId: null, ownerName: null, dueAt: new Date(now + 20 * DAY) });
  await put({ text: "dateless" });
  await put({ text: "soon", dueAt: new Date(now + DAY) });
  await put({ text: "fine", dueAt: new Date(now + 30 * DAY) });
  await put({ text: "ancient", dueAt: new Date(now + 30 * DAY), createdAt: new Date(now - 20 * DAY) });
  await put({ text: "finished", status: "done", completedAt: new Date(now - DAY) });
  await put({ text: "old finished", status: "done", completedAt: new Date(now - 30 * DAY) });
});

describe("GET /api/tasks flags, filters, counts", () => {
  test("filters", async () => {
    expect(await titles(bob, "?unassigned=1")).toEqual(["orphan"]);
    expect(await titles(bob, "?noDue=1")).toEqual(["dateless"]);
    expect(await titles(bob, "?dueSoon=1")).toEqual(["soon"]);
    expect(await titles(bob, "?stale=1")).toEqual(["ancient"]);
    expect(await titles(bob, "?overdue=1")).toEqual(["late"]);
  });
  test("counts and per-task flags", async () => {
    const r = await get(bob);
    expect(r.counts).toEqual({ total: 8, open: 6, overdue: 1, unassigned: 1, noDue: 1, dueSoon: 1, done7d: 1 });
    const by = Object.fromEntries(r.tasks.map((t: any) => [t.title, t.flags]));
    expect(by.late).toEqual(["overdue"]);
    expect(by.orphan).toEqual(["unassigned"]);
    expect(by.dateless).toEqual(["noDue"]);
    expect(by.ancient).toEqual(["stale"]);
    expect(by.finished).toEqual([]);
    // attention items come before the rest among active tasks
    const active = r.tasks.filter((t: any) => t.status !== "done").map((t: any) => t.title);
    expect(active.slice(0, 3).sort()).toEqual(["dateless", "late", "orphan"]);
  });
  test("SQL flags agree with the pure flags", async () => {
    const now = new Date();
    const rows = await db.select().from(commitments);
    const f = flagSql(now);
    for (const k of ["overdue", "unassigned", "noDue", "dueSoon", "stale", "urgent"] as const) {
      const ids = new Set((await db.select({ id: commitments.id }).from(commitments).where(f[k])).map((r) => r.id));
      expect(rows.filter((r) => taskFlags(r, now).includes(k)).map((r) => r.id).sort()).toEqual([...ids].sort());
    }
  });
  test("scope isolation: counts and filters never include unreadable tasks", async () => {
    await put({ text: "secret orphan", scopeTag: "channel_GP", channelId: "GP", ownerId: null, ownerName: null });
    await put({ text: "secret dateless", scopeTag: "channel_GP", channelId: "GP" });
    await put({ text: "dm orphan", scopeTag: "user_UALICE", channelId: null, ownerId: null, ownerName: null });
    for (const who of [bob, admin]) {
      const r = await get(who);
      expect(r.counts).toMatchObject({ total: 8, unassigned: 1, noDue: 1 });
      expect(await titles(who, "?unassigned=1")).toEqual(["orphan"]);
    }
    const a = await get(alice);
    expect(a.counts).toMatchObject({ total: 11, unassigned: 3, noDue: 4 });
  });
  test("buildTaskFilter(params, actor) is the same scope + filter the route uses", async () => {
    const where = await buildTaskFilter({ unassigned: "1" }, { id: "UBOB", role: "member" });
    expect((await db.select({ t: commitments.text }).from(commitments).where(where)).map((r) => r.t)).toEqual(["orphan"]);
  });
});
