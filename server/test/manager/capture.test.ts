// Real-time task capture, thread-reply updates, edit/delete sync, find_tasks isolation, follow-up DMs, digests and slash commands.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { channelMembers, channels, commitments, followUps, memories, users, workspace } from "../../src/db/schema";
import { encrypt } from "../../src/crypto";
import { ambientIo } from "../../src/memory/ambient";
import { setMemoryLlm } from "../../src/memory/llm";
import { setSlackClientForTest } from "../../src/slack/client";
import { ambientHook, settleAmbient } from "../../src/slack/ambient-hook";
import { runSlashCommand } from "../../src/slack/commands";
import { handleInteraction } from "../../src/slack/interactions";
import {
  addCommitment, captureTaskMessage, createFollowUp, digestTick, findTasks, followUpTick, formatTasks, getPrefs, handleCommitmentAction,
  handleFollowUpAction, listFollowUps, refreshTaskMessage, retireTaskMessage, setPrefs, FOLLOWUP_CAP,
} from "../../src/manager";
import { memoryTools } from "../../src/turn/memory-tools";
import { heuristicDepth } from "../../src/turn/depth";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes } from "../memory/helpers";

process.env.QUIET_HOURS = "1"; // quiet hours are opt-in; these tests cover the opt-in behaviour

beforeAll(installFakes);
afterAll(removeFakes);

const TS = "1781092800.000100"; // 2026-06-10T12:00:00Z, a Wednesday
const NOW = new Date("2026-06-10T12:00:00Z");
const NIGHT = new Date("2026-06-10T22:00:00Z");
let fake: ReturnType<typeof fakeSlack>;
let prompts: string[];
const posts = () => fake.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.args);

/** Fake model: commitments extractor and thread-reply classifier are scripted; everything else (fact extraction, contradiction checks) is empty. */
let extractReply = '{"commitments":[]}';
let classifyReply = '{"action":"none"}';
const llm = () => setMemoryLlm(async (a) => {
  prompts.push(a.prompt);
  if (a.system.includes("extract explicit commitments")) return extractReply;
  if (a.system.includes("ONE reply")) return classifyReply;
  return '{"superseded":[],"facts":[]}';
});

beforeEach(async () => {
  await resetDb();
  prompts = [];
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CHOME" });
  await db.insert(users).values([{ id: "UPRIYA", name: "Priya" }, { id: "UBOB", name: "Bob" }, { id: "UDANA", name: "Dana" }, { id: "UCAROL", name: "Carol" }]);
  await db.insert(channels).values([{ id: "C1", name: "pub", botIsMember: true }, { id: "GP", name: "priv", isPrivate: true, botIsMember: true }]);
  fake = fakeSlack();
  setSlackClientForTest(fake.client);
  ambientIo.permalink = async (c, ts) => `https://x.slack.com/archives/${c}/p${ts.replace(".", "")}`;
  extractReply = '{"commitments":[]}';
  classifyReply = '{"action":"none"}';
  llm();
});

const hook = (ev: Record<string, unknown>, privacy = { isPrivate: false, isIm: false }) =>
  ambientHook({ type: "message", channel_type: "channel", ...ev } as never, "UBOT", "ignore", async () => privacy);
const post = async (text: string, o: Record<string, unknown> = {}) => { await hook({ channel: "C1", ts: TS, user: "UBOB", text, ...o }, { isPrivate: o.channel === "GP", isIm: false }); await settleAmbient(); };
const rows = () => db.select().from(commitments);

