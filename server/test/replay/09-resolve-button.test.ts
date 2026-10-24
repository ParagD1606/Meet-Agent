import "../slack/env";
// Replay: "Resolved / Not quite" buttons were shown under "Done, I assigned it to Parag", and clicking Resolved saved
// "Q: assign ... A: Done, assigned" as a company fact that later got recalled as an answer.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { db } from "../db";
import { memories } from "../../src/db/schema";
import { seedMemory } from "../memory/helpers";
import { handleInteraction } from "../../src/slack/interactions";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { ME, PARAG, PUB, boot, liveTest, mention, scriptModel, scriptedTest, send, teardown, type Slack, type Step } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterAll(teardown);

const resolveButtons = () => slack.posts().flatMap((p) => (p.blocks ?? []).filter((b) => b.type === "actions").flatMap((b) => b.elements as any[])).filter((e) => e.action_id === "brain_resolve_yes");
const qaFacts = async () => (await db.select().from(memories)).filter((m) => m.status === "active" && m.text.startsWith("Q: "));
const once = (call: string, input: unknown, ack: string) => (s: { called: (n: string) => boolean }): Step => (s.called(call) ? { text: ack } : { call, input });

/** Turns that wrote, notified, asked or saved: every one must end without Resolve buttons. */
const ACTIONS: [string, string, (s: any) => Step][] = [
  ["assign_task", `assign the tales launch to <@${PARAG}> please`, once("assign_task", { title: "Tales launch", assignee: `<@${PARAG}>` }, "Done. I assigned the Tales launch to Parag.")],
  ["notify_teammate", `tell <@${PARAG}> that the deploy is done`, once("notify_teammate", { person: `<@${PARAG}>`, message: "the deploy is done" }, "Sent. Parag has been told.")],
  ["ask_teammate", `ask <@${PARAG}> whether the deploy is done?`, once("ask_teammate", { person: "Parag", question: "Is the deploy done yet?" }, "I asked Parag. I'll bring the answer back here.")],
  ["memory_remember", "please remember that Marlin pricing is final", once("memory_remember", { text: "Marlin pricing is final" }, "Noted: Marlin pricing is final.")],
];

describe("resolve buttons", () => {
  for (const [name, text, script] of ACTIONS) {
    scriptedTest(`no Resolve buttons after a ${name} turn`, async () => {
      scriptModel(script);
      await send(mention(text));
      expect(resolveButtons()).toHaveLength(0);
    });
  }

  scriptedTest("no Resolve buttons after update_task", async () => {
    scriptModel(once("assign_task", { title: "Tales launch", assignee: `<@${PARAG}>`, notify: false }, "Done."));
    await send(mention(`assign tales launch to <@${PARAG}>`));
    slack.reset();
    scriptModel(once("update_task", { title: "Tales launch", status: "done" }, "Marked the Tales launch as done."));
    await send(mention("the tales launch is done", { user: PARAG }));
    expect(resolveButtons()).toHaveLength(0);
  });

  scriptedTest("a question answered with only an acknowledgement gets no buttons", async () => {
    scriptModel(() => ({ text: "Got it, I'll let him know." }));
    await send(mention("can you note that the launch moved to friday?"));
    expect(resolveButtons()).toHaveLength(0);
  });

  scriptedTest("a factual answer shows the buttons; Resolved stores Q/A; an action ack click stores nothing", async () => {
    await seedMemory("shared", "Decision: Marlin pricing stays at 49 dollars per seat until January.");
    scriptModel(() => ({ text: "Marlin pricing stays at 49 dollars per seat until January." }));
    await send(mention("what did we decide about Marlin pricing?"));
    const [yes] = resolveButtons();
    expect(yes).toBeTruthy();
    const click = (text: string, value: string) => handleInteraction({
      type: "block_actions", user: { id: ME }, actions: [{ action_id: "brain_resolve_yes", value }],
      container: { channel_id: PUB, message_ts: "9.1" }, message: { ts: "9.1", text },
    } as never);

    // a stale/forged button under an action acknowledgement: nothing is stored
    await click("Done. I assigned the Tales launch to Parag.", yes.value);
    await click("Sent. Parag has been told.", yes.value);
    expect(await qaFacts()).toHaveLength(0);

    await click("Marlin pricing stays at 49 dollars per seat until January.", yes.value);
    const stored = await qaFacts();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.text).toContain("49 dollars");
    // someone else's click does nothing
    await handleInteraction({ type: "block_actions", user: { id: PARAG }, actions: [{ action_id: "brain_resolve_yes", value: yes.value }], container: { channel_id: PUB, message_ts: "9.2" }, message: { ts: "9.2", text: "Different answer text for a different click." } } as never);
    expect(await qaFacts()).toHaveLength(1);
  });

  liveTest("live model: factual answer has buttons, an assignment has none", async () => {
    setLoopModel(); setModelResolverForTest();
    await seedMemory("shared", "Decision: Marlin pricing stays at 49 dollars per seat until January.");
    await send(mention("what did we decide about Marlin pricing?"));
    expect(resolveButtons().length).toBeGreaterThanOrEqual(1);
    slack.reset();
    await send(mention(`assign the tales launch to <@${PARAG}> please, it is urgent`));
    expect(resolveButtons()).toHaveLength(0);
  }, 180_000);
});
