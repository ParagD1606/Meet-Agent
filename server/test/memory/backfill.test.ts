// History backfill (idempotent, resumable, paced, scoped) and fact-level edit/delete sync for ambient messages.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, resetDb } from "../db";
import { ambientMessages, channels, commitments, memories, settings, users, workspace } from "../../src/db/schema";
import { encrypt } from "../../src/crypto";
import { ambientIo, dropAmbient, editAmbient, factsBySourceTs, flushAmbient, recordAmbient, resetAmbientRate } from "../../src/memory/ambient";
import { backfillAll, backfillChannel, backfillDeps, getBackfillState } from "../../src/memory/backfill";
import { setMemoryLlm } from "../../src/memory/llm";
import { runNow, RUN_JOBS } from "../../src/memory/run-now";
import { EXTRACT_SYSTEM } from "../../src/memory/writeback";
import { setSlackClientForTest } from "../../src/slack/client";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes } from "./helpers";

beforeAll(installFakes);
afterAll(removeFakes);

const day = Math.floor(Date.now() / 1000) - 86_400;
const ts = (n: number) => `${day + n}.000100`;
let facts: string[] = [];
let commits = '{"commitments":[]}';
let sleeps: number[] = [];

beforeEach(async () => {
  await resetDb();
  installFakes();
  resetAmbientRate();
  facts = [];
  commits = '{"commitments":[]}';
  sleeps = [];
  backfillDeps.sleep = async (ms) => { sleeps.push(ms); };
  backfillDeps.minGapMs = 0;
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CHOME" });
  await db.insert(users).values([{ id: "U1", name: "Bob" }, { id: "UPRIYA", name: "Priya" }]);
  await db.insert(channels).values([{ id: "C1", name: "pub", botIsMember: true }, { id: "GP", name: "priv", isPrivate: true, botIsMember: true }]);
  ambientIo.permalink = async (c, t) => `https://x.slack.com/archives/${c}/p${t.replace(".", "")}`;
  setMemoryLlm(async (a) => {
    if (a.system === EXTRACT_SYSTEM) return JSON.stringify({ facts });
    if (a.system.includes("extract explicit commitments")) return commits;
    return '{"superseded":[],"facts":[]}';
  });
});

const long = (s: string) => `${s} for the Stripe migration project kickoff`;

describe("fact sync on edit/delete", () => {
  const send = async (n: number, text: string) => recordAmbient({ channel: "C1", ts: ts(n), user: "U1", text });

  test("facts carry the exact message permalink and a per-batch source_ref; delete retires them; edit replaces them", async () => {
    facts = ["Priya owns the Stripe migration kickoff plan"];
    await send(1, long("Priya owns the plan"));
    expect(await flushAmbient("C1")).toMatchObject({ messages: 1, facts: 1 });
    const [m] = await db.select().from(memories);
    expect(m).toMatchObject({ sourceRef: `C1/${ts(1)}`, permalink: `https://x.slack.com/archives/C1/p${ts(1).replace(".", "")}`, status: "active" });
    expect((await factsBySourceTs("C1", ts(1))).exclusive).toBe(true);

    facts = ["Dana owns the Stripe migration kickoff plan now"];
    await editAmbient("C1", ts(1), long("Dana owns the plan"));
    const all = await db.select().from(memories);
    expect(all.filter((x) => x.status === "active").map((x) => x.text)).toEqual(["Dana owns the Stripe migration kickoff plan now"]);
    expect(all.find((x) => x.text.startsWith("Priya"))!.status).toBe("deleted");

    await editAmbient("C1", ts(1), long("Dana owns the plan")); // unchanged text (unfurl event): nothing churns
    expect((await db.select().from(memories)).filter((x) => x.status === "active")).toHaveLength(1);

    await dropAmbient("C1", ts(1));
    expect((await db.select().from(memories)).filter((x) => x.status === "active")).toHaveLength(0);
  });

  test("a fact distilled from several messages is not retired by deleting one of them (documented gap)", async () => {
    facts = ["The Stripe migration kickoff moved to Monday morning"];
    await send(1, long("kickoff moved to Monday"));
    await send(2, long("agreed, Monday works for me"));
    await flushAmbient("C1");
    expect((await factsBySourceTs("C1", ts(2))).exclusive).toBe(false);
    await dropAmbient("C1", ts(2));
    expect((await db.select().from(memories)).filter((x) => x.status === "active")).toHaveLength(1);
  });
});

