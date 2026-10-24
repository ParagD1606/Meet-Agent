// QA H2: injected content must not turn a card-free write class into a silent action.
import "../turn/env";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetDb } from "../db";
import { createConnection } from "../../src/mcp/connections";
import { buildMcpTools, type McpToolCtx } from "../../src/mcp/tools";
import { actionClass, invalidateApprovalCards, needsApproval } from "../../src/mcp/policy";
import { fakeMcp, fakeSlack, seedTurn, seedUsers, type ToolCall } from "../turn/helpers";

const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } });
let calls: ToolCall[];
const ctx = (over: Partial<McpToolCtx> = {}): McpToolCtx => ({ turnId: "turn1", userId: "UASK", channelId: "C1", threadTs: "1.1", readOnly: false, orgConnectionsOnly: false, ...over });
const run = async (tools: any, name: string, input: any = {}) => tools[name].execute(input, { toolCallId: "x", messages: [] });

beforeEach(async () => {
  await resetDb();
  invalidateApprovalCards();
  await seedUsers();
  await seedTurn();
  fakeSlack();
});

describe("actionClass is fail-closed", () => {
  test.each(["share_document", "invite_collaborator", "grant_permission", "fork_repository", "publish_page", "create_or_update_file"])("%s is always carded", (n) =>
    expect(actionClass(n, "github")).toBe("other"));
  test("an unrecognised tool never inherits its app's class", () => {
    expect(actionClass("frobnicate", "linear")).toBe("other");
    expect(actionClass("frobnicate", "notion")).toBe("other");
  });
  test("untrusted turn: even a card-free class gets a card", () => {
    expect(needsApproval("ticket", {}, false)).toBe(false);
    expect(needsApproval("ticket", {}, true)).toBe(true);
  });
});

describe("mcp writes", () => {
  test("after a read (external text in the turn) a ticket write is carded; a clean turn is not", async () => {
    calls = fakeMcp([tool("list_issues"), tool("create_issue")]);
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const c = ctx();
    const { tools } = await buildMcpTools(c);
    await run(tools, "github__list_issues");
    expect((await run(tools, "github__create_issue", {})).status).toBe("awaiting_approval");
    const clean = await buildMcpTools(ctx());
    expect(await run(clean.tools, "github__create_issue", {})).toBe("ok:create_issue");
  });
  test("a flagged turn is carded even when an admin left the class card-free", async () => {
    calls = fakeMcp([tool("create_issue")]);
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx({ untrustedContext: true }));
    expect((await run(tools, "github__create_issue", {})).status).toBe("awaiting_approval");
    expect(calls).toHaveLength(0);
  });
});
