import "../slack/env";
// Replay: the model wrote its tool call as text:  call:enable_tool_family family="slack_search" /
// and  call:ask_teammate recipient="@Derpx06" message="..." /  and Slack showed that raw text to the user.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { like } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../../src/db/schema";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { DERP, boot, dm, liveTest, mention, offered, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterAll(teardown);

const RAW = [`call:enable_tool_family family="slack_search" /`, `call:ask_teammate recipient="@Derpx06" message="All the tasks are done now." /`];
/** Nothing the user can see (posts, updates, streamed drafts) may contain a raw pseudo tool call. */
const noRawCall = () => {
  const everything = JSON.stringify(slack.calls.map((c) => c.args));
  expect(everything).not.toMatch(/call:[a-z_]+/);
  expect(everything).not.toMatch(/<tool_call>|tool_code/);
};
const asks = async () => (await db.select().from(settings).where(like(settings.key, "ask:%"))).map((r) => r.value as any);

describe("raw pseudo tool-call text never reaches Slack", () => {
  scriptedTest("ask_teammate as text -> one repair nudge -> a real call with near-miss names (recipient/message) -> consent card", async () => {
    const model = scriptModel((s) => {
      if (s.called("ask_teammate")) return { text: "I asked Derpx06 for you; waiting for your OK." };
      if (s.prompt.includes("raw tool call")) return { call: "ask_teammate", input: { recipient: "@Derpx06", message: "All the tasks are done now." } };
      return { text: RAW[1]! };
    });
    await send(dm("ask @Derpx06 whether all the tasks are done now"));
    const [ask] = await asks();
    expect(ask).toMatchObject({ owner: DERP, status: "proposed", question: "All the tasks are done now." });
    expect(slack.posts().some((p) => JSON.stringify(p.blocks ?? []).includes("brain_ask_yes"))).toBe(true);
    expect(model.doStreamCalls).toHaveLength(3);
    noRawCall();
  });

  scriptedTest("enable_tool_family as text -> repaired; the alias `name` also works", async () => {
    scriptModel((s) => {
      if (s.called("enable_tool_family")) return { text: "Slack search is on; I found nothing new." };
      if (s.prompt.includes("raw tool call")) return { call: "enable_tool_family", input: { name: "slack_search" } };
      return { text: RAW[0]! };
    });
    await send(dm("search slack for the tales launch thread"));
    expect(slack.texts().at(-1)).toContain("Slack search is on");
    noRawCall();
  });

  scriptedTest("model never repairs itself -> plain-language fallback, no raw text, no action taken", async () => {
    scriptModel(() => ({ text: RAW[1]! }));
    await send(dm("ask @Derpx06 whether all the tasks are done now"));
    expect(slack.texts().at(-1)).toContain("couldn't complete");
    expect(await asks()).toHaveLength(0);
    noRawCall();
  });

  scriptedTest("also in a channel mention at memory depth (streamed drafts included)", async () => {
    scriptModel(() => ({ text: `call:memory_search query="tales" /` }));
    await send(mention("what did we decide about tales?"));
    noRawCall();
    expect(slack.texts().at(-1)).not.toBe("");
  });

  scriptedTest("tools offered to the repair nudge include the real ones", async () => {
    const model = scriptModel((s) => (s.prompt.includes("raw tool call") ? { text: "ok" } : { text: RAW[0]! }));
    await send(dm("ask @Derpx06 whether all the tasks are done now"));
    expect(model.doStreamCalls.length).toBe(2);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("ask_teammate");
    expect(offered(model).has("ask_teammate")).toBe(true);
  });

  liveTest("live model: asking to ask @Derpx06 never leaks call: text and yields a consent card", async () => {
    setLoopModel(); setModelResolverForTest();
    await send(dm(`ask <@${DERP}> whether all the tasks are done now`));
    noRawCall();
    expect((await asks()).some((a) => a.owner === DERP)).toBe(true);
  }, 120_000);
});
