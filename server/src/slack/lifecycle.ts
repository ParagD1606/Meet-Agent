import { eq } from "drizzle-orm";
import { db } from "../db";
import { approvals, channels, workspace } from "../db/schema";
import { log } from "../log";
import { invalidateSlackClient, getWorkspace, slackClient } from "./client";
import { HOME_CHANNEL_NAME } from "./proactivity";

export const FAREWELL_TEXT = "Company Brain is being removed from this workspace. Everything it remembered stays stored; reinstall any time to pick up where it left off.";

/** Best-effort goodbye in the home channel. Returns false (never throws) when the token is already dead. */
export async function postFarewell(text = FAREWELL_TEXT): Promise<boolean> {
  try {
    const ws = await getWorkspace();
    if (!ws) return false;
    let home = ws.homeChannelId;
    if (!home) home = (await db.select({ id: channels.id }).from(channels).where(eq(channels.name, HOME_CHANNEL_NAME)))[0]?.id ?? null;
    if (!home) return false;
    await (await slackClient()).chat.postMessage({ channel: home, text });
    return true;
  } catch (e) {
    log.info("farewell not delivered", { error: (e as Error).message });
    return false;
  }
}

/**
 * The app was uninstalled or its bot token revoked: say goodbye if we still can, then stop acting.
 * Drops the stored (now dead) token so nothing keeps retrying with it, marks every channel as not-joined
 * so no proactive path fires, and expires approvals that can never be answered. Memory is kept on purpose.
 */
export async function handleWorkspaceGone(kind: "app_uninstalled" | "tokens_revoked"): Promise<void> {
  log.warn("slack workspace gone", { kind });
  await postFarewell();
  await db.transaction(async (tx) => {
    await tx.update(channels).set({ botIsMember: false });
    await tx.update(approvals).set({ status: "expired" }).where(eq(approvals.status, "pending"));
    await tx.delete(workspace);
  });
  invalidateSlackClient();
}
