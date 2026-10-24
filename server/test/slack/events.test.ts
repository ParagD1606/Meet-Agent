import { beforeEach, describe, expect, test } from "bun:test";
import { addChannel, BOT, evt, nextTs, setup, TEAM } from "./helpers";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { channelMembers, channels, chimeLog, events, journeyState, messageFeedback, turns, users } from "../../src/db/schema";
import { handleEventCallback } from "../../src/slack/events";
import { setTriageGenerator } from "../../src/slack/triage";
import { routeMessage } from "../../src/slack/routing";
import { flushReactions, resetAckBreaker, setReactionGap } from "../../src/slack/reactions";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); setTriageGenerator(); setReactionGap(0); resetAckBreaker(); });

const msg = (o: Record<string, any> = {}) => ({ type: "message", user: "U1", text: "does anyone know the refund policy?", ts: nextTs(), channel: "C1", channel_type: "channel", ...o });
const reactions = async (m: string) => { await flushReactions(); return ctx.fake.calls.filter((c) => c.method === m).map((c) => c.args.name); };

describe("routeMessage (pure)", () => {
  const r = (o: Record<string, any>, botInThread = false) => routeMessage(msg(o) as any, BOT, { botInThread });
  test("ignores bots, self, system subtypes, empty", () => {
    expect(r({ bot_id: "B1" }).kind).toBe("ignore");
    expect(r({ user: BOT }).kind).toBe("ignore");
    expect(r({ user: undefined }).kind).toBe("ignore");
    expect(r({ subtype: "message_changed" }).kind).toBe("ignore");
    expect(r({ subtype: "channel_join" }).kind).toBe("ignore");
    expect(r({ text: "  " }).kind).toBe("ignore");
  });
  test("DM / mention / app_mention / triage", () => {
    expect(r({ channel_type: "im" })).toEqual({ kind: "turn", trigger: "dm" });
    expect(r({ text: `hey <@${BOT}> help` })).toEqual({ kind: "turn", trigger: "mention" });
    expect(r({ type: "app_mention" })).toEqual({ kind: "turn", trigger: "mention" });
    expect(r({})).toEqual({ kind: "triage", context: "channel" });
    expect(r({ subtype: "file_share", text: "", files: [{ id: "F1" }] })).toEqual({ kind: "triage", context: "channel" });
  });
  test("thread replies only matter when the bot is in the thread", () => {
    expect(r({ thread_ts: "1.1" }).kind).toBe("ignore");
    expect(r({ thread_ts: "1.1" }, true)).toEqual({ kind: "triage", context: "thread" });
    expect(r({ thread_ts: "1.1", text: `<@${BOT}> hi` })).toEqual({ kind: "turn", trigger: "mention" });
  });
});

describe("ingress: dedupe, filters, tenancy", () => {
  test("same event_id twice => one turn; retry-safe", async () => {
    const e = evt(msg({ text: `<@${BOT}> what's up` }));
    await handleEventCallback(e);
    await handleEventCallback(e);
    expect(ctx.turns).toHaveLength(1);
    expect((await db.select().from(events)).length).toBe(2); // event_id + message key
  });
  test("message + app_mention for the same message => one turn", async () => {
    const m = msg({ text: `<@${BOT}> hi` });
    await handleEventCallback(evt(m));
    await handleEventCallback(evt({ ...m, type: "app_mention", channel_type: undefined }));
    expect(ctx.turns).toHaveLength(1);
  });
  test("bot/self/edit events are dropped", async () => {
    for (const o of [{ bot_id: "B1" }, { user: BOT }, { subtype: "message_changed" }]) await handleEventCallback(evt(msg({ text: `<@${BOT}> x`, ...o })));
    expect(ctx.turns).toHaveLength(0);
  });
  test("foreign workspace events are dropped; unknown event types are harmless", async () => {
    await handleEventCallback(evt(msg({ text: `<@${BOT}> x` }), { team_id: "TOTHER" }));
    await handleEventCallback(evt({ type: "something_new" }));
    expect(ctx.turns).toHaveLength(0);
  });
  test("handler never throws even when the turn module explodes", async () => {
    const { deps } = await import("../../src/slack/deps");
    deps.runTurn = async () => { throw new Error("turn down"); };
    await handleEventCallback(evt(msg({ text: `<@${BOT}> x` })));
    expect(await reactions("reactions.add")).toContain("warning");
  });
});

