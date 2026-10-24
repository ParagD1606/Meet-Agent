import "../slack/env";
// Replay: scope safety. A task and a fact that live in a PRIVATE channel must never reach someone who is not in it:
// not through answers, find_tasks / memory tools, the Tasks API, digests, task lists or risk posts. One table, every surface.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { channelMembers, commitments, users } from "../../src/db/schema";
import { createSession } from "../../src/auth/session";
import { buildDailyStandup, buildWeeklyStatus, openTasksFor, riskTick, taskListMessage } from "../../src/manager";
import { setFeatureChannels } from "../../src/slack/proactive-features";
import { memoryTools } from "../../src/turn/memory-tools";
import { taskTools } from "../../src/turn/task-tools";
import { mountRoutes } from "../../src/routes";
import { seedMemory } from "../memory/helpers";
import { PRIV, PUB, ME, boot, mention, scriptModel, send, teardown, type Slack } from "./harness";

const app = new Hono();
mountRoutes(app);

// the private payload (task title, fact text), not the bare name: a tool may echo the name the asker typed
const SECRET = /acquire zorblax|planned for Q3|dana leads it/i;
const INSIDERS = ["UADMIN", ME]; // members of the private channel
const OUTSIDERS = ["UEVE", "UBOSS"]; // UBOSS is a workspace admin who is NOT in the channel

let slack: Slack;
let privTaskId: string;

beforeEach(async () => {
  slack = await boot();
  await db.insert(users).values({ id: "UBOSS", name: "Boss", role: "admin" });
  await db.insert(channelMembers).values({ channelId: PUB, userId: "UBOSS" });
  // the private task is created the way it really happens: ME @mentions Pixel inside the private channel
  scriptModel((s) => (s.called("assign_task") ? { text: "Done, assigned." } : { call: "assign_task", input: { title: "Acquire Zorblax Corp", assignee: "<@UADMIN>", priority: "urgent" } }));
  await send(mention("assign acquiring Zorblax Corp to <@UADMIN>, urgent", { channel: PRIV }));
  [{ id: privTaskId }] = (await db.select({ id: commitments.id }).from(commitments).where(eq(commitments.channelId, PRIV))) as [{ id: string }];
  expect(privTaskId).toBeTruthy();
  await seedMemory("channel_CPRIV", "Secret: the Zorblax Corp acquisition is planned for Q3 and Dana leads it.");
  // a public task, so every surface has something legitimate to show
  scriptModel((s) => (s.called("assign_task") ? { text: "Done." } : { call: "assign_task", input: { title: "Send the Marlin invoices", assignee: "<@UEVE>" } }));
  await send(mention("assign sending the marlin invoices to <@UEVE>", { channel: PUB }));
  slack.reset();
});
afterAll(teardown);

const cookie = async (id: string) => `brain_session=${await createSession(null, id)}`;
const apiTasks = async (id: string, qs = "") => JSON.stringify(((await (await app.request(`/api/tasks${qs}`, { headers: { cookie: await cookie(id) } })).json()) as any).tasks);
const scopeIn = (userId: string, ch: string) => ({ channelId: ch, isPrivate: ch === PRIV, isIm: ch.startsWith("D_"), userId });
const toolCtx = (userId: string, ch: string) => ({ turnId: "t", userId, channelId: ch, threadTs: undefined, messageTs: "1700000001.000100", scope: scopeIn(userId, ch), readOnly: false, orgConnectionsOnly: false, userText: "" }) as never;
const run = async (tools: Record<string, any>, name: string, input: unknown) => String(await tools[name].execute(input, {}));

/** Every way the secret could reach `viewer`, as text. */
const surfaces: [string, (viewer: string) => Promise<string>][] = [
  ["GET /api/tasks", (v) => apiTasks(v)],
  ["GET /api/tasks?q=", (v) => apiTasks(v, "?q=zorblax&status=open,done,dropped,overdue,in_progress")],
  ["GET /api/tasks?mine&assignedByMe", async (v) => (await apiTasks(v, "?mine=1")) + (await apiTasks(v, "?assignedByMe=1"))],
  ["find_tasks in a public channel", async (v) => run(memoryTools(toolCtx(v, PUB)), "find_tasks", { query: "zorblax acquisition", status: "all" })],
  ["find_tasks in their DM", async (v) => run(memoryTools(toolCtx(v, "D_" + v)), "find_tasks", { query: "zorblax", status: "all" })],
  ["find_tasks by owner", async (v) => run(memoryTools(toolCtx(v, PUB)), "find_tasks", { owner: "UADMIN", status: "all" })],
  ["memory_search in a public channel", async (v) => run(memoryTools(toolCtx(v, PUB)), "memory_search", { query: "Zorblax Corp acquisition Q3" })],
  ["memory_search in their DM", async (v) => run(memoryTools(toolCtx(v, "D_" + v)), "memory_search", { query: "Zorblax Corp acquisition Q3" })],
  ["entity_lookup", async (v) => run(memoryTools(toolCtx(v, PUB)), "entity_lookup", { name: "Zorblax Corp" })],
  ["search_threads", async (v) => run(memoryTools(toolCtx(v, PUB)), "search_threads", { query: "Zorblax" })],
  ["update_task by title", async (v) => run(taskTools(toolCtx(v, PUB)), "update_task", { title: "Zorblax", status: "done" })],
  ["update_task by id", async (v) => run(taskTools(toolCtx(v, PUB)), "update_task", { id: privTaskId, status: "dropped" })],
  ["/brain-tasks & digest list", async (v) => JSON.stringify(await taskListMessage(v)) + JSON.stringify(await openTasksFor(v))],
  ["daily standup of the public channel", async () => String(await buildDailyStandup({ id: PUB, isPrivate: false }))],
  ["weekly status of the public channel", async () => String(await buildWeeklyStatus({ id: PUB, isPrivate: false }))],
];

