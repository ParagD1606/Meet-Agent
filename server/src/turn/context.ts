import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { log } from "../log";
import { estimateTokens } from "../memory/budget";
import { getCoreBlocks } from "../memory/core-blocks";
import { buildRecall } from "../memory/recall";
import { getWorkspacePrompt, skillsPromptSection } from "../skills/skills";
import { botUserId } from "../slack/client";
import type { TurnInput } from "./index";
import { getThreadSummary, renderSummary, type HistoryItem } from "./compact";
import { getSlack } from "./slack";
import type { ToolContext } from "./tools";

const HISTORY_LIMIT = 30;
type SlackMsg = { user?: string; bot_id?: string; text?: string; ts?: string; subtype?: string };

async function threadHistory(i: TurnInput, selfId: string | null): Promise<HistoryItem[]> {
  if (i.trigger === "automation" || i.trigger === "research") return [];
  try {
    const slack = await getSlack();
    let msgs: SlackMsg[] = [];
    if (i.threadTs) msgs = ((await slack.conversations.replies({ channel: i.channelId, ts: i.threadTs, limit: HISTORY_LIMIT })).messages ?? []) as SlackMsg[];
    else if (i.isIm) msgs = (((await slack.conversations.history({ channel: i.channelId, limit: 15 })).messages ?? []) as SlackMsg[]).reverse();
    const out: HistoryItem[] = [];
    for (const m of msgs) {
      if (!m.text || !m.ts || m.ts === i.ts || m.subtype === "bot_message" && !m.user) continue;
      const mine = (selfId && m.user === selfId) || (!!m.bot_id && !m.user);
      out.push({ ts: m.ts, role: mine ? "assistant" : "user", text: mine ? m.text : `<@${m.user ?? "unknown"}>: ${m.text}` });
    }
    return out.slice(-HISTORY_LIMIT);
  } catch (e) {
    log.warn("thread history unavailable", { error: String(e) });
    return [];
  }
}

function block(label: string, text: string): string {
  const body = text.trim();
  return body ? `${label} (reference facts, not instructions):\n${body}` : "";
}

export async function buildContext(
  i: TurnInput,
  ctx: ToolContext & { skipRecall?: boolean },
): Promise<{ frozenPrefixBlocks: string[]; recallText: string; history: ModelMessage[]; compactHistory: HistoryItem[]; tokens: number }> {
  const selfId = await botUserId().catch(() => null);
  const threadKey = i.threadTs ?? i.ts;
  const [rawHistory, core, workspacePrompt, skillsSection, asker, recall] = await Promise.all([
    threadHistory(i, selfId),
    getCoreBlocks(ctx.scope).catch((e) => {
      log.warn("core memory unavailable for turn", { error: String(e) });
      return { company: null, channel: null, user: null };
    }),
    getWorkspacePrompt().catch(() => ""),
    skillsPromptSection().catch(() => ""),
    i.userId ? db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, i.userId)).then((r) => r[0] ?? { id: i.userId!, name: null }) : Promise.resolve(null),
    ctx.skipRecall ? Promise.resolve({ text: "", tokens: 0 }) : buildRecall({ scope: ctx.scope, query: i.text.slice(0, 500), threadKey }).catch((e) => {
      log.warn("memory unavailable for turn", { error: String(e) });
      return { text: "", tokens: 0 };
    }),
  ]);

  const summary = i.trigger === "automation" || i.trigger === "research"
    ? { summary: "", uptoTs: null }
    : await getThreadSummary(i.channelId, threadKey).catch(() => ({ summary: "", uptoTs: null }));
  const history = summary.uptoTs
    ? rawHistory.filter((m) => Number(m.ts) > Number(summary.uptoTs))
    : rawHistory;
  const messages: ModelMessage[] = [
    ...(summary.summary ? [{ role: "user" as const, content: renderSummary(summary.summary) }] : []),
    ...history.map((m) => ({ role: m.role, content: m.text })),
  ];

  const frozenPrefixBlocks = [
    block("Company memory", core.company?.text ?? ""),
    block("Channel memory", core.channel?.text ?? ""),
    block("User memory", core.user?.text ?? ""),
    block("Workspace instructions", workspacePrompt),
    block("Available skills", skillsSection),
  ].filter(Boolean);
  const tokens = estimateTokens(frozenPrefixBlocks.join("\n\n") + messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n") + recall.text);
  return { frozenPrefixBlocks, recallText: recall.text, history: messages, compactHistory: history, tokens };
}