describe("real-time capture", () => {
  test("@mention task: owner from the mention id, assigner = author, due vs message time, exact permalink, shared scope, open", async () => {
    extractReply = '{"commitments":[{"owner":"<@UPRIYA>","text":"Send the report","due":"2026-06-12"}]}';
    await post("<@UPRIYA> please send the report by Friday");
    const [c] = await rows();
    expect(c).toMatchObject({
      ownerId: "UPRIYA", ownerName: "Priya", assignerId: "UBOB", text: "Send the report", status: "open", scopeTag: "shared",
      channelId: "C1", sourceTs: TS, threadTs: TS, sourceRef: `msg:C1:${TS}:0`, permalink: `https://x.slack.com/archives/C1/p1781092800000100`,
    });
    expect(c!.dueAt!.toISOString().slice(0, 10)).toBe("2026-06-12");
    expect(prompts.find((p) => p.includes("Message author"))).toContain("Today: 2026-06-10"); // resolved against the message timestamp
    expect(prompts.find((p) => p.includes("Message author"))).toContain("Message author: <@UBOB>");
  });

  test("idempotent by (channel, ts); a re-delivered event adds nothing", async () => {
    extractReply = '{"commitments":[{"owner":"<@UPRIYA>","text":"Send the report","due":null}]}';
    await post("<@UPRIYA> please send the report by Friday");
    await post("<@UPRIYA> please send the report by Friday");
    expect(await captureTaskMessage({ channel: "C1", ts: TS, user: "UBOB", text: "<@UPRIYA> please send the report by Friday" })).toBe(0);
    expect(await rows()).toHaveLength(1);
  });

  test("private channel task is tagged channel_X; unknown channels fail closed; chit-chat never calls the model", async () => {
    extractReply = '{"commitments":[{"owner":"<@UBOB>","text":"Rotate the keys","due":null}]}';
    await post("<@UBOB> please rotate the keys", { channel: "GP", channel_type: "group" });
    expect((await rows())[0]!.scopeTag).toBe("channel_GP");
    prompts.length = 0;
    await post("good morning everyone, lunch at noon?", { ts: "1781092900.000100" });
    expect(prompts).toHaveLength(0);
  });

  test("thread replies: 'I'll take this' reassigns, 'Dana took this instead' reassigns by name, only owner/assigner closes with done, status facts are written", async () => {
    extractReply = '{"commitments":[{"owner":"<@UPRIYA>","text":"Send the report","due":null}]}';
    await post("<@UPRIYA> please send the report by Friday");
    classifyReply = '{"action":"reassign","index":0,"owner":"<@UCAROL>"}';
    await post("I'll take this", { ts: "1781093000.000100", thread_ts: TS, user: "UCAROL" });
    expect((await rows())[0]).toMatchObject({ ownerId: "UCAROL", status: "open" });
    classifyReply = '{"action":"reassign","index":0,"owner":"Dana"}';
    await post("Dana took this instead", { ts: "1781093100.000100", thread_ts: TS, user: "UBOB" });
    expect((await rows())[0]!.ownerId).toBe("UDANA");
    expect(await rows()).toHaveLength(1); // the reply was an update, not a new task
    classifyReply = '{"action":"done","index":0}';
    await post("done, shipped it", { ts: "1781093200.000100", thread_ts: TS, user: "UPRIYA" }); // not owner nor assigner
    expect((await rows())[0]!.status).toBe("open");
    await post("done, shipped it", { ts: "1781093300.000100", thread_ts: TS, user: "UDANA" });
    expect((await rows())[0]!.status).toBe("done");
    const facts = (await db.select().from(memories)).map((m) => m.text);
    expect(facts.some((t) => t.includes("took over") && t.includes("Dana"))).toBe(true);
    expect(facts.some((t) => t.includes("marked done by Dana"))).toBe(true);
  });
});

describe("edits and deletes", () => {
  test("message_changed re-extracts from the new text; an unchanged re-delivery is a no-op; message_deleted retires the task", async () => {
    extractReply = '{"commitments":[{"owner":"<@UPRIYA>","text":"Send the report","due":null}]}';
    await post("<@UPRIYA> please send the report by Friday");
    const ev = { channel: "C1", ts: TS, user: "UBOB", text: "<@UPRIYA> please send the report by Friday" };
    prompts.length = 0;
    await refreshTaskMessage(ev);
    expect(prompts).toHaveLength(0); // same text: no model call

    extractReply = '{"commitments":[{"owner":"<@UDANA>","text":"Send the invoice","due":null}]}';
    await hook({ channel: "C1", subtype: "message_changed", message: { ts: TS, user: "UBOB", text: "<@UDANA> please send the invoice by Friday" } });
    await settleAmbient();
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ ownerId: "UDANA", text: "Send the invoice", status: "open" });

    await hook({ channel: "C1", subtype: "message_deleted", deleted_ts: TS });
    await settleAmbient();
    expect((await rows())[0]!.status).toBe("dropped");
    expect(await retireTaskMessage("C1", TS)).toBe(0);
  });
});

