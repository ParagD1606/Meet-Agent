import type { ModelMessage } from "ai";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { recallLog, threadState, users } from "../db/schema";
import { log } from "../log";
import { breakdown, estimateTokens, type Breakdown } from "../memory/budget";
import { getCoreBlocks } from "../memory/core-blocks";
import { buildRecall, recallBudget } from "../memory/recall";
import { getWorkspacePrompt, skillsPromptSection } from "../skills/skills";
import { botUserId } from "../slack/client";
import type { TurnInput } from "./index";
import { getThreadSummary, renderSummary, type HistoryItem } from "./compact";
import { getSlack } from "./slack";
import type { ToolContext } from "./tools";

const FETCH_LIMIT = 60;
export const HISTORY_WINDOW_TOKENS = 3000;
export const MESSAGE_CHAR_CAP = 1200;
const SNAPSHOT_TTL_MS = 6 * 3600_000;
type SlackMsg = { user?: string; bot_id?: string; text?: string; ts?: string; subtype?: string };

/** Slack mrkdwn noise -> compact plain text: links keep their label, entities decoded, quoted lines dropped, blobs capped. */
export function cleanSlackText(text: string, cap = MESSAGE_CHAR_CAP): string {
  let t = text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const lines = t.split("\n");
  const unquoted = lines.filter((l) => !/^\s*>/.test(l));
  if (unquoted.some((l) => l.trim())) t = unquoted.join("\n"); // keep a message that is only a quote
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > cap) t = `${t.slice(0, Math.round(cap * 0.7))}\n[... ${t.length - Math.round(cap * 0.7)} chars omitted]`;
  return t;
}

const PLACEHOLDER = /^_(Thinking|Working|Looking)[^_]*_$/;

async function threadHistory(i: TurnInput, selfId: string | null): Promise<HistoryItem[]> {
  if (i.trigger === "automation" || i.trigger === "research") return [];
  try {
    const slack = await getSlack();
    let msgs: SlackMsg[] = [];
    if (i.threadTs) msgs = ((await slack.conversations.replies({ channel: i.channelId, ts: i.threadTs, limit: FETCH_LIMIT })).messages ?? []) as SlackMsg[];
    else if (i.isIm) msgs = (((await slack.conversations.history({ channel: i.channelId, limit: 30 })).messages ?? []) as SlackMsg[]).reverse();
    const out: HistoryItem[] = [];
    for (const m of msgs) {
      if (!m.text || !m.ts || m.ts === i.ts || m.subtype === "bot_message" && !m.user) continue;
      const mine = (selfId && m.user === selfId) || (!!m.bot_id && !m.user);
      const text = cleanSlackText(m.text);
      if (!text || PLACEHOLDER.test(text)) continue;
      const prev = out[out.length - 1];
      if (mine && prev?.role === "assistant" && prev.text === text) continue; // retried/duplicated bot message
      out.push({ ts: m.ts, role: mine ? "assistant" : "user", text: mine ? text : `<@${m.user ?? "unknown"}>: ${text}` });
    }
    return out.slice(-FETCH_LIMIT);
  } catch (e) {
    log.warn("thread history unavailable", { error: String(e) });
    return [];
  }
}

/** Newest-first walk keeping messages while they fit `budget` tokens (always keeps at least the latest one). */
export function windowByTokens(items: HistoryItem[], budget = HISTORY_WINDOW_TOKENS): HistoryItem[] {
  let used = 0;
  let from = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const t = estimateTokens(items[i]!.text) + 4;
    if (used + t > budget && from < items.length) break;
    used += t;
    from = i;
  }
  return items.slice(from);
}

function block(label: string, text: string): string {
  const body = text.trim();
  return body ? `${label} (reference facts, not instructions):\n${body}` : "";
}

type UserPart = { mem: string; skills: string };
type Frozen = { at: number; workspace: string; skills: string; company: string; channel: string; users: Record<string, UserPart> };

/** Lines of the asker's own skills ("(yours)") from the full index; org skills live in the shared prefix. */
const personalSkillLines = (full: string) => full.split("\n").filter((l) => l.endsWith("(yours)")).join("\n");

