import "../slack/env";
// Replay: a chase / follow-up / routed question sat unsent for two days because it was a Saturday night; people expected Pixel
// to message straight away. Quiet hours are now OFF by default and only QUIET_HOURS=1 holds delivery to the working window.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { commitments } from "../../src/db/schema";
import { addCommitment, chaseTick, createFollowUp, followUpTick } from "../../src/manager";
import { askDeps, attemptDelivery, getAsk, nextWindow, proposeAsk } from "../../src/slack/teammate";
import { ME, PARAG, PUB, boot, teardown, type Slack } from "./harness";

const SAT_NIGHT = new Date("2026-10-24T23:30:00Z");
const TUE_10AM = new Date("2026-10-27T10:00:00Z");
let slack: Slack;
const prevQuiet = process.env.QUIET_HOURS;
const deferred: { id: string; at: Date }[] = [];
const realDeps = { ...askDeps };

beforeEach(async () => {
  slack = await boot();
  deferred.length = 0;
  askDeps.defer = async (id, at) => { deferred.push({ id, at }); };
});
afterEach(() => { if (prevQuiet === undefined) delete process.env.QUIET_HOURS; else process.env.QUIET_HOURS = prevQuiet; Object.assign(askDeps, realDeps); });
afterAll(teardown);

const quiet = (on: boolean) => { if (on) process.env.QUIET_HOURS = "1"; else delete process.env.QUIET_HOURS; };
const overdueTask = () => addCommitment({
  text: "Ship the Tales launch", ownerId: PARAG, ownerName: "Parag", assignerId: ME, sourceType: "message", sourceRef: "assign:q", scopeTag: "shared",
  channelId: PUB, threadTs: "1.1", dueAt: new Date(SAT_NIGHT.getTime() - 86_400_000),
});
async function confirmedAsk(now: Date) {
  askDeps.now = () => now;
  const id = await proposeAsk({ asker: ME, owner: PARAG, question: "Is the Tales launch done?", origin: { channelId: "D_DANA", isPrivate: false, isIm: true } });
  await db.execute((await import("drizzle-orm")).sql`update settings set value = value || '{"status":"confirmed"}'::jsonb where key = ${"ask:" + id}`);
  return id;
}

describe("quiet hours default OFF", () => {
  const cases: [string, boolean, Date, boolean][] = [
    // label, QUIET_HOURS=1, when, expected to go out
    ["default settings, Saturday night", false, SAT_NIGHT, true],
    ["QUIET_HOURS=1, Saturday night", true, SAT_NIGHT, false],
    ["QUIET_HOURS=1, Tuesday 10:00 (inside the window)", true, TUE_10AM, true],
  ];
  for (const [label, on, when, goes] of cases) {
    test(`chase: ${label}`, async () => {
      quiet(on);
      await overdueTask();
      expect(await chaseTick(when)).toBe(goes ? 1 : 0);
      expect(slack.to("D_" + PARAG).length + slack.to(PUB).length > 0).toBe(goes);
    });

    test(`follow-up: ${label}`, async () => {
      quiet(on);
      const at = new Date(when.getTime() + 60_000);
      await createFollowUp({ ownerId: ME, text: "check on the Tales launch", at }, when);
      expect(await followUpTick(new Date(at.getTime() + 1000))).toBe(goes ? 1 : 0);
      expect(slack.to("D_" + ME).some((p) => /Reminder/.test(p.text))).toBe(goes);
    });

    test(`ask delivery: ${label}`, async () => {
      quiet(on);
      const id = await confirmedAsk(when);
      const r = await attemptDelivery(id, { now: when, notify: true });
      expect(r).toBe(goes ? "sent" : "deferred");
      expect((await getAsk(id))!.status).toBe(goes ? "sent" : "confirmed");
      expect(deferred.length).toBe(goes ? 0 : 1);
      expect(slack.to("D_" + PARAG).some((p) => /asked me to check with you/.test(p.text))).toBe(goes);
      expect(slack.texts().some((t) => /outside working hours/.test(t))).toBe(!goes);
      expect(nextWindow(when) === null).toBe(goes);
    });
  }

  test("a task assigned on a Saturday night is announced immediately by default", async () => {
    // assign_task's notification never consulted quiet hours; guard it stays that way
    quiet(false);
    const { taskTools } = await import("../../src/turn/task-tools");
    const tools = taskTools({ turnId: "t", userId: ME, channelId: "D_DANA", threadTs: undefined, messageTs: "1700000000.000100", scope: { channelId: "D_DANA", isPrivate: false, isIm: true, userId: ME }, readOnly: false, orgConnectionsOnly: false, userText: "" } as never);
    await (tools.assign_task as any).execute({ title: "Tales launch", assignee: `<@${PARAG}>`, priority: "urgent" }, {});
    expect(slack.to("D_" + PARAG).some((p) => /Urgent/.test(p.text))).toBe(true);
    expect((await db.select().from(commitments).where(eq(commitments.ownerId, PARAG))).length).toBe(1);
  });
});
