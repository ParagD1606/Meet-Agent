import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { addChannel, BOT, evt, nextTs, setup, TEAM } from "./helpers";
import { db } from "../../src/db";
import { approvals, channelMembers, channels, users, workspace } from "../../src/db/schema";
import { handleEventCallback } from "../../src/slack/events";
import { begin, drain, end, gateKey, isActive, mergeInbox, offer, resetGate } from "../../src/slack/active-turn-gate";
import { ACK_BREAKER_MAX_PER_HOUR, ack, done, evaluateAckBreaker, flushReactions, resetAckBreaker, setReactionGap } from "../../src/slack/reactions";
import { resetSampling, sampleTriage, triagePrefilter, FULL_TRIAGE_PER_CHANNEL_DAY } from "../../src/slack/triage-prefilter";
import { resolvePrivacy } from "../../src/slack/routing";
import { accessibleChannels, readThread, searchSlackChannels } from "../../src/slack/search";
import { createReplySink, prepareReply } from "../../src/slack/stream";
import { onAssistantThreadStarted, resetAssistantThreads, titleFor } from "../../src/slack/assistant";
import { parseDefault } from "../../src/slack/proactivity";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); resetGate(); resetAckBreaker(); resetSampling(); resetAssistantThreads(); setReactionGap(0); });

describe("active-turn gate + inbox", () => {
  test("second message while active is queued once-noticed and merged", () => {
    const k = gateKey("C1", "1.1");
    expect(begin(k)).toBe(true);
    expect(begin(k)).toBe(false);
    expect(offer(k, { userId: "U1", ts: "2", text: "also this" })).toEqual({ queued: true, notice: true });
    expect(offer(k, { userId: "U2", ts: "3", text: "and that" }).notice).toBe(false);
    const m = mergeInbox(drain(k));
    expect(m.text).toContain("<@U1>: also this");
    expect(m.text).toContain("<@U2>: and that");
    expect(m.ts).toBe("3");
    expect(drain(k)).toEqual([]);
    end(k);
    expect(isActive(k)).toBe(false);
    expect(offer(k, { userId: "U1", ts: "4", text: "x" }).queued).toBe(false);
  });

  test("events: messages during a running turn run as ONE merged follow-up with a single notice", async () => {
    await addChannel("C1");
    const seen: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    const { deps } = await import("../../src/slack/deps");
    deps.runTurn = async (i) => { seen.push(i.text); if (seen.length === 1) await first; };
    const mention = (text: string, ts: string) => evt({ type: "message", user: "U1", text: `<@${BOT}> ${text}`, ts, thread_ts: "50.1", channel: "C1", channel_type: "channel" });
    const p1 = handleEventCallback(mention("first", "50.1"));
    await Bun.sleep(30);
    await handleEventCallback(mention("second", "50.2"));
    await handleEventCallback(mention("third", "50.3"));
    release();
    await p1;
    expect(seen.length).toBe(2);
    expect(seen[1]).toContain("second");
    expect(seen[1]).toContain("third");
    expect(ctx.fake.calls.filter((c) => c.method === "chat.postMessage" && String(c.args.text).includes("pick it up")).length).toBe(1);
  });
});

describe("reaction breaker", () => {
  test("pure: opens after the hourly max and stays open", () => {
    let st: any; const now = Date.now();
    for (let i = 0; i < ACK_BREAKER_MAX_PER_HOUR; i++) { const d = evaluateAckBreaker(st, now); expect(d.allowed).toBe(true); st = d.next; }
    const d = evaluateAckBreaker(st, now);
    expect(d).toMatchObject({ allowed: false, opened: true });
    expect(evaluateAckBreaker(d.next, now + 1000).allowed).toBe(false);
    expect(evaluateAckBreaker(d.next, now + 3_600_001).allowed).toBe(true);
  });
  test("ack past the limit adds no reaction, and done() skips un-acked messages", async () => {
    for (let i = 0; i < ACK_BREAKER_MAX_PER_HOUR + 5; i++) { await ack("C1", `${i}.1`); if (i % 10 === 9) await flushReactions(); }
    await done("C1", "999.1");
    await flushReactions();
    expect(ctx.fake.calls.filter((c) => c.method === "reactions.add").length).toBe(ACK_BREAKER_MAX_PER_HOUR);
    expect(ctx.fake.calls.filter((c) => c.method === "reactions.remove").length).toBe(0);
  });
});

