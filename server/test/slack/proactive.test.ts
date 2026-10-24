// B4 (b)+(d): opt-in private nudges and the auto-reply confidence gate, with scope isolation.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { addChannel, evt, nextTs, setup } from "./helpers";
import { db } from "../../src/db";
import { chimeLog } from "../../src/db/schema";
import { handleEventCallback } from "../../src/slack/events";
import { setFeatureChannels } from "../../src/slack/proactive-features";
import { setTriageGenerator } from "../../src/slack/triage";
import { resetSampling } from "../../src/slack/triage-prefilter";
import { clearRecallCache } from "../../src/memory/recall";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(installFakes);
afterAll(() => { removeFakes(); setTriageGenerator(); });
beforeEach(async () => { ctx = await setup(); setTriageGenerator(); resetSampling(); clearRecallCache(); });

const msg = (o: Record<string, any> = {}) => ({ type: "message", user: "U1", text: "should we use Stripe for billing payments?", ts: nextTs(), channel: "C1", channel_type: "channel", ...o });
const ephemerals = () => ctx.fake.calls.filter((c) => c.method === "chat.postEphemeral").map((c) => c.args);
const DECISION = "We decided to use Stripe for billing payments";

describe("private nudge on a past decision", () => {
  test("opted-in channel: asker gets an ephemeral nudge, no public turn, even when the channel is not proactive", async () => {
    await addChannel("C1", { proactivity: "quiet" });
    await setFeatureChannels("nudge", ["C1"]);
    await seedMemory("shared", DECISION, { factType: "decision" });
    const m = msg();
    expect(await handleEventCallback(evt(m))).toBeUndefined();
    expect(ephemerals()).toHaveLength(1);
    expect(ephemerals()[0]).toMatchObject({ channel: "C1", user: "U1", thread_ts: m.ts });
    expect(ephemerals()[0].text).toContain("past decision");
    expect(ctx.turns).toHaveLength(0);
    expect(ctx.fake.count("chat.postMessage")).toBe(0);
  });

  test("not opted in: nothing happens", async () => {
    await addChannel("C1", { proactivity: "quiet" });
    await seedMemory("shared", DECISION, { factType: "decision" });
    await handleEventCallback(evt(msg()));
    expect(ephemerals()).toHaveLength(0);
  });

  test("only decisions that strongly match: a plain fact or an unrelated decision does not nudge", async () => {
    await addChannel("C1", { proactivity: "quiet" });
    await setFeatureChannels("nudge", ["C1"]);
    await seedMemory("shared", DECISION, { factType: "fact" });
    await seedMemory("shared", "We decided the offsite will be in Lisbon in March", { factType: "decision" });
    await handleEventCallback(evt(msg()));
    expect(ephemerals()).toHaveLength(0);
  });

  test("scope isolation: a private channel's decision never nudges in a public channel (and does in its own channel)", async () => {
    await addChannel("C1", { proactivity: "quiet" });
    await addChannel("GP", { isPrivate: true, proactivity: "quiet" });
    await setFeatureChannels("nudge", ["C1", "GP"]);
    await seedMemory("channel_GP", DECISION, { factType: "decision" });
    await handleEventCallback(evt(msg()));
    expect(ephemerals()).toHaveLength(0);
    await handleEventCallback(evt(msg({ channel: "GP", channel_type: "group" })));
    expect(ephemerals()).toHaveLength(1);
    expect(ephemerals()[0].channel).toBe("GP");
  });

  test("per-user rate limit: 2 nudges in a burst, then silence", async () => {
    await addChannel("C1", { proactivity: "quiet" });
    await setFeatureChannels("nudge", ["C1"]);
    await seedMemory("shared", DECISION, { factType: "decision" });
    for (let i = 0; i < 4; i++) await handleEventCallback(evt(msg()));
    expect(ephemerals()).toHaveLength(2);
    await handleEventCallback(evt(msg({ user: "U2" })));
    expect(ephemerals()).toHaveLength(3); // another person has their own budget
  });
});

describe("auto-reply confidence gate", () => {
  const answer = () => setTriageGenerator(async () => "ANSWER\nPriority: normal");

  test("gate off (default): unchanged behaviour, public chime turn", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    answer();
    await handleEventCallback(evt(msg({ text: "does anyone know the refund policy?" })));
    expect(ctx.turns).toHaveLength(1);
    expect(ephemerals()).toHaveLength(0);
  });

  test("gate on, no close memory: only an ephemeral suggestion, no turn, no chime budget spent", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    await setFeatureChannels("autoreply", ["C1"]);
    answer();
    await handleEventCallback(evt(msg({ text: "does anyone know the refund policy?" })));
    expect(ctx.turns).toHaveLength(0);
    expect(ephemerals()).toHaveLength(1);
    expect(ephemerals()[0]).toMatchObject({ user: "U1" });
    expect(await db.select().from(chimeLog)).toHaveLength(0);
  });

  test("gate on, close memory match: public turn goes ahead", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    await setFeatureChannels("autoreply", ["C1"]);
    await seedMemory("shared", "The refund policy is thirty days for annual plans", {});
    answer();
    await handleEventCallback(evt(msg({ text: "the refund policy is thirty days for annual plans, right?" })));
    expect(ctx.turns).toHaveLength(1);
  });

  test("gate on, explicit summons priority: public turn", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    await setFeatureChannels("autoreply", ["C1"]);
    setTriageGenerator(async () => "ANSWER\nPriority: summons");
    await handleEventCallback(evt(msg({ text: "brain, what is the refund policy?" })));
    expect(ctx.turns).toHaveLength(1);
  });

  test("triage prompt carries the memory the channel may read, and nothing else", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    await seedMemory("shared", DECISION, { factType: "decision" });
    await seedMemory("channel_GP", "Stripe billing payments secret plan is Hooli", { factType: "decision" });
    let prompt = "";
    setTriageGenerator(async (a) => { prompt = a.prompt; return "PASS\nReason: x"; });
    await handleEventCallback(evt(msg()));
    expect(prompt).toContain("<memory>");
    expect(prompt).toContain(DECISION);
    expect(prompt).not.toContain("Hooli");
  });
});
