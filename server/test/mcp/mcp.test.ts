import "../turn/env";
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { approvals, leases, mcpConnections } from "../../src/db/schema";
import { decrypt } from "../../src/crypto";
import { createConnection, deleteConnection, handleOAuthCallback, listConnections } from "../../src/mcp/connections";
import { DbOAuthProvider, readAuth, writeAuth } from "../../src/mcp/oauth";
import { buildMcpTools, type McpToolCtx } from "../../src/mcp/tools";
import { decideLease } from "../../src/turn/lease";
import { fakeMcp, fakeSlack, seedTurn, seedUsers, type ToolCall } from "../turn/helpers";
import { users } from "../../src/db/schema";

let calls: ToolCall[];
let slack: ReturnType<typeof fakeSlack>;
const ctx = (over: Partial<McpToolCtx> = {}): McpToolCtx => ({ turnId: "turn1", userId: "UASK", channelId: "C1", threadTs: "1.1", readOnly: false, orgConnectionsOnly: false, ...over });
const run = async (tools: any, name: string, input: any = {}) => tools[name].execute(input, { toolCallId: "x", messages: [] });

beforeEach(async () => {
  await resetDb();
  await seedUsers();
  await seedTurn();
  slack = fakeSlack();
  calls = fakeMcp();
});

describe("connections", () => {
  test("tokens are stored encrypted and never listed", async () => {
    const c = await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "super-secret-token" });
    const [raw] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, c.id));
    expect(raw!.authEnc).toBeTruthy();
    expect(raw!.authEnc).not.toContain("super-secret-token");
    expect(JSON.parse(decrypt(raw!.authEnc!)).accessToken).toBe("super-secret-token");
    expect(JSON.stringify(await listConnections("UASK", "member"))).not.toContain("authEnc");
    expect(c.status).toBe("connected");
  });

  test("validation: personal-only never org, custom URLs must be public, user scope needs owner", async () => {
    await expect(createConnection({ provider: "gmail-personal-only", scope: "org" })).rejects.toThrow();
    await expect(createConnection({ url: "http://169.254.169.254/mcp", scope: "org" })).rejects.toThrow();
    await expect(createConnection({ url: "http://localhost:9/mcp", scope: "org" })).rejects.toThrow();
    await expect(createConnection({ provider: "github", scope: "user" })).rejects.toThrow();
    await expect(createConnection({ provider: "nope", scope: "org" })).rejects.toThrow();
  });

  test("visibility and deletion rights", async () => {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, "UOTH"));
    const mine = await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "a" });
    const theirs = await createConnection({ provider: "linear", scope: "user", ownerUserId: "UOWN", token: "b" });
    const org = await createConnection({ provider: "notion", scope: "org", token: "c" });
    expect((await listConnections("UASK", "member")).map((c) => c.id).sort()).toEqual([mine.id, org.id].sort());
    expect(await listConnections("UOTH", "admin")).toHaveLength(3);
    await expect(deleteConnection(theirs.id, "UASK")).rejects.toThrow();
    await expect(deleteConnection(org.id, "UASK")).rejects.toThrow();
    expect(await deleteConnection(mine.id, "UASK")).toBe(true);
    expect(await deleteConnection(org.id, "UOTH")).toBe(true);
  });

  test("oauth provider round-trips tokens encrypted, keeps refresh token across refreshes, rejects forged state", async () => {
    const c = await createConnection({ provider: "linear", scope: "user", ownerUserId: "UASK" });
    expect(c.status).toBe("pending");
    const p = new DbOAuthProvider(c.id, true);
    await p.saveTokens({ access_token: "a1", refresh_token: "r1", token_type: "Bearer", expires_in: 3600 });
    await p.saveTokens({ access_token: "a2", token_type: "Bearer", expires_in: 3600 });
    const t = await p.tokens();
    expect(t).toMatchObject({ access_token: "a2", refresh_token: "r1" });
    const [raw] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, c.id));
    expect(raw!.authEnc).not.toContain("a2");
    expect(raw!.status).toBe("connected");
    const state = await p.state();
    expect((await readAuth(c.id)).state).toBe(state);
    await expect(handleOAuthCallback("code", `${c.id}.forged`)).rejects.toThrow(/state/);
    await expect(handleOAuthCallback("code", "nonexistent.x")).rejects.toThrow(/state/);
    expect(() => new DbOAuthProvider(c.id, false).redirectToAuthorization(new URL("https://x.test"))).toThrow(/reconnected/);
  });
});

