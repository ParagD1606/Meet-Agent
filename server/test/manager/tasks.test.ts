// Tasks: assign_task / update_task / notify_teammate / find_tasks, memory <-> task agreement, dedupe, sync-tasks.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { channelMembers, channels, commitments, followUps, meetings, memories, users, workspace } from "../../src/db/schema";
import { encrypt } from "../../src/crypto";
import { setSlackClientForTest } from "../../src/slack/client";
import { setMemoryLlm } from "../../src/memory/llm";
import { addCommitment, handleCommitmentAction, parseAssignmentFact, syncTasksFromMemory } from "../../src/manager";
import { findTasks, formatTasks } from "../../src/manager/find";
import { taskTools } from "../../src/turn/task-tools";
import { runNow, RUN_JOBS, resetRunNow } from "../../src/memory/run-now";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);

let fake: ReturnType<typeof fakeSlack>;
const posts = () => fake.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.args);
const scopeDm = (u: string) => ({ channelId: `D_${u}`, isPrivate: false, isIm: true, userId: u });
const scopeCh = (u: string, c = "C1") => ({ channelId: c, isPrivate: false, isIm: false, userId: u });
const ctx = (u: string, scope: ReturnType<typeof scopeDm>, o: Record<string, unknown> = {}) =>
  ({ turnId: "t1", userId: u, channelId: scope.channelId, threadTs: undefined, messageTs: "1700000000.000100", scope, readOnly: false, orgConnectionsOnly: false, userText: "", ...o }) as never;
const run = (tools: Record<string, any>, name: string, input: unknown) => tools[name].execute(input, {} as never) as Promise<string>;

beforeEach(async () => {
  await resetDb();
  resetRunNow();
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CHOME" });
  await db.insert(users).values([{ id: "UDANA", name: "Dana" }, { id: "UPARAG", name: "Parag" }, { id: "UEVE", name: "Eve" }, { id: "UADMIN", name: "Root", role: "admin" }]);
  await db.insert(channels).values([{ id: "C1", name: "pub", botIsMember: true }, { id: "GP", name: "priv", isPrivate: true, botIsMember: true }]);
  await db.insert(channelMembers).values([{ channelId: "C1", userId: "UDANA" }, { channelId: "C1", userId: "UPARAG" }, { channelId: "GP", userId: "UDANA" }]);
  fake = fakeSlack();
  setSlackClientForTest(fake.client);
  setMemoryLlm(async () => '{"superseded":[],"commitments":[]}');
});

describe("assign_task", () => {
  test("incident: DM assignment creates the task, the memory fact, and an immediate DM with Done/Drop", async () => {
    const tools = taskTools(ctx("UDANA", scopeDm("UDANA")));
    const out = await run(tools, "assign_task", { title: "Tales launch", assignee: "<@UPARAG>", priority: "urgent", due: "2026-06-20" });
    expect(out).toContain("Created task");
    const [row] = await db.select().from(commitments);
    expect(row).toMatchObject({ ownerId: "UPARAG", assignerId: "UDANA", priority: "urgent", status: "open", scopeTag: "user_UDANA", sourceTs: "1700000000.000100" });
    expect(row!.permalink).toContain("1700000000");
    expect(row!.dueAt!.toISOString().slice(0, 10)).toBe("2026-06-20");
    const facts = (await db.select().from(memories)).filter((m) => m.status === "active");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.text).toContain("Tales launch");
    expect(facts[0]!.text).toContain("urgent");
    expect(row!.memoryId).toBe(facts[0]!.id);
    const dm = posts().find((p) => p.channel === "D_UPARAG")!;
    expect(dm.text).toContain("Urgent");
    expect(dm.text).toContain("Tales launch");
    expect(JSON.stringify(dm.blocks)).toContain("brain_commit_done");
    expect(JSON.stringify(dm.blocks)).toContain("brain_commit_drop");
    // repeating the request does not duplicate
    await run(tools, "assign_task", { title: "the Tales launch task", assignee: "Parag" });
    expect(await db.select().from(commitments)).toHaveLength(1);
  });

  test("in a channel the owner is mentioned in the thread (no DM); notify:false stays silent", async () => {
    const tools = taskTools(ctx("UDANA", scopeCh("UDANA"), { threadTs: "1700000000.000100" }));
    await run(tools, "assign_task", { title: "Write docs", assignee: "UPARAG" });
    const p = posts();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ channel: "C1", thread_ts: "1700000000.000100" });
    expect(p[0].text).toContain("<@UPARAG>");
    expect((await db.select().from(commitments))[0]!.scopeTag).toBe("shared");
    await run(tools, "assign_task", { title: "Other thing", assignee: "UPARAG", notify: false });
    expect(posts()).toHaveLength(1);
  });

  test("unknown assignee is an error, nothing is written", async () => {
    const out = await run(taskTools(ctx("UDANA", scopeDm("UDANA"))), "assign_task", { title: "Ghost task", assignee: "Nobody Here" });
    expect(out).toStartWith("ERROR");
    expect(await db.select().from(commitments)).toHaveLength(0);
  });
});

