import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { addChannel, setup } from "./helpers";
import { db } from "../../src/db";
import { channelMembers, memories, users } from "../../src/db/schema";
import { handleInteraction } from "../../src/slack/interactions";
import { askDeps, attemptDelivery, captureOwnerReply, getAsk, nextWindow, proposeAsk } from "../../src/slack/teammate";
import { installFakes, removeFakes } from "../memory/helpers";

process.env.QUIET_HOURS = "1"; // quiet hours are opt-in; these tests cover the opt-in behaviour

beforeAll(installFakes);
afterAll(removeFakes);

const WED_10 = new Date("2026-10-21T10:00:00Z");
let ctx: Awaited<ReturnType<typeof setup>>;
let deferred: { id: string; at: Date }[];
beforeEach(async () => {
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
    const relay = posts().at(-1)!;
    expect(relay.channel).toBe("CPRIV");
    expect(relay.thread_ts).toBe("1.1");
    expect(relay.text).toContain("Finance lead, Priya.");
  });
});
