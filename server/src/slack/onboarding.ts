import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { mcpConnections, users } from "../db/schema";
import { log } from "../log";
import { channelIntroCard, homeView, teamInviteCard, welcomeCard } from "./cards";
import { postDm, postMessage, slackClient } from "./client";
import { pruneEvents } from "./dedupe";
import { journeyTick as sweepJourneys, startJourney } from "./journey/engine";
import { ensureUser } from "./sync";


/** New workspace member (team_join) or freshly installed admin: welcome DM exactly once. */
export async function onUserJoined(userId: string): Promise<void> {
  await ensureUser(userId);
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.isBot || u.deactivated) return;
  if (!(await startJourney(userId))) return; // already welcomed
  const card = welcomeCard(u.name);
  await postDm(userId, card.text, card.blocks);
}

/** App Home tab opened: (re)publish the home view and make sure the user has a journey row. */
export async function onAppHome(userId: string): Promise<void> {
  try {
    await ensureUser(userId);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(mcpConnections)
      .where(and(eq(mcpConnections.status, "connected"), sql`(${mcpConnections.scope} = 'org' or ${mcpConnections.ownerUserId} = ${userId})`));
    await (await slackClient()).views.publish({ user_id: userId, view: homeView({ name: u?.name, connections: c?.n ?? 0 }) as never });
  } catch (err) { log.warn("app home publish failed", { userId, error: (err as Error).message }); }
}

/** Bot added to a channel: one short introduction (never in DMs). */
export async function introduceInChannel(channelId: string): Promise<void> {
  const card = channelIntroCard();
  try { await postMessage({ channel: channelId, text: card.text, blocks: card.blocks }); }
  catch (err) { log.warn("channel intro failed", { channelId, error: (err as Error).message }); }
}

/** After OAuth install: welcome the installer and show the invite-your-team card. */
export async function sendInstallOnboarding(installerId: string | undefined): Promise<void> {
  if (!installerId) return;
  await onUserJoined(installerId);
  const card = teamInviteCard();
  await postDm(installerId, card.text, card.blocks);
}

/** Cron entrypoint (jobs): nudge eligible users, and trim the dedupe table while we are at it. */
export async function journeyTick(): Promise<{ checked: number; sent: number }> {
  await pruneEvents().catch((err) => log.warn("event prune failed", { error: (err as Error).message }));
  return sweepJourneys();
}