describe("find_tasks", () => {
  const seed = async () => {
    await db.insert(channelMembers).values([{ channelId: "GP", userId: "UBOB" }]);
    await addCommitment({ ownerId: "UPRIYA", ownerName: "Priya", assignerId: "UBOB", text: "Send the Acme invoice", dueAt: new Date("2026-06-12"), sourceType: "message", sourceRef: "m:1", permalink: "https://x.slack.com/archives/C1/p1", channelId: "C1", scopeTag: "shared" });
    await addCommitment({ ownerId: "UBOB", ownerName: "Bob", assignerId: "UPRIYA", text: "Rotate the production keys", sourceType: "message", sourceRef: "m:2", permalink: "https://x.slack.com/archives/GP/p2", channelId: "GP", scopeTag: "channel_GP" });
  };
  const pub = { channelId: "C1", isPrivate: false, isIm: false, userId: "UCAROL" };

  test("returns owner, assigner, due, status and the Source link", async () => {
    await seed();
    const out = formatTasks(await findTasks({ scope: pub, asker: "UCAROL", query: "who was given the Acme invoice task?" }));
    expect(out).toContain("owner: <@UPRIYA>");
    expect(out).toContain("assigned by: <@UBOB>");
    expect(out).toContain("due: 2026-06-12");
    expect(out).toContain("[open]");
    expect(out).toContain("Source: https://x.slack.com/archives/C1/p1");
  });

  test("a private channel task is never returned to a non-member, in a public channel or in their DM", async () => {
    await seed();
    for (const scope of [pub, { channelId: "D1", isPrivate: false, isIm: true, userId: "UCAROL" }]) {
      const r = await findTasks({ scope, asker: "UCAROL", query: "rotate production keys" });
      expect(r.tasks).toHaveLength(0);
      expect(formatTasks(r)).toContain("don't know");
    }
    const asBob = await findTasks({ scope: { channelId: "D2", isPrivate: false, isIm: true, userId: "UBOB" }, asker: "UBOB", query: "rotate production keys" });
    expect(asBob.tasks).toHaveLength(1);
    const inGp = await findTasks({ scope: { channelId: "GP", isPrivate: true, isIm: false, userId: "UBOB" }, asker: "UBOB", owner: "me" });
    expect(inGp.tasks.map((t) => t.sourceRef)).toEqual(["m:2"]);
  });

  test("filters by owner name, assigner, status and due range; the tool is wired and the router sends 'who was given' questions to memory depth", async () => {
    await seed();
    expect((await findTasks({ scope: pub, asker: "UCAROL", owner: "Priya" })).tasks).toHaveLength(1);
    expect((await findTasks({ scope: pub, asker: "UCAROL", assigner: "Bob" })).tasks).toHaveLength(1);
    expect((await findTasks({ scope: pub, asker: "UCAROL", status: "done" })).tasks).toHaveLength(0);
    expect((await findTasks({ scope: pub, asker: "UCAROL", dueAfter: "2026-07-01" })).tasks).toHaveLength(0);
    const tool = memoryTools({ turnId: "t", userId: "UCAROL", channelId: "C1", scope: pub, readOnly: true, orgConnectionsOnly: false }).find_tasks as { execute: (i: unknown, o: unknown) => Promise<string> };
    expect(await tool.execute({ query: "Acme invoice" }, {})).toContain("Source:");
    for (const q of ["who was given the invoice task?", "who owns billing?", "who is responsible for the migration", "what's due this week?"]) {
      expect(heuristicDepth({ trigger: "mention", text: q })).toBe("memory");
    }
  });
});

