import "../turn/env";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { resetDb } from "../db";
import { db } from "../../src/db";
import { approvals, mcpConnections } from "../../src/db/schema";
import { createConnection, makeWorkspaceWide, setAllowWrites } from "../../src/mcp/connections";
import { verifyConnection } from "../../src/mcp/health";
import { invalidateApprovalCards, setApprovalCards } from "../../src/mcp/policy";
import { retryPolicy } from "../../src/mcp/reset-retry";
import { buildMcpTools, type McpToolCtx } from "../../src/mcp/tools";
import { setOrgWrites } from "../../src/mcp/writes";
import { handleBlockAction, settled } from "../../src/turn/approval";
import { setFollowUp, type FollowUpInput } from "../../src/turn/followup";
import { fakeSlack, seedTurn, seedUsers } from "../turn/helpers";
import { startFakeMcp } from "./fake-server";

retryPolicy.backoffMs = 0;
const ctx = (over: Partial<McpToolCtx> = {}): McpToolCtx => ({ turnId: "turn1", userId: "UASK", channelId: "C1", threadTs: "1.1", readOnly: false, orgConnectionsOnly: false, ...over });
const run = async (tools: any, name: string, input: any = {}) => tools[name].execute(input, { toolCallId: "x", messages: [] });
const click = (action: "approval_approve" | "approval_deny", id: string) => handleBlockAction({ user: { id: "UASK" }, actions: [{ action_id: action, value: id }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fake: Awaited<ReturnType<typeof startFakeMcp>>;
let slack: ReturnType<typeof fakeSlack>;
let followUps: FollowUpInput[];
let orgId: string;

beforeEach(async () => {
  await resetDb();
  invalidateApprovalCards();
  await seedUsers();
  await seedTurn();
  slack = fakeSlack();
  followUps = [];
  setFollowUp(async (i) => { followUps.push(i); });
  fake = await startFakeMcp();
  orgId = (await createConnection({ provider: "notion", scope: "org", token: "good" })).id;
});
afterEach(() => fake.stop());

const create = (tools: any, title = "demo") => run(tools, "call_tool", { name: "notion__notion-create-pages", args: JSON.stringify({ pages: [{ title }] }) });

describe("workspace (org) Notion connection over real MCP", () => {
  test("search_tools returns the write tool WITH its schema and marker; one call_tool creates the page via the org connection", async () => {
    const { tools } = await buildMcpTools(ctx());
    expect(Object.keys(tools)).toContain("call_tool"); // 16 tools: lazy
    const found = String(await run(tools, "search_tools", { query: "create a new page note" }));
    expect(found).toContain("notion__notion-create-pages");
    expect(found).toContain("[WRITE: runs immediately]"); // doc_edit class, clean turn, no admin card setting
    expect(found).toContain('"pages"'); // schema inline: no second round trip
    expect(String(await run(tools, "search_tools", { query: "calendar events" }))).toContain('"title":{'); // a property NAMED title must survive schema minification
    const out = await create(tools);
    expect(out).toContain("created 1 page");
    expect(fake.calls.map((c) => c.tool)).toEqual(["notion-create-pages"]);
    expect(fake.calls[0]!.auth).toBe("Bearer good");
  });

  test("after external data entered the turn the same write is carded; Approve runs it with the org connection, Deny runs nothing", async () => {
    const { tools } = await buildMcpTools(ctx());
    await run(tools, "call_tool", { name: "notion__notion-search", args: JSON.stringify({ query: "roadmap" }) }); // read => untrusted context
    const card = await create(tools, "from-roadmap");
    expect(card.status).toBe("awaiting_approval");
    expect(fake.calls.filter((c) => c.tool === "notion-create-pages")).toHaveLength(0);
    expect(slack.of("postMessage")).toHaveLength(1);
    const [a] = await db.select().from(approvals);
    expect((a!.args as any).connectionId).toBe(orgId);
    await click("approval_approve", a!.id);
    await settled();
    expect(fake.calls.filter((c) => c.tool === "notion-create-pages")).toHaveLength(1);
    expect(followUps[0]!.text).toContain("created 1 page");

    const card2 = await create(tools, "denied");
    await click("approval_deny", card2.approvalId);
    await settled();
    expect(fake.calls.filter((c) => c.tool === "notion-create-pages")).toHaveLength(1);
  });

  test("destructive-hinted tools (create-view, calendar events, delete) always need a card, even on a clean turn", async () => {
    const { tools } = await buildMcpTools(ctx());
    const found = String(await run(tools, "search_tools", { query: "calendar create events view delete comment" }));
    expect(found).toContain("[WRITE: needs approval]");
    for (const [name, args] of [["notion__notion-calendar-create-events", { title: "x", start: "2026-01-01" }], ["notion__notion-create-view", { database_id: "d" }], ["notion__notion-delete-comment", { comment_id: "c" }]] as const) {
      expect((await run(tools, "call_tool", { name, args: JSON.stringify(args) })).status).toBe("awaiting_approval");
    }
    expect(fake.calls).toHaveLength(0);
  });

  test("admin switches: workspace writes off hides writes; a per-connection override wins either way", async () => {
    await setOrgWrites(false);
    let { tools } = await buildMcpTools(ctx());
    expect(String(await run(tools, "search_tools", { query: "create page" }))).not.toContain("create-pages");
    expect((await create(tools)).kind).toBe("not_found");
    await setAllowWrites(orgId, true);
    ({ tools } = await buildMcpTools(ctx()));
    expect(await create(tools)).toContain("created");
    await setOrgWrites(true);
    await setAllowWrites(orgId, false);
    ({ tools } = await buildMcpTools(ctx()));
    expect((await create(tools)).kind).toBe("not_found");
  });

  test("an approval granted before writes were turned off is refused at execution time", async () => {
    const { tools } = await buildMcpTools(ctx());
    const card = await run(tools, "call_tool", { name: "notion__notion-create-view", args: JSON.stringify({ database_id: "d" }) });
    await setOrgWrites(false);
    await click("approval_approve", card.approvalId);
    await settled();
    expect(fake.calls).toHaveLength(0);
    expect(followUps[0]!.text).toContain("no longer available");
  });

  test("read-only and unattended (org-only) turns never get write tools", async () => {
    for (const c of [ctx({ readOnly: true }), ctx({ orgConnectionsOnly: true })]) {
      const { tools } = await buildMcpTools(c);
      const found = String(await run(tools, "search_tools", { query: "create update page" }));
      expect(found).not.toContain("create-pages");
      expect(found).not.toContain("update-page");
      expect((await create(tools)).kind).toBe("not_found");
    }
  });

  test("the asker's own personal connection is preferred for writes", async () => {
    const own = await createConnection({ provider: "notion", scope: "user", ownerUserId: "UASK", token: "good" });
    const { tools } = await buildMcpTools(ctx());
    await run(tools, "call_tool", { name: "notion__notion-search", args: JSON.stringify({ query: "a" }) });
    const card = await create(tools);
    expect((await db.select().from(approvals).where(eq(approvals.id, card.approvalId)))[0]!.args).toMatchObject({ connectionId: own.id });
  });

  test("errors: the app's rejection is named, structured, and carries the input schema; search_tools is capped", async () => {
    const { tools } = await buildMcpTools(ctx());
    fake.state.boom = true;
    const err = await create(tools);
    expect(err).toMatchObject({ status: "error", kind: "invalid_input" });
    expect(err.message).toContain("Notion rejected notion-create-pages: validation_error: parent.page_id is required");
    expect(err.message).toContain("Input schema:");
    const missing = await run(tools, "call_tool", { name: "notion__notion-create-pages", args: "{}" });
    expect(missing.message).toContain('"pages"'); // wrong args => the schema, not just a name
    for (let i = 0; i < 3; i++) await run(tools, "search_tools", { query: `page ${i}` });
    expect(String(await run(tools, "search_tools", { query: "page again" }))).toContain("Search limit reached");
  });

  test("connection notes tell the model what it can use and in which mode", async () => {
    const { notes } = await buildMcpTools(ctx());
    expect(notes.join(" ")).toContain("Notion (workspace, read+write)");
    await setOrgWrites(false);
    expect((await buildMcpTools(ctx())).notes.join(" ")).toContain("Notion (workspace, read-only: an admin has not allowed writes)");
  });
});

describe("personal connections of other people", () => {
  test("GitHub connected personally by a teammate: not usable, but the model is told who has it and can ask them", async () => {
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "t" });
    const { tools, notes } = await buildMcpTools(ctx());
    expect(String(await run(tools, "search_tools", { query: "create page" }))).not.toContain("github__"); // nothing callable through the teammate's account
    expect(Object.keys(tools)).toContain("request_teammate_access");
    const text = notes.join(" ");
    expect(text).toContain("GitHub (by Owner)");
    expect(text).toContain("request_teammate_access");
    expect(text).toContain("workspace-wide");
    expect(text).not.toContain("t\"");
    // org-only (unattended) turns must not leak other people's personal apps
    expect((await buildMcpTools(ctx({ orgConnectionsOnly: true }))).notes.join(" ")).not.toContain("GitHub");
  });

  test("an admin making it workspace-wide exposes it to everyone", async () => {
    const gh = await createConnection({ provider: "github", scope: "user", ownerUserId: "UOWN", token: "good" });
    await makeWorkspaceWide(gh.id);
    const { tools } = await buildMcpTools(ctx());
    expect(String(await run(tools, "search_tools", { query: "create page" }))).toContain("notion__notion-create-pages"); // ranking ties; the point is the call below
    expect(await run(tools, "call_tool", { name: "github__notion-search", args: JSON.stringify({ query: "x" }) })).toContain("results for x");
  });
});

describe("reauth and health", () => {
  test("a 401 marks the connection needs_reauth, returns a structured reauth error, DMs admins once; recovery clears it", async () => {
    await seedAdmin();
    fake.state.mode = "reauth";
    const { tools } = await buildMcpTools(ctx());
    expect(Object.keys(tools)).not.toContain("call_tool"); // listing failed => note instead
    const v1 = await verifyConnection((await db.select().from(mcpConnections))[0]!);
    expect(v1).toMatchObject({ ok: false, needsReauth: true });
    await verifyConnection((await db.select().from(mcpConnections))[0]!);
    for (let i = 0; i < 40 && !slack.of("postMessage").length; i++) await sleep(50); // the runtime-path notice is fire-and-forget
    const [row] = await db.select().from(mcpConnections);
    expect(row).toMatchObject({ status: "needs_reauth", reauthNotified: true });
    expect(row!.lastError).toContain("Reconnect");
    expect(slack.of("postMessage").filter((c) => String(c.args.text).includes("needs to be reconnected"))).toHaveLength(1); // one-time
    expect((await buildMcpTools(ctx())).notes.join(" ")).toContain("Notion (workspace) needs reconnecting");

    fake.state.mode = "ok";
    const ok = await verifyConnection(row!);
    expect(ok).toMatchObject({ ok: true, toolCount: 16 });
    expect(await db.select().from(mcpConnections)).toMatchObject([{ status: "connected", reauthNotified: false, lastError: null }]);
  });

  test("verification caches tool metadata (read/write split) and latency; transient outages keep the connection and record the error", async () => {
    const r = await verifyConnection((await db.select().from(mcpConnections))[0]!);
    expect(r).toMatchObject({ ok: true, toolCount: 16, writeCount: 5, readCount: 11 });
    const [row] = await db.select().from(mcpConnections);
    expect(row!.toolMeta!.find((t) => t.name === "notion-create-pages")).toMatchObject({ kind: "write", cls: "doc_edit" });
    expect(row!.toolMeta!.find((t) => t.name === "notion-calendar-create-events")).toMatchObject({ kind: "write", cls: "other" });
    expect(row!.lastVerifiedAt).toBeTruthy();
    fake.state.mode = "down";
    const bad = await verifyConnection(row!);
    expect(bad.ok).toBe(false);
    expect(bad.needsReauth).toBe(false);
    const [after] = await db.select().from(mcpConnections);
    expect(after!.status).toBe("connected");
    expect(after!.lastError).toContain("Notion did not respond");
    expect(after!.toolMeta).toHaveLength(16); // last good catalogue survives
  });
});

describe("oauth robustness", () => {
  test("a rejected refresh drops the dead tokens (keeps the registered client); 401-ish errors are reauth, 403 is not", async () => {
    const { DbOAuthProvider, readAuth } = await import("../../src/mcp/oauth");
    const { isReauthError } = await import("../../src/mcp/errors");
    const c = await createConnection({ provider: "linear", scope: "user", ownerUserId: "UASK" });
    const p = new DbOAuthProvider(c.id, false);
    await p.saveClientInformation({ client_id: "cid" } as any);
    await p.saveTokens({ access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 60 });
    await p.invalidateCredentials("tokens");
    expect(await readAuth(c.id)).toMatchObject({ clientInfo: { client_id: "cid" } });
    expect((await readAuth(c.id)).accessToken).toBeUndefined();
    expect(await p.tokens()).toBeUndefined();
    expect(isReauthError(new Error("HTTP 401 Unauthorized"))).toBe(true);
    expect(isReauthError(new Error("invalid_grant: refresh token revoked"))).toBe(true);
    expect(isReauthError(new Error("403 forbidden: no access to this page"))).toBe(false);
  });
});

async function seedAdmin() {
  const { users } = await import("../../src/db/schema");
  await db.update(users).set({ role: "admin" }).where(eq(users.id, "UOTH"));
}

void setApprovalCards;
