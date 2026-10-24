// B4 (a)+(c): opt-in weekly digest and deadline reminders, scoped per channel.
import "../slack/env";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildDigest, deadlineTick, digestTick } from "../../src/automations";
import { db, resetDb } from "../db";
import { channels, episodes, memoryReminders, workspace } from "../../src/db/schema";
import { encrypt } from "../../src/crypto";
import { setSlackClientForTest } from "../../src/slack/client";
import { setFeatureChannels } from "../../src/slack/proactive-features";
import { fakeSlack } from "../slack/helpers";
import { installFakes, removeFakes, seedMemory } from "../memory/helpers";

beforeAll(installFakes);
afterAll(removeFakes);

const NOW = new Date("2026-06-10T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const ahead = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
let fake: ReturnType<typeof fakeSlack>;

beforeEach(async () => {
  await resetDb();
  await db.insert(workspace).values({ id: "T1", name: "Acme", botTokenEnc: encrypt("xoxb-test"), botUserId: "UBOT", homeChannelId: "CH" });
  await db.insert(channels).values([
    { id: "C1", name: "pub", botIsMember: true },
    { id: "GP", name: "priv", isPrivate: true, botIsMember: true },
  ]);
  fake = fakeSlack();
  setSlackClientForTest(fake.client);
});
const posts = () => fake.calls.filter((c) => c.method === "chat.postMessage").map((c) => c.args);

describe("weekly digest", () => {
  test("sections from the week's facts, deadlines, discussions; old and other-channel facts left out", async () => {
    await seedMemory("shared", "We decided to move billing to Stripe", { factType: "decision", sourceRef: "C1", createdAt: ago(2) });
    await seedMemory("shared", "Action item: Priya to follow up with legal", { sourceRef: "C1", createdAt: ago(10) });
    await seedMemory("shared", "Launch review is due soon", { sourceRef: "C1", createdAt: ago(1), validUntil: ahead(24 * 5) });
    await seedMemory("shared", "The office wifi password rotated", { sourceRef: "C1", createdAt: ago(3) });
    await seedMemory("shared", "A decision made last month about pricing tiers", { factType: "decision", sourceRef: "C1", createdAt: ago(40) });
    await seedMemory("shared", "We decided the Lisbon offsite is on", { factType: "decision", sourceRef: "C2", createdAt: ago(1) });
    await db.insert(episodes).values({ id: "e1", scopeTag: "shared", channelId: "C1", threadTs: "1.1", summary: "Team debated the migration plan", embedding: new Array(1536).fill(0.01), endedAt: ago(1) });
    const text = (await buildDigest({ id: "C1", isPrivate: false }, NOW))!;
    expect(text).toContain("*Decisions*");
    expect(text).toContain("move billing to Stripe");
    expect(text).toContain("follow up with legal");
    expect(text).toContain("*Deadlines*");
    expect(text).toContain("wifi password");
    expect(text).toContain("migration plan");
    expect(text).not.toContain("pricing tiers");
    expect(text).not.toContain("Lisbon");
  });

  test("quiet week: no digest", async () => {
    expect(await buildDigest({ id: "C1", isPrivate: false }, NOW)).toBeNull();
  });

  test("scope isolation: a private channel's facts never reach a public digest, and vice versa", async () => {
    await seedMemory("channel_GP", "We decided to acquire Hooli", { factType: "decision", sourceRef: "C1", createdAt: ago(1) }); // even with a misleading source_ref
    await seedMemory("channel_GP", "We decided to double the secret budget", { factType: "decision", sourceRef: "GP", createdAt: ago(1) });
    await seedMemory("shared", "We decided to ship on Friday", { factType: "decision", sourceRef: "C1", createdAt: ago(1) });
    const pub = (await buildDigest({ id: "C1", isPrivate: false }, NOW))!;
    expect(pub).toContain("ship on Friday");
    expect(pub).not.toContain("Hooli");
    expect(pub).not.toContain("secret budget");
    const priv = (await buildDigest({ id: "GP", isPrivate: true }, NOW))!;
    expect(priv).toContain("secret budget");
    expect(priv).not.toContain("ship on Friday");
  });

  test("digestTick posts only to opted-in channels the bot is in", async () => {
    await seedMemory("shared", "We decided to ship on Friday", { factType: "decision", sourceRef: "C1", createdAt: ago(1) });
    expect(await digestTick(NOW)).toEqual([]);
    await setFeatureChannels("digest", ["C1", "CX"]);
    expect(await digestTick(NOW)).toEqual(["C1"]);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].channel).toBe("C1");
  });
});

describe("deadline reminders", () => {
  test("opt-in, within 24h, once per fact, scoped to its channel", async () => {
    const due = await seedMemory("shared", "Submit the SOC2 evidence", { sourceRef: "C1", validUntil: ahead(10) });
    await seedMemory("shared", "Renew the domain", { sourceRef: "C1", validUntil: ahead(24 * 6) }); // too far
    await seedMemory("channel_GP", "Private board filing due", { sourceRef: "GP", validUntil: ahead(5) });
    expect(await deadlineTick(NOW)).toBe(0); // not opted in
    await setFeatureChannels("deadlines", ["C1"]);
    expect(await deadlineTick(NOW)).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ channel: "C1" });
    expect(posts()[0].text).toContain("SOC2 evidence");
    expect(posts()[0].text).not.toContain("board filing");
    expect(await deadlineTick(NOW)).toBe(0); // already reminded
    expect((await db.select().from(memoryReminders))[0]).toMatchObject({ memoryId: due, channelId: "C1" });
  });

  test("a failed post is retried on the next tick", async () => {
    await seedMemory("shared", "Submit the SOC2 evidence", { sourceRef: "C1", validUntil: ahead(10) });
    await setFeatureChannels("deadlines", ["C1"]);
    setSlackClientForTest(fakeSlack({ "chat.postMessage": () => { throw new Error("slack down"); } }).client);
    expect(await deadlineTick(NOW)).toBe(0);
    setSlackClientForTest(fake.client);
    expect(await deadlineTick(NOW)).toBe(1);
  });
});