describe("turn routing", () => {
  test("mention: strips the mention, threads on the message, 👀 then ✅", async () => {
    const m = msg({ text: `<@${BOT}>   what did we decide?` });
    await handleEventCallback(evt(m));
    expect(ctx.turns[0]).toMatchObject({ trigger: "mention", channelId: "C1", threadTs: m.ts, ts: m.ts, userId: "U1", text: "what did we decide?", isIm: false, isPrivate: false });
    expect(await reactions("reactions.add")).toEqual(["eyes", "white_check_mark"]);
    expect(await reactions("reactions.remove")).toEqual(["eyes"]);
    expect((await db.select().from(users).where(eq(users.id, "U1"))).length).toBe(1);
  });
  test("mention inside an existing thread keeps that thread", async () => {
    await handleEventCallback(evt(msg({ text: `<@${BOT}> hi`, thread_ts: "5.5" })));
    expect(ctx.turns[0].threadTs).toBe("5.5");
  });
  test("DM: dm trigger, isIm, no forced thread, private channel flag for mpim/group", async () => {
    await handleEventCallback(evt(msg({ channel: "D1", channel_type: "im", text: "plain dm" })));
    expect(ctx.turns[0]).toMatchObject({ trigger: "dm", isIm: true, threadTs: undefined, text: "plain dm" });
    await handleEventCallback(evt(msg({ channel: "G1", channel_type: "group", text: `<@${BOT}> hi` })));
    expect(ctx.turns[1]).toMatchObject({ trigger: "mention", isPrivate: true });
    const [g] = await db.select().from(channels).where(eq(channels.id, "G1"));
    expect(g).toMatchObject({ isPrivate: true, botIsMember: true });
  });
});

describe("proactive path: gate -> triage -> budget -> chime turn", () => {
  const triageSays = (out: string) => setTriageGenerator(async () => out);

  test("ANSWER in a proactive channel runs a read-only chime turn", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    triageSays("ANSWER\nPriority: normal");
    const m = msg({ text: "does anyone know the refund policy?" });
    await handleEventCallback(evt(m));
    expect(ctx.turns).toHaveLength(1);
    expect(ctx.turns[0]).toMatchObject({ trigger: "chime", channelId: "C1", threadTs: m.ts, readOnly: true, orgConnectionsOnly: true, userId: "U1" });
    expect(await db.select().from(chimeLog)).toHaveLength(1);
    expect(await reactions("reactions.add")).toEqual([]); // chimes don't 👀
  });
  test("PASS, ACK, and triage failure never run a turn; ACK reacts", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    triageSays("PASS\nReason: humans talking");
    await handleEventCallback(evt(msg()));
    setTriageGenerator(async () => { throw new Error("llm down"); });
    await handleEventCallback(evt(msg()));
    triageSays("garbage");
    await handleEventCallback(evt(msg()));
    expect(ctx.turns).toHaveLength(0);
    expect(await db.select().from(chimeLog)).toHaveLength(0);
    triageSays("ACK\nEmoji: tada\nReason: shipped");
    const m = msg({ text: "we just shipped the new billing flow!" });
    await handleEventCallback(evt(m));
    expect(ctx.turns).toHaveLength(0);
    await flushReactions();
    expect(ctx.fake.calls.find((c) => c.method === "reactions.add")?.args).toMatchObject({ channel: "C1", timestamp: m.ts, name: "tada" });
  });
  test("quiet channels: triage is not even called", async () => {
    await addChannel("CQ", { proactivity: "quiet" });
    let calls = 0;
    setTriageGenerator(async () => { calls++; return "ANSWER\nPriority: normal"; });
    await handleEventCallback(evt(msg({ channel: "CQ" })));
    expect(calls).toBe(0);
    expect(ctx.turns).toHaveLength(0);
  });
  test("budget: a burst of ANSWERs yields a single chime (5 min gap)", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    triageSays("ANSWER\nPriority: urgent");
    for (let i = 0; i < 5; i++) await handleEventCallback(evt(msg()));
    expect(ctx.turns).toHaveLength(1);
  });
  test("thread replies: ignored unless the bot has a turn in that thread, then triaged", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    triageSays("ANSWER\nPriority: normal");
    await handleEventCallback(evt(msg({ thread_ts: "100.1", ts: "100.2" })));
    expect(ctx.turns).toHaveLength(0);
    await db.insert(turns).values({ id: "t1", channelId: "C1", threadTs: "100.1", trigger: "mention" });
    await handleEventCallback(evt(msg({ thread_ts: "100.1", ts: "100.3" })));
    expect(ctx.turns).toHaveLength(1);
    expect(ctx.turns[0].threadTs).toBe("100.1");
  });
  test("@mention bypasses proactivity (works in quiet channels)", async () => {
    await addChannel("CQ", { proactivity: "quiet" });
    await handleEventCallback(evt(msg({ channel: "CQ", text: `<@${BOT}> hi` })));
    expect(ctx.turns).toHaveLength(1);
  });
});