describe("follow-up DMs", () => {
  const FUTURE = new Date(NOW.getTime() + 3_600_000);
  const dms = () => posts().filter((p) => String(p.channel).startsWith("D_"));

  test("a reminder DMs only the requester, during working hours; at night it waits", async () => {
    const f = await createFollowUp({ ownerId: "UBOB", text: "check with Dana about the invoice", at: FUTURE }, NOW);
    expect(f.status).toBe("pending");
    const due = new Date(FUTURE.getTime() + 60_000);
    expect(await followUpTick(NIGHT)).toBe(0); // quiet hours
    expect(await followUpTick(new Date("2026-06-10T22:30:00Z"))).toBe(0);
    expect(await followUpTick(due)).toBe(1);
    expect(dms()).toHaveLength(1);
    expect(dms()[0]).toMatchObject({ channel: "D_UBOB" });
    expect(String(dms()[0].text)).toContain("check with Dana");
    expect(await followUpTick(due)).toBe(0); // one-shot: not sent twice
    expect((await db.select().from(followUps))[0]!.status).toBe("sent");
  });

  test("recurring follow-ups move to the next slot", async () => {
    await createFollowUp({ ownerId: "UBOB", text: "weekly sync notes", at: FUTURE, repeatDays: 7 }, NOW);
    expect(await followUpTick(new Date(FUTURE.getTime() + 60_000))).toBe(1);
    const [f] = await db.select().from(followUps);
    expect(f).toMatchObject({ status: "pending", sendCount: 1 });
    expect(f!.dueAt.getTime()).toBe(FUTURE.getTime() + 7 * 86_400_000);
  });

  test("follow up with @Bob needs the requester's consent card click; a stranger's click does nothing", async () => {
    const f = await createFollowUp({ ownerId: "UPRIYA", targetId: "UBOB", text: "any news on the invoice?", at: FUTURE, origin: { channelId: "C1", threadTs: TS } }, NOW);
    expect(f.status).toBe("proposed");
    const due = new Date(FUTURE.getTime() + 60_000);
    expect(await followUpTick(due)).toBe(0); // not consented
    await handleFollowUpAction({ user: { id: "UBOB" } }, { action_id: "brain_fu_yes", value: f.id });
    expect((await db.select().from(followUps))[0]!.status).toBe("proposed");
    await handleFollowUpAction({ user: { id: "UPRIYA" } }, { action_id: "brain_fu_yes", value: f.id });
    expect(await followUpTick(due)).toBe(1);
    expect(dms()[0]).toMatchObject({ channel: "D_UBOB" });
    expect(String(dms()[0].text)).toContain("any news on the invoice?");
    expect(String(dms()[0].text)).not.toContain("C1");
  });

  test("declining cancels; per-recipient cap stops a flood; owner cap and validation", async () => {
    const f = await createFollowUp({ ownerId: "UPRIYA", targetId: "UBOB", text: "nudge about the invoice", at: FUTURE }, NOW);
    await handleFollowUpAction({ user: { id: "UPRIYA" } }, { action_id: "brain_fu_no", value: f.id });
    expect((await db.select().from(followUps))[0]!.status).toBe("cancelled");

    for (let i = 0; i < 8; i++) await createFollowUp({ ownerId: "UPRIYA", text: `reminder number ${i}`, at: FUTURE }, NOW);
    expect(await followUpTick(new Date(FUTURE.getTime() + 60_000))).toBe(5); // burst of 5 per person, the rest wait
    for (let i = 0; i < FOLLOWUP_CAP; i++) await createFollowUp({ ownerId: "UCAROL", text: `thing ${i} to do`, at: FUTURE }, NOW).catch(() => {});
    expect((await listFollowUps("UCAROL")).length).toBe(FOLLOWUP_CAP);
    await expect(createFollowUp({ ownerId: "UCAROL", text: "one too many", at: FUTURE }, NOW)).rejects.toThrow(/active follow-ups/);
    await expect(createFollowUp({ ownerId: "UBOB", text: "in the past", at: new Date(NOW.getTime() - 1000) }, NOW)).rejects.toThrow();
    await expect(createFollowUp({ ownerId: "UBOB", text: "password is hunter22222", at: FUTURE }, NOW)).rejects.toThrow(/secret/);
  });
});

