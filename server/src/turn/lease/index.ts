import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { id as newId } from "../../crypto";
import { db } from "../../db";
import { leases, mcpConnections, turns, users } from "../../db/schema";
import { log } from "../../log";
import { getPreset } from "../../mcp/catalog";
import { followUp } from "../followup";
import { type BlockActionsPayload, esc, getSlack } from "../slack";

export const LEASE_TTL_MS = 10 * 60_000;
export type Lease = typeof leases.$inferSelect;

/** Teammates (not the requester) with a connected personal connection for `provider` that may be leased. */
export async function leaseCandidates(provider: string, requesterId: string) {
  const preset = getPreset(provider);
  if (preset?.personalOnly) return [];
  const rows = await db
    .select({ connectionId: mcpConnections.id, ownerUserId: mcpConnections.ownerUserId, label: mcpConnections.label, name: users.name })
    .from(mcpConnections)
    .innerJoin(users, eq(users.id, mcpConnections.ownerUserId))
    .where(and(eq(mcpConnections.provider, provider), eq(mcpConnections.scope, "user"), eq(mcpConnections.status, "connected"), ne(mcpConnections.ownerUserId, requesterId), eq(users.deactivated, false)));
  return rows;
}

/** Creates (or reuses) a pending lease and DMs the owner an Allow/Deny card. */
export async function requestLease(a: { connectionId: string; requesterId: string; turnId: string; reason?: string }): Promise<Lease> {
  const [conn] = await db.select().from(mcpConnections).where(eq(mcpConnections.id, a.connectionId));
  if (!conn || conn.scope !== "user" || !conn.ownerUserId || conn.status !== "connected") throw new Error("connection cannot be leased");
  if (conn.ownerUserId === a.requesterId) throw new Error("you already own this connection");
  if (getPreset(conn.provider)?.personalOnly) throw new Error("this connection is personal-only and cannot be leased");

  const [existing] = await db.select().from(leases).where(and(
    eq(leases.connectionId, conn.id), eq(leases.requesterId, a.requesterId), inArray(leases.status, ["pending", "granted"]), gt(leases.expiresAt, new Date()),
  ));
  if (existing) return existing;

  const lease: Lease = {
    id: newId("lease_"), connectionId: conn.id, ownerUserId: conn.ownerUserId, requesterId: a.requesterId,
    turnId: a.turnId, status: "pending", expiresAt: new Date(Date.now() + LEASE_TTL_MS),
  };
  await db.insert(leases).values(lease);
  try {
    const slack = await getSlack();
    const dm = await slack.conversations.open({ users: conn.ownerUserId });
    const channel = dm.channel?.id;
    if (!channel) throw new Error("could not open DM");
    const text = `<@${a.requesterId}> would like to use your *${esc(conn.label)}* connection for one read-only request.${a.reason ? `\n> ${esc(a.reason).slice(0, 500)}` : ""}\nIt expires in 10 minutes and works exactly once.`;
    await slack.chat.postMessage({
      channel, text: "Access request",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "actions", elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Allow once" }, action_id: "lease_allow", value: lease.id },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: "lease_deny", value: lease.id },
        ] },
      ],
    });
  } catch (e) {
    await db.update(leases).set({ status: "denied" }).where(eq(leases.id, lease.id));
    log.warn("lease DM failed", { leaseId: lease.id, error: String(e) });
    throw new Error("could not reach the connection owner");
  }
  return lease;
}

/** Only the owner can decide, only while pending and unexpired. Returns the updated lease or null. */
export async function decideLease(leaseId: string, deciderId: string, allow: boolean): Promise<Lease | null> {
  const [row] = await db.update(leases).set({ status: allow ? "granted" : "denied" })
    .where(and(eq(leases.id, leaseId), eq(leases.ownerUserId, deciderId), eq(leases.status, "pending"), gt(leases.expiresAt, new Date())))
    .returning();
  return row ?? null;
}

/** Where a lease may be spent: the same connection, in the thread the request came from, for a read-only tool. */
export type LeaseBinding = { connectionId: string; toolIsRead: boolean; channelId: string; threadTs?: string | null };

const sameThread = (b: LeaseBinding) => sql`exists (select 1 from ${turns} t where t.id = ${leases.turnId} and t.channel_id = ${b.channelId} and t.thread_ts is not distinct from ${b.threadTs ?? null})`;

/**
 * One-use: atomically flips granted -> used. Second call (or after expiry / wrong requester) returns false.
 * With `bind` the lease is also pinned to its connection, to the originating thread (turn) and to read-only tools,
 * so a granted lease cannot be spent by another conversation or on a write.
 */
export async function consumeLease(leaseId: string, requesterId: string, bind?: LeaseBinding): Promise<boolean> {
  if (bind && !bind.toolIsRead) return false;
  const rows = await db.update(leases).set({ status: "used" })
    .where(and(
      eq(leases.id, leaseId), eq(leases.requesterId, requesterId), eq(leases.status, "granted"), gt(leases.expiresAt, new Date()),
      ...(bind ? [eq(leases.connectionId, bind.connectionId), sameThread(bind)] : []),
    ))
    .returning({ id: leases.id });
  return rows.length === 1;
}

/** Live granted leases of the requester; `scope` limits them to leases requested from that thread. */
export async function grantedLeases(requesterId: string, scope?: { channelId: string; threadTs?: string | null }): Promise<Lease[]> {
  return db.select().from(leases).where(and(
    eq(leases.requesterId, requesterId), eq(leases.status, "granted"), gt(leases.expiresAt, new Date()),
    ...(scope ? [sameThread({ connectionId: "", toolIsRead: true, ...scope })] : []),
  ));
}

export async function expireLeases(now = new Date()): Promise<number> {
  const rows = await db.update(leases).set({ status: "expired" })
    .where(and(inArray(leases.status, ["pending", "granted"]), lt(leases.expiresAt, now))).returning({ id: leases.id });
  return rows.length;
}

/** Handles lease_allow / lease_deny clicks. Returns true when the action belonged to this module. */
export async function handleLeaseAction(p: BlockActionsPayload): Promise<boolean> {
  const act = p.actions?.find((x) => x.action_id === "lease_allow" || x.action_id === "lease_deny");
  if (!act?.value) return false;
  const allow = act.action_id === "lease_allow";
  const channel = p.channel?.id ?? p.container?.channel_id;
  const ts = p.message?.ts ?? p.container?.message_ts;
  const update = async (text: string) => {
    if (!channel || !ts) return;
    const slack = await getSlack();
    await slack.chat.update({ channel, ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }).catch(() => {});
  };
  const [row] = await db.select().from(leases).where(eq(leases.id, act.value));
  if (!row) return true;
  if (row.ownerUserId !== p.user.id) return true; // not yours; ignore
  const decided = await decideLease(row.id, p.user.id, allow);
  if (!decided) {
    await update(row.status === "pending" || row.status === "granted" ? "This request has expired." : `This request was already handled (${row.status}).`);
    return true;
  }
  await update(allow ? ":white_check_mark: Allowed for one request." : ":no_entry: Denied.");
  if (allow) {
    const [turn] = await db.select().from(turns).where(eq(turns.id, decided.turnId));
    if (turn) {
      await followUp({
        channelId: turn.channelId, threadTs: turn.threadTs, userId: decided.requesterId,
        text: `<@${decided.ownerUserId}> granted a one-time read-only lease on connection ${decided.connectionId}. Continue the original request using it.`,
        readOnly: true,
      }).catch((e) => log.warn("lease follow-up failed", { error: String(e) }));
    }
  }
  return true;
}
