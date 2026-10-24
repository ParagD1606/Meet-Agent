// Shared harness for the regression replay suite: real handlers + real Postgres, fake Slack, scripted (or live) model.
import "../slack/env";
import { test } from "bun:test";
import { sql } from "drizzle-orm";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { db, resetDb } from "../db";
import { encrypt } from "../../src/crypto";
import { channelMembers, channels, users, workspace } from "../../src/db/schema";
import { setSlackClientForTest } from "../../src/slack/client";
import { deps } from "../../src/slack/deps";
import { handleEventCallback } from "../../src/slack/events";
import { settleAmbient } from "../../src/slack/ambient-hook";
import { setSlackClient } from "../../src/turn/slack";
import { setLoopModel } from "../../src/turn/loop";
import { setDepthClassifier } from "../../src/turn/depth";
import { setModelResolverForTest } from "../../src/llm";
import { setMemoryLlm } from "../../src/memory/llm";
import { setEmbedder } from "../../src/memory/embed";
import { ambientIo, resetAmbientRate } from "../../src/memory/ambient";
import { invalidateLimits } from "../../src/limits/settings";
import { EXTRACT_SYSTEM } from "../../src/memory/writeback";
import { fakeSlack } from "../slack/helpers";
import { fakeVector } from "../memory/helpers";

// the app logs JSON lines to stdout; keep test output readable (REPLAY_LOGS=1 to see them)
const stdout = console.log.bind(console);
if (!process.env.REPLAY_LOGS) console.log = (...a: unknown[]) => { if (typeof a[0] === "string" && a[0].startsWith('{"t":')) return; stdout(...a); };

export const LIVE = process.env.LIVE_MODEL === "1";
/** Live-model scenarios: skipped unless LIVE_MODEL=1 (never in CI). */
// one retry: a live provider occasionally stalls past the 120s turn limit; a real regression fails twice
export const liveTest = (LIVE ? (name: string, fn: () => Promise<void>, ms = 120_000) => test(name, fn, { timeout: ms, retry: 1 }) : test.skip) as (name: string, fn: () => Promise<void>, ms?: number) => void;
/** Scripted-model scenarios: skipped in a live run, so LIVE_MODEL=1 only spends on the live ones. */
export const scriptedTest = LIVE ? test.skip : test;

export const BOT = "UBOT";
export const ME = "UDANA"; // the asker in most transcripts
export const PARAG = "UPARAG";
export const DERP = "UDERP";
export const PUB = "CPUB";
export const PRIV = "CPRIV";

const realDeps = { runTurn: deps.runTurn, handleBlockAction: deps.handleBlockAction };

export type Post = { method: string; channel: string; thread_ts?: string; text: string; blocks?: any[]; ts?: string };
export type Slack = ReturnType<typeof fakeSlack> & { posts: () => Post[]; texts: () => string[]; to: (channel: string) => Post[]; reset: () => void };

export async function boot(o: { extractFacts?: string[] } = {}): Promise<Slack> {
  await resetDb();
  await db.execute(sql`create table if not exists message_feedback (
    id bigserial primary key, channel_id text not null, message_ts text not null, user_id text not null,
    rating text not null, created_at timestamptz not null default now())`);
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: BOT, homeChannelId: "CHOME" });
  await db.insert(users).values([
    { id: ME, name: "Dana" }, { id: PARAG, name: "Parag" }, { id: DERP, name: "Derpx06" }, { id: "UEVE", name: "Eve" },
    { id: "UADMIN", name: "Root", role: "admin" },
  ]);
  await db.insert(channels).values([
    { id: PUB, name: "general", botIsMember: true }, { id: PRIV, name: "secret", isPrivate: true, botIsMember: true },
    { id: "D_DANA", name: "dm-dana", isIm: true, botIsMember: true }, { id: "D_PARAG", name: "dm-parag", isIm: true, botIsMember: true },
  ]);
  await db.insert(channelMembers).values([
    { channelId: PUB, userId: ME }, { channelId: PUB, userId: PARAG }, { channelId: PUB, userId: "UEVE" },
    { channelId: PRIV, userId: ME }, { channelId: PRIV, userId: "UADMIN" },
  ]);
  invalidateLimits();
  resetAmbientRate();
  ambientIo.post = async () => {};
  ambientIo.permalink = async (c, ts) => `https://acme.slack.com/archives/${c}/p${ts.replace(".", "")}`;
  deps.runTurn = realDeps.runTurn;
  deps.handleBlockAction = realDeps.handleBlockAction;

  const mem = (a: { system: string; prompt: string }) => (a.system.includes("standalone search query") ? JSON.stringify({ query: a.prompt.split("LATEST MESSAGE: ").pop()!.trim() || "x", asOf: null }) // identity rewrite
    : a.system === EXTRACT_SYSTEM ? JSON.stringify({ facts: o.extractFacts ?? [] }) : '{"superseded":[],"facts":[],"commitments":[]}');
  setEmbedder(async (texts) => texts.map(fakeVector)); // deterministic and free, in live mode too
  setMemoryLlm(LIVE ? null : async (a) => mem(a));
  setDepthClassifier(async () => "memory");
  let n = 0;
  store.length = 0;
  // the fake workspace remembers what was said, so history/thread reads (used for "tell him", "continue") look like real Slack
  const fake = fakeSlack({
    "conversations.replies": (a) => ({ ok: true, messages: store.filter((m) => m.channel === a.channel && (m.ts === a.ts || m.thread_ts === a.ts)).map(pub) }),
    "conversations.history": (a) => ({ ok: true, messages: store.filter((m) => m.channel === a.channel && (!m.thread_ts || m.thread_ts === m.ts)).map(pub).reverse() }),
    "chat.getPermalink": (a) => ({ ok: true, permalink: `https://acme.slack.com/archives/${a.channel}/p${String(a.message_ts).replace(".", "")}` }),
    "chat.postMessage": (a) => { const ts = `${1800000000 + ++n}.000100`; store.push({ channel: a.channel, ts, thread_ts: a.thread_ts, user: BOT, text: String(a.text ?? "") }); return { ok: true, ts, channel: a.channel }; },
    "chat.update": (a) => { const m = store.find((x) => x.channel === a.channel && x.ts === a.ts); if (m) m.text = String(a.text ?? ""); return { ok: true, ts: a.ts, channel: a.channel }; },
  });
  setSlackClientForTest(fake.client);
  setSlackClient(async () => fake.client as never);
  const posts = (): Post[] => fake.calls.filter((c) => c.method === "chat.postMessage" || c.method === "chat.update")
    .map((c) => ({ method: c.method, channel: c.args.channel, thread_ts: c.args.thread_ts, text: String(c.args.text ?? ""), blocks: c.args.blocks, ts: c.args.ts }));
  return { ...fake, posts, texts: () => posts().map((p) => p.text), to: (ch) => posts().filter((p) => p.channel === ch), reset: () => { fake.calls.length = 0; } };
}

