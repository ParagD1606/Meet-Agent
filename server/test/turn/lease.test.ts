import "./env";
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { leases } from "../../src/db/schema";
import { createConnection } from "../../src/mcp/connections";
import { setFollowUp, type FollowUpInput } from "../../src/turn/followup";
import { consumeLease, decideLease, expireLeases, grantedLeases, handleLeaseAction, leaseCandidates, requestLease } from "../../src/turn/lease";
import { fakeSlack, seedTurn, seedUsers } from "./helpers";

let slack: ReturnType<typeof fakeSlack>;
let followUps: FollowUpInput[];
let ownerConn: string;

beforeEach(async () => {
  await resetDb();
  await seedUsers();
  await seedTurn();
  slack = fakeSlack();
  followUps = [];
  setFollowUp(async (i) => { followUps.push(i); });
  ownerConn = (await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "t" })).id;
});

const request = () => requestLease({ connectionId: ownerConn, requesterId: "UASK", turnId: "turn1", reason: "need PRs" });

describe("lease", () => {
  test("request DMs the owner with allow/deny and expires in 10 minutes", async () => {
    const l = await request();
    expect(l.status).toBe("pending");
    expect(l.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(slack.of("open")[0]!.args.users).toBe("UOWN");
    const msg = slack.of("postMessage")[0]!.args;
    expect(msg.channel).toBe("D_UOWN");
    expect(msg.blocks[1].elements.map((e: any) => e.action_id)).toEqual(["lease_allow", "lease_deny"]);
  });

  test("duplicate requests reuse the live lease (no second DM)", async () => {
    const a = await request();
    const b = await request();
    expect(b.id).toBe(a.id);
    expect(slack.of("postMessage")).toHaveLength(1);
  });

  test("only the owner can decide", async () => {
    const l = await request();
    expect(await decideLease(l.id, "UASK", true)).toBeNull();
    expect(await decideLease(l.id, "UOTH", true)).toBeNull();
    expect((await decideLease(l.id, "UOWN", true))!.status).toBe("granted");
    expect(await decideLease(l.id, "UOWN", false)).toBeNull(); // already decided
  });

  test("one-use: second consume fails, other requester cannot consume", async () => {
    const l = await request();
    expect(await consumeLease(l.id, "UASK")).toBe(false); // not granted yet
    await decideLease(l.id, "UOWN", true);
    expect(await consumeLease(l.id, "UOTH")).toBe(false);
    expect(await consumeLease(l.id, "UASK")).toBe(true);
    expect(await consumeLease(l.id, "UASK")).toBe(false);
    expect((await db.select().from(leases).where(eq(leases.id, l.id)))[0]!.status).toBe("used");
    expect(await grantedLeases("UASK")).toHaveLength(0);
  });

  test("concurrent consumes: exactly one wins", async () => {
    const l = await request();
    await decideLease(l.id, "UOWN", true);
    const r = await Promise.all(Array.from({ length: 5 }, () => consumeLease(l.id, "UASK")));
    expect(r.filter(Boolean)).toHaveLength(1);
  });

  test("expired leases cannot be granted or consumed, and are swept", async () => {
    const l = await request();
    await db.update(leases).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(leases.id, l.id));
    expect(await decideLease(l.id, "UOWN", true)).toBeNull();
    const g = await request(); // a fresh one replaces the lapsed one
    expect(g.id).not.toBe(l.id);
    await decideLease(g.id, "UOWN", true);
    await db.update(leases).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(leases.id, g.id));
    expect(await consumeLease(g.id, "UASK")).toBe(false);
    expect(await expireLeases()).toBeGreaterThanOrEqual(2);
  });

  test("refuses own connection, org connection and personal-only providers", async () => {
    await expect(requestLease({ connectionId: ownerConn, requesterId: "UOWN", turnId: "turn1" })).rejects.toThrow();
    const org = await createConnection({ provider: "linear", scope: "org", token: "t" });
    await expect(requestLease({ connectionId: org.id, requesterId: "UASK", turnId: "turn1" })).rejects.toThrow();
    const gm = await createConnection({ provider: "gmail-personal-only", scope: "user", ownerUserId: "UOWN", token: "t" });
    await expect(requestLease({ connectionId: gm.id, requesterId: "UASK", turnId: "turn1" })).rejects.toThrow(/personal/);
    expect(await leaseCandidates("gmail-personal-only", "UASK")).toEqual([]);
  });

  test("candidates exclude the requester", async () => {
    expect((await leaseCandidates("github", "UASK")).map((c) => c.ownerUserId)).toEqual(["UOWN"]);
    expect(await leaseCandidates("github", "UOWN")).toEqual([]);
  });

  test("Allow button grants and resumes the requester's thread; a stranger's click is ignored", async () => {
    const l = await request();
    const act = (user: string, a: string) => handleLeaseAction({ user: { id: user }, actions: [{ action_id: a, value: l.id }], channel: { id: "D_UOWN" }, message: { ts: "9.9" } });
    expect(await act("UASK", "lease_allow")).toBe(true);
    expect((await db.select().from(leases).where(eq(leases.id, l.id)))[0]!.status).toBe("pending");
    expect(await act("UOWN", "lease_allow")).toBe(true);
    expect((await db.select().from(leases).where(eq(leases.id, l.id)))[0]!.status).toBe("granted");
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ channelId: "C1", threadTs: "1.1", userId: "UASK" });
    await act("UOWN", "lease_allow"); // double click
    expect(followUps).toHaveLength(1);
  });

  test("Deny does not resume", async () => {
    const l = await request();
    await handleLeaseAction({ user: { id: "UOWN" }, actions: [{ action_id: "lease_deny", value: l.id }] });
    expect((await db.select().from(leases).where(eq(leases.id, l.id)))[0]!.status).toBe("denied");
    expect(followUps).toHaveLength(0);
  });
});
