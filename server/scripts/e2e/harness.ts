// Shared harness for the live e2e scenarios (real Vertex models + embeddings, throwaway Postgres, fake Slack).
// NOT part of CI: run with  bash <wrapper that loads the model env + DATABASE_URL> bun server/scripts/e2e/NN-name.ts
// Never writes secrets anywhere; the env comes from the caller's shell.
import { sql } from "drizzle-orm";
import { encrypt } from "../../src/crypto";
import { db, pool, resetDb } from "../../test/db";
import { channelMembers, channels, users, workspace } from "../../src/db/schema";
import { setSlackClientForTest } from "../../src/slack/client";
import { setSlackClient } from "../../src/turn/slack";
import { handleEventCallback } from "../../src/slack/events";
import { settleAmbient } from "../../src/slack/ambient-hook";
import { flushAmbient } from "../../src/memory/ambient";
import { completeJson } from "../../src/memory/llm";
import { z } from "zod";

if (!process.env.DATABASE_URL?.includes("5433")) throw new Error("refusing to run: DATABASE_URL must be the throwaway e2e db");
if (process.env.MODEL_PROVIDER !== "vertex") throw new Error("e2e needs MODEL_PROVIDER=vertex");

export const BOT = "UBOT";
export const TEAM = "T1";
export const HOME = "CHOME";

// ---------- count real model traffic ----------
export const traffic = { chat: 0, embed: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const u = String(typeof input === "string" ? input : input?.url ?? input);
  if (u.includes("aiplatform.googleapis.com")) {
    if (/generateContent|streamGenerateContent/i.test(u)) traffic.chat++;
    else if (/predict|embed/i.test(u)) traffic.embed++;
  }
  return realFetch(input, init);
}) as typeof fetch;

