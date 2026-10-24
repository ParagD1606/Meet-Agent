import { eq } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { settings } from "../db/schema";
import { log } from "../log";
import { putSetting } from "../manager/commitments";
import { postMessage, slackClient } from "../slack/client";
import { confirmWriteCard } from "../slack/cards";
import type { SlackScope } from "../memory/scope";

const TTL_MS = 15 * 60_000;
const key = (id: string) => `confirm:${id}`;

type Pending = {
  tool: "assign_task" | "update_task"; args: unknown; userId: string; channelId: string; threadTs?: string; messageTs?: string;
  scope: SlackScope; exp: number;
};

/**
 * A write the model proposed while untrusted text was in the turn: park the args (settings `confirm:<id>`, 15 min) and post a
 * Confirm/Cancel card in the thread. Nothing happens until the asker clicks Confirm.
 */
export async function proposeConfirmWrite(p: Omit<Pending, "exp"> & { summary: string }): Promise<void> {
  const id = newId("cw_");
  const { summary, ...rest } = p;
  await putSetting(key(id), { ...rest, exp: Date.now() + TTL_MS } satisfies Pending);
  const card = confirmWriteCard({ id, summary });
  await postMessage({ channel: p.channelId, thread_ts: p.threadTs ?? p.messageTs, text: card.text, blocks: card.blocks });
}

type Payload = { user?: { id?: string }; channel?: { id?: string }; container?: { channel_id?: string; message_ts?: string }; message?: { ts?: string } };

/** brain_cw_yes / brain_cw_no: only the asker's click counts; the row is claimed by a delete so a double click runs once. */
export async function handleConfirmWriteAction(payload: Payload, a: { action_id?: string; value?: string }): Promise<boolean> {
  if (a.action_id !== "brain_cw_yes" && a.action_id !== "brain_cw_no") return false;
  if (!a.value || !payload.user?.id) return true;
  const [peek] = await db.select().from(settings).where(eq(settings.key, key(a.value)));
  const p = peek?.value as Pending | undefined;
  if (!p || p.userId !== payload.user.id) return true; // someone else's click: ignored, the card stays
  const [claimed] = await db.delete(settings).where(eq(settings.key, key(a.value))).returning();
  if (!claimed) return true;
  let text: string;
  if (a.action_id === "brain_cw_no") text = "Cancelled, nothing was changed.";
  else if (p.exp < Date.now()) text = "That confirmation expired; ask me again.";
  else {
    try {
      const { taskTools } = await import("./task-tools");
      const t = taskTools({
        turnId: `confirm_${a.value}`, userId: p.userId, channelId: p.channelId, threadTs: p.threadTs, messageTs: p.messageTs, scope: p.scope,
        readOnly: false, orgConnectionsOnly: false, trigger: "mention", userText: "",
      })[p.tool] as { execute?: (i: unknown, o: unknown) => Promise<unknown> };
      text = String(await t.execute!(p.args, {}));
    } catch (e) { log.warn("confirmed write failed", { tool: p.tool, error: String(e) }); text = `Could not do that: ${String(e).slice(0, 120)}`; }
  }
  const channel = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  if (channel && ts) await (await slackClient()).chat.update({ channel, ts, text, blocks: [] }).catch(() => undefined);
  return true;
}
