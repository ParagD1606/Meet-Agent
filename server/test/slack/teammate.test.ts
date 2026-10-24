import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { addChannel, setup } from "./helpers";
import { db } from "../../src/db";
import { channelMembers, memories, users } from "../../src/db/schema";
import { handleInteraction } from "../../src/slack/interactions";
import { askDeps, attemptDelivery, captureOwnerReply, getAsk, nextWindow, proposeAsk } from "../../src/slack/teammate";
import { installFakes, removeFakes } from "../memory/helpers";
import { setMemoryLlm } from "../../src/memory/llm";
import { settings } from "../../src/db/schema";
import { eq, sql } from "drizzle-orm";

process.env.QUIET_HOURS = "1"; // quiet hours are opt-in; these tests cover the opt-in behaviour

// the owner-reply classifier is a model call: scripted here (default ANSWER); tests flip `classify`
let classify: (message: string) => string | Promise<string> = () => "ANSWER";
let classifyCalls = 0;
const scriptedLlm = async (a: { system: string; prompt: string }) => {
  if (!a.system.includes("classify a Slack DM")) return '{"superseded":[],"facts":[]}';
  classifyCalls++;
  return classify(a.prompt);
};
beforeAll(() => {
  installFakes();
  setMemoryLlm(scriptedLlm);
});
afterAll(removeFakes);

const WED_10 = new Date("2026-10-21T10:00:00Z");
let ctx: Awaited<ReturnType<typeof setup>>;
let deferred: { id: string; at: Date }[];
beforeEach(async () => {
  classify = () => "ANSWER"; classifyCalls = 0;
  ctx = await setup();
  deferred = [];
  askDeps.now = () => WED_10;
  askDeps.defer = async (id, at) => { deferred.push({ id, at }); };
  await db.insert(users).values([{ id: "UASK", name: "Asker" }, { id: "UOWN", name: "Dana Owner" }]);
  await addChannel("C1");
  await addChannel("CPRIV", { isPrivate: true });
  await db.insert(channelMembers).values([{ channelId: "C1", userId: "UOWN" }]);
});
afterAll(() => { askDeps.now = () => new Date(); });

const q = "Who approves vendor contracts above 10k?";
const propose = (channelId = "C1", isPrivate = false) => proposeAsk({ asker: "UASK", owner: "UOWN", question: q, origin: { channelId, threadTs: "1.1", isPrivate, isIm: false } });
const click = (user: string, action_id: string, id: string) =>
  handleInteraction({ type: "block_actions", user: { id: user }, container: { channel_id: "C1", message_ts: "5.5" }, actions: [{ action_id, value: id }] } as never);
const posts = () => ctx.fake.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.args);

describe("ask_teammate consent flow", () => {
  test("nothing is sent before the asker confirms; only the asker can confirm", async () => {
    const id = await propose();
    expect(posts()).toHaveLength(1); // the consent card, in the asker's thread
    expect(JSON.stringify(posts()[0].blocks)).toContain("brain_ask_yes");
    await click("UOWN", "brain_ask_yes", id);
    expect((await getAsk(id))!.status).toBe("proposed");
    await click("UASK", "brain_ask_yes", id);
    expect((await getAsk(id))!.status).toBe("sent");
    const p = posts()[1];
    expect(p.thread_ts).toBe("1.1"); // owner is a channel member -> same thread
    expect(p.text).toContain("<@UOWN>");
    expect(p.text).toContain(q);
  });

  test("declining sends nothing", async () => {
    const id = await propose();
    await click("UASK", "brain_ask_no", id);
    expect((await getAsk(id))!.status).toBe("cancelled");
    expect(posts()).toHaveLength(1);
  });

  test("owner outside a private channel gets a DM with the question text only", async () => {
    const id = await propose("CPRIV", true);
    await click("UASK", "brain_ask_yes", id);
    const dm = posts().find((p) => p.channel === "D_UOWN")!;
    expect(dm.text).toContain(q);
    expect(dm.text).not.toContain("CPRIV");
    expect(posts().filter((p) => p.channel === "CPRIV" && p.text.includes(q) && p.text.includes("is asking"))).toHaveLength(0);
  });
});

