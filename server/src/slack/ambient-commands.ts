import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { announceAmbient, setObserve } from "../memory/ambient";
import { slackClient } from "./client";

type Reply = { response_type: "ephemeral"; text: string };
const say = (text: string): Reply => ({ response_type: "ephemeral", text });

export const ambientCommandIo = {
  creatorOf: async (channelId: string): Promise<string | null> =>
    ((await (await slackClient()).conversations.info({ channel: channelId })).channel as { creator?: string } | undefined)?.creator ?? null,
};

/** /brain-pause and /brain-resume: stop or restart ambient learning in this channel. Workspace admins or the channel's creator only. Returns null for other commands. */
export async function ambientCommand(p: { command?: string; user_id?: string; channel_id?: string }): Promise<Reply | null> {
  if (p.command !== "/brain-pause" && p.command !== "/brain-resume") return null;
  const channelId = p.channel_id ?? "";
  if (!p.user_id || !channelId || channelId.startsWith("D")) return say("This only works in a channel.");
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, p.user_id));
  const allowed = u?.role === "admin" || u?.role === "owner" || (await ambientCommandIo.creatorOf(channelId).catch(() => null)) === p.user_id;
  if (!allowed) return say("Only workspace admins or the channel's creator can do that.");
  const resume = p.command === "/brain-resume";
  if (!(await setObserve(channelId, resume))) return say("I'm not in this channel yet.");
  if (resume) await announceAmbient(channelId);
  return say(resume ? "Resumed. I'll learn from this channel again." : "Paused. I won't learn from this channel until `/brain-resume`. What I already learned stays; ask an admin to remove it in the Brain app.");
}
