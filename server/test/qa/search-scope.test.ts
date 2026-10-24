// QA H1: live Slack search must not reach private/DM content from a public-channel turn, and must taint the turn.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { channelMembers, channels, users } from "../../src/db/schema";
import { setSlackClientForTest } from "../../src/slack/client";
import { slackSearchTools } from "../../src/slack/search";
import { installFakes, removeFakes } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
let apiArgs: any;
beforeEach(async () => {
  await resetDb();
  await db.insert(users).values({ id: "U1", name: "Ann" });
  await db.insert(channels).values([{ id: "CPUB", name: "pub", botIsMember: true }, { id: "CPRIV", name: "priv", isPrivate: true, botIsMember: true }]);
  await db.insert(channelMembers).values([{ channelId: "CPUB", userId: "U1" }, { channelId: "CPRIV", userId: "U1" }]);
  setSlackClientForTest({
    apiCall: async (_m: string, a: any) => { apiArgs = a; return { results: { messages: [{ channel_id: "D9", channel_type: "im", content: "my dm secret", message_ts: "1.1" }] } }; },
    conversations: { history: async ({ channel }: any) => ({ messages: [{ ts: "1.1", text: `launch note in ${channel}` }] }), replies: async () => ({ messages: [{ ts: "1.1", text: "launch thread" }] }) },
  });
});
const run = (t: any, input: any) => t.execute(input, { toolCallId: "x", messages: [] });

describe("live search scope", () => {
  test("a public-channel turn searches public channels only", async () => {
    const ctx: any = { userId: "U1", actionToken: "tok", isIm: false, isPrivate: false };
    await run(slackSearchTools(ctx).search_slack_live, { query: "secret" });
    expect(apiArgs.channel_types).toEqual(["public_channel"]);
  });
  test("a DM turn may search everything, and a private hit taints the turn", async () => {
    const ctx: any = { userId: "U1", actionToken: "tok", isIm: true, isPrivate: false };
    await run(slackSearchTools(ctx).search_slack_live, { query: "secret" });
    expect(apiArgs.channel_types).toContain("im");
    expect(ctx.touchedPrivateData).toBe(true);
  });
  test("channel search in a public turn skips private channels and does not taint; in a private turn it taints", async () => {
    const pub: any = { userId: "U1", isIm: false, isPrivate: false };
    const out = String(await run(slackSearchTools(pub).search_slack_channels, { query: "launch" }));
    expect(out).toContain("CPUB");
    expect(out).not.toContain("CPRIV");
    expect(pub.touchedPrivateData).toBeFalsy();
    const priv: any = { userId: "U1", isIm: false, isPrivate: true };
    await run(slackSearchTools(priv).search_slack_channels, { query: "launch" });
    expect(priv.touchedPrivateData).toBe(true);
  });
  test("read_thread refuses a private channel from a public turn", async () => {
    const pub: any = { userId: "U1", isIm: false, isPrivate: false };
    expect(String(await run(slackSearchTools(pub).read_thread, { channelId: "CPRIV", threadTs: "1.1" }))).toContain("not a member");
  });
});