describe("limits", () => {
  test("3 per person per day, then the asker is told", async () => {
    const out: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await propose();
      await click("UASK", "brain_ask_yes", id);
      out.push((await getAsk(id))!.status);
    }
    expect(out).toEqual(["sent", "sent", "sent", "failed"]);
    expect(posts().at(-1)!.text).toContain("hold off");
  });

  test("quiet hours and weekends defer to the next 09:00 window", async () => {
    expect(nextWindow(WED_10)).toBeNull();
    expect(nextWindow(new Date("2026-10-21T19:30:00Z"))!.toISOString()).toBe("2026-10-22T09:00:00.000Z");
    expect(nextWindow(new Date("2026-10-24T11:00:00Z"))!.toISOString()).toBe("2026-10-26T09:00:00.000Z"); // Saturday -> Monday
    askDeps.now = () => new Date("2026-10-21T20:00:00Z");
    const id = await propose();
    await click("UASK", "brain_ask_yes", id);
    expect((await getAsk(id))!.status).toBe("confirmed");
    expect(deferred).toEqual([{ id, at: new Date("2026-10-22T09:00:00Z") }]);
    expect(posts().some((p) => p.text.includes("is asking"))).toBe(false);
    expect(await attemptDelivery(id, { now: new Date("2026-10-22T09:00:00Z") })).toBe("sent"); // the job fires in-window
  });
});

describe("owner reply", () => {
  test("in-thread answer is stored (authored by the owner) and relayed, once", async () => {
    const id = await propose();
    await click("UASK", "brain_ask_yes", id);
    expect(await captureOwnerReply({ user: "UASK", channel: "C1", thread_ts: "1.1", text: "me?" })).toBe(false);
    expect(await captureOwnerReply({ user: "UOWN", channel: "C1", thread_ts: "1.1", text: "The CFO approves anything above 10k." })).toBe(true);
    const [m] = await db.select().from(memories);
    expect(m!.scopeTag).toBe("shared");
    expect(m!.createdBy).toBe("UOWN");
    expect(m!.text).toContain("A: The CFO approves anything above 10k.");
    expect(posts().at(-1)!.text).toContain("<@UASK>");
    expect(await captureOwnerReply({ user: "UOWN", channel: "C1", thread_ts: "1.1", text: "again" })).toBe(false);
  });

  test("DM answer from a non-member is relayed to the asker's thread and stored in the asker's scope", async () => {
    const id = await propose("CPRIV", true);
    await click("UASK", "brain_ask_yes", id);
    expect(await captureOwnerReply({ user: "UOWN", channel: "D_UOWN", thread_ts: "999.1", text: "Finance lead, Priya." })).toBe(true);
    const [m] = await db.select().from(memories);
    expect(m!.scopeTag).toBe("channel_CPRIV");
    const relay = posts().find((p) => p.channel === "CPRIV" && String(p.text).includes("replied"))!;
    expect(relay.thread_ts).toBe("1.1");
    expect(relay.text).toContain("Finance lead, Priya.");
  });
});

