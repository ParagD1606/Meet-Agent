// Replay: Parag owes Dana an answer; instead he DMs Pixel "cna you please create a task for @Muneer Abass about ... tell him about it".
import "../slack/env";
// Bug: with exactly one open ask, ANY top-level DM from Parag was swallowed as the answer ("Thanks, I passed that on to Dana"); no task was created.
import { afterAll, beforeEach, describe, expect } from "bun:test";
import { eq, like } from "drizzle-orm";
import { db } from "../db";
import { commitments, settings, turns, users } from "../../src/db/schema";
import { handleInteraction } from "../../src/slack/interactions";
import { getAsk, openAsksFor } from "../../src/slack/teammate";
import { ME, PARAG, boot, dm, scriptModel, scriptedTest, send, teardown, type Slack } from "./harness";

let slack: Slack;
beforeEach(async () => { slack = await boot(); });
afterAll(teardown);

const MUNEER = "UMUNEER";
const REAL = "cna you please create a task for @Muneer Abass about the seperation of frontend and the backend in vhsmo also tell him about it as well pelase";
const asks = async () => (await db.select().from(settings).where(like(settings.key, "ask:%"))).map((r) => r.value as any);

async function openAskForParag() {
  scriptModel((s) => s.called("ask_teammate") ? { text: "I asked Parag." } : { call: "ask_teammate", input: { recipient: "@Parag", message: "Are you interested in the Tales project?" } });
  await send(dm("ask Parag whether he is interested in the Tales project", { user: ME, channel: "D_DANA" }));
  const ask = (await asks()).find((a) => a.status === "proposed")!;
  await handleInteraction({ type: "block_actions", user: { id: ME }, actions: [{ action_id: "brain_ask_yes", value: ask.id }], container: { channel_id: "D_DANA", message_ts: "1.1" } });
  expect((await getAsk(ask.id))!.status).toBe("sent");
  return ask.id as string;
}

describe("owner DMs a request while an ask is open", () => {
  scriptedTest("the exact failing DM becomes a normal turn that creates the task; the ask is not answered or relayed", async () => {
    await db.insert(users).values({ id: MUNEER, name: "Muneer Abass" });
    const id = await openAskForParag();
    expect(slack.to("D_" + PARAG).some((p) => /Reply in the thread under this message to answer/.test(p.text))).toBe(true);

    slack.reset();
    const seen: string[] = [];
    scriptModel((s) => {
      seen.push(s.last);
      return s.called("assign_task")
        ? { text: "Done. I created the task for Muneer and told him." }
        : { call: "assign_task", input: { title: "Separate frontend and backend in vhsmo", assignee: `<@${MUNEER}>` } };
    });
    await send(dm(REAL.replace("@Muneer Abass", `<@${MUNEER}>`), { user: PARAG, channel: "D_" + PARAG }));

    // it ran as a turn for Parag (not consumed), and the context note says the message is only context
    expect((await db.select().from(turns).where(eq(turns.channelId, "D_" + PARAG)))).toHaveLength(1);
    expect(seen.join("\n")).toContain("NOT necessarily an answer");
    // a tracked task exists for Muneer
    const [c] = await db.select().from(commitments);
    expect(c).toMatchObject({ ownerId: MUNEER, assignerId: PARAG });
    expect(c!.text.toLowerCase()).toContain("frontend");
    // nothing was relayed to the asker, the owner was not "thanked", the ask is still open
    expect(slack.to("D_DANA")).toHaveLength(0);
    expect(slack.texts().join("\n")).not.toMatch(/Thanks, I passed that on|is your answer/);
    expect((await getAsk(id))!.status).toBe("sent");
    expect(await openAsksFor(PARAG)).toHaveLength(1);
  });

  scriptedTest("plain-text version (no resolved mention) still reaches runTurn and is never relayed", async () => {
    const id = await openAskForParag();
    slack.reset();
    scriptModel(() => ({ text: "Sure, who is Muneer?" }));
    await send(dm(REAL, { user: PARAG, channel: "D_" + PARAG }));
    expect((await db.select().from(turns).where(eq(turns.channelId, "D_" + PARAG)))).toHaveLength(1);
    expect(slack.to("D_DANA")).toHaveLength(0);
    expect((await getAsk(id))!.status).toBe("sent");
  });
});
