import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { encrypt } from "../../src/crypto";
import { channelMembers, channels, commitments, workspace } from "../../src/db/schema";
import { addCommitment } from "../../src/manager";
import { setMemoryLlm } from "../../src/memory/llm";
import { setSlackClientForTest } from "../../src/slack/client";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes } from "../memory/helpers";
import { db, call, login, mkUser, resetDb } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);

let alice: string, bob: string, admin: string, fake: ReturnType<typeof fakeSlack>;
const mk = (o: Partial<Parameters<typeof addCommitment>[0]> & { text: string; sourceRef: string }) =>
  addCommitment({ sourceType: "message", scopeTag: "shared", channelId: "C1", ownerId: "UBOB", ownerName: "User UBOB", assignerId: "UALICE", ...o });
const list = async (cookie: string, qs = "") => ((await (await call("GET", `/api/tasks${qs}`, { cookie })).json()) as any).tasks as any[];

beforeEach(async () => {
  await resetDb();
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CH" });
  fake = fakeSlack();
  setSlackClientForTest(fake.client);
  setMemoryLlm(async () => '{"superseded":[]}');
  alice = await login("UALICE", "member");
  bob = await login("UBOB", "member");
  admin = await login("UADMIN", "admin");
  await mkUser("UCARL");
  await db.insert(channels).values([{ id: "C1", name: "pub", botIsMember: true }, { id: "GP", name: "secret", isPrivate: true, botIsMember: true }]);
  await db.insert(channelMembers).values([{ channelId: "GP", userId: "UALICE" }, { channelId: "C1", userId: "UALICE" }]);
});

describe("GET /api/tasks", () => {
  test("anonymous 401; any member 200; names, channel name, priority, overdue returned", async () => {
    expect((await call("GET", "/api/tasks")).status).toBe(401);
    await mk({ text: "Ship Tales", sourceRef: "a", priority: "urgent", dueAt: new Date(Date.now() - 86_400_000) });
    const [t] = await list(bob);
    expect(t).toMatchObject({ title: "Ship Tales", priority: "urgent", ownerName: "User UBOB", assignerName: "User UALICE", channelName: "pub", overdue: true, canEdit: true });
  });

  test("scope isolation: a private-channel task is never listed to a non-member (member or admin), and cannot be probed", async () => {
    await mk({ text: "Secret plan", sourceRef: "s", scopeTag: "channel_GP", channelId: "GP", ownerId: "UALICE", assignerId: "UALICE" });
    await mk({ text: "Public thing", sourceRef: "p" });
    expect((await list(alice)).map((t) => t.title).sort()).toEqual(["Public thing", "Secret plan"]);
    for (const who of [bob, admin]) expect((await list(who)).map((t) => t.title)).toEqual(["Public thing"]);
    const [secret] = await db.select().from(commitments).where(eq(commitments.sourceRef, "s"));
    for (const who of [bob, admin]) expect((await call("PATCH", `/api/tasks/${secret!.id}`, { cookie: who, body: { status: "done" } })).status).toBe(403);
    expect((await db.select().from(commitments).where(eq(commitments.id, secret!.id)))[0]!.status).toBe("open");
    expect((await call("PATCH", "/api/tasks/cm_forged", { cookie: admin, body: { status: "done" } })).status).toBe(404);
  });

  test("a DM-scoped task is visible to its assigner and its owner only", async () => {
    await mk({ text: "DM task", sourceRef: "assign:d", scopeTag: "user_UALICE", channelId: null });
    await mk({ text: "Ambient DM item", sourceRef: "fact:9", scopeTag: "user_UALICE", channelId: null }); // owner was never told: stays private
    expect(await list(alice)).toHaveLength(2);
    expect((await list(bob)).map((t) => t.title)).toEqual(["DM task"]);
    expect(await list(await login("UEVE", "member"))).toHaveLength(0);
  });

  test("filters: mine, assignedByMe, status, q, owner", async () => {
    await mk({ text: "Alpha work", sourceRef: "1" });
    await mk({ text: "Beta work", sourceRef: "2", ownerId: "UALICE", assignerId: "UBOB" });
    expect((await list(alice, "?mine=1")).map((t) => t.title)).toEqual(["Beta work"]);
    expect((await list(alice, "?assignedByMe=1")).map((t) => t.title)).toEqual(["Alpha work"]);
    expect((await list(alice, "?q=alpha")).map((t) => t.title)).toEqual(["Alpha work"]);
    expect(await list(alice, "?status=done")).toHaveLength(0);
    expect((await list(alice, "?owner=UBOB")).map((t) => t.title)).toEqual(["Alpha work"]);
  });
});

