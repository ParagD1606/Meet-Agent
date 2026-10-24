import { and, eq, inArray } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { mcpConnections, users } from "../db/schema";
import { log, redactError } from "../log";
import { getSlack } from "../turn/slack";
import { getPreset } from "./catalog";
import { listConnectionTools, type ConnectionRow } from "./client";
import { classifyError, isReauthError, isTransientError } from "./errors";
import { runForConnection } from "./operation-queue";
import { actionClass, classifyTool } from "./policy";
import { retryPolicy, withResetRetry } from "./reset-retry";

export type VerifyResult = {
  ok: boolean; needsReauth: boolean; toolCount: number; readCount: number; writeCount: number; latencyMs: number; error?: string;
};

/** Lists the tools live (never from cache), caches their metadata on the row, and records health. Never throws. */
export async function verifyConnection(conn: ConnectionRow): Promise<VerifyResult> {
  const t0 = Date.now();
  try {
    const tools = await runForConnection(conn.id, () => withResetRetry(() => listConnectionTools(conn, true), isTransientError, undefined, retryPolicy));
    const trust = getPreset(conn.provider)?.trusted === true;
    const meta = tools.map((t) => ({ name: t.name, kind: classifyTool(t.name, t.description, t.annotations, { trustAnnotations: trust }), cls: actionClass(t.name, conn.provider, t.annotations) }));
    const writeCount = meta.filter((m) => m.kind === "write").length;
    await db.update(mcpConnections)
      .set({ toolMeta: meta, lastVerifiedAt: new Date(), lastError: null, status: "connected", reauthNotified: false })
      .where(eq(mcpConnections.id, conn.id));
    return { ok: true, needsReauth: false, toolCount: meta.length, readCount: meta.length - writeCount, writeCount, latencyMs: Date.now() - t0 };
  } catch (e) {
    const needsReauth = e instanceof Error && e.name === "McpReauthRequired" || isReauthError(e);
    const error = needsReauth ? "Authorization expired or was revoked. Reconnect to continue." : `${conn.label} did not respond correctly: ${String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").slice(0, 300)} (${classifyError(e)})`;
    await db.update(mcpConnections).set({ lastVerifiedAt: new Date(), lastError: error, ...(needsReauth ? { status: "needs_reauth" as const } : {}) }).where(eq(mcpConnections.id, conn.id));
    if (needsReauth) await notifyReauth(conn.id).catch((err) => log.warn("reauth notice failed", { connection: conn.id, error: redactError(err) }));
    else log.warn("mcp health check failed", { connection: conn.id, error: redactError(e) });
    return { ok: false, needsReauth, toolCount: 0, readCount: 0, writeCount: 0, latencyMs: Date.now() - t0, error };
  }
}

/** One DM to the owner (personal) or to the admins/owners (workspace connection) per outage; reset when the connection recovers. */
export async function notifyReauth(connectionId: string): Promise<number> {
  const [claimed] = await db.update(mcpConnections).set({ reauthNotified: true })
    .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.reauthNotified, false))).returning();
  if (!claimed) return 0;
  const to = claimed.scope === "user" && claimed.ownerUserId
    ? [claimed.ownerUserId]
    : (await db.select({ id: users.id }).from(users).where(and(inArray(users.role, ["owner", "admin"]), eq(users.deactivated, false)))).map((u) => u.id);
  const slack = await getSlack();
  const text = `Your ${claimed.scope === "org" ? "workspace " : ""}${claimed.label} connection needs to be reconnected, so I can't use it right now. Reconnect it here: ${config.PUBLIC_URL.replace(/\/$/, "")}/configure/integrations`;
  let sent = 0;
  for (const u of to) {
    try {
      const dm = await slack.conversations.open({ users: u });
      if (dm.channel?.id) { await slack.chat.postMessage({ channel: dm.channel.id, text }); sent++; }
    } catch (e) { log.warn("reauth DM failed", { user: u, error: redactError(e) }); }
  }
  return sent;
}

/** The hourly job: verify every connected app. Failures are recorded per row, never thrown. */
export async function verifyAllConnections(): Promise<{ checked: number; ok: number; failed: number }> {
  const rows = await db.select().from(mcpConnections).where(eq(mcpConnections.status, "connected"));
  let ok = 0;
  for (const c of rows) if ((await verifyConnection(c)).ok) ok++;
  return { checked: rows.length, ok, failed: rows.length - ok };
}