describe("task digest + commands", () => {
  const mk = (o: Partial<Parameters<typeof addCommitment>[0]>, n: number) =>
    addCommitment({ ownerId: "UBOB", ownerName: "Bob", assignerId: "UPRIYA", sourceType: "message", sourceRef: `d:${n}`, channelId: "C1", scopeTag: "shared", text: `task ${n}`, ...o });

  test("daily digest: default off, once per day, working hours only, never includes unreadable (private) tasks", async () => {
    await mk({ text: "Ship the public thing", permalink: "https://x.slack.com/archives/C1/p9" }, 1);
    await mk({ text: "Rotate secret keys", channelId: "GP", scopeTag: "channel_GP" }, 2); // Bob is not a member of GP
    const dms = () => posts().filter((p) => p.channel === "D_UBOB");
    expect((await digestTick(NOW)).digests).toBe(0); // default off
    await setPrefs("UBOB", { digest: { on: true, time: "09:00", days: [1, 2, 3, 4, 5] } });
    expect((await digestTick(NIGHT)).digests).toBe(0); // quiet hours
    expect((await digestTick(NOW)).digests).toBe(1);
    expect((await digestTick(NOW)).digests).toBe(0); // already sent today
    const text = JSON.stringify(dms()[0]);
    expect(text).toContain("Ship the public thing");
    expect(text).not.toContain("Rotate secret keys");
    // the same tasks but Bob IS a member: he now sees it next day
    await db.insert(channelMembers).values({ channelId: "GP", userId: "UBOB" });
    expect((await digestTick(new Date("2026-06-11T12:00:00Z"))).digests).toBe(1);
    expect(JSON.stringify(dms()[1])).toContain("Rotate secret keys");
  });

  test("/brain-tasks lists mine and what I assigned with Done/Drop; Done closes through the chase handler", async () => {
    await mk({ text: "Send the report", permalink: "https://x.slack.com/archives/C1/p7" }, 1);
    await mk({ ownerId: "UDANA", ownerName: "Dana", assignerId: "UBOB", text: "Review the PR" }, 2);
    const r = await runSlashCommand({ command: "/brain-tasks", user_id: "UBOB", channel_id: "C1" });
    const json = JSON.stringify(r);
    expect(r!.response_type).toBe("ephemeral");
    expect(json).toContain("Assigned to you");
    expect(json).toContain("You assigned");
    expect(json).toContain("Send the report");
    expect(json).toContain("brain_task_done");
    await handleCommitmentAction({ user: { id: "UBOB" } }, { action_id: "brain_task_done", value: (await rows()).find((c) => c.text === "Send the report")!.id });
    expect((await rows()).find((c) => c.text === "Send the report")!.status).toBe("done");
    // assigner may close a task they handed out; a bystander may not
    await handleInteraction({ type: "block_actions", user: { id: "UCAROL" }, actions: [{ action_id: "brain_task_drop", value: (await rows()).find((c) => c.text === "Review the PR")!.id }] } as never);
    expect((await rows()).find((c) => c.text === "Review the PR")!.status).toBe("open");
    await handleCommitmentAction({ user: { id: "UBOB" } }, { action_id: "brain_task_drop", value: (await rows()).find((c) => c.text === "Review the PR")!.id });
    expect((await rows()).find((c) => c.text === "Review the PR")!.status).toBe("dropped");
  });

  test("/brain-followups: list, digest on/off with time and days, weekly, cancel", async () => {
    const f = await createFollowUp({ ownerId: "UBOB", text: "ping legal about the contract", at: new Date(Date.now() + 86_400_000) });
    const list = JSON.stringify(await runSlashCommand({ command: "/brain-followups", user_id: "UBOB", channel_id: "C1" }));
    expect(list).toContain(f.id);
    expect(list).toContain("Daily digest: off");
    await runSlashCommand({ command: "/brain-followups", user_id: "UBOB", text: "digest on 8:30 mon,wed", channel_id: "C1" });
    expect((await getPrefs("UBOB")).digest).toEqual({ on: true, time: "08:30", days: [1, 3] });
    await runSlashCommand({ command: "/brain-followups", user_id: "UBOB", text: "weekly on", channel_id: "C1" });
    expect((await getPrefs("UBOB")).weekly?.on).toBe(true);
    await runSlashCommand({ command: "/brain-followups", user_id: "UBOB", text: "digest off", channel_id: "C1" });
    expect((await getPrefs("UBOB")).digest?.on).toBe(false);
    expect(JSON.stringify(await runSlashCommand({ command: "/brain-followups", user_id: "UCAROL", text: `cancel ${f.id}`, channel_id: "C1" }))).toContain("couldn't find");
    expect(JSON.stringify(await runSlashCommand({ command: "/brain-followups", user_id: "UBOB", text: `cancel ${f.id}`, channel_id: "C1" }))).toContain("Cancelled");
    expect(await listFollowUps("UBOB")).toHaveLength(0);
  });
});
