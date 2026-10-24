import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { and, asc, eq, or } from "drizzle-orm";
import { sha256 } from "../crypto";
import { db } from "../db";
import { mcpConnections } from "../db/schema";
import { log } from "../log";
import { requestApproval } from "../turn/approval";
import { consumeLease, grantedLeases } from "../turn/lease";
import { getPreset } from "./catalog";
import { callConnectionTool, listConnectionTools, type ConnectionRow, type McpToolInfo } from "./client";
import { isTransientError, toolError } from "./errors";
import { appPrefix, groupKey } from "./group";
import { connectionNotes } from "./visibility";
import { connWritable, getOrgWrites } from "./writes";
import { teammateAccessTools } from "./access-intent";
import { capResult, minifyResult } from "./minify";
import { runForConnection } from "./operation-queue";
import { actionClass, ALL_CARDED, classifyTool, getApprovalCards, needsApproval } from "./policy";
import { retryPolicy, withResetRetry } from "./reset-retry";
import { lazyToolSet, minSchema, shortDesc, type LazyEntry } from "./tool-search";

export type McpToolCtx = {
  turnId: string;
  userId: string | null;
  channelId: string;
  threadTs?: string;
  readOnly: boolean;
  orgConnectionsOnly: boolean;
  /** Mutated during the turn: once external text entered it, every write is carded. */
  untrustedContext?: boolean;
  /** Apps with more tools than this are reached through search_tools/call_tool. Default 12. */
  lazyThreshold?: number;
};

export const LAZY_TOOL_THRESHOLD = 12;
const MAX_NAME = 64;


