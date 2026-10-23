import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { log } from "../log";
import { readTags, type SlackScope } from "../memory/scope";
import { searchMemory } from "../memory/search";
import { getWorkspacePrompt, skillsPromptSection } from "../skills/skills";
import { botUserId } from "../slack/client";
import { buildSystemPrompt } from "./prompt";
import { getSlack } from "./slack";
import type { TurnInput } from "./index";

const HISTORY_LIMIT = 30;
const MAX_FILE_CHARS = 20_000;

type SlackMsg = { user?: string; bot_id?: string; text?: string; ts?: string; subtype?: string };

async function threadHistory(i: TurnInput, selfId: string | null): Promise<ModelMessage[]> {
  if (i.trigger === "automation" || i.trigger === "research") return [];
  try {
    const slack = await getSlack();
    let msgs: SlackMsg[] = [];
    if (i.threadTs) msgs = ((await slack.conversations.replies({ channel: i.channelId, ts: i.threadTs, limit: HISTORY_LIMIT })).messages ?? []) as SlackMsg[];
    else if (i.isIm) msgs = (((await slack.conversations.history({ channel: i.channelId, limit: 15 })).messages ?? []) as SlackMsg[]).reverse();
    const out: ModelMessage[] = [];
    for (const m of msgs) {
      if (!m.text || m.ts === i.ts || m.subtype === "bot_message" && !m.user) continue;
      const mine = (selfId && m.user === selfId) || (!!m.bot_id && !m.user);
      out.push(mine ? { role: "assistant", content: m.text } : { role: "user", content: `<@${m.user ?? "unknown"}>: ${m.text}` });
    }
    return out.slice(-HISTORY_LIMIT);
  } catch (e) {
    log.warn("thread history unavailable", { error: String(e) });
    return [];
  }
}

export async function buildContext(i: TurnInput, scope: SlackScope, connectionNotes: string[]): Promise<{ system: string; messages: ModelMessage[] }> {
  const selfId = await botUserId().catch(() => null);
  const [history, memories, workspacePrompt, skillsSection, asker] = await Promise.all([
    threadHistory(i, selfId),
    (async () => {
      try {
        const hits = await searchMemory({ tags: await readTags(scope), query: i.text.slice(0, 500), limit: 8 });
        return hits.map((h) => `- (${h.source}, ${h.createdAt.toISOString().slice(0, 10)}) ${h.text}`);
      } catch (e) { log.warn("memory unavailable for turn", { error: String(e) }); return []; }
    })(),
    getWorkspacePrompt().catch(() => ""),
    skillsPromptSection().catch(() => ""),
    i.userId ? db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, i.userId)).then((r) => r[0] ?? { id: i.userId!, name: null }) : Promise.resolve(null),
  ]);
  const files = (i.files ?? []).map((f) => `\n\n[attachment: ${f.name} (${f.mimeType})]\n${f.text.slice(0, MAX_FILE_CHARS)}`).join("");
  const current = i.userId && (i.trigger === "mention" || i.trigger === "dm" || i.trigger === "chime")
    ? `<@${i.userId}>: ${i.text}${files}`
    : `${i.text}${files}`;
  return {
    system: buildSystemPrompt({
      now: new Date(), botUserId: selfId, workspacePrompt, skillsSection, memories, asker,
      trigger: i.trigger, isIm: i.isIm, isPrivate: i.isPrivate, readOnly: !!i.readOnly, connectionNotes,
    }),
    messages: [...history, { role: "user", content: current }],
  };
}