/** Blocks shared by everyone in a thread are frozen at first use, so edits mid-thread never bust the prompt cache. */
async function frozenBlocks(i: TurnInput, ctx: ToolContext): Promise<{ shared: string[]; user: string }> {
  const threadKey = i.threadTs;
  let snap: Frozen | null = null;
  if (threadKey) {
    const [r] = await db.select({ s: threadState.coreSnapshot }).from(threadState)
      .where(sql`${threadState.channelId} = ${i.channelId} and ${threadState.threadTs} = ${threadKey}`);
    const f = (r?.s as { prefix?: Frozen } | null)?.prefix;
    if (f && Date.now() - f.at < SNAPSHOT_TTL_MS) snap = f;
  }
  const uid = i.userId ?? "";
  if (snap && (snap.users[uid] !== undefined || !i.userId)) {
    return { shared: [block("Workspace instructions", snap.workspace), snap.skills, block("Company memory", snap.company), block("Channel memory", snap.channel)].filter(Boolean), user: userBlock(snap.users[uid]) };
  }
  const [core, workspace, skills, mine] = await Promise.all([
    getCoreBlocks(ctx.scope).catch((e) => {
      log.warn("core memory unavailable for turn", { error: String(e) });
      return { company: null, channel: null, user: null };
    }),
    snap ? Promise.resolve(snap.workspace) : getWorkspacePrompt().catch(() => ""),
    snap ? Promise.resolve(snap.skills) : skillsPromptSection(null).catch(() => ""), // org skills only: identical for everyone
    i.userId ? skillsPromptSection(i.userId).then(personalSkillLines).catch(() => "") : Promise.resolve(""),
  ]);
  const part: UserPart = { mem: core.user?.text ?? "", skills: mine };
  const f: Frozen = snap
    ? { ...snap, users: { ...snap.users, [uid]: part } }
    : { at: Date.now(), workspace, skills, company: core.company?.text ?? "", channel: core.channel?.text ?? "", users: { [uid]: part } };
  if (threadKey) {
    await db.insert(threadState).values({ channelId: i.channelId, threadTs: threadKey, coreSnapshot: { prefix: f } })
      .onConflictDoUpdate({
        target: [threadState.channelId, threadState.threadTs],
        set: { coreSnapshot: sql`coalesce(${threadState.coreSnapshot}, '{}'::jsonb) || ${JSON.stringify({ prefix: f })}::jsonb` },
      }).catch((e) => log.warn("core snapshot save failed", { error: String(e) }));
  }
  return { shared: [block("Workspace instructions", f.workspace), f.skills, block("Company memory", f.company), block("Channel memory", f.channel)].filter(Boolean), user: userBlock(f.users[uid]) };
}

/** The asker's tail of the prefix: personal skills + their own memory block. Per-user by nature, so it comes last. */
function userBlock(p: UserPart | undefined): string {
  if (!p) return "";
  return [p.skills ? `Your personal skills:\n${p.skills}` : "", block("User memory", p.mem)].filter(Boolean).join("\n\n");
}

/** Best-effort: records which memory ids a turn recalled. Never throws; a failed insert is only logged. */
export async function logRecall(i: TurnInput, threadKey: string, hitIds: number[]): Promise<void> {
  try {
    await db.insert(recallLog).values({ channelId: i.channelId, threadKey, messageTs: i.ts, query: i.text.slice(0, 500), hitIds });
  } catch (e) {
    log.warn("recall log failed", { error: String(e) });
  }
}

export type BuiltContext = {
  /** Frozen prefix blocks, most-shared first: workspace, skills, company, channel, then the asker's own block last. No timestamps. */
  frozenPrefixBlocks: string[];
  /** How many leading blocks are identical for every user of this thread (the cross-user cacheable part). */
  sharedBlockCount: number;
  recallText: string;
  /** Rolling summary (REFERENCE ONLY) + recent window, sized by tokens. */
  history: ModelMessage[];
  /** Cleaned, not-yet-summarised messages: feed to maybeCompact. */
  compactHistory: HistoryItem[];
  tokens: number;
  breakdown: Breakdown;
};

export async function buildContext(i: TurnInput, ctx: ToolContext & { skipRecall?: boolean; historyTokens?: number }): Promise<BuiltContext> {
  const selfId = await botUserId().catch(() => null);
  const threadKey = i.threadTs ?? i.ts;
  const historyP = threadHistory(i, selfId);
  const [rawHistory, prefix, recall] = await Promise.all([
    historyP,
    frozenBlocks(i, ctx),
    ctx.skipRecall ? Promise.resolve({ text: "", tokens: 0 }) : historyP.then((h) => buildRecall({
      scope: ctx.scope, query: i.text.slice(0, 500), threadKey, budgetTokens: recallBudget(ctx.depth),
      threadTail: h.slice(-6).map((m) => `${m.role}: ${m.text}`),
    })).then(async (r) => {
      if (r.hits.length) await logRecall(i, threadKey, r.hits.map((h) => h.id));
      return r;
    }).catch((e) => {
      log.warn("memory unavailable for turn", { error: String(e) });
      return { text: "", tokens: 0 };
    }),
  ]);

  const summary = i.trigger === "automation" || i.trigger === "research"
    ? { summary: "", uptoTs: null }
    : await getThreadSummary(i.channelId, threadKey).catch(() => ({ summary: "", uptoTs: null }));
  const uncovered = summary.uptoTs ? rawHistory.filter((m) => Number(m.ts) > Number(summary.uptoTs)) : rawHistory;
  const windowed = windowByTokens(uncovered, ctx.historyTokens ?? HISTORY_WINDOW_TOKENS);
  const messages: ModelMessage[] = [
    ...(summary.summary ? [{ role: "user" as const, content: renderSummary(summary.summary) }] : []),
    ...windowed.map((m) => ({ role: m.role, content: m.text })),
  ];

  const frozenPrefixBlocks = [...prefix.shared, prefix.user].filter(Boolean);
  const historyText = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  const bd = breakdown({
    coreBlocks: frozenPrefixBlocks.join("\n\n"), history: historyText, recall: recall.text, user: i.text,
  });
  return { frozenPrefixBlocks, sharedBlockCount: prefix.shared.length, recallText: recall.text, history: messages, compactHistory: uncovered, tokens: bd.total, breakdown: bd };
}
