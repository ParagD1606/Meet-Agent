import "../slack/env";
// Near-miss argument names (owner/to/person, task/name, state, task_id, recipient, text/body, message/note) are accepted by
// assign_task, update_task, notify_teammate, schedule_follow_up without changing the schema the model is shown.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { commitments, followUps } from "../../src/db/schema";
import { scheduleFollowUpTool } from "../../src/turn/follow-up-tool";
import { taskTools } from "../../src/turn/task-tools";
import { DERP, ME, PARAG, boot, mention, scriptModel, send, teardown, type Slack } from "../replay/harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterAll(teardown);

const ctx = { turnId: "t", userId: ME, channelId: "CPUB", threadTs: undefined, messageTs: "1700000001.000100", scope: { channelId: "CPUB", isPrivate: false, isIm: false, userId: ME }, readOnly: false, orgConnectionsOnly: false, userText: "" } as never;
const tools: Record<string, any> = { ...taskTools(ctx), schedule_follow_up: scheduleFollowUpTool(ctx) };
const soon = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const parse = async (name: string, input: unknown) => (await asSchema(tools[name].inputSchema).validate!(input)) as { success: boolean; value?: any };

describe("schema shown to the model is unchanged by the aliases", () => {
  const want: Record<string, string[]> = {
    assign_task: ["title", "assignee", "due", "priority", "notify"],
    update_task: ["id", "title", "status", "owner", "due", "priority"],
    notify_teammate: ["person", "message"],
    schedule_follow_up: ["text", "at", "person", "repeatEveryDays"],
  };
  for (const [name, props] of Object.entries(want))
    test(name, () => {
      const js = asSchema(tools[name].inputSchema).jsonSchema as any;
      expect(Object.keys(js.properties)).toEqual(props);
    });
});

describe("aliases fill the canonical field; the canonical field wins when both are given", () => {
  test("assign_task: assignee <- owner/to/user/person/recipient/assigned_to; title <- task/name/text/description", async () => {
    for (const a of ["owner", "to", "user", "person", "recipient", "assigned_to"]) expect((await parse("assign_task", { title: "Ship it", [a]: "@Parag" })).value).toMatchObject({ assignee: "@Parag" });
    for (const t of ["task", "name", "text", "description"]) expect((await parse("assign_task", { assignee: "U1", [t]: "Ship it" })).value).toMatchObject({ title: "Ship it" });
    expect((await parse("assign_task", { title: "Real", task: "Alias", assignee: "UPARAG" })).value).toMatchObject({ title: "Real" });
    expect((await parse("assign_task", { title: "x" })).success).toBe(false); // still validated
  });
  test("update_task: status <- state; id <- task_id/task", async () => {
    expect((await parse("update_task", { id: "a", state: "done" })).value).toMatchObject({ status: "done" });
    for (const k of ["task_id", "task"]) expect((await parse("update_task", { [k]: "t_1", status: "dropped" })).value).toMatchObject({ id: "t_1" });
    expect((await parse("update_task", { id: "a", state: "bogus" })).success).toBe(false);
  });
  test("notify_teammate and schedule_follow_up", async () => {
    for (const k of ["recipient", "to", "user", "who"]) expect((await parse("notify_teammate", { [k]: "<@UDERP>", message: "hi there" })).value).toMatchObject({ person: "<@UDERP>" });
    for (const k of ["text", "body", "content"]) expect((await parse("notify_teammate", { person: "UDERP", [k]: "hi there" })).value).toMatchObject({ message: "hi there" });
    for (const k of ["recipient", "to", "user"]) expect((await parse("schedule_follow_up", { [k]: "UDERP", text: "check in", at: "2030-01-01T09:00:00+00:00" })).value).toMatchObject({ person: "UDERP" });
    for (const k of ["message", "note"]) expect((await parse("schedule_follow_up", { [k]: "check in", at: "2030-01-01T09:00:00+00:00" })).value).toMatchObject({ text: "check in" });
  });
});

describe("through a real turn, with @name, <@U123> and bare-id person forms", () => {
  test("assign_task with near-miss names", async () => {
    for (const [title, key, who] of [["Task alpha", "owner", "@Parag"], ["Task beta", "to", `<@${PARAG}>`], ["Task gamma", "person", PARAG]] as const) {
      scriptModel((s) => (s.called("assign_task") ? { text: "Done." } : { call: "assign_task", input: { task: title, [key]: who, notify: false } }));
      await send(mention(`assign ${title} to ${who}`));
    }
    const rows = await db.select().from(commitments);
    expect(rows.map((r) => r.text).sort()).toEqual(["Task alpha", "Task beta", "Task gamma"]);
    expect(rows.every((r) => r.ownerId === PARAG)).toBe(true);
  });

  test("update_task with task_id + state", async () => {
    scriptModel((s) => (s.called("assign_task") ? { text: "ok" } : { call: "assign_task", input: { title: "Close me", assignee: `<@${PARAG}>`, notify: false } }));
    await send(mention(`assign Close me to <@${PARAG}>`));
    const [row] = await db.select().from(commitments);
    scriptModel((s) => (s.called("update_task") ? { text: "Marked done." } : { call: "update_task", input: { task_id: row!.id, state: "done" } }));
    await send(mention("the Close me task is done", { user: PARAG }));
    expect((await db.select().from(commitments).where(eq(commitments.id, row!.id)))[0]!.status).toBe("done");
  });

  test("notify_teammate with recipient/text in all three person forms", async () => {
    for (const who of ["@Derpx06", `<@${DERP}>`, DERP]) {
      slack.reset();
      scriptModel((s) => (s.called("notify_teammate") ? { text: "Sent." } : { call: "notify_teammate", input: { recipient: who, text: "all the tasks are done now" } }));
      await send(mention(`tell ${who} all the tasks are done now`));
      expect(slack.to("D_" + DERP).concat(slack.posts()).map((p) => p.text).join("\n")).toContain("all the tasks are done now");
    }
  });

  test("schedule_follow_up with message (reminder) and recipient (consent card)", async () => {
    scriptModel((s) => (s.called("schedule_follow_up") ? { text: "Scheduled." } : { call: "schedule_follow_up", input: { message: "send the invoices", at: soon(30) } }));
    await send(mention("remind me to send the invoices"));
    scriptModel((s) => (s.called("schedule_follow_up") ? { text: "Waiting for your OK." } : { call: "schedule_follow_up", input: { recipient: "@Parag", note: "check the invoices", at: soon(31) } }));
    await send(mention("follow up with @Parag about the invoices"));
    const rows = await db.select().from(followUps);
    expect(rows.map((r) => r.text).sort()).toEqual(["check the invoices", "send the invoices"]);
    expect(rows.find((r) => r.text === "check the invoices")).toMatchObject({ targetId: PARAG, status: "proposed" });
  });

  test("schedule_follow_up resolves <@U123> and a bare id too", async () => {
    for (const who of [`<@${PARAG}>`, PARAG]) await tools.schedule_follow_up.execute({ text: `check ${who}`, at: soon(5), person: who }, {});
    expect((await db.select().from(followUps)).map((r) => r.targetId)).toEqual([PARAG, PARAG]);
  });
});