describe("PATCH /api/tasks/:id", () => {
  test("role checks: owner/assigner/admin may change; a stranger may not; reassign is assigner/admin only", async () => {
    await mk({ text: "Alpha", sourceRef: "1" });
    const [row] = await db.select().from(commitments);
    const eve = await login("UEVE", "member");
    expect((await call("PATCH", `/api/tasks/${row!.id}`, { cookie: eve, body: { status: "done" } })).status).toBe(403);
    expect((await call("PATCH", `/api/tasks/${row!.id}`, { cookie: bob, body: { ownerId: "UCARL" } })).status).toBe(403);
    expect((await call("PATCH", `/api/tasks/${row!.id}`, { cookie: alice, body: { ownerId: "UCARL", priority: "urgent" } })).status).toBe(200);
    expect((await db.select().from(commitments))[0]).toMatchObject({ ownerId: "UCARL", priority: "urgent" });
    expect((await call("PATCH", `/api/tasks/${row!.id}`, { cookie: admin, body: { status: "in_progress" } })).status).toBe(200);
    expect((await call("PATCH", `/api/tasks/${row!.id}`, { cookie: alice, body: { status: "done" } })).status).toBe(200);
    expect((await db.select().from(commitments))[0]!.status).toBe("done");
    expect((await call("PATCH", `/api/tasks/${row!.id}`, { cookie: alice, body: { status: "bogus" } })).status).toBe(400);
  });
});

describe("POST /api/tasks", () => {
  test("member creates a task in a channel they can read and the owner is told; private channel they are not in is forbidden", async () => {
    const r = await call("POST", "/api/tasks", { cookie: alice, body: { title: "Write launch notes", ownerId: "UBOB", channelId: "C1", priority: "urgent", due: "2026-12-01" } });
    expect(r.status).toBe(201);
    expect((await db.select().from(commitments))[0]).toMatchObject({ ownerId: "UBOB", assignerId: "UALICE", scopeTag: "shared", priority: "urgent", channelId: "C1" });
    expect(fake.calls.some((c) => c.method === "chat.postMessage" && c.args.channel === "D_UBOB")).toBe(true);
    expect((await call("POST", "/api/tasks", { cookie: bob, body: { title: "Sneaky", ownerId: "UALICE", channelId: "GP" } })).status).toBe(403);
    expect((await call("POST", "/api/tasks", { cookie: admin, body: { title: "Sneaky admin", ownerId: "UALICE", channelId: "GP" } })).status).toBe(403);
    expect((await call("POST", "/api/tasks", { cookie: alice, body: { title: "write launch notes", ownerId: "UBOB", channelId: "C1" } })).status).toBe(200);
    expect(await db.select().from(commitments)).toHaveLength(1);
  });

  test("unknown person 400; no channel: member task is private to the two people, admin task is shared", async () => {
    expect((await call("POST", "/api/tasks", { cookie: alice, body: { title: "Nobody task", ownerId: "UNOPE" } })).status).toBe(400);
    await call("POST", "/api/tasks", { cookie: alice, body: { title: "Private one", ownerId: "UBOB" } });
    await call("POST", "/api/tasks", { cookie: admin, body: { title: "Company one", ownerId: "UBOB" } });
    const rows = await db.select().from(commitments);
    expect(rows.find((r) => r.text === "Private one")!.scopeTag).toBe("user_UALICE");
    expect(rows.find((r) => r.text === "Company one")!.scopeTag).toBe("shared");
  });
});

describe("GET /api/people and sync-tasks", () => {
  test("people: member-safe fields only; sync-tasks is admin-only", async () => {
    const r = (await (await call("GET", "/api/people", { cookie: bob })).json()) as any;
    expect(r.people.length).toBeGreaterThan(2);
    expect(Object.keys(r.people[0]).sort()).toEqual(["avatarUrl", "id", "name", "title"]);
    expect((await call("POST", "/api/memory/run", { cookie: bob, body: { job: "sync-tasks" } })).status).toBe(403);
    expect((await call("POST", "/api/memory/run", { cookie: admin, body: { job: "sync-tasks" } })).status).toBe(200);
  });
});
