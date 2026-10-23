import { and, eq, lt } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { approvals, turns } from "../db/schema";
import { log } from "../log";
import { callConnectionTool } from "../mcp/client";
import { getConnection } from "../mcp/connections";
import { followUp } from "./followup";
import { expireLeases, handleLeaseAction } from "./lease";
import { type BlockActionsPayload, esc, getSlack } from "./slack";

export const APPROVAL_TTL_MS = 15 * 60_000;
export type ApprovalRow = typeof approvals.$inferSelect;
/** Shape persisted in approvals.args so the call can be executed after a restart. */
export type ApprovalArgs = { connectionId: string; mcpTool: string; input: Record<string, unknown> };

export async function requestApproval(a: {
  turnId: string; requesterId: string; channelId: string; threadTs?: string | null;
  connectionId: string; toolName: string; mcpTool: string; input: Record<string, unknown>;
}): Promise<{ approvalId: string }> {
  const row = {
    id: newId("appr_"), turnId: a.turnId, requesterId: a.requesterId, toolName: a.toolName,
    args: { connectionId: a.connectionId, mcpTool: a.mcpTool, input: a.input } satisfies ApprovalArgs,
    channelId: a.channelId, threadTs: a.threadTs ?? null, status: "pending" as const,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
  };
  await db.insert(approvals).values(row);
  try {
    const slack = await getSlack();
    const preview = esc(JSON.stringify(a.input, null, 2)).slice(0, 1500);
    const res = await slack.chat.postMessage({
      channel: a.channelId, thread_ts: a.threadTs ?? undefined, text: `Approval needed: ${a.toolName}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `<@${a.requesterId}> I need your approval to run \`${esc(a.toolName)}\`:\n\`\`\`${preview}\`\`\`\nExpires in 15 minutes.` } },
        { type: "actions", elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approval_approve", value: row.id },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: "approval_deny", value: row.id },
        ] },
      ],
    });
    if (res.ts) await db.update(approvals).set({ messageTs: res.ts }).where(eq(approvals.id, row.id));
  } catch (e) {
    await db.update(approvals).set({ status: "denied" }).where(eq(approvals.id, row.id));
    throw new Error(`could not post approval card: ${String(e)}`);
  }
  await db.update(turns).set({ status: "waiting_approval" }).where(eq(turns.id, a.turnId));
  return { approvalId: row.id };
}

async function setCard(row: ApprovalRow, text: string) {
  if (!row.messageTs) return;
  try {
    const slack = await getSlack();
    await slack.chat.update({ channel: row.channelId, ts: row.messageTs, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
  } catch (e) { log.warn("approval card update failed", { id: row.id, error: String(e) }); }
}
const finishTurn = (turnId: string) =>
  db.update(turns).set({ status: "done", finishedAt: new Date() }).where(and(eq(turns.id, turnId), eq(turns.status, "waiting_approval")));

const inflight = new Set<Promise<unknown>>();
/** Resolves once background executions started by handleBlockAction have finished (tests, graceful shutdown). */
export const settled = () => Promise.allSettled([...inflight]);

/** Executes an approved call strictly under the requester's own connection, then continues the thread. */
export async function executeApproved(row: ApprovalRow): Promise<string> {
  const args = row.args as ApprovalArgs;
  let result: string;
  const conn = await getConnection(args.connectionId);
  if (!conn || conn.status !== "connected" || conn.scope !== "user" || conn.ownerUserId !== row.requesterId) {
    result = "ERROR: the connection is no longer available under the requester's account.";
  } else {
    try { result = await callConnectionTool(conn, args.mcpTool, args.input); }
    catch (e) { result = `ERROR: ${String(e instanceof Error ? e.message : e)}`; log.warn("approved call failed", { id: row.id, error: String(e) }); }
  }
  await finishTurn(row.turnId);
  await followUp({
    channelId: row.channelId, threadTs: row.threadTs, userId: row.requesterId,
    text: `[system] The requester approved \`${row.toolName}\` and it was executed. Result:\n${result.slice(0, 8000)}\nReport the outcome briefly.`,
  }).catch((e) => log.warn("approval follow-up failed", { error: String(e) }));
  return result;
}

async function decide(row: ApprovalRow, approve: boolean, now = new Date()) {
  if (row.expiresAt <= now) {
    const [r] = await db.update(approvals).set({ status: "expired" }).where(and(eq(approvals.id, row.id), eq(approvals.status, "pending"))).returning();
    if (r) { await setCard(r, ":hourglass: Approval expired. Nothing was run."); await finishTurn(r.turnId); }
    return;
  }
  const [r] = await db.update(approvals).set({ status: approve ? "approved" : "denied" })
    .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending"))).returning();
  if (!r) return; // lost a race / already handled: never run twice
  if (!approve) { await setCard(r, ":no_entry: Denied. Nothing was run."); await finishTurn(r.turnId); return; }
  await setCard(r, `:white_check_mark: Approved by <@${r.requesterId}>. Running \`${esc(r.toolName)}\`...`);
  const p = executeApproved(r).catch((e) => log.error("approval execution crashed", { id: r.id, error: String(e) }));
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Slack agent calls this for every block_actions payload. True when it belonged to approvals/leases. */
export async function handleBlockAction(p: BlockActionsPayload): Promise<boolean> {
  const act = p.actions?.find((x) => x.action_id === "approval_approve" || x.action_id === "approval_deny");
  if (!act) return handleLeaseAction(p);
  if (!act.value) return true;
  const [row] = await db.select().from(approvals).where(eq(approvals.id, act.value));
  if (!row) return true;
  if (row.requesterId !== p.user.id) {
    const slack = await getSlack().catch(() => null);
    await slack?.chat.postEphemeral({ channel: row.channelId, user: p.user.id, text: `Only <@${row.requesterId}> can answer this approval.` }).catch(() => {});
    return true;
  }
  await decide(row, act.action_id === "approval_approve");
  return true;
}

/** Expires overdue approvals/leases (and updates their cards). Safe to call repeatedly. */
export async function expireStale(now = new Date()): Promise<{ approvals: number; leases: number }> {
  const rows = await db.update(approvals).set({ status: "expired" })
    .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now))).returning();
  for (const r of rows) { await setCard(r, ":hourglass: Approval expired. Nothing was run."); await finishTurn(r.turnId); }
  return { approvals: rows.length, leases: await expireLeases(now) };
}

let sweeper: ReturnType<typeof setInterval> | undefined;
/**
 * Call once on boot. All approval/lease state lives in Postgres, so live cards keep working across restarts;
 * this only sweeps whatever expired while we were down and keeps sweeping.
 */
export async function resumePending(): Promise<{ approvals: number; leases: number }> {
  const out = await expireStale();
  const stuck = await db.select({ id: turns.id }).from(turns).where(and(eq(turns.status, "waiting_approval")));
  // a waiting turn with no live approval can never resume (e.g. card post failed): close it
  for (const t of stuck) {
    const live = await db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.turnId, t.id), eq(approvals.status, "pending")));
    if (!live.length) await finishTurn(t.id);
  }
  sweeper ??= setInterval(() => void expireStale().catch((e) => log.warn("sweep failed", { error: String(e) })), 60_000);
  sweeper.unref?.();
  return out;
}
export const stopSweeper = () => { if (sweeper) clearInterval(sweeper); sweeper = undefined; };
