import "./env";
import type { WebClient } from "@slack/web-api";
import { db } from "../../src/db";
import { turns, users } from "../../src/db/schema";
import { setSlackClient } from "../../src/turn/slack";

export type Call = { method: string; args: any };
/** Fake Slack: records every call; ts values are deterministic. */
export function fakeSlack() {
  const calls: Call[] = [];
  let n = 0;
  const rec = (method: string, extra?: (a: any) => any) => async (args: any) => {
    calls.push({ method, args });
    return { ok: true, ts: `100.${++n}`, ...(extra?.(args) ?? {}) };
  };
  const client = {
    chat: { postMessage: rec("postMessage"), update: rec("update"), postEphemeral: rec("postEphemeral") },
    conversations: { open: rec("open", (a) => ({ channel: { id: `D_${a.users}` } })), replies: rec("replies", () => ({ messages: [] })), history: rec("history", () => ({ messages: [] })) },
  } as unknown as WebClient;
  setSlackClient(async () => client);
  return { calls, of: (m: string) => calls.filter((c) => c.method === m) };
}

export async function seedUsers() {
  await db.insert(users).values([
    { id: "UASK", name: "Asker" }, { id: "UOWN", name: "Owner" }, { id: "UOTH", name: "Other" },
  ]);
}
export async function seedTurn(id = "turn1", status: "running" | "waiting_approval" = "running") {
  await db.insert(turns).values({ id, channelId: "C1", threadTs: "1.1", userId: "UASK", trigger: "mention", status });
}

import { setMcpFactory, type McpToolInfo } from "../../src/mcp/client";
export type ToolCall = { connectionId: string; name: string; args: Record<string, unknown> };
/** Fake MCP network: same tool list for every connection; records every call with the connection that made it. */
export function fakeMcp(tools: McpToolInfo[] = [
  { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: {} } },
  { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
]) {
  const calls: ToolCall[] = [];
  setMcpFactory(async (conn) => ({
    listTools: async () => tools,
    callTool: async (name, args) => { calls.push({ connectionId: conn.id, name, args }); return { content: [{ type: "text", text: `ok:${name}` }] }; },
    close: async () => {},
  }));
  return calls;
}
