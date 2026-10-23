import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { and, eq, or } from "drizzle-orm";
import { db } from "../db";
import { mcpConnections } from "../db/schema";
import { log } from "../log";
import { requestApproval } from "../turn/approval";
import { consumeLease, grantedLeases } from "../turn/lease";
import { getPreset } from "./catalog";
import { callConnectionTool, listConnectionTools, type ConnectionRow, type McpToolInfo } from "./client";
import { classifyTool } from "./policy";

export type McpToolCtx = {
  turnId: string;
  userId: string | null;
  channelId: string;
  threadTs?: string;
  readOnly: boolean;
  orgConnectionsOnly: boolean;
};

const safeName = (provider: string, tool: string) => `${provider}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
const schemaOf = (t: McpToolInfo) => jsonSchema((t.inputSchema?.type ? t.inputSchema : { type: "object", properties: {} }) as any);

/**
 * Builds the model-facing MCP tools for one turn.
 *  - reads: user's own connection first, else the org's, else a one-use lease on a teammate's
 *  - writes: ONLY the asker's own connection, never on readOnly / orgConnectionsOnly turns, and always behind an approval card
 * Write tools are not constructed at all when the turn is read-only.
 */
export async function buildMcpTools(ctx: McpToolCtx): Promise<{ tools: ToolSet; notes: string[] }> {
  const tools: ToolSet = {};
  const notes: string[] = [];
  const uid = ctx.orgConnectionsOnly ? null : ctx.userId;

  const rows = await db.select().from(mcpConnections).where(and(
    eq(mcpConnections.status, "connected"),
    uid ? or(eq(mcpConnections.scope, "org"), and(eq(mcpConnections.scope, "user"), eq(mcpConnections.ownerUserId, uid))) : eq(mcpConnections.scope, "org"),
  ));
  const byProvider = new Map<string, { own?: ConnectionRow; org?: ConnectionRow; leased?: { conn: ConnectionRow; leaseId: string } }>();
  for (const c of rows) {
    const slot = byProvider.get(c.provider) ?? {};
    if (c.scope === "user") slot.own = c; else slot.org = c;
    byProvider.set(c.provider, slot);
  }

  if (ctx.userId && !ctx.orgConnectionsOnly && !ctx.readOnly) {
    for (const lease of await grantedLeases(ctx.userId)) {
      const [conn] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, lease.connectionId));
      if (!conn || conn.status !== "connected" || conn.scope !== "user" || conn.ownerUserId !== lease.ownerUserId) continue;
      const slot = byProvider.get(conn.provider) ?? {};
      if (!slot.own && !slot.org) { slot.leased = { conn, leaseId: lease.id }; byProvider.set(conn.provider, slot); }
    }
  }

  for (const [provider, slot] of byProvider) {
    const trust = getPreset(provider)?.trusted === true;
    const readConn = slot.own ?? slot.org ?? slot.leased?.conn;
    const writeConn = ctx.readOnly || ctx.orgConnectionsOnly ? undefined : slot.own;
    if (!readConn) continue;
    let listed: McpToolInfo[];
    try { listed = await listConnectionTools(readConn); }
    catch (e) { notes.push(`${readConn.label}: unavailable (${e instanceof Error && e.name === "McpReauthRequired" ? "needs reconnect" : "error"})`); log.warn("mcp list failed", { connection: readConn.id, error: String(e) }); continue; }

    for (const t of listed) {
      const kind = classifyTool(t.name, t.description, t.annotations, { trustAnnotations: trust });
      const name = safeName(provider, t.name);
      const base = `[${readConn.label}] ${t.description ?? t.name}`;
      if (kind === "read") {
        const leased = slot.leased && readConn === slot.leased.conn ? slot.leased : undefined;
        tools[name] = dynamicTool({
          description: leased ? `${base} (one-time lease from a teammate: usable for a single call)` : base,
          inputSchema: schemaOf(t),
          execute: async (input) => {
            if (leased && !(await consumeLease(leased.leaseId, ctx.userId!))) return "ERROR: the teammate's one-time access has already been used or has expired. Ask them again with request_teammate_access.";
            try { return await callConnectionTool(readConn, t.name, (input ?? {}) as Record<string, unknown>); }
            catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
          },
        });
      } else if (writeConn && ctx.userId) {
        // the write connection may differ from the read one only if own != read (never: own always wins), but keep it explicit
        tools[name] = dynamicTool({
          description: `${base} (WRITE: posts an approval card; the action runs only if the requester approves)`,
          inputSchema: schemaOf(t),
          execute: async (input) => {
            try {
              const { approvalId } = await requestApproval({
                turnId: ctx.turnId, requesterId: ctx.userId!, channelId: ctx.channelId, threadTs: ctx.threadTs,
                connectionId: writeConn.id, toolName: name, mcpTool: t.name, input: (input ?? {}) as Record<string, unknown>,
              });
              return { status: "awaiting_approval", approvalId, instruction: "An approval card was posted. Tell the user briefly that you're waiting for their approval, then stop. Do not retry." };
            } catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
          },
        });
      }
    }
  }
  return { tools, notes };
}