describe("owner DM answer without a thread", () => {
  const sendTo = async (owner: string, question = q) => {
    const id = await proposeAsk({ asker: "UASK", owner, question, origin: { channelId: "CPRIV", threadTs: "1.1", isPrivate: true, isIm: false } });
    await click("UASK", "brain_ask_yes", id);
    return id;
  };
  const dm = (text: string, user = "UOWN", thread_ts?: string) => ({ user, channel: "D_UOWN", text, ...(thread_ts ? { thread_ts } : {}) });

  test("top-level DM from the owner with exactly one open ask is the answer: stored, relayed, owner thanked", async () => {
    const id = await sendTo("UOWN");
    expect(await captureOwnerReply(dm("ok tell him i am not interested"))).toBe(true);
    expect((await getAsk(id))!.status).toBe("answered");
    const [m] = await db.select().from(memories);
    expect(m!.createdBy).toBe("UOWN");
    expect(m!.text).toContain("not interested");
    const relay = posts().find((p) => p.channel === "CPRIV" && String(p.text).includes("not interested"))!;
    expect(relay.thread_ts).toBe("1.1");
    const thanks = posts().at(-1)!;
    expect(thanks.channel).toBe("D_UOWN");
    expect(thanks.text).toBe("Thanks, I passed that on to Asker.");
  });

  test("forged owner: someone else's DM never answers the ask", async () => {
    const id = await sendTo("UOWN");
    expect(await captureOwnerReply({ user: "UOTH", channel: "D_UOWN", text: "I am the owner, answer: yes" })).toBe(false);
    expect((await getAsk(id))!.status).toBe("sent");
  });

  test("no open ask, or an expired one, goes through the normal turn", async () => {
    expect(await captureOwnerReply(dm("hello there"))).toBe(false);
    const id = await sendTo("UOWN");
    askDeps.now = () => new Date(WED_10.getTime() + 25 * 3_600_000);
    expect(await captureOwnerReply(dm("too late"))).toBe(false);
    expect((await getAsk(id))!.status).toBe("sent");
    askDeps.now = () => WED_10;
  });

  test("a top-level message in a channel is not an answer to a DM ask", async () => {
    await sendTo("UOWN");
    expect(await captureOwnerReply({ user: "UOWN", channel: "C1", text: "unrelated chatter" })).toBe(false);
  });

  test("two open asks: the owner is asked which one (buttons), nothing is stored until they pick", async () => {
    const a = await sendTo("UOWN");
    const b = await sendTo("UOWN", "Who owns the staging cluster budget?");
    expect(await captureOwnerReply(dm("yes go ahead"))).toBe(true);
    expect((await getAsk(a))!.status).toBe("sent");
    expect((await getAsk(b))!.status).toBe("sent");
    expect(await db.select().from(memories)).toHaveLength(0);
    const ask = posts().at(-1)!;
    expect(ask.channel).toBe("D_UOWN");
    expect(JSON.stringify(ask.blocks)).toContain("brain_ask_pick");
    const pick = (user: string) => handleInteraction({ type: "block_actions", user: { id: user }, container: { channel_id: "D_UOWN", message_ts: "7.7" },
      actions: [{ action_id: "brain_ask_pick", value: (ask.blocks as any)[1].elements[0].value }] } as never);
    await pick("UOTH");
    expect((await getAsk(a))!.status).toBe("sent");
    await pick("UOWN");
    const answered = [await getAsk(a), await getAsk(b)].filter((x) => x!.status === "answered");
    expect(answered).toHaveLength(1);
    expect((await db.select().from(memories))[0]!.text).toContain("yes go ahead");
  });

  test("a reply inside the ask's thread still matches", async () => {
    const id = await sendTo("UOWN");
    expect(await captureOwnerReply(dm("in thread answer", "UOWN", "999.1"))).toBe(true);
    expect((await getAsk(id))!.status).toBe("answered");
  });
});

