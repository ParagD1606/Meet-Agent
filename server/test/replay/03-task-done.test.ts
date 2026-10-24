// Replay: Parag (the owner) says "@Pixel please inform him that the task is done".
import "../slack/env";
// Bug: Pixel said "I'll let him know" but nothing changed: task still open, memory still said open, assigner never told.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { db } from "../db";
import { commitments, memories } from "../../src/db/schema";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { ME, PARAG, PUB, boot, liveTest, mention, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => {
  slack = await boot();
  // setup through the real handler: Dana assigns the Tales launch to Parag
  scriptModel((s) => s.called("assign_task") ? { text: "Done, assigned." } : { call: "assign_task", input: { title: "Tales launch", assignee: `<@${PARAG}>`, priority: "urgent" } });
  await send(mention(`assign tales launch to <@${PARAG}>, urgent`, { user: ME }));
  slack.reset();
});
afterAll(teardown);

async function assertDone() {
  const [c] = await db.select().from(commitments);
  expect(c!.status).toBe("done");
  expect(c!.completedAt).toBeTruthy();
  const facts = await db.select().from(memories);
  const active = facts.filter((m) => m.status === "active" && /tales launch/i.test(m.text));
  expect(active).toHaveLength(1);
  expect(active[0]!.text).toMatch(/\[done/);
  const old = facts.filter((m) => m.status === "superseded" && /tales launch/i.test(m.text));
  expect(old.length).toBeGreaterThanOrEqual(1);
  expect(old[0]!.text).toMatch(/\[open/);
  expect(c!.memoryId).toBe(active[0]!.id);
  // the assigner (Dana) is told in a DM
  const told = slack.posts().filter((p) => p.channel === "D_" + ME && /completed/i.test(p.text) && /tales/i.test(p.text));
  expect(told.length).toBeGreaterThanOrEqual(1);
}

describe("owner reports the task done", () => {
  scriptedTest("update_task marks it done, supersedes the open fact, DMs the assigner", async () => {
    scriptModel((s) => s.called("update_task") ? { text: "Marked the Tales launch as done and told Dana." } : { call: "update_task", input: { title: "Tales launch", status: "done" } });
    await send(mention("please inform him that the task is done", { user: PARAG }));
    await assertDone();
    expect(slack.texts().at(-1)).toContain("done");
  });

  scriptedTest("model first promises ('I'll let him know') with no tool: the loop repairs it into a real update", async () => {
    let first = true;
    scriptModel((s) => {
      if (s.called("update_task")) return { text: "Marked it done; Dana has been told." };
      if (first) { first = false; return { text: "Sure, I'll let him know the task is done." }; }
      return { call: "update_task", input: { title: "tales launch", status: "done" } };
    });
    await send(mention("please inform him that the task is done", { user: PARAG }));
    await assertDone();
    expect(slack.texts().join("\n")).not.toContain("I'll let him know");
  });

  scriptedTest("a stranger cannot close someone else's task and the model must say so", async () => {
    scriptModel((s) => s.called("update_task") ? { text: "I can't change that one; only Parag or Dana can." } : { call: "update_task", input: { title: "Tales launch", status: "done" } });
    await send(mention("mark the tales launch done", { user: "UEVE" }));
    expect((await db.select().from(commitments))[0]!.status).toBe("open");
  });

  liveTest("live model: owner says 'inform him that the task is done'", async () => {
    setLoopModel(); setModelResolverForTest();
    await send(mention("please inform him that the tales launch task is done", { user: PARAG }));
    await assertDone();
  }, 120_000);
});