describe("update_task + find_tasks", () => {
  const assign = async () => run(taskTools(ctx("UDANA", scopeDm("UDANA"))), "assign_task", { title: "Tales launch", assignee: "<@UPARAG>", priority: "urgent" });

  test("owner marks it done from their own DM: tab, memory and assigner all agree", async () => {
    await assign();
    fake.calls.length = 0;
    const out = await run(taskTools(ctx("UPARAG", scopeDm("UPARAG"))), "update_task", { title: "tales launch task", status: "done" });
    expect(out).toContain("now done");
    const [row] = await db.select().from(commitments);
    expect(row!.status).toBe("done");
    expect(row!.completedAt).not.toBeNull();
    const all = await db.select().from(memories);
    const active = all.filter((m) => m.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]!.text).toContain("[done");
    expect(all.some((m) => m.status === "superseded" && m.text.includes("[open"))).toBe(true);
    expect(row!.memoryId).toBe(active[0]!.id);
    const told = posts().find((p) => p.channel === "D_UDANA")!;
    expect(told.text).toContain("Parag completed: Tales launch");
  });

  test("only owner, assigner or admin can change; reassign needs assigner/admin", async () => {
    await assign();
    const eve = await run(taskTools(ctx("UEVE", scopeDm("UEVE"))), "update_task", { title: "Tales launch", status: "done" });
    expect(eve).toContain("No task like that"); // not even visible to her
    const [row] = await db.select().from(commitments);
    const byId = await run(taskTools(ctx("UEVE", scopeDm("UEVE"))), "update_task", { id: row!.id, status: "done" });
    expect(byId).toContain("No task like that");
    const own = await run(taskTools(ctx("UPARAG", scopeDm("UPARAG"))), "update_task", { id: row!.id, owner: "UEVE" });
    expect(own).toContain("Not allowed");
    const re = await run(taskTools(ctx("UDANA", scopeDm("UDANA"))), "update_task", { id: row!.id, owner: "UEVE" });
    expect(re).toContain("owner Eve");
    expect((await db.select().from(commitments))[0]!.ownerId).toBe("UEVE");
  });

  test("find_tasks answers 'is X done?' from task status, fuzzy, with priority", async () => {
    await assign();
    await run(taskTools(ctx("UDANA", scopeDm("UDANA"))), "update_task", { title: "Tales launch", status: "done" });
    const r = formatTasks(await findTasks({ scope: scopeDm("UDANA"), asker: "UDANA", query: "is the Tales launched feature done?" }));
    expect(r).toContain("[done, URGENT]");
    expect(r).toContain("Tales launch");
    // in_progress is a first-class status and shows in the default listing
    await run(taskTools(ctx("UDANA", scopeDm("UDANA"))), "assign_task", { title: "Pricing page", assignee: "UPARAG" });
    await run(taskTools(ctx("UPARAG", scopeDm("UPARAG"))), "update_task", { title: "Pricing page", status: "in_progress" });
    expect(formatTasks(await findTasks({ scope: scopeDm("UDANA"), asker: "UDANA" }))).toContain("[in_progress]");
  });

  test("Done button notifies the assigner and updates memory", async () => {
    await assign();
    const [row] = await db.select().from(commitments);
    fake.calls.length = 0;
    await handleCommitmentAction({ user: { id: "UPARAG" } }, { action_id: "brain_commit_done", value: row!.id });
    expect((await db.select().from(commitments))[0]!.status).toBe("done");
    expect(posts().some((p) => p.channel === "D_UDANA" && p.text.includes("completed"))).toBe(true);
    expect((await db.select().from(memories)).some((m) => m.status === "active" && m.text.includes("[done"))).toBe(true);
  });
});

