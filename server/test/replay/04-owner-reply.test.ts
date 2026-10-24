// Replay: Pixel asked Parag a question on Dana's behalf; Parag answered in his DM, top-level: "ok tell him i am not interested".
import "../slack/env";
// Bug: the answer was run as a fresh turn, the model said "I'll let him know" with nothing relayed, and Dana never heard back.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { eq, like } from "drizzle-orm";
import { db } from "../db";
import { memories, settings, turns } from "../../src/db/schema";
import { handleInteraction } from "../../src/slack/interactions";
import { getAsk, openAsksFor } from "../../src/slack/teammate";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { ME, PARAG, boot, dm, liveTest, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterAll(teardown);

const asks = async () => (await db.select().from(settings).where(like(settings.key, "ask:%"))).map((r) => r.value as any);

/** Dana DMs Pixel; the model (with near-miss argument names) proposes the ask; Dana clicks "Ask them". */
async function askParag(question: string, user = ME, channel = "D_DANA") {
  const before = (await asks()).length;
  await send(dm(`ask Parag ${question}`, { user, channel }));
  const all = await asks();
  expect(all.length).toBe(before + 1);
  const ask = all.find((a) => a.status === "proposed")!;
  const card = slack.posts().find((p) => JSON.stringify(p.blocks ?? []).includes(ask.id))!;
  expect(card).toBeTruthy();
  await handleInteraction({ type: "block_actions", user: { id: user }, actions: [{ action_id: "brain_ask_yes", value: ask.id }], container: { channel_id: channel, message_ts: "1.1" } });
  expect((await getAsk(ask.id))!.status).toBe("sent");
  return ask.id as string;
}
const proposeThenDeliver = (q: string) => scriptModel((s) => s.called("ask_teammate")
  ? { text: "I asked Parag. I'll bring the answer back here." }
  : { call: "ask_teammate", input: { recipient: "@Parag", message: q } }); // recipient/message: the near-miss names the real model used

describe("owner answers an ask in a DM", () => {
  scriptedTest("top-level DM reply is captured, stored, relayed to the asker; owner is thanked; no model turn, no empty promise", async () => {
    proposeThenDeliver("Are you interested in the Tales project?");
    const id = await askParag("whether he is interested in the Tales project");
    expect(slack.to("D_" + PARAG).some((p) => /asked me to check with you/.test(p.text))).toBe(true);
    expect(await openAsksFor(PARAG)).toHaveLength(1);

    slack.reset();
    setLoopModel(undefined); // a turn here would hit the real model: it must not run
    scriptModel(() => { throw new Error("the owner's answer must be consumed without a model turn"); });
    await send(dm("ok tell him i am not interested", { user: PARAG, channel: "D_" + PARAG }));

    expect((await getAsk(id))!.status).toBe("answered");
    // relayed to the asker's DM, quoting the owner's words
    expect(slack.to("D_DANA").some((p) => /not interested/.test(p.text))).toBe(true);
    // the owner is thanked
    expect(slack.to("D_" + PARAG).some((p) => /Thanks, I passed that on/.test(p.text))).toBe(true);
    // the answer is remembered in the asker's scope
    const facts = (await db.select().from(memories)).filter((m) => m.status === "active" && /not interested/.test(m.text));
    expect(facts).toHaveLength(1);
    expect(facts[0]!.scopeTag).toBe(`user_${ME}`);
    // never an unbacked promise, and no turn row for the owner's message
    expect(slack.texts().join("\n")).not.toMatch(/let him know|I'll tell him/i);
    expect((await db.select().from(turns).where(eq(turns.channelId, "D_" + PARAG)))).toHaveLength(0);
    expect(await openAsksFor(PARAG)).toHaveLength(0);
  });

  scriptedTest("a clarifying question back is not an answer", async () => {
    proposeThenDeliver("Are you interested in the Tales project?");
    const id = await askParag("whether he is interested in the Tales project");
    scriptModel((s) => ({ text: "Sure, what would you like to know?" }));
    await send(dm("interested in what exactly?", { user: PARAG, channel: "D_" + PARAG }));
    expect((await getAsk(id))!.status).toBe("sent");
  });

  scriptedTest("two open asks: the owner gets a picker, only the clicked question is answered", async () => {
    proposeThenDeliver("Are you interested in the Tales project?");
    const a1 = await askParag("whether he is interested in the Tales project");
    proposeThenDeliver("Did you pay the Marlin invoice?");
    await db.insert((await import("../../src/db/schema")).channels).values({ id: "D_EVE", name: "dm-eve", isIm: true, botIsMember: true }).onConflictDoNothing();
    const a2 = await askParag("whether he paid the Marlin invoice", "UEVE", "D_EVE");
    expect(await openAsksFor(PARAG)).toHaveLength(2);

    slack.reset();
    await send(dm("not yet, next week", { user: PARAG, channel: "D_" + PARAG }));
    const picker = slack.to("D_" + PARAG).find((p) => /Which question is that answering/.test(p.text));
    expect(picker).toBeTruthy();
    const buttons = (picker!.blocks!.find((b) => b.type === "actions")!.elements as any[]);
    expect(buttons).toHaveLength(2);
    expect((await getAsk(a1))!.status).toBe("sent");
    expect((await getAsk(a2))!.status).toBe("sent");

    const pick = buttons.find((b) => JSON.parse(b.value).a === a2)!;
    await handleInteraction({ type: "block_actions", user: { id: PARAG }, actions: [{ action_id: "brain_ask_pick", value: pick.value }], container: { channel_id: "D_" + PARAG, message_ts: "9.9" } });
    expect((await getAsk(a2))!.status).toBe("answered");
    expect((await getAsk(a1))!.status).toBe("sent");
    expect(slack.to("D_EVE").some((p) => /not yet, next week/.test(p.text))).toBe(true);
    expect(slack.to("D_DANA").some((p) => /not yet/.test(p.text))).toBe(false);
    expect(slack.to("D_" + PARAG).some((p) => /Thanks, I passed that on/.test(p.text))).toBe(true);
    // a click by someone else does nothing
    await handleInteraction({ type: "block_actions", user: { id: "UEVE" }, actions: [{ action_id: "brain_ask_pick", value: buttons.find((b) => JSON.parse(b.value).a === a1)!.value }], container: { channel_id: "D_" + PARAG, message_ts: "9.9" } });
    expect((await getAsk(a1))!.status).toBe("sent");
  });

  liveTest("live model: 'ask Parag ...' produces a consent card for Parag, and his DM answer is relayed", async () => {
    setLoopModel(); setModelResolverForTest();
    await send(dm("please ask Parag whether he is interested in the Tales project", { user: ME, channel: "D_DANA" }));
    const ask = (await asks()).find((a) => a.owner === PARAG && a.status === "proposed");
    expect(ask).toBeTruthy();
    await handleInteraction({ type: "block_actions", user: { id: ME }, actions: [{ action_id: "brain_ask_yes", value: ask.id }], container: { channel_id: "D_DANA", message_ts: "1.1" } });
    await send(dm("ok tell him i am not interested", { user: PARAG, channel: "D_" + PARAG }));
    expect((await getAsk(ask.id))!.status).toBe("answered");
    expect(slack.to("D_DANA").some((p) => /not interested/.test(p.text))).toBe(true);
  }, 120_000);
});