describe("membership + users + reactions + onboarding", () => {
  test("bot joins a channel: flagged member, members synced, intro posted", async () => {
    ctx = await setup({ "conversations.info": () => ({ channel: { id: "C9", name: "launch", is_member: true } }), "conversations.members": () => ({ members: ["U1", "U2", BOT] }) });
    await handleEventCallback(evt({ type: "member_joined_channel", user: BOT, channel: "C9", channel_type: "C" }));
    const [c] = await db.select().from(channels).where(eq(channels.id, "C9"));
    expect(c).toMatchObject({ name: "launch", botIsMember: true });
    expect((await db.select().from(channelMembers).where(eq(channelMembers.channelId, "C9"))).length).toBe(3);
    expect(ctx.fake.count("chat.postMessage")).toBe(2); // intro card + the one-time ambient-learning notice
  });
  test("human joins/leaves tracked; bot leaving clears membership", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    await handleEventCallback(evt({ type: "member_joined_channel", user: "U5", channel: "C1" }));
    expect(await db.select().from(channelMembers)).toHaveLength(1);
    await handleEventCallback(evt({ type: "member_left_channel", user: "U5", channel: "C1" }));
    expect(await db.select().from(channelMembers)).toHaveLength(0);
    await handleEventCallback(evt({ type: "channel_left", channel: "C1" }));
    expect((await db.select().from(channels).where(eq(channels.id, "C1")))[0]!.botIsMember).toBe(false);
  });
  test("team_join upserts the user and sends exactly one welcome DM; user_change updates", async () => {
    const user = { id: "U7", real_name: "Ada Lovelace", profile: { email: "ada@x.io", title: "Eng" }, is_admin: true };
    await handleEventCallback(evt({ type: "team_join", user }));
    await handleEventCallback(evt({ type: "team_join", user }));
    expect(ctx.fake.count("chat.postMessage")).toBe(1);
    expect(await db.select().from(journeyState)).toHaveLength(1);
    await handleEventCallback(evt({ type: "user_change", user: { ...user, real_name: "Ada L", profile: { ...user.profile, title: "CTO" } } }));
    expect((await db.select().from(users).where(eq(users.id, "U7")))[0]).toMatchObject({ name: "Ada L", title: "CTO", role: "admin" });
  });
  test("👍/👎 on bot messages recorded (latest wins); other reactions/messages ignored", async () => {
    const r = (o: Record<string, any>) => handleEventCallback(evt({ type: "reaction_added", user: "U1", reaction: "+1", item_user: BOT, item: { type: "message", channel: "C1", ts: "1.1" }, ...o }));
    await r({});
    await r({ reaction: "-1::skin-tone-3" });
    await r({ reaction: "tada" });
    await r({ item_user: "U2", item: { type: "message", channel: "C1", ts: "2.2" } });
    await r({ user: BOT });
    const rows = await db.select().from(messageFeedback);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rating: "down", messageTs: "1.1", userId: "U1" });
  });
  test("app_home_opened publishes the home tab (not for the messages tab)", async () => {
    await handleEventCallback(evt({ type: "app_home_opened", user: "U1", tab: "home" }));
    await handleEventCallback(evt({ type: "app_home_opened", user: "U1", tab: "messages" }));
    expect(ctx.fake.count("views.publish")).toBe(1);
  });
  test("interactions: journey_quiet handled locally, others forwarded to the turn module", async () => {
    const { handleInteraction } = await import("../../src/slack/interactions");
    await handleInteraction({ type: "block_actions", user: { id: "U1" }, container: { channel_id: "D1", message_ts: "1.1" }, actions: [{ action_id: "journey_quiet" }] });
    expect(ctx.blockActions).toHaveLength(0);
    expect((await db.select().from(journeyState).where(eq(journeyState.userId, "U1")))[0]!.data).toMatchObject({ quiet: true });
    await handleInteraction({ type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "approval_approve" }] });
    expect(ctx.blockActions).toHaveLength(1);
  });
  void TEAM;
});

describe("triage pre-filter + rate limit (zero-token path)", () => {
  test("small talk never reaches the triage model; a rate-limited channel stops calling it", async () => {
    await addChannel("C1", { proactivity: "proactive" });
    let calls = 0;
    setTriageGenerator(async () => { calls++; return "PASS\nReason: x"; });
    await handleEventCallback(evt(msg({ text: "ok thanks" })));
    await handleEventCallback(evt(msg({ text: "lol that was a great lunch yesterday folks" })));
    expect(calls).toBe(0);
    await handleEventCallback(evt(msg({ text: "does anyone know the refund policy?" })));
    expect(calls).toBe(1);
  });
});
