import { eq } from "drizzle-orm";
import { db } from "../db";
import { channels, settings, workspace } from "../db/schema";

export type ProactivityDefault = "all" | "own";
export type ChannelProactivity = "default" | "proactive" | "quiet";
export const HOME_CHANNEL_NAME = "company-brain";

export function parseDefault(raw: unknown): ProactivityDefault {
  return raw === "own" ? "own" : "all";
}

/**
 * Pure policy for UNPROMPTED replies (chime/triage) in a channel. DMs and @mentions never consult this.
 * Precedence: bot must be a member > home channel (always proactive) > per-channel override > org default.
 * Org default "own" means only the home channel is proactive unless a channel opts in.
 */
export function isProactive(a: {
  isIm: boolean;
  botIsMember: boolean;
  isHome: boolean;
  override: ChannelProactivity;
  orgDefault: ProactivityDefault;
}): boolean {
  if (a.isIm || !a.botIsMember) return false;
  if (a.isHome) return true;
  if (a.override === "proactive") return true;
  if (a.override === "quiet") return false;
  return a.orgDefault === "all";
}

export async function orgProactivityDefault(): Promise<ProactivityDefault> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "proactivity_default"));
  return parseDefault(row?.value);
}

/** DB-backed decision for one channel. Unknown channel => false (never speak where we are not known to belong). */
export async function channelIsProactive(channelId: string): Promise<boolean> {
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch) return false;
  const [ws] = await db.select({ home: workspace.homeChannelId }).from(workspace).limit(1);
  return isProactive({
    isIm: ch.isIm,
    botIsMember: ch.botIsMember,
    isHome: ch.id === ws?.home || ch.name === HOME_CHANNEL_NAME,
    override: ch.proactivity,
    orgDefault: await orgProactivityDefault(),
  });
}
