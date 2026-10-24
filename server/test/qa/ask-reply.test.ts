// QA M2: an owner's stray message must not be captured as the answer; stale asks stop capturing.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { addChannel, setup } from "../slack/helpers";
import { db } from "../../src/db";
import { memories, users } from "../../src/db/schema";
import { handleInteraction } from "../../src/slack/interactions";
import { askDeps, captureOwnerReply, expireStaleAsks, getAsk, proposeAsk } from "../../src/slack/teammate";
import { installFakes, removeFakes } from "../memory/helpers";

beforeAll(installFakes);
afterAll(() => { removeFakes(); askDeps.now = () => new Date(); });
const WED_10 = new Date("2026-10-21T10:00:00Z");
beforeEach(async () => {
  await setup();
  askDeps.now = () => WED_10;
  askDeps.defer = async () => {};
  await db.insert(users).values([{ id: "UASK", name: "Asker" }, { id: "UOWN", name: "Dana" }]);
  await addChannel("CPRIV", { isPrivate: true });
});

async function sentAsk() {
  const id = await proposeAsk({ asker: "UASK", owner: "UOWN", question: "Who approves?", origin: { channelId: "CPRIV", threadTs: "1.1", isPrivate: true, isIm: false } });
  await handleInteraction({ type: "block_actions", user: { id: "UASK" }, container: { channel_id: "CPRIV", message_ts: "5.5" }, actions: [{ action_id: "brain_ask_yes", value: id }] } as never);
  return id;
}

test("an unrelated, un-threaded DM from the owner is not an answer", async () => {
  await sentAsk();
  expect(await captureOwnerReply({ user: "UOWN", channel: "D_UOWN", text: "lunch at 1?" })).toBe(false);
  expect(await db.select().from(memories)).toHaveLength(0);
});

test("a reply to the bot's DM thread is", async () => {
  await sentAsk();
  expect(await captureOwnerReply({ user: "UOWN", channel: "D_UOWN", thread_ts: "999.1", text: "Priya approves." })).toBe(true);
});

test("an ask older than 24h no longer captures and is swept to failed", async () => {
  const id = await sentAsk();
  askDeps.now = () => new Date(WED_10.getTime() + 25 * 3_600_000);
  expect(await captureOwnerReply({ user: "UOWN", channel: "D_UOWN", thread_ts: "999.1", text: "Priya approves." })).toBe(false);
  expect(await expireStaleAsks()).toBe(1);
  expect((await getAsk(id))!.status).toBe("failed");
});