describe("private-channel task and fact never leak to a non-member", () => {
  for (const [name, view] of surfaces) {
    for (const viewer of OUTSIDERS) {
      test(`${name} -> ${viewer}`, async () => {
        const seen = await view(viewer);
        expect(seen).not.toMatch(SECRET);
      });
    }
  }

  test("positive controls: members DO see it on the surfaces that serve their scope (the checks above are not vacuous)", async () => {
    for (const v of INSIDERS) expect(await apiTasks(v)).toMatch(SECRET);
    expect(await run(memoryTools(toolCtx(ME, PRIV)), "find_tasks", { query: "zorblax", status: "all" })).toMatch(SECRET);
    expect(await run(memoryTools(toolCtx(ME, PRIV)), "memory_search", { query: "Zorblax Corp acquisition Q3" })).toMatch(SECRET);
    expect(JSON.stringify(await taskListMessage("UADMIN"))).toMatch(SECRET);
  });

  test("update_task by an outsider changes nothing", async () => {
    for (const v of OUTSIDERS) {
      await run(taskTools(toolCtx(v, PUB)), "update_task", { title: "Zorblax", status: "done" });
      await run(taskTools(toolCtx(v, PUB)), "update_task", { id: privTaskId, status: "dropped" });
    }
    expect((await db.select().from(commitments).where(eq(commitments.id, privTaskId)))[0]!.status).toBe("open");
  });

  test("a non-member cannot change it through the Tasks API (member, workspace admin or forged id)", async () => {
    for (const v of OUTSIDERS) {
      const r = await app.request(`/api/tasks/${privTaskId}`, { method: "PATCH", headers: { cookie: await cookie(v), "content-type": "application/json", "x-requested-with": "fetch" }, body: JSON.stringify({ status: "done", ownerId: v }) });
      expect([403, 404]).toContain(r.status);
    }
    expect((await db.select().from(commitments).where(eq(commitments.id, privTaskId)))[0]).toMatchObject({ status: "open", ownerId: "UADMIN" });
  });

  test("risk watch: an overdue private task is posted only to its own opted-in private channel, never a public one or the home channel", async () => {
    await db.update(commitments).set({ dueAt: new Date(Date.now() - 5 * 86_400_000) }).where(eq(commitments.id, privTaskId));
    await setFeatureChannels("risks", [PUB]); // only the public channel opted in
    await riskTick();
    expect(JSON.stringify(slack.posts().filter((p) => p.channel !== PRIV))).not.toMatch(SECRET);
    await setFeatureChannels("risks", [PUB, PRIV]);
    slack.reset();
    await riskTick();
    expect(JSON.stringify(slack.posts().filter((p) => p.channel !== PRIV))).not.toMatch(SECRET);
  });

  test("end to end: an outsider's whole turn (prompt, tool results, Slack posts) never contains the secret", async () => {
    const model = scriptModel((s) => {
      if (!s.called("find_tasks")) return { calls: [{ call: "find_tasks", input: { query: "zorblax acquisition", status: "all" } }, { call: "memory_search", input: { query: "Zorblax Corp acquisition Q3" } }] };
      return { text: "I have no record of that." };
    });
    await send(mention("what's the status of the Zorblax Corp acquisition task and who owns it?", { user: "UBOSS", channel: PUB }));
    // the asker's own question names the company, so only the private payload (title, id, fact text) is checked
    const seen = JSON.stringify(model.doStreamCalls.map((c) => c.prompt));
    expect(seen).not.toMatch(SECRET);
    expect(seen).not.toContain(privTaskId);
    expect(JSON.stringify(slack.posts().map((p) => p.text))).not.toMatch(SECRET);
  });
});
