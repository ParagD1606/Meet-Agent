import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { addChannel, setup } from "./helpers";
import { db } from "../../src/db";
import { memories, memoryReviews, recallLog, users } from "../../src/db/schema";
import { buildRecall } from "../../src/memory/recall";
import { handleInteraction } from "../../src/slack/interactions";
import { resolveActions } from "../../src/slack/cards";
import { STATIC_SYSTEM } from "../../src/turn/prompt";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup({ "chat.getPermalink": () => ({ ok: true, permalink: "https://acme.slack.com/archives/C1/p1" }) });
  await db.insert(users).values([{ id: "UASK", name: "Asker" }]);
  await addChannel("C1");
  await addChannel("CPRIV", { isPrivate: true });
});

const question = "Which region hosts the billing database?";
const value = (t = "111.1") => (resolveActions({ u: "UASK", q: question, t })[0] as any).elements[0].value as string;
const click = (user: string, action_id: string, ch = "C1", extra: any = {}) =>
  handleInteraction({ type: "block_actions", user: { id: user }, container: { channel_id: ch, message_ts: "222.2" },
    message: { ts: "222.2", text: "The billing database lives in eu-west-1. Sources: <https://x.y/z|Slack thread, Oct 3>" },
    actions: [{ action_id, value: value() }], ...extra } as never);

describe("Resolve button", () => {
  test("answers carry Resolved / Not quite actions", () => {
    const ids = (resolveActions({ u: "U1", q: "q" })[0] as any).elements.map((e: any) => e.action_id);
    expect(ids).toEqual(["brain_resolve_yes", "brain_resolve_no"]);
  });

  test("Resolved stores a decision Q/A in the thread's scope and a repeat question recalls it", async () => {
    await click("UASK", "brain_resolve_yes");
    const [m] = await db.select().from(memories);
    expect(m!.scopeTag).toBe("shared");
    expect(m!.factType).toBe("decision");
    expect(m!.text).toBe(`Q: ${question} A: The billing database lives in eu-west-1.`);
    expect(m!.sourceRef).toBe("C1:111.1");
    expect(m!.permalink).toBe("https://acme.slack.com/archives/C1/p1");
    expect(ctx.fake.count("chat.update")).toBe(1);
    const r = await buildRecall({ scope: { channelId: "C1", isPrivate: false, isIm: false, userId: "UASK" }, query: question, rewrite: false });
    expect(r.text).toContain("eu-west-1");
    expect(r.text).toContain("<https://acme.slack.com/archives/C1/p1|Slack thread");
  });

  test("private channel -> channel tag; someone else's click is ignored", async () => {
    await click("UOTHER", "brain_resolve_yes", "CPRIV");
    expect(await db.select().from(memories)).toHaveLength(0);
    await click("UASK", "brain_resolve_yes", "CPRIV");
    expect((await db.select().from(memories))[0]!.scopeTag).toBe("channel_CPRIV");
  });

  test("Not quite asks a follow-up and queues the recalled facts for review", async () => {
    const id = await seedMemory("shared", "billing database is in us-east-1");
    await db.insert(recallLog).values({ channelId: "C1", threadKey: "111.1", messageTs: "111.1", query: question, hitIds: [id] });
    await click("UASK", "brain_resolve_no", "C1", { container: { channel_id: "C1", message_ts: String(Date.now() / 1000) } });
    expect(await db.select().from(memories).where(eq(memories.sourceRef, "C1:111.1"))).toHaveLength(0);
    const post = ctx.fake.calls.find((c) => c.method === "chat.postMessage")!;
    expect(post.args.thread_ts).toBe("111.1");
    expect(post.args.text).toContain("What was missing");
    expect((await db.select().from(memoryReviews)).map((r) => r.memoryId)).toEqual([id]);
  });
});

describe("citations", () => {
  test("prompt asks for inline sources, uncertainty and abstention", () => {
    expect(STATIC_SYSTEM).toContain("Sources:");
    expect(STATIC_SYSTEM).toContain("I don't have that");
    expect(STATIC_SYSTEM).toContain("never invent links");
  });

  test("every cited permalink in recall comes from a scope the asker can read", async () => {
    await seedMemory("shared", "Atlas launch is on Friday", { permalink: "https://acme.slack.com/archives/CPUB/p1", source: "slack" });
    await seedMemory("channel_CPRIV", "Atlas launch budget is secret", { permalink: "https://acme.slack.com/archives/CPRIV/p2", source: "slack" });
    await seedMemory("channel_COTHER", "Atlas launch layoffs plan", { permalink: "https://acme.slack.com/archives/COTHER/p3", source: "slack" });
    const pub = await buildRecall({ scope: { channelId: "C1", isPrivate: false, isIm: false, userId: "UASK" }, query: "Atlas launch", rewrite: false });
    expect(pub.text).toContain("archives/CPUB/p1");
    expect(pub.text).not.toContain("CPRIV");
    expect(pub.text).not.toContain("COTHER");
    const priv = await buildRecall({ scope: { channelId: "CPRIV", isPrivate: true, isIm: false, userId: "UASK" }, query: "Atlas launch", rewrite: false });
    const cited = [...priv.text.matchAll(/https:\/\/acme\.slack\.com\/archives\/(\w+)\//g)].map((m) => m[1]);
    expect(cited.sort()).toEqual(["CPRIV", "CPUB"]);
  });
});
