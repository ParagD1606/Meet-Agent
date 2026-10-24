// QA: privacy/scope leaks through newer paths. Each test is one hypothesis.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, resetDb } from "../db";
import { channelMembers, channels, commitments, meetings, memoryReviews, users, workspace } from "../../src/db/schema";
import { encrypt } from "../../src/crypto";
import { setSlackClientForTest } from "../../src/slack/client";
import { addCommitment, chaseTick, resolveOwner, runExtraction } from "../../src/manager";
import { getMeeting, listMeetings } from "../../src/meetings";
import { runSlashCommand } from "../../src/slack/commands";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);
const NOW = new Date("2026-06-10T12:00:00Z");
let fake: ReturnType<typeof fakeSlack>;
beforeEach(async () => {
  await resetDb();
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CHOME" });
  await db.insert(users).values([{ id: "U1", name: "Ann" }, { id: "U2", name: "Bob" }, { id: "UA", name: "Admin", role: "admin" }]);
  fake = fakeSlack();
  setSlackClientForTest(fake.client);
});

describe("meetings", () => {
  test("a huddle held in a DM is not visible to other members", async () => {
    await db.insert(channels).values({ id: "D1", isIm: true, isPrivate: false }); // DMs are stored isIm=true, isPrivate=false
    await db.insert(channelMembers).values({ channelId: "D1", userId: "U1" });
    await db.insert(meetings).values({ id: "mt_1", sourceFileId: "F1", channelId: "D1", title: "DM huddle", transcript: "secret", summary: "private talk", status: "ready", endedAt: NOW, tasks: [] });
    expect(await listMeetings({ userId: "U2", role: "member" })).toHaveLength(0);
    expect(await getMeeting("mt_1", { userId: "U2", role: "member" })).toBeNull();
  });
  test("meeting commitments from a DM or unknown channel never land in the shared scope", async () => {
    await db.insert(channels).values({ id: "D1", isIm: true });
    for (const [i, ch] of ["D1", "CUNKNOWN"].entries()) {
      await db.insert(meetings).values({ id: `mt_${i}`, sourceFileId: `F${i}`, channelId: ch, title: "m", transcript: "t", summary: "s", status: "ready", endedAt: NOW, updatedAt: NOW, tasks: [{ title: `Task ${i}`, assigneeId: "U1" }] });
    }
    await runExtraction(new Date(NOW.getTime() + 1000));
    const rows = await db.select().from(commitments);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.scopeTag).not.toBe("shared");
  });
});

describe("review modal", () => {
  test("/brain-review does not show DM-scope facts to admins (web /reviews filters to shared)", async () => {
    const id = await seedMemory("user_U1", "Ann's secret salary negotiation notes");
    await db.insert(memoryReviews).values({ id: "rv_1", kind: "low_confidence", memoryId: id, payload: { reason: "thumbs_down" } });
    await runSlashCommand({ command: "/brain-review", user_id: "UA", trigger_id: "TR" });
    const open = fake.calls.find((c) => c.method === "views.open")!;
    expect(JSON.stringify(open.args.view)).not.toContain("salary");
  });
});

describe("chase", () => {
  test("a DM-scope commitment is not nudged to a third-party owner (leaks the private text)", async () => {
    await db.insert(channels).values({ id: "D1", isIm: true });
    await addCommitment({ sourceType: "fact", sourceRef: "fact:1", scopeTag: "user_U1", ownerId: "U2", ownerName: "Bob", text: "Bob to hide the layoff list", dueAt: new Date(NOW.getTime() + 3600_000), channelId: "D1", threadTs: "1.1" });
    await chaseTick(NOW);
    expect(JSON.stringify(fake.calls.filter((c) => c.method === "chat.postMessage"))).not.toContain("layoff");
  });

  test("private-channel commitment: nudged to a member owner only", async () => {
    await db.insert(channels).values({ id: "GP", isPrivate: true, botIsMember: true });
    await db.insert(channelMembers).values({ channelId: "GP", userId: "U1" });
    const due = new Date(NOW.getTime() + 3600_000);
    await addCommitment({ sourceType: "fact", sourceRef: "f:1", scopeTag: "channel_GP", ownerId: "U2", text: "outsider secret task", dueAt: due, channelId: "GP", threadTs: "1.1" });
    await addCommitment({ sourceType: "fact", sourceRef: "f:2", scopeTag: "channel_GP", ownerId: "U1", text: "member task", dueAt: due, channelId: "GP", threadTs: "1.1" });
    await chaseTick(NOW);
    const sent = JSON.stringify(fake.calls.filter((c) => c.method === "chat.postMessage"));
    expect(sent).toContain("member task");
    expect(sent).not.toContain("outsider secret");
  });
});

describe("resolveOwner", () => {
  test("an ambiguous first name resolves to the channel member", async () => {
    await db.insert(users).values([{ id: "UD1", name: "Dana Lee" }, { id: "UD2", name: "Dana Cruz" }]);
    await db.insert(channels).values({ id: "C1" });
    await db.insert(channelMembers).values({ channelId: "C1", userId: "UD2" });
    expect((await resolveOwner("Dana")).id).toBeNull();
    expect((await resolveOwner("Dana", "C1")).id).toBe("UD2");
  });
});
