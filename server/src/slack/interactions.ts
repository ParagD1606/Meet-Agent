import { log } from "../log";
import { handleCommitmentAction } from "../manager/chase";
import { handleFollowUpAction } from "../manager/followups";
import { handleBrainAction } from "./commands";
import { deps } from "./deps";
import { setJourneyQuiet } from "./journey/engine";
import { slackClient } from "./client";
import { handleResolveAction } from "./resolve";
import { handleAskAction } from "./teammate";
import { handleConfirmWriteAction } from "../turn/confirm-write";

type Action = { action_id?: string; value?: string };
type BlockActions = {
  type?: string;
  user?: { id?: string };
  actions?: Action[];
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts?: string };
};

/**
 * Slack interactivity payload. Brain-owned buttons (`journey_*`, link buttons `brain_*`) are handled here;
 * `brain_forget_*`, `brain_review_*` and `brain_home_forget` go to commands.ts; everything else goes to the turn module's approval handler.
 */
export async function handleInteraction(payload: BlockActions): Promise<void> {
  try {
    if (payload.type !== "block_actions") return;
    const actions = payload.actions ?? [];
    if (await (await import("../meetings")).handleMeetingTaskAction(payload)) return;
    const own = actions.filter((a) => a.action_id?.startsWith("journey_") || a.action_id?.startsWith("brain_"));
    for (const a of own) {
      if (await handleCommitmentAction(payload, a) || await handleFollowUpAction(payload, a)) continue;
      if (await handleBrainAction(payload as never, a)) continue;
      if (await handleResolveAction(payload, a) || await handleAskAction(payload, a) || await handleConfirmWriteAction(payload, a)) continue;
      if (a.action_id === "journey_quiet" && payload.user?.id) {
        await setJourneyQuiet(payload.user.id);
        const channel = payload.container?.channel_id ?? payload.channel?.id;
        const ts = payload.container?.message_ts ?? payload.message?.ts;
        if (channel && ts) {
          await (await slackClient()).chat.update({ channel, ts, text: "Got it, I won't send more tips.", blocks: [] })
            .catch((e: Error) => log.warn("journey quiet ack failed", { error: e.message }));
        }
      }
    }
    if (own.length < actions.length) {
      const handled = await deps.handleBlockAction(payload);
      if (!handled) log.warn("block action unhandled", { ids: actions.map((a) => a.action_id) });
    }
  } catch (err) {
    log.error("interaction failed", { error: (err as Error).message });
  }
}
