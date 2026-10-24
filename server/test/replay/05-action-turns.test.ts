import "../slack/env";
// Replay: 'ok tell him that all the tasks are done now', 'say hello to @X', and a bare 'continue' right after a tool turn.
// Bug: these short imperatives were routed to a tool-less depth, so the model could only pretend ("I've told him") while nothing was sent.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { turns } from "../../src/db/schema";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { DERP, ME, boot, dm, liveTest, offered, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterAll(teardown);

const lastTurn = async () => (await db.select().from(turns).where(eq(turns.channelId, "D_DANA")).orderBy(turns.startedAt)).at(-1)!;
const rank = { direct: 0, memory: 1, tools: 2, deep: 3 } as const;
const dmsToDerp = () => slack.to("D_" + DERP).filter((p) => /From Dana via Pixel/.test(p.text));

/** A first tool turn in the DM so "ok tell him ..." / "continue" have something to continue. */
async function priorToolTurn() {
  scriptModel((s) => s.called("assign_task") ? { text: "Done. Assigned the interview room task to Derpx06." } : { call: "assign_task", input: { title: "Interview room feature", assignee: `<@${DERP}>`, notify: false } });
  await send(dm(`assign the interview room feature to <@${DERP}>`));
  expect((await lastTurn()).depth).toBe("tools");
  slack.reset();
}

describe("short imperatives after a tool turn really act", () => {
  scriptedTest("'ok tell him that all the tasks are done now': tools depth, a real DM goes out via notify_teammate", async () => {
    await priorToolTurn();
    const model = scriptModel((s) => s.called("notify_teammate") ? { text: "Sent Derpx06 a DM." } : { call: "notify_teammate", input: { person: "Derpx06", message: "all the tasks are done now" } });
    await send(dm("ok tell him that all the tasks are done now"));
    const t = await lastTurn();
    expect(rank[t.depth as keyof typeof rank]).toBeGreaterThanOrEqual(rank.tools);
    expect(offered(model).has("notify_teammate")).toBe(true);
    expect(dmsToDerp().map((p) => p.text).join()).toContain("all the tasks are done now");
    expect((t.toolCalls as any[]).map((c) => c.name)).toContain("notify_teammate");
  });

  scriptedTest("'say hello to @X' sends a hello", async () => {
    const model = scriptModel((s) => s.called("notify_teammate") ? { text: "Said hello to Derpx06." } : { call: "notify_teammate", input: { person: `<@${DERP}>`, message: "hello" } });
    await send(dm(`say hello to <@${DERP}>`));
    expect(rank[(await lastTurn()).depth as keyof typeof rank]).toBeGreaterThanOrEqual(rank.tools);
    expect(offered(model).has("notify_teammate")).toBe(true);
    expect(dmsToDerp().map((p) => p.text).join()).toContain("hello");
  });

  scriptedTest("a bare 'continue' after a tool turn keeps tools (never drops to memory depth)", async () => {
    await priorToolTurn();
    const model = scriptModel((s) => ({ text: "Continuing: nothing left to do." }));
    await send(dm("continue"));
    expect(rank[(await lastTurn()).depth as keyof typeof rank]).toBeGreaterThanOrEqual(rank.tools);
    expect(offered(model).has("assign_task")).toBe(true);
    expect(offered(model).has("notify_teammate")).toBe(true);
  });

  scriptedTest("the model claims it told him but sent nothing: the claim never reaches Slack, an honest line does", async () => {
    scriptModel(() => ({ text: "I've told him all the tasks are done." }));
    await send(dm("ok tell him that all the tasks are done now"));
    const final = slack.texts().at(-1)!;
    expect(final).not.toContain("I've told him");
    expect(final).toContain("didn't actually");
    expect(dmsToDerp()).toHaveLength(0);
  });

  scriptedTest("'I'll let him know' as a first step is repaired into a real notify_teammate", async () => {
    let first = true;
    scriptModel((s) => {
      if (s.called("notify_teammate")) return { text: "Done: messaged Derpx06." };
      if (first) { first = false; return { text: "Sure, I'll let him know." }; }
      return { call: "notify_teammate", input: { person: "Derpx06", message: "all the tasks are done now" } };
    });
    await send(dm("tell Derpx06 that all the tasks are done now"));
    expect(dmsToDerp()).toHaveLength(1);
    expect(slack.texts().join("\n")).not.toContain("I'll let him know");
  });

  liveTest("live model: 'say hello to @X' and 'ok tell him ...' really DM him", async () => {
    setLoopModel(); setModelResolverForTest();
    await send(dm(`say hello to <@${DERP}>`));
    expect(dmsToDerp().length).toBeGreaterThanOrEqual(1);
    slack.reset();
    await send(dm("ok tell him that all the tasks are done now"));
    const sent = dmsToDerp();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.at(-1)!.text.toLowerCase()).toContain("tasks are done");
    // no claim of having done it unless the DM went out
    expect(slack.texts().at(-1)!).not.toMatch(/call:/);
  }, 180_000);
});
