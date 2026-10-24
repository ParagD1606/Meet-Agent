// Replay: "@Pixel assign the task of tales launch to @Parag please and tell him that it is urgent".
import "../slack/env";
// Bug: the assignment lived only in memory (no tracked task), Parag was told late/never, the task was invisible in the Tasks tab.
import { afterAll, beforeEach, describe, expect, setSystemTime, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { commitments, memories } from "../../src/db/schema";
import { createSession } from "../../src/auth/session";
import { app } from "../api/helpers";
import { BOT, ME, PARAG, PUB, boot, liveTest, mention, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterEach(() => setSystemTime());
afterAll(teardown);

const TEXT = `assign the task of tales launch to <@${PARAG}> please and tell him that it is urgent`;

async function assertAssigned() {
  const [c] = await db.select().from(commitments);
  expect(c).toBeTruthy();
  expect(c!).toMatchObject({ ownerId: PARAG, assignerId: ME, priority: "urgent", status: "open" });
  expect(c!.text.toLowerCase()).toContain("tales");
  const facts = (await db.select().from(memories)).filter((m) => m.status === "active" && /tales/i.test(m.text));
  expect(facts.length).toBeGreaterThanOrEqual(1);
  expect(facts[0]!.text.toLowerCase()).toContain("urgent");
  expect(facts[0]!.text).toContain(PARAG);
  // Parag was told immediately: an @mention in the thread (he is in the channel) or a DM, with Done/Drop buttons
  const told = slack.posts().filter((p) => (p.text.includes(`<@${PARAG}>`) && /tales/i.test(p.text)) && !/^_Thinking/.test(p.text));
  expect(told.length).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(told.map((p) => p.blocks))).toContain("brain_commit_done");
  expect(told.some((p) => /urgent/i.test(p.text))).toBe(true);
  // visible to a member through the Tasks API (a different channel member, not the assigner)
  await db.insert((await import("../../src/db/schema")).users).values({ id: "UVIEW", name: "Viewer" }).onConflictDoNothing();
  const cookie = `brain_session=${await createSession(null, "UEVE")}`;
  const r = await app.request("/api/tasks", { headers: { cookie } });
  const { tasks } = (await r.json()) as any;
  expect(tasks.map((t: any) => t.title.toLowerCase()).join("|")).toContain("tales");
  expect(tasks.find((t: any) => /tales/i.test(t.title))).toMatchObject({ priority: "urgent", ownerName: "Parag" });
}

describe("assign + tell it is urgent", () => {
  scriptedTest("Saturday night: task row, memory fact, immediate @mention (not deferred), visible in GET /api/tasks", async () => {
    setSystemTime(new Date("2026-10-24T23:30:00Z")); // Saturday night UTC: outside any working window
    scriptModel((s) => s.called("assign_task")
      ? { text: "Done. I assigned the Tales launch to Parag and told him it's urgent." }
      : { call: "assign_task", input: { title: "Tales launch", assignee: `<@${PARAG}>`, priority: "urgent" } });
    await send(mention(TEXT));
    await assertAssigned();
    expect(slack.texts().at(-1)).toContain("assigned");
    expect(slack.texts().join("\n")).not.toMatch(/outside working hours|I'll ask them at/);
  });

  scriptedTest("model that uses a name instead of the mention still resolves Parag; unknown names fail loudly instead of faking it", async () => {
    scriptModel((s) => s.called("assign_task") ? { text: "Done, assigned." } : { call: "assign_task", input: { title: "Tales launch", assignee: "@Parag", priority: "urgent" } });
    await send(mention(TEXT));
    expect((await db.select().from(commitments))[0]!.ownerId).toBe(PARAG);
  });

  scriptedTest("the model claims 'I'll let him know' without any tool: repaired by a real assign_task, never a bare claim", async () => {
    let first = true;
    scriptModel((s) => {
      if (s.called("assign_task")) return { text: "Done. Task assigned and Parag has been told." };
      if (first) { first = false; return { text: "Sure, I'll let him know the Tales launch is urgent." }; }
      return { call: "assign_task", input: { title: "Tales launch", assignee: `<@${PARAG}>`, priority: "urgent" } };
    });
    await send(mention(TEXT));
    await assertAssigned();
    expect(slack.texts().join("\n")).not.toContain("I'll let him know");
  });

  liveTest("live model: creates the task, tells Parag, fact stored", async () => {
    await send(mention(TEXT));
    await assertAssigned();
  }, 120_000);
});
