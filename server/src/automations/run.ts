import type { WebClient } from "@slack/web-api";
import { CronExpressionParser } from "cron-parser";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { automations, channels, users } from "../db/schema";
import { log } from "../log";
import { type Actor, type Automation, AutomationError, RESEARCH_PREFIX, isAdmin } from "./automations";

/** Seams for the Slack/turn/research modules (lazy-loaded so this file never fails at import time). Tests override. */
export const deps = {
  slack: async (): Promise<WebClient> => (await import("../slack/client")).slackClient(),
  runTurn: async (input: import("../turn").TurnInput): Promise<void> => (await import("../turn")).runTurn(input),
  startResearch: async (a: { requesterId: string; channelId: string; threadTs?: string; question: string }): Promise<string> =>
    (await import("../research")).startResearch(a),
};

class Skip extends Error {}
const skip = (why: string): never => {
  throw new Skip(why);
};

type Dest = { channelId: string; isPrivate: boolean; isIm: boolean };

/** Resolve + verify the destination. Anything unexpected or ambiguous => Skip (fail closed). */
async function resolveDest(a: Automation, slack: WebClient): Promise<Dest> {
  if (!a.destChannelId) {
    const r = await slack.conversations.open({ users: a.ownerUserId });
    const channelId = r.ok ? r.channel?.id : undefined;
    if (!channelId) return skip("could not open DM with owner");
    return { channelId, isPrivate: false, isIm: true };
  }
  const info = await slack.conversations.info({ channel: a.destChannelId });
  const ch = info.ok ? info.channel : undefined;
  if (!ch || ch.is_archived) return skip("channel unavailable");
  if (ch.is_im || ch.is_mpim) return skip("destination is a direct conversation");
  if (ch.is_member !== true) return skip("bot is not a member of the channel");
  if (typeof ch.is_private !== "boolean") return skip("cannot determine channel privacy");
  const [row] = await db.select().from(channels).where(eq(channels.id, a.destChannelId));
  return { channelId: a.destChannelId, isPrivate: ch.is_private || !!row?.isPrivate, isIm: false };
}

async function perform(a: Automation): Promise<void> {
  const [owner] = await db.select().from(users).where(eq(users.id, a.ownerUserId));
  if (!owner || owner.deactivated) return skip("owner inactive or unknown");
  const slack = await deps.slack();

  if (a.kind === "reminder") {
    const r = await slack.chat.postMessage({ channel: a.destChannelId ?? a.ownerUserId, text: `:alarm_clock: Reminder: ${a.prompt}` });
    if (!r.ok) throw new Error(r.error ?? "post failed");
    return;
  }

  const dest = await resolveDest(a, slack);
  if (a.prompt.startsWith(RESEARCH_PREFIX)) {
    await deps.startResearch({ requesterId: a.ownerUserId, channelId: dest.channelId, question: a.prompt.slice(RESEARCH_PREFIX.length).trim() });
    return;
  }
  await deps.runTurn({
    trigger: "automation",
    channelId: dest.channelId,
    ts: `${Math.floor(Date.now() / 1000)}.000000`,
    userId: a.ownerUserId,
    text: `Scheduled digest requested by <@${a.ownerUserId}>. Post the recap directly, from read-only sources.\n\n${a.prompt}`,
    isPrivate: dest.isPrivate,
    isIm: dest.isIm,
    readOnly: true,
    orgConnectionsOnly: true,
  });
}

/**
 * Atomically claims then runs one automation. Scheduled runs pass `fireAt`; the claim (last_run_at < fireAt) makes
 * duplicate jobs / the tick safety net harmless. `manual` skips the enabled/claim checks. Returns lastStatus.
 */
export async function executeAutomation(id: string, opts: { fireAt?: Date; manual?: boolean } = {}): Promise<string> {
  const fireAt = opts.fireAt ?? new Date();
  const claimed = await db
    .update(automations)
    .set({ lastRunAt: new Date(), lastStatus: "running" })
    .where(
      opts.manual
        ? eq(automations.id, id)
        : and(eq(automations.id, id), eq(automations.enabled, true), or(isNull(automations.lastRunAt), lt(automations.lastRunAt, fireAt))),
    )
    .returning();
  const a = claimed[0];
  if (!a) return "not-run";

  let status: string;
  try {
    await perform(a);
    status = "ok";
  } catch (err) {
    status = err instanceof Skip ? `skipped: ${err.message}` : `error: ${err instanceof Error ? err.message : String(err)}`;
    log[err instanceof Skip ? "warn" : "error"]("automation not delivered", { id, status });
  }
  const oneOff = !opts.manual && !a.cron;
  await db.update(automations).set({ lastStatus: status.slice(0, 300), ...(oneOff ? { enabled: false } : {}) }).where(eq(automations.id, id));
  return status;
}

/** Manual "run now" for the API; actor (when given) must own the automation or be admin. */
export async function runNow(id: string, actor?: Actor): Promise<{ ok: boolean; status: string }> {
  const [a] = await db.select().from(automations).where(eq(automations.id, id));
  if (!a) throw new AutomationError("automation not found", "not_found");
  if (actor && a.ownerUserId !== actor.userId && !isAdmin(actor)) throw new AutomationError("forbidden: not your automation", "forbidden");
  const status = await executeAutomation(id, { manual: true });
  return { ok: status === "ok", status };
}

/** Enabled automations whose latest scheduled fire has not run yet. */
export async function findDue(now = new Date()): Promise<{ id: string; fireAt: Date }[]> {
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.enabled, true), sql`(${automations.cron} is not null or ${automations.runAt} is not null)`));
  const due: { id: string; fireAt: Date }[] = [];
  for (const a of rows) {
    try {
      if (a.cron) {
        const prev = CronExpressionParser.parse(a.cron, { currentDate: now, tz: "UTC" }).prev().toDate();
        const base = Math.max(a.lastRunAt?.getTime() ?? 0, a.createdAt.getTime());
        if (prev.getTime() > base) due.push({ id: a.id, fireAt: prev });
      } else if (a.runAt && !a.lastRunAt && a.runAt <= now) {
        due.push({ id: a.id, fireAt: a.runAt });
      }
    } catch (err) {
      log.warn("bad schedule on automation", { id: a.id, err: String(err) });
    }
  }
  return due;
}