type Msg = { channel: string; ts: string; thread_ts?: string; user: string; text: string };
const store: Msg[] = [];
const pub = ({ channel: _c, ...m }: Msg) => m;
/** Pre-existing Slack history for conversations.replies/history (not routed through any handler). */
export const seedMessage = (channel: string, ts: string, thread_ts: string | undefined, user: string, text: string) => void store.push({ channel, ts, thread_ts, user, text });

export function teardown() {
  setLoopModel(); setModelResolverForTest(); setMemoryLlm(null); setEmbedder(null); setDepthClassifier();
  deps.runTurn = realDeps.runTurn; deps.handleBlockAction = realDeps.handleBlockAction;
}

// ---- scripted model ----------------------------------------------------------------------------------------
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
export type Step = { text: string } | { call: string; input: unknown } | { calls: { call: string; input: unknown }[] };
export type Seen = {
  n: number;
  /** whole prompt as JSON */ prompt: string;
  /** last message as JSON */ last: string;
  /** true once a tool result for `name` is in the prompt */ called: (name: string) => boolean;
  toolNames: string[];
  toolChoice?: unknown;
};
let id = 0;
const chunks = (s: Step): any[] => {
  const head = { type: "stream-start", warnings: [] };
  if ("text" in s) return [head, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: s.text }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];
  const cs = "calls" in s ? s.calls : [s];
  return [head, ...cs.map((c) => ({ type: "tool-call", toolCallId: `c${++id}`, toolName: c.call, input: JSON.stringify(c.input) })), { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage }];
};
/** A model that answers every step with whatever `f` says. Installed as THE turn model (and the triage/recovery role). */
export function scriptModel(f: (s: Seen) => Step) {
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async (o: any) => {
      const prompt = JSON.stringify(o.prompt);
      const seen: Seen = {
        n: ++n, prompt, last: JSON.stringify(o.prompt.at(-1)), toolChoice: o.toolChoice,
        toolNames: (o.tools ?? []).map((t: any) => t.name),
        called: (name) => prompt.includes(`"toolName":"${name}"`) && prompt.includes('"type":"tool-result"'),
      };
      return { stream: simulateReadableStream({ chunks: chunks(f(seen)) as any }) } as any;
    },
  });
  setLoopModel(model as any);
  setModelResolverForTest((role) => (role === "triage" ? (model as any) : undefined));
  return model;
}
/** Tool names the model was offered across the whole script. */
export const offered = (m: MockLanguageModelV4) => new Set(m.doStreamCalls.flatMap((c) => (c.tools ?? []).map((t: any) => t.name as string)));

// ---- Slack events ------------------------------------------------------------------------------------------
let evN = 0;
let tsN = Math.floor(Date.now() / 1000) - 3600;
export const nextTs = () => `${++tsN}.000${100 + (tsN % 800)}`;
type Ev = { event_id: string; team_id: string; type: string; event: Record<string, any> };
const wrap = (event: Record<string, any>): Ev => ({ event_id: `EvR${++evN}`, team_id: "T1", type: "event_callback", event });
type O = { user?: string; channel?: string; ts?: string; thread_ts?: string };
/** `@Pixel text` in a channel. */
export const mention = (text: string, o: O = {}) =>
  wrap({ type: "app_mention", user: o.user ?? ME, channel: o.channel ?? PUB, channel_type: "channel", text: `<@${BOT}> ${text}`, ts: o.ts ?? nextTs(), ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}) });
/** A DM message to the bot (top-level unless thread_ts). */
export const dm = (text: string, o: O = {}) =>
  wrap({ type: "message", user: o.user ?? ME, channel: o.channel ?? "D_DANA", channel_type: "im", text, ts: o.ts ?? nextTs(), ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}) });
/** A plain channel message (no mention): ambient capture only. */
export const say = (text: string, o: O = {}) =>
  wrap({ type: "message", user: o.user ?? ME, channel: o.channel ?? PUB, channel_type: "channel", text, ts: o.ts ?? nextTs(), ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}) });

/** Deliver a Slack event through the real dispatcher and wait for the turn and background capture to finish. */
export async function send(ev: Ev) {
  const e = ev.event;
  if (e.type === "message" || e.type === "app_mention") store.push({ channel: e.channel, ts: e.ts, thread_ts: e.thread_ts, user: e.user, text: e.text });
  await handleEventCallback(ev as never);
  await settleAmbient();
  return ev.event;
}

/** Poll until `f` returns truthy (background work such as memory capture). */
export async function eventually<T>(f: () => Promise<T | false | undefined | null> | T, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("eventually: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