describe("tool exposure", () => {
  test("readOnly turns never get write tools (and writes are never even constructed)", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    await createConnection({ provider: "linear", scope: "org", token: "t" });
    const { tools } = await buildMcpTools(ctx({ readOnly: true }));
    expect(Object.keys(tools).sort()).toEqual(["github__list_issues", "linear__list_issues"]);
  });

  test("writes only from the asker's own connection: org-only providers expose reads only", async () => {
    await createConnection({ provider: "linear", scope: "org", token: "t" });
    expect(Object.keys((await buildMcpTools(ctx())).tools)).toEqual(["linear__list_issues"]);
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    expect(Object.keys((await buildMcpTools(ctx())).tools).sort()).toEqual(["github__create_issue", "github__list_issues", "linear__list_issues"]);
  });

  test("orgConnectionsOnly ignores the asker's personal connections entirely", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    await createConnection({ provider: "linear", scope: "org", token: "t" });
    expect(Object.keys((await buildMcpTools(ctx({ orgConnectionsOnly: true }))).tools)).toEqual(["linear__list_issues"]);
  });

  test("a teammate's connection is invisible; unauthenticated automation sees org only", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "t" });
    expect((await buildMcpTools(ctx())).tools).toEqual({});
    const org = await createConnection({ provider: "linear", scope: "org", token: "t" });
    expect(Object.keys((await buildMcpTools(ctx({ userId: null }))).tools)).toEqual(["linear__list_issues"]);
    expect(org.id).toBeTruthy();
  });

  test("reads prefer the asker's own connection over the org's", async () => {
    await createConnection({ provider: "github", scope: "org", token: "t" });
    const own = await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx());
    expect(await run(tools, "github__list_issues")).toBe("ok:list_issues");
    expect(calls).toEqual([{ connectionId: own.id, name: "list_issues", args: {} }]);
  });

  test("pending/errored connections are not exposed", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK" });
    expect((await buildMcpTools(ctx())).tools).toEqual({});
  });

  test("a write tool call only posts an approval; nothing runs until approved", async () => {
    const own = await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx());
    const out = await run(tools, "github__create_issue", { title: "x" });
    expect(out.status).toBe("awaiting_approval");
    expect(calls).toHaveLength(0);
    const [a] = await db.select().from(approvals);
    expect(a).toMatchObject({ status: "pending", requesterId: "UASK", toolName: "github__create_issue" });
    expect((a!.args as any).connectionId).toBe(own.id);
    expect(slack.of("postMessage")).toHaveLength(1);
  });

  test("leased read: usable once through the owner's connection, then refused", async () => {
    const ownerConn = await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "t" });
    const lease = { id: "lease1", connectionId: ownerConn.id, ownerUserId: "UOWN", requesterId: "UASK", turnId: "turn1", status: "pending" as const, expiresAt: new Date(Date.now() + 60_000) };
    await db.insert(leases).values(lease);
    expect((await buildMcpTools(ctx())).tools).toEqual({}); // not granted yet
    await decideLease("lease1", "UOWN", true);
    const { tools } = await buildMcpTools(ctx());
    expect(Object.keys(tools)).toEqual(["github__list_issues"]); // reads only, never writes
    expect(await run(tools, "github__list_issues")).toBe("ok:list_issues");
    expect(calls[0]!.connectionId).toBe(ownerConn.id);
    expect(String(await run(tools, "github__list_issues"))).toContain("already been used");
    expect(calls).toHaveLength(1);
  });

  test("leases are not honored on readOnly turns", async () => {
    const ownerConn = await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "t" });
    await db.insert(leases).values({ id: "l2", connectionId: ownerConn.id, ownerUserId: "UOWN", requesterId: "UASK", turnId: "turn1", status: "granted", expiresAt: new Date(Date.now() + 60_000) });
    expect((await buildMcpTools(ctx({ readOnly: true }))).tools).toEqual({});
  });

  test("an unreachable server degrades to a note instead of failing the turn", async () => {
    const { setMcpFactory } = await import("../../src/mcp/client");
    setMcpFactory(async () => { throw new Error("down"); });
    await createConnection({ provider: "github", scope: "org", token: "t" });
    const r = await buildMcpTools(ctx());
    expect(r.tools).toEqual({});
    expect(r.notes[0]).toContain("GitHub");
  });
});