/** `<app>__<tool>`; on overflow or collision, truncated + a short hash of (connection id, tool) so keys stay unique. */
export function toolKey(c: Pick<ConnectionRow, "id" | "provider" | "url">, tool: string, used: Set<string>): string {
  const base = `${appPrefix(c as ConnectionRow)}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  let key = base;
  if (key.length > MAX_NAME || used.has(key)) key = `${base.slice(0, MAX_NAME - 7)}_${sha256(`${c.id}\0${tool}`).slice(0, 6)}`;
  used.add(key);
  return key;
}

export { minSchema };
const schemaOf = (t: McpToolInfo) => jsonSchema(minSchema(t.inputSchema?.type ? t.inputSchema : { type: "object", properties: {} }) as any);

type Slot = { own?: ConnectionRow; org?: ConnectionRow; leased?: { conn: ConnectionRow; leaseId: string } };

/**
 * Builds the model-facing MCP tools for one turn.
 *  - reads: user's own connection first, else the org's, else a one-use lease on a teammate's
 *  - writes: the asker's own connection, else the workspace connection when writes are allowed (setting mcp_org_writes, per-connection allowWrites);
 *    never on readOnly / orgConnectionsOnly turns, never through a lease; approval cards follow the action-class policy
 *  - apps with > lazyThreshold tools are not listed; `search_tools` + `call_tool` reach them (catalog cached with the client's TTL cache)
 * Write tools are not constructed at all when the turn is read-only.
 */
export async function buildMcpTools(ctx: McpToolCtx): Promise<{ tools: ToolSet; notes: string[] }> {
  const tools: ToolSet = {};
  const notes: string[] = [];
  const uid = ctx.orgConnectionsOnly ? null : ctx.userId;
  const threshold = ctx.lazyThreshold ?? LAZY_TOOL_THRESHOLD;

  const rows = await db.select().from(mcpConnections).where(and(
    eq(mcpConnections.status, "connected"),
    uid ? or(eq(mcpConnections.scope, "org"), and(eq(mcpConnections.scope, "user"), eq(mcpConnections.ownerUserId, uid))) : eq(mcpConnections.scope, "org"),
  )).orderBy(asc(mcpConnections.id));
  const groups = new Map<string, Slot>();
  for (const c of rows) {
    const slot = groups.get(groupKey(c)) ?? {};
    if (c.scope === "user") slot.own = c; else slot.org = c;
    groups.set(groupKey(c), slot);
  }

  if (ctx.userId && !ctx.orgConnectionsOnly && !ctx.readOnly) {
    for (const lease of await grantedLeases(ctx.userId)) {
      const [conn] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, lease.connectionId));
      if (!conn || conn.status !== "connected" || conn.scope !== "user" || conn.ownerUserId !== lease.ownerUserId) continue;
      const slot = groups.get(groupKey(conn)) ?? {};
      if (!slot.own && !slot.org) { slot.leased = { conn, leaseId: lease.id }; groups.set(groupKey(conn), slot); }
    }
  }

  const cards = await getApprovalCards().catch(() => ALL_CARDED);
  const orgWrites = await getOrgWrites().catch(() => false); // fail closed
  const used = new Set<string>();
  const lazy: LazyEntry[] = [];
  const lazyApps: string[] = [];

  for (const slot of groups.values()) {
    const readConn = slot.own ?? slot.org ?? slot.leased?.conn;
    if (!readConn) continue;
    const trust = getPreset(readConn.provider)?.trusted === true;
    // writes: the asker's own account when they have one, else the workspace connection if an admin allows writes through it
    const writeConn = ctx.readOnly || ctx.orgConnectionsOnly ? undefined : (slot.own ?? (slot.org && connWritable(slot.org, orgWrites) ? slot.org : undefined));
    const leased = slot.leased && readConn === slot.leased.conn ? slot.leased : undefined;
    let listed: McpToolInfo[];
    try { listed = await listConnectionTools(readConn); }
    catch (e) { notes.push(`${readConn.label}: unavailable (${e instanceof Error && e.name === "McpReauthRequired" ? "needs reconnect" : "error"})`); log.warn("mcp list failed", { connection: readConn.id, error: String(e) }); continue; }

    const isLazy = listed.length > threshold;
    let exposed = 0;
    for (const t of listed) {
      const kind = classifyTool(t.name, t.description, t.annotations, { trustAnnotations: trust });
      if (kind === "write" && !(writeConn && ctx.userId)) continue;
      const name = toolKey(readConn, t.name, used);
      const cls = actionClass(t.name, readConn.provider, t.annotations);
      const gated = kind === "write" && needsApproval(cls, cards);
      const run = kind === "read"
        ? async (input: Record<string, unknown>, fields?: string[]) => {
            if (leased && !(await consumeLease(leased.leaseId, ctx.userId!))) return "ERROR: the teammate's one-time access has already been used or has expired. Ask them again with request_teammate_access.";
            ctx.untrustedContext = true; // a connected app's data may carry injected instructions
            return runRead(readConn, t.name, name, input, ctx, fields);
          }
        : async (input: Record<string, unknown>) => {
            // No card for ticket/slack/doc/email-calendar writes unless an admin turned that class on; destructive or unclassified always gets one.
            if (!gated && !needsApproval(cls, cards, ctx.untrustedContext)) return runWrite(writeConn!, t.name, name, input, ctx);
            try {
              const { approvalId } = await requestApproval({
                turnId: ctx.turnId, requesterId: ctx.userId!, channelId: ctx.channelId, threadTs: ctx.threadTs,
                connectionId: writeConn!.id, toolName: name, mcpTool: t.name, input,
              });
              return { status: "awaiting_approval", approvalId, instruction: "An approval card was posted. Tell the user briefly that you're waiting for their approval, then stop. Do not retry." };
            } catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
          };
      exposed++;
      if (isLazy) { lazy.push({ name, info: t, kind, run, gated }); continue; }
      const desc = shortDesc(t.description ?? t.name) + (kind === "write" ? (gated ? " [WRITE: needs user approval]" : " [WRITE: runs immediately, be sure]") : leased ? " [one-time lease]" : "");
      tools[name] = dynamicTool({ description: desc, inputSchema: schemaOf(t), execute: async (input) => run((input ?? {}) as Record<string, unknown>) });
    }
    if (isLazy && exposed) lazyApps.push(`${appPrefix(readConn)}:${exposed}`);
  }

  Object.assign(tools, lazyToolSet(lazy, lazyApps));
  const info = await connectionNotes(ctx).catch(() => ({ notes: [] as string[], othersOnly: false }));
  if (info.othersOnly && !tools.request_teammate_access) Object.assign(tools, teammateAccessTools(ctx, "I don't have access"));
  return { tools, notes: [...notes, ...info.notes] };
}

/** One approved-by-policy write: serialized per connection, never retried (a retry could double-write), output capped. */
async function runWrite(conn: ConnectionRow, mcpTool: string, name: string, input: Record<string, unknown>, ctx: McpToolCtx): Promise<unknown> {
  let raw: string;
  try { raw = await runForConnection(conn.id, () => callConnectionTool(conn, mcpTool, input)); }
  catch (e) { return toolError(name, e); }
  if (raw.startsWith("ERROR: ")) return toolError(name, `${conn.label} rejected ${mcpTool}: ${raw.slice(7)}`);
  return capResult(minifyResult(raw, {}), { turnId: ctx.turnId, toolName: name });
}

/** One read: serialized per connection, retried once on a transport reset, errors structured, output minified + capped. */
async function runRead(conn: ConnectionRow, mcpTool: string, name: string, input: Record<string, unknown>, ctx: McpToolCtx, fields?: string[]): Promise<unknown> {
  let raw: string;
  try {
    raw = await runForConnection(conn.id, () =>
      withResetRetry(() => callConnectionTool(conn, mcpTool, input), isTransientError, () => log.warn("mcp transient error, retrying", { connection: conn.id, tool: mcpTool }), retryPolicy));
  } catch (e) {
    return toolError(name, e);
  }
  if (raw.startsWith("ERROR: ")) return toolError(name, `${conn.label} rejected ${mcpTool}: ${raw.slice(7)}`);
  return capResult(minifyResult(raw, { fields }), { turnId: ctx.turnId, toolName: name });
}
