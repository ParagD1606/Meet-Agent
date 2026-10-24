import { beforeEach, describe, expect, test } from "bun:test";
import { addChannel, evt, nextTs, setup } from "./helpers";
import { handleEventCallback } from "../../src/slack/events";
import { begin, drain, gateKey, resetGate, signalOf } from "../../src/slack/active-turn-gate";
import { deps } from "../../src/slack/deps";
import { clientMsgId, once } from "../../src/slack/idempotent";
import { searchSlackRealtime } from "../../src/slack/search";
import { createReplySink } from "../../src/slack/stream";
import { classifySteer, setSteerClassifier, steerActive } from "../../src/turn/steering";
import { resetAckBreaker, setReactionGap } from "../../src/slack/reactions";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { ctx = await setup(); resetGate(); setSteerClassifier(); resetAckBreaker(); setReactionGap(0); });

describe("classifySteer", () => {
  test("stop words and acks never reach the model", async () => {
    setSteerClassifier(async () => { throw new Error("must not be called"); });
    for (const t of ["stop", "Cancel!", "never mind", "<@UBOT> stop", "please stop"]) expect(await classifySteer("x", { text: t })).toBe("STOP");
    for (const t of ["thanks", "ok", "👍"]) expect(await classifySteer("x", { text: t })).toBe("IGNORE");
    expect(await classifySteer("x", { text: "see the attached", hasFiles: true })).toBe("APPEND");
  });
  test("model verdict is used; garbage or failure falls back to APPEND", async () => {
    setSteerClassifier(async () => "REPLACE.");
    expect(await classifySteer("a", { text: "actually do b instead" })).toBe("REPLACE");
    setSteerClassifier(async () => "dunno");
    expect(await classifySteer("a", { text: "and c?" })).toBe("APPEND");
    setSteerClassifier(async () => { throw new Error("down"); });
    expect(await classifySteer("a", { text: "and c?" })).toBe("APPEND");
  });
});

describe("steerActive", () => {
  const k = gateKey("C1", "1.1");
  const m = (userId: string, text: string) => ({ userId, ts: nextTs(), text });
  test("owner STOP aborts the running turn with reason and clears the inbox", async () => {
    begin(k, { userId: "U1", text: "build report" });
    const sig = signalOf(k)!;
    await steerActive(k, m("U1", "also this")); // queued (fallback APPEND)
    const r = await steerActive(k, m("U1", "stop"));
    expect(r).toMatchObject({ action: "STOP", handled: true });
    expect(sig.aborted).toBe(true);
    expect(sig.reason).toBe("stop");
    expect(drain(k)).toEqual([]);
    expect(signalOf(k)!.aborted).toBe(false); // fresh signal armed for whatever runs next
  });
  test("owner REPLACE aborts and queues only the new message; a stranger's REPLACE/STOP is just queued", async () => {
    begin(k, { userId: "U1", text: "build report" });
    setSteerClassifier(async () => "REPLACE");
    const sig = signalOf(k)!;
    await steerActive(k, m("U2", "actually something else"));
    expect(sig.aborted).toBe(false);
    expect((await steerActive(k, m("U2", "stop"))).action).toBe("APPEND"); // STOP from a non-owner is downgraded
    expect(sig.aborted).toBe(false);
    const r = await steerActive(k, m("U1", "do X instead"));
    expect(r.action).toBe("REPLACE");
    expect(sig.aborted).toBe(true);
    expect(sig.reason).toBe("replace");
    expect(drain(k).map((x) => x.text)).toEqual(["do X instead"]);
  });
  test("IGNORE is dropped; no running turn means not handled", async () => {
    begin(k, { userId: "U1", text: "build report" });
    expect(await steerActive(k, m("U1", "thanks"))).toMatchObject({ action: "IGNORE", handled: true });
    expect(drain(k)).toEqual([]);
    resetGate();
    expect((await steerActive(k, m("U1", "hello"))).handled).toBe(false);
  });
});

