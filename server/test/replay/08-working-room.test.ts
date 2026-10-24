import "../slack/env";
// Replay: a simple memory question ended with "I ran out of working room on this one" because the model burned its steps
// on the same search over and over and never answered.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { seedMemory } from "../memory/helpers";
import { DEPTH_CONFIG } from "../../src/turn/depth";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { boot, liveTest, mention, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); await seedMemory("shared", "Decision: Marlin pricing stays at 49 dollars per seat until January."); });
afterAll(teardown);

const Q = "what did we decide about Marlin pricing?";
const final = () => slack.texts().at(-1)!;
const NO_ROOM = /working room|ran out of|say "?continue/i;

describe("simple memory questions always get an answer", () => {
  scriptedTest("identical repeated search: the repeat is served from cache with an 'answer now' hint, the model then answers", async () => {
    const model = scriptModel((s) => (s.prompt.includes("Already ran this exact call") ? { text: "We decided Marlin pricing stays at 49 dollars per seat." } : { call: "memory_search", input: { query: "Marlin pricing" } }));
    await send(mention(Q));
    expect(final()).toContain("49 dollars");
    expect(final()).not.toMatch(NO_ROOM);
    expect(model.doStreamCalls).toHaveLength(3); // search, repeat (cached), answer
  });

  scriptedTest("a model that never stops searching (new query each time): the final step is tool-less and answers; no 'working room' text", async () => {
    let n = 0;
    const model = scriptModel((s) => ((s.toolChoice as any)?.type === "none" ? { text: "From what I found: Marlin pricing stays at 49 dollars per seat." } : { call: "memory_search", input: { query: `Marlin pricing take ${++n}` } }));
    await send(mention(Q));
    expect(final()).toContain("49 dollars");
    expect(final()).not.toMatch(NO_ROOM);
    expect(model.doStreamCalls).toHaveLength(DEPTH_CONFIG.memory.maxSteps);
    expect((model.doStreamCalls.at(-1)!.toolChoice as any).type).toBe("none");
  });

  scriptedTest("search thrash: the 4th distinct memory_search is refused with 'enough searching' so the model stops", async () => {
    scriptModel((s) => {
      if (s.prompt.includes("Enough searching")) { return { text: "Marlin pricing stays at 49 dollars per seat." }; }
      return { call: "memory_search", input: { query: `pricing ${s.n}` } };
    });
    await send(mention(Q));
    expect(final()).not.toMatch(NO_ROOM);
  });

  scriptedTest("a question that gets a tool-less wrap-up still shows only the answer (no hint at memory depth)", async () => {
    scriptModel((s) => ((s.toolChoice as any)?.type === "none" ? { text: "Marlin pricing stays at 49 dollars per seat." } : { call: "memory_search", input: { query: `x${s.n}` } }));
    await send(mention("what did we decide about Marlin pricing last time?"));
    expect(final()).not.toContain("continue");
  });

  liveTest("live model: the seeded fact is returned and no working-room apology appears", async () => {
    setLoopModel(); setModelResolverForTest();
    await send(mention(Q));
    expect(final()).toMatch(/49/);
    expect(final()).not.toMatch(NO_ROOM);
  }, 120_000);
});
