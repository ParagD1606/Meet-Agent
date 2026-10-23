import "./env";
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { approvals, turns } from "../../src/db/schema";
import { createConnection } from "../../src/mcp/connections";
import { executeApproved, expireStale, handleBlockAction, requestApproval, resumePending, settled, stopSweeper } from "../../src/turn/approval";
import { setFollowUp, type FollowUpInput } from "../../src/turn/followup";
import { fakeMcp, fakeSlack, seedTurn, seedUsers, type ToolCall } from "./helpers";

let slack: ReturnType<typeof fakeSlack>;
let mcp: ToolCall[];
let followUps: FollowUpInput[];
let connId: string;

const ask = (over: Partial<Parameters<typeof requestApproval>[0]> = {}) =>
  requestApproval({ turnId: "turn1", requesterId: "UASK", channelId: "C1", threadTs: "1.1", connectionId: connId, toolName: "github__create_issue", mcpTool: "create_issue", input: { title: "bug" }, ...over });
const click = (user: string, action: "approval_approve" | "approval_deny", id: string) =>
  handleBlockAction({ user: { id: user }, actions: [{ action_id: action, value: id }] });
const row = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
const turnStatus = async () => (await db.select().from(turns).where(eq(turns.id, "turn1")))[0]!.status;

beforeEach(async () => {
  await resetDb();
  await seedUsers();
  await seedTurn();
  slack = fakeSlack();
  mcp = fakeMcp();
  followUps = [];
  setFollowUp(async (i) => { followUps.push(i); });
  connId = (await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "tok" })).id;
});

describe("approval lifecycle", () => {
  test("request persists a pending row, posts a card with buttons, and parks the turn", async () => {
    const { approvalId } = await ask();
    const r = await row(approvalId);
    expect(r.status).toBe("pending");
    expect(r.messageTs).toBeTruthy();
    expect(r.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(r.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const card = slack.of("postMessage")[0]!.args;
    expect(card.blocks[1].elements.map((e: any) => e.action_id)).toEqual(["approval_approve", "approval_deny"]);
    expect(await turnStatus()).toBe("waiting_approval");
    expect(mcp).toHaveLength(0);
  });

  test("only the requester can approve; others change nothing", async () => {
    const { approvalId } = await ask();
    expect(await click("UOTH", "approval_approve", approvalId)).toBe(true);
    await settled();
    expect((await row(approvalId)).status).toBe("pending");
    expect(mcp).toHaveLength(0);
    expect(slack.of("postEphemeral")).toHaveLength(1);
  });

  test("approve executes exactly once under the requester's connection, then continues the thread", async () => {
    const { approvalId } = await ask();
    await click("UASK", "approval_approve", approvalId);
    await click("UASK", "approval_approve", approvalId); // double click
    await click("UASK", "approval_deny", approvalId); // late deny
    await settled();
    expect((await row(approvalId)).status).toBe("approved");
    expect(mcp).toEqual([{ connectionId: connId, name: "create_issue", args: { title: "bug" } }]);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.text).toContain("ok:create_issue");
    expect(followUps[0]).toMatchObject({ channelId: "C1", threadTs: "1.1", userId: "UASK" });
    expect(await turnStatus()).toBe("done");
  });

  test("deny runs nothing and closes the turn", async () => {
    const { approvalId } = await ask();
    await click("UASK", "approval_deny", approvalId);
    await settled();
    expect((await row(approvalId)).status).toBe("denied");
    expect(mcp).toHaveLength(0);
    expect(followUps).toHaveLength(0);
    expect(await turnStatus()).toBe("done");
  });

  test("clicking after expiry marks it expired and runs nothing", async () => {
    const { approvalId } = await ask();
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, approvalId));
    await click("UASK", "approval_approve", approvalId);
    await settled();
    expect((await row(approvalId)).status).toBe("expired");
    expect(mcp).toHaveLength(0);
    expect(slack.of("update").at(-1)!.args.text).toContain("expired");
  });

  test("expireStale sweeps overdue pending approvals only", async () => {
    const a = await ask();
    const b = await ask();
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, a.approvalId));
    const out = await expireStale();
    expect(out.approvals).toBe(1);
    expect((await row(a.approvalId)).status).toBe("expired");
    expect((await row(b.approvalId)).status).toBe("pending");
  });

  test("execution refuses a connection that is not the requester's own", async () => {
    const other = (await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "x" })).id;
    const { approvalId } = await ask({ connectionId: other });
    await click("UASK", "approval_approve", approvalId);
    await settled();
    expect(mcp).toHaveLength(0);
    expect(followUps[0]!.text).toContain("no longer available");
  });

  test("a failing tool call is reported, not thrown", async () => {
    const { setMcpFactory } = await import("../../src/mcp/client");
    setMcpFactory(async () => ({ listTools: async () => [], callTool: async () => { throw new Error("upstream 500"); }, close: async () => {} }));
    const { approvalId } = await ask();
    await click("UASK", "approval_approve", approvalId);
    await settled();
    expect(followUps[0]!.text).toContain("upstream 500");
  });
});

describe("restart resilience", () => {
  test("a pending approval created before 'restart' is still actionable (state is only in Postgres)", async () => {
    const { approvalId } = await ask();
    // simulate restart: drop every in-memory hook, boot again
    setFollowUp(undefined);
    const swept = await resumePending();
    stopSweeper();
    expect(swept.approvals).toBe(0);
    setFollowUp(async (i) => { followUps.push(i); });
    await click("UASK", "approval_approve", approvalId);
    await settled();
    expect(mcp).toHaveLength(1);
  });

  test("resumePending expires what lapsed while down and closes orphaned waiting turns", async () => {
    const { approvalId } = await ask();
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(approvals.id, approvalId));
    await db.insert(turns).values({ id: "orphan", channelId: "C1", trigger: "mention", status: "waiting_approval" });
    const out = await resumePending();
    stopSweeper();
    expect(out.approvals).toBe(1);
    expect((await row(approvalId)).status).toBe("expired");
    expect(await turnStatus()).toBe("done");
    expect((await db.select().from(turns).where(eq(turns.id, "orphan")))[0]!.status).toBe("done");
    expect(mcp).toHaveLength(0);
  });

  test("executeApproved can be driven straight from the persisted row", async () => {
    const { approvalId } = await ask();
    expect(await executeApproved(await row(approvalId))).toBe("ok:create_issue");
  });
});