describe("notify_teammate", () => {
  test("channel member: @mention in thread; non-member: DM 'From ... via Pixel'", async () => {
    const t = taskTools(ctx("UDANA", scopeCh("UDANA"), { threadTs: "5.5", userText: "tell Parag hi" }));
    expect(await run(t, "notify_teammate", { person: "UPARAG", message: "hello there" })).toContain("in this thread");
    expect(posts()[0]).toMatchObject({ channel: "C1", thread_ts: "5.5" });
    expect(await run(t, "notify_teammate", { person: "UEVE", message: "hello there" })).toContain("DM");
    expect(posts()[1]).toMatchObject({ channel: "D_UEVE" });
    expect(posts()[1].text).toBe("From Dana via Pixel: hello there");
  });

  test("rate limited per target (5/day); forged mentions and secrets refused", async () => {
    const t = taskTools(ctx("UDANA", scopeDm("UDANA"), { userText: "say hi to Eve" }));
    for (let i = 0; i < 5; i++) expect(await run(t, "notify_teammate", { person: "UEVE", message: `hi number ${i}` })).toContain("Sent");
    expect(await run(t, "notify_teammate", { person: "UEVE", message: "hi again" })).toContain("Not sent");
    expect(posts()).toHaveLength(5);
    expect(await run(t, "notify_teammate", { person: "UPARAG", message: "see <@UEVE> secret" })).toStartWith("ERROR");
    expect(await run(t, "notify_teammate", { person: "UPARAG", message: "token xoxb-1234567890-abcdefghij" })).toStartWith("ERROR");
  });

  test("untrusted context: consent card, nothing sent to the target", async () => {
    const t = taskTools(ctx("UDANA", scopeDm("UDANA"), { untrustedContext: true, userText: "tell Eve hi" }));
    expect(await run(t, "notify_teammate", { person: "UEVE", message: "hi from me" })).toContain("consent card");
    expect(posts().every((p) => p.channel !== "D_UEVE")).toBe(true);
    expect((await db.select().from(followUps))[0]).toMatchObject({ targetId: "UEVE", status: "proposed" });
  });
});

describe("dedupe + sync-tasks", () => {
  test("owner + normalized title + channel never duplicates, across sources", async () => {
    const base = { sourceType: "message" as const, scopeTag: "shared", channelId: "C1", ownerId: "UPARAG", ownerName: "Parag" };
    expect(await addCommitment({ ...base, text: "Ship the pricing page", sourceRef: "a:1" })).toBe(true);
    expect(await addCommitment({ ...base, text: "ship pricing page task", sourceRef: "b:2" })).toBe(false);
    expect(await addCommitment({ ...base, channelId: "GP", text: "Ship pricing page", sourceRef: "c:3" })).toBe(true);
    // ambient capture of the same message that assign_task already handled
    await run(taskTools(ctx("UDANA", scopeCh("UDANA"))), "assign_task", { title: "Fix login", assignee: "UPARAG" });
    const ts = "1700000000.000100";
    expect(await addCommitment({ ...base, text: "Please fix the login bug", sourceRef: `msg:C1:${ts}:0`, sourceTs: ts })).toBe(false);
  });

  test("parseAssignmentFact", () => {
    expect(parseAssignmentFact("The Tales launch task is assigned to Parag (<@U123ABC>) and is urgent.")).toEqual({ title: "Tales launch", ownerName: "Parag", ownerId: "U123ABC", urgent: true });
    expect(parseAssignmentFact("Pricing page is assigned to Eve (<@UEVE1>)")).toMatchObject({ title: "Pricing page", ownerId: "UEVE1" });
    expect(parseAssignmentFact("Dana likes tea")).toBeNull();
  });

  test("sync-tasks backfills from facts and meetings, idempotently; admin job is registered", async () => {
    const id = await seedMemory("shared", "The Tales launch task is assigned to Parag (<@UPARAG>)", { sourceRef: "C1" });
    await db.insert(meetings).values({ id: "m1", sourceFileId: "F1", channelId: "C1", title: "Sync", transcript: "t", status: "ready", tasks: [{ title: "Draft plan", assigneeName: "Eve" }] });
    expect(RUN_JOBS).toContain("sync-tasks");
    const r1 = await syncTasksFromMemory();
    expect(r1).toMatchObject({ facts: 1, meetings: 1 });
    const rows = await db.select().from(commitments);
    expect(rows).toHaveLength(2);
    const t = rows.find((x) => x.sourceType === "fact")!;
    expect(t).toMatchObject({ ownerId: "UPARAG", channelId: "C1", status: "open" });
    expect(t.memoryId).toBe(id);
    expect(rows.every((x) => x.memoryId)).toBe(true); // meeting task also mirrored into memory
    const r2 = await runNow("sync-tasks");
    expect(r2.ok && r2.counts).toMatchObject({ facts: 0, meetings: 0 });
    expect(await db.select().from(commitments)).toHaveLength(2);
    // completing a backfilled task supersedes the ORIGINAL assignment fact
    await run(taskTools(ctx("UPARAG", scopeCh("UPARAG"))), "update_task", { id: t.id, status: "done" });
    const [orig] = await db.select().from(memories).where(eq(memories.id, id));
    expect(orig!.status).toBe("superseded");
  });
});