describe("triage pre-filter + sampling", () => {
  const f = (text: string, o: Record<string, any> = {}) => triagePrefilter({ text, botUserId: BOT, context: "channel", ...o });
  test("table", () => {
    expect(f("ok").pass).toBe(false);
    expect(f("lol nice weekend everyone, great lunch yesterday").pass).toBe(false);
    expect(f("<@U9> can you check the deploy?").pass).toBe(false); // addressed to someone else
    expect(f("does anyone know the refund policy?").pass).toBe(true);
    expect(f("We decided to move the launch to Friday").pass).toBe(true);
    expect(f("we just shipped the new billing page, welcome aboard Sam").pass).toBe(true);
    expect(f("a".repeat(3000)).pass).toBe(false);
    expect(f("thanks, that worked", { context: "thread", lastSpeakerId: "U2", speakerId: "U1" }).pass).toBe(false);
    expect(f("what is the status of billing?", { context: "thread", lastSpeakerId: "U2", speakerId: "U1" }).pass).toBe(true);
  });
  test("sampling: full below the daily volume, ~20% above, stable per message", () => {
    for (let i = 0; i < FULL_TRIAGE_PER_CHANNEL_DAY; i++) expect(sampleTriage("C1", `${i}.1`).sampled).toBe(true);
    const picks = Array.from({ length: 500 }, (_, i) => sampleTriage("C1", `${i}.9`).sampled).filter(Boolean).length;
    expect(picks).toBeGreaterThan(40);
    expect(picks).toBeLessThan(180);
    resetSampling();
    for (let i = 0; i < FULL_TRIAGE_PER_CHANNEL_DAY; i++) sampleTriage("C1", `${i}.1`);
    expect(sampleTriage("C1", "77.7").sampled).toBe(sampleTriage("C1", "77.7").sampled);
  });
  test("new proactivity default is own (only #company-brain)", () => {
    expect(parseDefault(undefined)).toBe("own");
    expect(parseDefault("all")).toBe("all");
  });
});

describe("fail-closed privacy", () => {
  test("pure", () => {
    expect(resolvePrivacy(undefined, null)).toEqual({ isIm: false, isPrivate: true });
    expect(resolvePrivacy("channel", null)).toEqual({ isIm: false, isPrivate: false });
    expect(resolvePrivacy("channel", { isIm: false, isPrivate: true }).isPrivate).toBe(true);
    expect(resolvePrivacy("mpim", null).isPrivate).toBe(true);
    expect(resolvePrivacy("im", null).isIm).toBe(true);
  });
  test("app_mention with no channel_type and failing conversations.info is treated as private", async () => {
    ctx = await setup({ "conversations.info": () => { throw new Error("boom"); } });
    await handleEventCallback(evt({ type: "app_mention", user: "U1", text: `<@${BOT}> hi`, ts: nextTs(), channel: "CUNKNOWN" }));
    expect(ctx.turns[0]).toMatchObject({ isPrivate: true, isIm: false });
  });
});

describe("slack search tools are asker-scoped", () => {
  const seed = async () => {
    await db.insert(users).values([{ id: "UA", name: "Ann" }, { id: "UB", name: "Bob" }]);
    await addChannel("CPUB", { name: "general" });
    await addChannel("CPRIV", { name: "secret", isPrivate: true });
    await addChannel("CNOBOT", { name: "nobot", botIsMember: false });
    await db.insert(channelMembers).values([
      { channelId: "CPUB", userId: "UA" }, { channelId: "CPUB", userId: "UB" },
      { channelId: "CPRIV", userId: "UB" }, { channelId: "CNOBOT", userId: "UA" },
    ]);
  };
  test("only channels the asker belongs to (bot present); unknown asker sees nothing", async () => {
    await seed();
    expect((await accessibleChannels({ userId: "UA" })).map((c) => c.id)).toEqual(["CPUB"]);
    expect((await accessibleChannels({ userId: "UB" })).map((c) => c.id).sort()).toEqual(["CPRIV", "CPUB"]);
    expect(await accessibleChannels({ userId: null })).toEqual([]);
  });
  test("read_thread refuses a private channel the asker is not in; search never touches it", async () => {
    await seed();
    const r = await readThread({ asker: { userId: "UA" }, channelId: "CPRIV", threadTs: "1.1" });
    expect(r.ok).toBe(false);
    expect(ctx.fake.calls.some((c) => c.method === "conversations.replies")).toBe(false);
    await searchSlackChannels({ asker: { userId: "UA" }, query: "launch" });
    const hist = ctx.fake.calls.filter((c) => c.method === "conversations.history").map((c) => c.args.channel);
    expect(hist).toEqual(["CPUB"]);
  });
  test("search returns matching messages with names", async () => {
    ctx = await setup({ "conversations.history": () => ({ ok: true, messages: [{ user: "UB", text: "launch moved to friday", ts: "5.1" }, { user: "UB", text: "lunch?", ts: "4.1" }] }) });
    await seed();
    const { hits } = await searchSlackChannels({ asker: { userId: "UA" }, query: "launch" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ user: "Bob", channel: "general" });
  });
});

