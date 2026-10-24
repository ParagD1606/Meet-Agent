import "../slack/env";
// Replay: facts are posted in a public channel (ambient capture), then within a minute "@Pixel are you aware of this info then?".
// Bug: Pixel answered about the unrelated company core note ("VHSMO makes ...") as if that were the posted info.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { db } from "../db";
import { memories } from "../../src/db/schema";
import { setCoreBlockText } from "../../src/memory/core-blocks";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { ME, PUB, boot, liveTest, mention, say, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

const FACTS = [
  "Quokka cluster lives in eu-west-2 and is owned by the platform team",
  "Zephyr gateway latency budget is 40ms at p99",
  "Marlin invoices are due on the 5th of every month",
];
const POSTED = FACTS.map((f) => `${f}, confirmed today`);
const TOKENS = ["quokka", "eu-west-2", "zephyr", "40ms", "marlin", "5th"];
const NOT_YET = /not (yet )?(in|saved|stored|part of)[^.]*(long[- ]term )?memory|haven'?t (saved|stored|captured)|not yet (in )?(my )?(long[- ]term )?memory|just (posted|shared|said)|still (processing|learning)/i;

let slack: Slack;
beforeEach(async () => {
  slack = await boot({ extractFacts: FACTS });
  await setCoreBlockText({ scope: { channelId: PUB, isPrivate: false, isIm: false, userId: ME }, actor: { userId: "UADMIN", role: "admin", agentContext: "primary" }, label: "company", text: "VHSMO makes a screen-free pocket camera for authentic retro photos." });
});
afterAll(teardown);

async function postThenAsk() {
  for (const t of POSTED) await send(say(t));
  slack.reset();
  await send(mention("are you aware of this info then?"));
  return slack.texts().at(-1)!;
}

describe("ambient facts then 'are you aware of this info?'", () => {
  scriptedTest("the turn model is handed the just-posted facts (recent-channel + recalled), not only the company note", async () => {
    const model = scriptModel((s) => {
      // a model that answers from whatever the prompt gives it, like the real one
      const fromChannel = TOKENS.find((t) => s.prompt.toLowerCase().includes(`${t}`) && s.prompt.includes("<recent-channel>"));
      return { text: fromChannel ? "Yes, I saw that in the channel: the Quokka cluster lives in eu-west-2, Zephyr's latency budget is 40ms." : "VHSMO makes a screen-free pocket camera." };
    });
    const reply = await postThenAsk();
    const prompt = JSON.stringify(model.doStreamCalls.at(-1)!.prompt.at(-1));
    expect(prompt).toContain("<recent-channel>");
    for (const f of FACTS) expect(prompt).toContain(f);
    expect(prompt).toContain("<memory-context>"); // flushed into memory before recall
    expect(reply).toContain("eu-west-2");
    expect(reply).not.toMatch(/^VHSMO makes/);
    // and they really are long-term memory now
    const stored = (await db.select().from(memories)).filter((m) => m.status === "active" && m.scopeTag === "shared").map((m) => m.text);
    for (const f of FACTS) expect(stored).toContain(f);
  });

  scriptedTest("even when extraction is down the raw messages still reach the model", async () => {
    const { setMemoryLlm } = await import("../../src/memory/llm");
    setMemoryLlm(async () => { throw new Error("llm down"); });
    const model = scriptModel(() => ({ text: "I can see those messages in the channel." }));
    await postThenAsk();
    const prompt = JSON.stringify(model.doStreamCalls.at(-1)!.prompt.at(-1));
    expect(prompt).toContain("<recent-channel>");
    expect(prompt).toContain("Quokka cluster lives in eu-west-2");
  });

  liveTest("live model: references the posted facts or says they are not in long-term memory yet; never just the company note", async () => {
    setLoopModel(); setModelResolverForTest();
    const reply = await postThenAsk();
    const low = reply.toLowerCase();
    const refs = TOKENS.some((t) => low.includes(t)) || NOT_YET.test(reply);
    expect(refs).toBe(true);
    expect(/screen-free/.test(low) && !TOKENS.some((t) => low.includes(t))).toBe(false);
  }, 180_000);
});
