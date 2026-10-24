import "../slack/env";
// Replay: "@Pixel is the interview room tales feature done?"
// Bug: Pixel said it needed Jira/GitHub to know, or burned its steps and apologised that it "ran out of working room",
// although the task (done/open) was tracked in Pixel's own Tasks.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { addCommitment, resolveCommitment } from "../../src/manager";
import { db } from "../db";
import { commitments } from "../../src/db/schema";
import { setLoopModel } from "../../src/turn/loop";
import { setModelResolverForTest } from "../../src/llm";
import { heuristicDepth } from "../../src/turn/depth";
import { turns } from "../../src/db/schema";
import { DERP, ME, PUB, boot, liveTest, mention, offered, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterAll(teardown);

async function seedTask(status: "open" | "done") {
  await addCommitment({ text: "Interview room tales feature", ownerId: DERP, ownerName: "Derpx06", assignerId: ME, sourceType: "message", sourceRef: "assign:seed", scopeTag: "shared", channelId: PUB, threadTs: "1.1" });
  if (status === "done") {
    const [c] = await db.select().from(commitments);
    await resolveCommitment(c!.id, "done", { id: DERP });
  }
}
const BAD = /jira|github|linear|connect(ing)? (a|the|your) tool|working room|ran out of/i;
const ASK = "is the interview room tales feature done?";

describe("task status questions are answered from the tracked task", () => {
  scriptedTest("routing: 'is X done?' is a memory-depth read, 'X is done' / 'mark it done' stay actions", () => {
    for (const t of [ASK, "is the tales launch completed?", "has the interview room feature been done yet?"]) expect(heuristicDepth({ trigger: "mention", text: t })).toBe("memory");
    for (const t of ["the tales launch is done", "mark the tales launch done", "tell him it is done?", "is it done? tell him"]) expect(heuristicDepth({ trigger: "mention", text: t })).toBe("tools");
  });

  scriptedTest("done task: find_tasks is available at memory depth, its row says done, the answer says so", async () => {
    await seedTask("done");
    const model = scriptModel((s) => {
      if (!s.called("find_tasks")) return { call: "find_tasks", input: { query: "interview room tales feature" } };
      return { text: /\[done/.test(s.prompt) ? "Yes, the interview room tales feature is done (Derpx06 closed it)." : "I can't tell." };
    });
    await send(mention(ASK));
    expect((await db.select().from(turns))[0]!.depth).toBe("memory");
    expect(offered(model).has("find_tasks")).toBe(true);
    const final = slack.texts().at(-1)!;
    expect(final).toContain("is done");
    expect(final).not.toMatch(BAD);
    // the tool result the model saw carries the status and the owner
    const seen = JSON.stringify(model.doStreamCalls.at(-1)!.prompt);
    expect(seen).toContain("[done]");
    expect(seen).toContain(DERP);
  });

  scriptedTest("open task: the row says open and the answer is not 'done'", async () => {
    await seedTask("open");
    scriptModel((s) => {
      if (!s.called("find_tasks")) return { call: "find_tasks", input: { query: "interview room tales feature" } };
      return { text: /\[open/.test(s.prompt) ? "Not yet, it's still open with Derpx06." : "done" };
    });
    await send(mention(ASK));
    expect(slack.texts().at(-1)).toContain("still open");
  });

  scriptedTest("a model that keeps searching never ends with 'ran out of working room' or a Jira/GitHub excuse", async () => {
    await seedTask("done");
    let n = 0;
    scriptModel((s) => {
      if (s.toolChoice && (s.toolChoice as any).type === "none") return { text: "From the tracked task: the interview room tales feature is done." };
      return { call: "memory_search", input: { query: `interview room tales feature variant ${++n}` } };
    });
    await send(mention(ASK));
    const final = slack.texts().at(-1)!;
    expect(final).toContain("is done");
    expect(final).not.toMatch(BAD);
  });

  liveTest("live model: done task is reported done; open task is reported open; no tool excuses", async () => {
    setLoopModel(); setModelResolverForTest();
    await seedTask("done");
    await send(mention(ASK));
    let final = slack.texts().at(-1)!;
    expect(final).toMatch(/done|complete|finished|shipped|closed/i);
    expect(final).not.toMatch(BAD);
    slack = await boot();
    await seedTask("open");
    await send(mention(ASK));
    final = slack.texts().at(-1)!;
    expect(final).toMatch(/open|not (yet )?(done|complete|finished)|in progress|still|pending/i);
    expect(final).not.toMatch(BAD);
  }, 180_000);
});