describe("reply sink", () => {
  test("prepareReply strips broadcasts and chunks", () => {
    const parts = prepareReply(`<!here> ${"x ".repeat(4000)}`);
    expect(parts.join("")).not.toContain("<!here>");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 3000)).toBe(true);
  });
  test("native streaming falls back to a plain post when startStream fails", async () => {
    const calls: string[] = [];
    const slack: any = {
      chat: {
        startStream: async () => { calls.push("start"); throw new Error("not_allowed"); },
        postMessage: async (a: any) => { calls.push(`post:${a.text.slice(0, 12)}`); return { ts: "9.9" }; },
        update: async () => ({}), stopStream: async () => ({}), appendStream: async () => ({}),
      },
      assistant: { threads: { setStatus: async () => ({}) } },
    };
    const sink = createReplySink({ slack, channel: "D1", threadTs: "1.1", native: true });
    await sink.begin();
    const text = "word ".repeat(60);
    sink.text(text);
    await sink.finish(text);
    expect(calls[0]).toBe("start");
    expect(calls.some((c) => c.startsWith("post:word"))).toBe(true);
    expect(sink.mode).toBe("update");
  });
  test("native streaming: start, append, stop with the sanitised remainder", async () => {
    const calls: any[] = [];
    const slack: any = { chat: {
      startStream: async (a: any) => { calls.push(["start", a.markdown_text]); return { ts: "7.7" }; },
      appendStream: async (a: any) => { calls.push(["append", a.markdown_text]); return {}; },
      stopStream: async (a: any) => { calls.push(["stop", a.markdown_text]); return {}; },
    } };
    const sink = createReplySink({ slack, channel: "D1", threadTs: "1.1", native: true, teamId: "T1", userId: "U1" });
    const full = `${"alpha beta ".repeat(20)}<!channel> tail`;
    sink.text(full.slice(0, 150));
    sink.text(full);
    await sink.finish(full);
    expect(calls[0]![0]).toBe("start");
    expect(calls.at(-1)![0]).toBe("stop");
    expect(JSON.stringify(calls)).not.toContain("<!channel>");
  });
});

describe("assistant threads", () => {
  test("assistant_thread_started sets suggested prompts", async () => {
    await handleEventCallback(evt({ type: "assistant_thread_started", assistant_thread: { user_id: "U1", channel_id: "D1", thread_ts: "1.1" } }));
    const c = ctx.fake.calls.find((x) => x.method === "assistant.threads.setSuggestedPrompts");
    expect(c?.args).toMatchObject({ channel_id: "D1", thread_ts: "1.1" });
    expect(c?.args.prompts.length).toBeGreaterThan(1);
    expect(titleFor(`<@${BOT}> ${"long ".repeat(30)}`).length).toBeLessThanOrEqual(60);
    void onAssistantThreadStarted;
  });
});

describe("tokens_revoked / app_uninstalled teardown", () => {
  test("user-token revocation is ignored; bot revocation posts a farewell and tears down", async () => {
    await addChannel("C1");
    await db.update(channels).set({ botIsMember: true }).where(eq(channels.id, "C1"));
    await db.insert(approvals).values({ id: "a1", turnId: "t1", requesterId: "U1", toolName: "x", args: {}, channelId: "C1", status: "pending", expiresAt: new Date(Date.now() + 1e6) } as any).catch(() => undefined);
    await handleEventCallback(evt({ type: "tokens_revoked", tokens: { oauth: ["U1"], bot: [] } }));
    expect((await db.select().from(workspace)).length).toBe(1);
    await handleEventCallback(evt({ type: "tokens_revoked", tokens: { bot: [BOT] } }));
    expect(ctx.fake.calls.some((c) => c.method === "chat.postMessage" && c.args.channel === "CHOME")).toBe(true);
    expect((await db.select().from(workspace)).length).toBe(0);
    expect((await db.select().from(channels).where(eq(channels.id, "C1")))[0]!.botIsMember).toBe(false);
    const [a] = await db.select().from(approvals);
    if (a) expect(a.status).toBe("expired");
    // later events are dropped (no workspace)
    await handleEventCallback(evt({ type: "message", user: "U1", text: `<@${BOT}> hi`, ts: nextTs(), channel: "C1", channel_type: "channel" }));
    expect(ctx.turns).toHaveLength(0);
    void TEAM;
  });
  test("app_uninstalled tears down too", async () => {
    await handleEventCallback(evt({ type: "app_uninstalled" }));
    expect((await db.select().from(workspace)).length).toBe(0);
  });
});