// ---------- checks ----------
const results: { name: string; ok: boolean; evidence: string }[] = [];
export function check(name: string, ok: boolean, evidence = "") {
  results.push({ name, ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${evidence ? `\n        ${String(evidence).replace(/\n/g, "\n        ").slice(0, 1200)}` : ""}`);
  return ok;
}
export function finish(feature: string): never {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n== ${feature}: ${results.length - bad.length}/${results.length} passed | model calls chat=${traffic.chat} embed=${traffic.embed}`);
  for (const b of bad) console.log(`   FAILED: ${b.name}`);
  process.exit(bad.length ? 1 : 0);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- fake Slack (records everything; permalinks are deterministic) ----------
export type Call = { method: string; args: any };
export const slack = {
  calls: [] as Call[],
  /** channel -> message ts -> text, for conversations.history / replies */
  history: new Map<string, { ts: string; user?: string; text: string; thread_ts?: string }[]>(),
  creators: new Map<string, string>(),
  purposes: new Map<string, string>(),
  files: {} as Record<string, any>,
  failMethods: new Set<string>(),
  reset() { this.calls.length = 0; this.history.clear(); this.creators.clear(); this.failMethods.clear(); },
  of(m: string) { return this.calls.filter((c) => c.method === m); },
  /** every text the bot posted (postMessage + update), optionally filtered by channel */
  posts(channel?: string) {
    return this.calls.filter((c) => (c.method === "chat.postMessage" || c.method === "chat.update" || c.method === "chat.postEphemeral") && (!channel || c.args.channel === channel));
  },
  texts(channel?: string) { return this.posts(channel).map((c) => `${c.args.text ?? ""} ${JSON.stringify(c.args.blocks ?? "")}`); },
  /** the bot's final reply in the thread rooted at `root` (placeholder/progress lines skipped) */
  reply(channel: string, root: string): string {
    const m = (this.history.get(channel) ?? []).filter((x) => x.user === BOT && x.thread_ts === root && !/^_(Thinking|Working)/.test(x.text));
    return m.at(-1)?.text ?? "";
  },
  lastText(channel?: string) { return this.posts(channel).filter((c) => c.method !== "chat.postEphemeral" && !/Thinking\.\.\./.test(c.args.text ?? "")).at(-1)?.args.text as string | undefined; },
};
export const permalink = (channel: string, ts: string) => `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
let postN = 0;
function mk(path: string[]): any {
  return new Proxy(function () {}, {
    get: (_t, k: string) => (k === "then" ? undefined : k === "token" && path.length === 0 ? "xoxb-e2e" : mk([...path, k])),
    apply: async (_t, _this, [args]) => {
      const m = path.join(".");
      slack.calls.push({ method: m, args });
      if (slack.failMethods.has(m)) throw Object.assign(new Error(m + " failed"), { data: { error: "fake_failure" } });
      switch (m) {
        case "chat.getPermalink": return { ok: true, permalink: permalink(args.channel, args.message_ts) };
        case "chat.postMessage": {
          const ts = `${Math.floor(Date.now() / 1000)}.${String(++postN).padStart(6, "0")}`;
          const h = slack.history.get(args.channel) ?? [];
          h.push({ ts, user: BOT, text: args.text ?? "", thread_ts: args.thread_ts });
          slack.history.set(args.channel, h);
          return { ok: true, ts, channel: args.channel };
        }
        case "chat.update": {
          const row = (slack.history.get(args.channel) ?? []).find((x) => x.ts === args.ts);
          if (row) row.text = args.text ?? row.text;
          return { ok: true, ts: args.ts };
        }
        case "conversations.open": return { ok: true, channel: { id: "D_" + args.users } };
        case "conversations.info": return { ok: true, channel: { id: args.channel, creator: slack.creators.get(args.channel), purpose: { value: slack.purposes.get(args.channel) ?? "" } } };
        case "conversations.history": return { ok: true, messages: (slack.history.get(args.channel) ?? []).slice().reverse(), has_more: false };
        case "conversations.replies": return { ok: true, messages: (slack.history.get(args.channel) ?? []).filter((x) => x.ts === args.ts || x.thread_ts === args.ts), has_more: false };
        case "conversations.members": return { ok: true, members: [], response_metadata: {} };
        case "users.info": return { ok: true, user: { id: args.user, real_name: NAMES[args.user] ?? "User " + args.user, profile: { email: args.user + "@x.io" } } };
        case "files.info": return { ok: true, file: slack.files[args.file] };
        case "reactions.get": return { ok: true, message: {} };
        case "auth.test": return { ok: true, user_id: BOT, team_id: TEAM };
        default: return { ok: true };
      }
    },
  });
}
const fakeClient = mk([]);

// ---------- cast ----------
export const U = { PRIYA: "UPRIYA01", DANA: "UDANA002", ALICE: "UALICE03", BOB: "UBOB0004", MAHESH: "UMAHESH5", ADMIN: "UADMIN06", OUTSIDER: "UOUTSD07" } as const;
export const C = { ENG: "CENG0001", SALES: "CSALES02", EXEC: "GEXEC003", RANDOM: "CRANDOM4" } as const;
const NAMES: Record<string, string> = { [U.PRIYA]: "Priya Sharma", [U.DANA]: "Dana Whitfield", [U.ALICE]: "Alice Moreno", [U.BOB]: "Bob Okafor", [U.MAHESH]: "Mahesh Rao", [U.ADMIN]: "Ada Admin", [U.OUTSIDER]: "Oscar Outsider" };

/** Fresh db + workspace + cast + channels. exec is PRIVATE (Alice, Dana, Admin only); everything else public. */
export async function setup(opts: { cast?: boolean } = {}) {
  await resetDb();
  await db.execute(sql`create table if not exists message_feedback (
    id bigserial primary key, channel_id text not null, message_ts text not null, user_id text not null,
    rating text not null, created_at timestamptz not null default now())`);
  slack.reset();
  setSlackClientForTest(fakeClient);
  setSlackClient(async () => fakeClient);
  await db.insert(workspace).values({ id: TEAM, name: "Acme", botTokenEnc: encrypt("xoxb-e2e"), botUserId: BOT, homeChannelId: HOME });
  if (opts.cast === false) return;
  await db.insert(users).values(Object.entries(NAMES).map(([id, name]) => ({ id, name, email: `${name.split(" ")[0]!.toLowerCase()}@acme.io`, role: id === U.ADMIN ? ("admin" as const) : ("member" as const) })));
  await db.insert(channels).values([
    { id: C.ENG, name: "eng", botIsMember: true }, { id: C.SALES, name: "sales", botIsMember: true },
    { id: C.EXEC, name: "exec-private", isPrivate: true, botIsMember: true }, { id: C.RANDOM, name: "random", botIsMember: true },
    { id: HOME, name: "brain-admin", botIsMember: true },
  ]);
  const mem = (c: string, us: string[]) => us.map((u) => ({ channelId: c, userId: u }));
  await db.insert(channelMembers).values([
    ...mem(C.ENG, [U.PRIYA, U.DANA, U.ALICE, U.BOB, U.MAHESH, U.ADMIN, U.OUTSIDER]),
    ...mem(C.SALES, [U.PRIYA, U.ALICE, U.BOB, U.MAHESH, U.ADMIN, U.OUTSIDER]),
    ...mem(C.EXEC, [U.ALICE, U.DANA, U.ADMIN]),
    ...mem(C.RANDOM, [U.PRIYA, U.BOB, U.OUTSIDER]),
  ]);
}

// ---------- event simulation ----------
let evN = 0;
let tsBase = Math.floor(Date.now() / 1000) - 3 * 3600;
let tsN = 0;
/** Message ts for a given offset in seconds from a rolling base (strictly increasing). */
export const nextTs = (at?: Date) => `${at ? Math.floor(at.getTime() / 1000) : tsBase + Math.floor(++tsN * 7)}.${String(++evN).padStart(6, "0")}`;

type Msg = { channel: string; user: string; text: string; thread_ts?: string; ts?: string; at?: Date; channel_type?: string; subtype?: string; files?: any[] };
/** Deliver one message through the REAL event handler (signature path skipped; handleEventCallback is what the route calls). */
export async function say(m: Msg): Promise<string> {
  const ts = m.ts ?? nextTs(m.at);
  const priv = m.channel === C.EXEC;
  const isIm = m.channel.startsWith("D");
  const hist = slack.history.get(m.channel) ?? [];
  hist.push({ ts, user: m.user, text: m.text, thread_ts: m.thread_ts });
  slack.history.set(m.channel, hist);
  await handleEventCallback({
    event_id: `Ev${++evN}`, team_id: TEAM, type: "event_callback",
    event: { type: "message", channel: m.channel, user: m.user, text: m.text, ts, thread_ts: m.thread_ts, channel_type: m.channel_type ?? (isIm ? "im" : priv ? "group" : "channel"), ...(m.subtype ? { subtype: m.subtype } : {}), ...(m.files ? { files: m.files } : {}) },
  });
  return ts;
}
/** @mention of the bot as app_mention + message (Slack sends both). */
export async function mention(m: Msg): Promise<string> {
  const ts = m.ts ?? nextTs(m.at);
  const text = `<@${BOT}> ${m.text}`;
  const isIm = m.channel.startsWith("D");
  const channel_type = m.channel_type ?? (isIm ? "im" : m.channel === C.EXEC ? "group" : "channel");
  const h = slack.history.get(m.channel) ?? [];
  h.push({ ts, user: m.user, text, thread_ts: m.thread_ts });
  slack.history.set(m.channel, h);
  await handleEventCallback({ event_id: `Ev${++evN}`, team_id: TEAM, type: "event_callback", event: { type: "app_mention", channel: m.channel, user: m.user, text, ts, thread_ts: m.thread_ts, channel_type } });
  return ts;
}
export const edit = async (channel: string, ts: string, user: string, text: string, thread_ts?: string) =>
  handleEventCallback({ event_id: `Ev${++evN}`, team_id: TEAM, type: "event_callback", event: { type: "message", subtype: "message_changed", channel, channel_type: channel === C.EXEC ? "group" : "channel", message: { ts, user, text, thread_ts }, ts: nextTs() } });
export const del = async (channel: string, ts: string) =>
  handleEventCallback({ event_id: `Ev${++evN}`, team_id: TEAM, type: "event_callback", event: { type: "message", subtype: "message_deleted", channel, channel_type: channel === C.EXEC ? "group" : "channel", deleted_ts: ts, ts: nextTs() } });

/** Wait for background task capture, then flush the ambient buffers of the given channels. Returns facts stored. */
export async function drain(channelIds: string[] = [C.ENG, C.SALES, C.EXEC, C.RANDOM]): Promise<number> {
  await settleAmbient();
  let n = 0;
  for (const c of channelIds) n += (await flushAmbient(c)).facts;
  await settleAmbient();
  return n;
}

// ---------- DB peeks ----------
export const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
export const facts = (where = "true") => q(`select id, scope_tag, text, fact_type, status, permalink, created_by, source_ref, valid_at, valid_until, superseded_by, context_prefix from memories where kind='fact' and ${where} order by id`);
export const activeFacts = (tag?: string) => facts(`status='active' ${tag ? `and scope_tag='${tag}'` : ""}`);
export const dump = (rows: any[]) => rows.map((r) => `#${r.id} [${r.scope_tag}/${r.status}/${r.fact_type}] ${r.text}`).join("\n");

// ---------- LLM judge ----------
const verdict = z.object({ correct: z.boolean(), reason: z.string().optional() });
/** Cheap-model judge: does `answer` convey the expected facts (and not contradict them)? */
export async function judge(question: string, answer: string, expected: string): Promise<{ correct: boolean; reason?: string }> {
  try {
    return await completeJson({
      role: "extract", maxOutputTokens: 200,
      system: 'You grade an AI assistant\'s answer. Reply JSON only: {"correct":true|false,"reason":"short"}. correct=true only when the answer states the expected facts (wording may differ) and does not contradict them or add a conflicting claim.',
      prompt: `Question: ${question}\nExpected: ${expected}\nAnswer: ${answer}`,
    }, verdict);
  } catch (e) { return { correct: false, reason: "judge failed: " + String(e).slice(0, 100) }; }
}
export const abstains = (answer: string) => /\b(don'?t (have|know)|no (record|information|memory)|not (sure|find|found|aware)|couldn'?t find|can'?t find|nothing (in|on)|unable to find|no mention|haven'?t (seen|got|been told))/i.test(answer);

export { db, pool, handleEventCallback, settleAmbient };
