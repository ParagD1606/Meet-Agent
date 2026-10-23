import "../turn/env";
import { beforeEach, describe, expect, test } from "bun:test";
import { resetDb } from "../db";
import { createConnection } from "../../src/mcp/connections";
import { setMcpFactory, type McpToolInfo } from "../../src/mcp/client";
import { McpReauthRequired } from "../../src/mcp/oauth";
import { buildMcpTools, type McpToolCtx } from "../../src/mcp/tools";
import { classifyError, isTransientError, toolError } from "../../src/mcp/errors";
import { createSerialOperationQueue, runForConnection } from "../../src/mcp/operation-queue";
import { withResetRetry } from "../../src/mcp/reset-retry";
import { requesterLacksPersonalAppAccess, teammateAccessTools } from "../../src/mcp/access-intent";
import { classifyTool } from "../../src/mcp/policy";
import { seedTurn, seedUsers, fakeSlack } from "../turn/helpers";

const ctx: McpToolCtx = { turnId: "turn1", userId: "UASK", channelId: "C1", threadTs: "1.1", readOnly: false, orgConnectionsOnly: false };
const run = async (tools: any, name: string, input: any = {}) => tools[name].execute(input, { toolCallId: "x", messages: [] });
const TOOLS: McpToolInfo[] = [{ name: "list_things", description: "List things", inputSchema: { type: "object", properties: {} } }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("operation queue", () => {
  test("serializes operations in order, even when one fails", async () => {
    const q = createSerialOperationQueue();
    const log: string[] = [];
    const op = (n: string, ms: number, fail = false) => q.run(async () => { log.push(`start ${n}`); await sleep(ms); log.push(`end ${n}`); if (fail) throw new Error(n); return n; });
    const results = await Promise.allSettled([op("a", 20), op("b", 5, true), op("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  test("per-connection queues are independent", async () => {
    let active = 0, peak = 0;
    const op = () => async () => { peak = Math.max(peak, ++active); await sleep(15); active--; };
    await Promise.all([runForConnection("c1", op()), runForConnection("c2", op())]);
    expect(peak).toBe(2);
  });

  test("concurrent MCP reads on one connection never overlap", async () => {
    await resetDb(); await seedUsers(); await seedTurn(); fakeSlack();
    let active = 0, peak = 0;
    setMcpFactory(async () => ({
      listTools: async () => TOOLS,
      callTool: async () => { peak = Math.max(peak, ++active); await sleep(15); active--; return { content: [{ type: "text", text: "ok" }] }; },
      close: async () => {},
    }));
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx);
    await Promise.all([run(tools, "github__list_things"), run(tools, "github__list_things"), run(tools, "github__list_things")]);
    expect(peak).toBe(1);
  });
});

describe("reset retry", () => {
  test("retries once on a transient error, not on others, never twice", async () => {
    let n = 0;
    expect(await withResetRetry(async () => { if (++n === 1) throw new Error("read ECONNRESET"); return "ok"; }, isTransientError)).toBe("ok");
    expect(n).toBe(2);
    n = 0;
    await expect(withResetRetry(async () => { n++; throw new Error("400 bad request"); }, isTransientError)).rejects.toThrow("400");
    expect(n).toBe(1);
    n = 0;
    await expect(withResetRetry(async () => { n++; throw new Error("socket hang up"); }, isTransientError)).rejects.toThrow();
    expect(n).toBe(2);
  });

  test("through the tool: a dropped connection is retried once transparently; a persistent one is a structured error", async () => {
    await resetDb(); await seedUsers(); await seedTurn(); fakeSlack();
    let n = 0, mode: "flaky" | "down" = "flaky";
    setMcpFactory(async () => ({
      listTools: async () => TOOLS,
      callTool: async () => { n++; if (mode === "down" || n === 1) throw new Error("fetch failed: ECONNRESET"); return { content: [{ type: "text", text: "fine" }] }; },
      close: async () => {},
    }));
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx);
    expect(await run(tools, "github__list_things")).toBe("fine");
    expect(n).toBe(2);
    mode = "down"; n = 0;
    const err = await run(tools, "github__list_things");
    expect(err).toMatchObject({ status: "error", kind: "transient", retryable: true });
    expect(n).toBe(2);
  });
});

describe("error taxonomy", () => {
  test("classifies auth, rate limit, timeout, 5xx, not found, invalid", () => {
    expect(classifyError(new McpReauthRequired("c1"))).toBe("reauth");
    expect(classifyError(new Error("HTTP 401 Unauthorized"))).toBe("reauth");
    expect(classifyError(new Error("429 Too Many Requests"))).toBe("rate_limited");
    expect(classifyError(new Error("Request timed out"))).toBe("timeout");
    expect(classifyError(new Error("HTTP 500 Internal Server Error"))).toBe("server_error");
    expect(classifyError(new Error("404 not found"))).toBe("not_found");
    expect(classifyError(new Error("invalid argument: title is required"))).toBe("invalid_input");
    expect(classifyError(new Error("something odd"))).toBe("tool_error");
    expect(toolError("t", "ERROR: 429 slow down").kind).toBe("rate_limited");
    expect(toolError("t", new McpReauthRequired("c")).retryable).toBe(false);
  });

  test("surfaced from a tool: reauth and server tool errors are structured, not thrown", async () => {
    await resetDb(); await seedUsers(); await seedTurn(); fakeSlack();
    let mode = "reauth";
    setMcpFactory(async (conn) => ({
      listTools: async () => TOOLS,
      callTool: async () => { if (mode === "reauth") throw new McpReauthRequired(conn.id); return { isError: true, content: [{ type: "text", text: "429 rate limit exceeded" }] }; },
      close: async () => {},
    }));
    await createConnection({ provider: "github", scope: "user", ownerUserId: "UASK", token: "t" });
    const { tools } = await buildMcpTools(ctx);
    expect(await run(tools, "github__list_things")).toMatchObject({ status: "error", kind: "reauth", retryable: false });
    mode = "tool";
    expect(await run(tools, "github__list_things")).toMatchObject({ status: "error", kind: "rate_limited" });
  });
});

describe("access intent + policy", () => {
  test("only an explicit lack of access counts; 'not connected' does not", () => {
    for (const yes of ["I don't have access to Linear", "I have no permissions there", "I can't log in to Notion", "access denied", "I'm not authorized"]) expect(requesterLacksPersonalAppAccess(yes)).toBe(true);
    for (const no of ["I don't have it connected", "can you check linear?", "", undefined, "connect my github"]) expect(requesterLacksPersonalAppAccess(no)).toBe(false);
  });

  test("request_teammate_access is offered only on lack-of-access, never read-only/org-only/anonymous", () => {
    const base = { turnId: "t", userId: "U1", readOnly: false, orgConnectionsOnly: false };
    expect(Object.keys(teammateAccessTools(base, "I don't have access to Linear"))).toEqual(["request_teammate_access"]);
    expect(teammateAccessTools(base, "what's in linear?")).toEqual({});
    expect(teammateAccessTools({ ...base, readOnly: true }, "I don't have access")).toEqual({});
    expect(teammateAccessTools({ ...base, orgConnectionsOnly: true }, "I don't have access")).toEqual({});
    expect(teammateAccessTools({ ...base, userId: null }, "I don't have access")).toEqual({});
  });

  test("policy stays fail-closed", () => {
    expect(classifyTool("frobnicate", "reads things", { readOnlyHint: true })).toBe("write"); // untrusted annotation
    expect(classifyTool("frobnicate", "x", { readOnlyHint: true }, { trustAnnotations: true })).toBe("read");
    expect(classifyTool("listIssues", undefined)).toBe("read");
    expect(classifyTool("list_and_delete", undefined)).toBe("write");
    expect(classifyTool("get_x", "safe", { destructiveHint: true }, { trustAnnotations: true })).toBe("write");
    expect(classifyTool("zork", "list things safely")).toBe("write");
  });
});