describe("history backfill", () => {
  const msg = (n: number, text: string, extra: Record<string, unknown> = {}) => ({ ts: ts(n), user: "U1", text, ...extra });
  const script = (o: { pages: Record<string, { messages: unknown[]; next?: string }>; replies?: Record<string, unknown[]>; failFirst?: boolean }) => {
    let failed = false;
    return fakeSlack({
      "conversations.history": (a) => {
        if (o.failFirst && !failed) { failed = true; throw Object.assign(new Error("ratelimited"), { code: "slack_webapi_rate_limited", retryAfter: 3 }); }
        const p = o.pages[a.cursor ?? "first"]!;
        return { ok: true, messages: [...p.messages].reverse(), has_more: !!p.next, response_metadata: { next_cursor: p.next ?? "" } };
      },
      "conversations.replies": (a) => ({ ok: true, messages: [{ ts: a.ts, user: "U1", text: "parent", thread_ts: a.ts }, ...(o.replies?.[a.ts] ?? [])], has_more: false }),
    });
  };
  const pages = {
    first: { messages: [msg(1, long("Priya will own the roadmap")), msg(2, long("Bob will write the launch notes"), { reply_count: 1, thread_ts: ts(2) })], next: "p2" },
    p2: { messages: [msg(3, long("Customer asked about SSO pricing")), msg(4, "ok", {}), msg(5, long("Done with it"), { bot_id: "B1" })] },
  };
  const replies = { [ts(2)]: [{ ts: ts(6), user: "U1", thread_ts: ts(2), text: long("Launch notes shipped yesterday") }] };

  test("pages + thread replies flow through ambient extraction; bots/trivial skipped; second run is a no-op", async () => {
    const fake = script({ pages, replies });
    setSlackClientForTest(fake.client);
    facts = ["The roadmap owner is Priya for the Stripe migration"];
    const r = await backfillChannel("C1", { budget: { calls: 20 } });
    expect(r).toMatchObject({ pages: 2, done: true, messages: 4 }); // 1,2,3 + the reply; "ok" and the bot are skipped
    expect(fake.count("conversations.replies")).toBe(1);
    expect((await db.select().from(ambientMessages).where(eq(ambientMessages.channelId, "C1"))).length).toBe(4);
    expect((await db.select().from(memories)).every((m) => m.scopeTag === "shared")).toBe(true);
    const before = (await db.select().from(memories)).length;
    expect((await backfillChannel("C1")).done).toBe(true);
    expect((await backfillChannel("C1", { force: true, budget: { calls: 20 } })).messages).toBe(0); // ledger: nothing added twice
    expect((await db.select().from(memories)).length).toBe(before);
    expect(await getBackfillState("C1")).toMatchObject({ done: true });
  });

  test("resumes from the stored cursor when the call budget runs out", async () => {
    const fake = script({ pages, replies });
    setSlackClientForTest(fake.client);
    const a = await backfillChannel("C1", { budget: { calls: 2 } }); // page 1 + its thread's replies
    expect(a).toMatchObject({ pages: 1, done: false });
    expect((await getBackfillState("C1"))!.cursor).toBe("p2");
    const b = await backfillChannel("C1", { budget: { calls: 5 } });
    expect(b).toMatchObject({ pages: 1, done: true });
    expect(fake.calls.filter((c) => c.method === "conversations.history").map((c) => c.args.cursor)).toEqual([undefined, "p2"]);
    expect((await db.select().from(ambientMessages)).length).toBe(4);
  });

  test("Retry-After is honoured, paging is paced, days default 30 and clamp to 90", async () => {
    const fake = script({ pages: { first: { messages: [msg(1, long("Priya will own the roadmap"))] } }, failFirst: true });
    setSlackClientForTest(fake.client);
    backfillDeps.minGapMs = 700;
    await backfillChannel("C1", { budget: { calls: 10 } });
    expect(sleeps).toContain(3000);
    const oldest = Number(fake.calls.find((c) => c.method === "conversations.history")!.args.oldest);
    expect(Math.round((Date.now() / 1000 - oldest) / 86_400)).toBe(30);
    await db.insert(settings).values({ key: "memory_backfill_days", value: 500 });
    await db.delete(settings).where(eq(settings.key, "backfill:C1"));
    const fake2 = script({ pages: { first: { messages: [] } } });
    setSlackClientForTest(fake2.client);
    await backfillChannel("C1", { budget: { calls: 3 } });
    expect(Math.round((Date.now() / 1000 - Number(fake2.calls[0]!.args.oldest)) / 86_400)).toBe(90);
  });

  test("tasks in history become commitments (never chased when already past due); private channel stays channel_X; run-now job exists", async () => {
    const old = Math.floor(Date.now() / 1000) - 5 * 86_400;
    commits = '{"commitments":[{"owner":"<@UPRIYA>","text":"Send the report","due":"2020-01-01"}]}';
    setSlackClientForTest(script({ pages: { first: { messages: [{ ts: `${old}.000100`, user: "U1", text: "<@UPRIYA> please send the report by Friday" }] } } }).client);
    expect(RUN_JOBS).toContain("backfill-history");
    const out = await runNow("backfill-history");
    expect(out.ok && out.counts).toMatchObject({ tasks: 2 }); // one per observed channel (C1 shared, GP private)
    const rows = await db.select().from(commitments);
    expect(rows.map((r) => r.scopeTag).sort()).toEqual(["channel_GP", "shared"]);
    expect(rows.every((r) => r.nudgeCount >= 3 && r.status === "open")).toBe(true);
    expect(rows[0]!.sourceRef).toMatch(/^msg:/);
    expect((await backfillAll({ calls: 5 })).remaining).toBe(0);
  });

  test("channels the bot has left or opted out are skipped", async () => {
    await db.update(channels).set({ observe: false }).where(eq(channels.id, "C1"));
    const fake = script({ pages: { first: { messages: [msg(1, long("Priya will own the roadmap"))] } } });
    setSlackClientForTest(fake.client);
    expect((await backfillChannel("C1")).pages).toBe(0);
    expect(fake.count("conversations.history")).toBe(0);
  });
});