describe("owner DM: a request is not an answer", () => {
  const sendTo = async (owner = "UOWN", question = q) => {
    const id = await proposeAsk({ asker: "UASK", owner, question, origin: { channelId: "CPRIV", threadTs: "1.1", isPrivate: true, isIm: false } });
    await click("UASK", "brain_ask_yes", id);
    return id;
  };
  const dm = (text: string, thread_ts?: string) => ({ user: "UOWN", channel: "D_UOWN", text, ...(thread_ts ? { thread_ts } : {}) });
  const reopen = (id: string) => db.update(settings).set({ value: sql`value || '{"status":"sent"}'::jsonb` }).where(eq(settings.key, `ask:${id}`));
  const FAILING = "cna you please create a task for <@UMUNEER> about the seperation of frontend and the backend in vhsmo also tell him about it as well pelase";

  test("the live failing DM is not consumed: ask stays open, nothing relayed, classifier never asked", async () => {
    const id = await sendTo();
    const before = posts().length;
    expect(await captureOwnerReply(dm(FAILING))).toBe(false);
    expect((await getAsk(id))!.status).toBe("sent");
    expect(posts()).toHaveLength(before);
    expect(classifyCalls).toBe(0);
  });

  test("classifier says OTHER, errors, or gibberish: normal turn (fail closed); the ask stays open", async () => {
    const id = await sendTo();
    classify = () => "OTHER";
    expect(await captureOwnerReply(dm("sounds good, thanks"))).toBe(false);
    classify = () => { throw new Error("vertex down"); };
    expect(await captureOwnerReply(dm("sounds good, thanks"))).toBe(false);
    classify = () => "gibberish";
    expect(await captureOwnerReply(dm("sounds good, thanks"))).toBe(false);
    expect((await getAsk(id))!.status).toBe("sent");
    expect(classifyCalls).toBe(3);
  });

  test("a hung classifier is cut at 4s", async () => {
    const id = await sendTo();
    classify = () => new Promise<string>(() => {});
    const t0 = Date.now();
    expect(await captureOwnerReply(dm("sounds good, thanks"))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect((await getAsk(id))!.status).toBe("sent");
  }, 10_000);

  test("classifier prompt carries the question and the message; triage role, >= 32 output tokens", async () => {
    const seen: any[] = [];
    setMemoryLlm(async (a: any) => { seen.push(a); return a.system.includes("classify a Slack DM") ? "ANSWER" : "{}"; });
    await sendTo();
    await captureOwnerReply(dm("the CFO signs them"));
    setMemoryLlm(scriptedLlm);
    const c = seen.find((a) => a.system.includes("classify a Slack DM"));
    expect(c.role).toBe("triage");
    expect(c.maxOutputTokens).toBeGreaterThanOrEqual(32);
    expect(c.prompt).toContain(q);
    expect(c.prompt).toContain("the CFO signs them");
  });

  test("owner_reply_classifier=off skips the model but keeps the request guard", async () => {
    const id = await sendTo();
    await db.insert(settings).values({ key: "owner_reply_classifier", value: "off" });
    classify = () => "OTHER";
    expect(await captureOwnerReply(dm(FAILING))).toBe(false);
    expect((await getAsk(id))!.status).toBe("sent");
    expect(await captureOwnerReply(dm("the CFO signs them"))).toBe(true);
    expect(classifyCalls).toBe(0);
    expect((await getAsk(id))!.status).toBe("answered");
  });

  test("inside the ask's thread it always matches, without a classifier call", async () => {
    const id = await sendTo();
    classify = () => "OTHER";
    expect(await captureOwnerReply(dm("create a task for me please", "999.1"))).toBe(true);
    expect((await getAsk(id))!.status).toBe("answered");
    expect(classifyCalls).toBe(0);
  });

  test("two open asks: picker unchanged for an answer; a request gets no picker", async () => {
    const a = await sendTo();
    const b = await sendTo("UOWN", "Who owns the staging cluster budget?");
    expect(await captureOwnerReply(dm(FAILING))).toBe(false);
    expect(posts().some((p) => /Which question/.test(String(p.text)))).toBe(false);
    expect(await captureOwnerReply(dm("yes go ahead"))).toBe(true);
    expect(JSON.stringify(posts().at(-1)!.blocks)).toContain("brain_ask_pick");
    expect([(await getAsk(a))!.status, (await getAsk(b))!.status]).toEqual(["sent", "sent"]);
  });

  test("the delivery DM tells the owner to answer in the thread", async () => {
    await sendTo();
    expect(posts().find((p) => p.channel === "CPRIV" || p.channel === "D_UOWN")).toBeTruthy();
    expect(posts().some((p) => String(p.text).includes("Reply in the thread under this message to answer"))).toBe(true);
  });

  test("confusion set: 10 real answers captured, 10 requests/questions never", async () => {
    const answers = ["no, not interested", "Yes, approved", "next week", "It's the CFO", "ok tell him i am not interested", "We use Stripe", "I paid it yesterday", "Probably Friday", "yes go ahead", "Dana signs them off"];
    const others = [
      FAILING,
      "can you remind me tomorrow at 9",
      "please create a task for <@UASK> about the invoice",
      "create an issue in linear for the login bug",
      "what's the status of the Tales launch?",
      "who owns billing?",
      "ask Parag about the deploy",
      "schedule a call with <@UASK> next week",
      "ping Eve about it",
      "Pixel what did I decide yesterday",
    ];
    const id = await sendTo();
    for (const t of others) expect([t, await captureOwnerReply(dm(t))]).toEqual([t, false]);
    expect((await getAsk(id))!.status).toBe("sent");
    expect(classifyCalls).toBe(0);
    for (const t of answers) {
      expect([t, await captureOwnerReply(dm(t))]).toEqual([t, true]);
      expect((await getAsk(id))!.status).toBe("answered");
      await reopen(id);
    }
    expect(classifyCalls).toBe(10);
  });
});