describe("end to end: stop in a thread with a running turn", () => {
  test("second message 'stop' aborts the first turn's signal and starts no extra turn", async () => {
    await addChannel("C1");
    let release!: () => void;
    const started: AbortSignal[] = [];
    deps.runTurn = async (i) => { started.push(i.abortSignal!); await new Promise<void>((r) => { release = r; i.abortSignal!.addEventListener("abort", () => r()); }); };
    const ts = nextTs();
    const first = handleEventCallback(evt({ type: "message", user: "U1", text: "<@UBOT> long job", ts, channel: "C1", channel_type: "channel" }));
    await Bun.sleep(150);
    await handleEventCallback(evt({ type: "message", user: "U1", text: "<@UBOT> stop", ts: nextTs(), thread_ts: ts, channel: "C1", channel_type: "channel" }));
    await first;
    expect(started).toHaveLength(1);
    expect(started[0]!.aborted).toBe(true);
    release?.();
  });
});

describe("idempotent posting", () => {
  test("clientMsgId is deterministic and uuid-shaped", () => {
    expect(clientMsgId("a")).toBe(clientMsgId("a"));
    expect(clientMsgId("a")).not.toBe(clientMsgId("b"));
    expect(clientMsgId("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test("once runs at most once per key, but a failed run can be retried", async () => {
    let n = 0;
    await expect(once("k1", async () => { n++; throw new Error("slack down"); })).rejects.toThrow();
    expect((await once("k1", async () => ++n))).toEqual({ replayed: false, value: 2 });
    expect(await once("k1", async () => ++n)).toEqual({ replayed: true });
    expect(n).toBe(2);
  });
  test("a retried turn (same trigger ts) posts its reply once, sends client_msg_id, and removes the second placeholder", async () => {
    const posts: any[] = []; const deleted: string[] = [];
    const slack: any = { chat: {
      postMessage: async (a: any) => { posts.push(a); return { ts: `${posts.length}.1` }; },
      update: async () => ({}), delete: async (a: any) => { deleted.push(a.ts); return {}; },
    } };
    const mk = () => createReplySink({ slack, channel: "C1", threadTs: "1.1", idemKey: "m1" });
    const a = mk(); await a.begin(); await a.finish("the answer");
    const b = mk(); await b.begin(); await b.finish("the answer"); // retry of the same turn
    expect(posts.filter((p) => p.text === "the answer")).toHaveLength(0); // first reply went through update of the placeholder
    const noPlaceholder = (idem: string) => createReplySink({ slack, channel: "C1", threadTs: "1.1", idemKey: idem, placeholder: false });
    const before = posts.length;
    await noPlaceholder("m2").finish("hi"); await noPlaceholder("m2").finish("hi");
    expect(posts.length - before).toBe(1);
    expect(posts.at(-1).client_msg_id).toBe(clientMsgId("C1:1.1:m2:0"));
    expect(deleted).toEqual(["2.1"]); // second placeholder cleaned up
  });
});

describe("Real-time Search", () => {
  test("no action token: clear error, no API call", async () => {
    const r = await searchSlackRealtime({ query: "x" });
    expect(r.ok).toBe(false);
    expect(ctx.fake.count("apiCall")).toBe(0);
  });
  test("missing scope / consent maps to a clear, fallback-pointing error", async () => {
    ctx = await setup({ apiCall: () => { throw Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope" } }); } });
    const r = await searchSlackRealtime({ actionToken: "tok", query: "x" });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("search_slack_channels");
    expect((r as { error: string }).error).toContain("missing_scope");
  });
  test("success parses messages from assistant.search.context", async () => {
    ctx = await setup({ apiCall: () => ({ ok: true, results: { messages: [{ channel_id: "C9", message_ts: "1.2", author_user_id: "U7", content: "the launch is friday", permalink: "https://x/p" }] } }) });
    const r = await searchSlackRealtime({ actionToken: "tok", query: "launch" });
    expect(r).toEqual({ ok: true, hits: [{ channelId: "C9", ts: "1.2", user: "U7", text: "the launch is friday", permalink: "https://x/p" }] });
    const call = ctx.fake.calls.find((c) => c.method === "apiCall")!;
    expect(call.args).toBe("assistant.search.context"); // first positional arg
  });
});
