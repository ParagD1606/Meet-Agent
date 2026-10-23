import { eq } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channels, turns } from "../db/schema";
import { log } from "../log";
import { captureTurn } from "../memory/writeback";
import { buildContext } from "./context";
import { setFollowUp } from "./followup";
import { runLoop } from "./loop";
import { serialize } from "./queue";
import { getSlack } from "./slack";
import { assembleTools } from "./tools";

export { handleBlockAction, resumePending, expireStale } from "./approval";
export { buildTools, type ToolContext } from "./tools";

export type TurnInput = {
  trigger: "mention" | "dm" | "chime" | "automation" | "research";
  channelId: string;
  threadTs?: string;
  ts: string;
  userId: string | null;
  text: string;
  isPrivate: boolean;
  isIm: boolean;
  files?: { name: string; mimeType: string; text: string }[];
  readOnly?: boolean;
  orgConnectionsOnly?: boolean;
};

const MAX_SLACK_TEXT = 38_000;
const NO_REPLY = /^\s*NO_REPLY\s*$/;

/** One turn at a time per (channel, thread): in-process FIFO plus a pg advisory lock for multi-process safety. */
export function runTurn(input: TurnInput): Promise<void> {
  const key = `turn:${input.channelId}:${input.threadTs ?? (input.isIm ? "dm" : input.ts)}`;
  return serialize(key, () => execute(input));
}

async function execute(input: TurnInput): Promise<void> {
  const turnId = newId("turn_");
  const readOnly = !!input.readOnly;
  const orgConnectionsOnly = !!input.orgConnectionsOnly;
  await db.insert(turns).values({ id: turnId, channelId: input.channelId, threadTs: input.threadTs ?? null, userId: input.userId, trigger: input.trigger });

  const scope = { channelId: input.channelId, isPrivate: input.isPrivate, isIm: input.isIm, userId: input.userId };
  // where the reply goes: DMs reply inline, channels reply in thread, automations post top-level
  const replyThread = input.trigger === "automation" || input.trigger === "research" ? input.threadTs : input.isIm ? input.threadTs : (input.threadTs ?? input.ts);
  const interactive = input.trigger === "mention" || input.trigger === "dm";
  let placeholderTs: string | undefined;
  let slack: Awaited<ReturnType<typeof getSlack>> | undefined;

  const edit = async (text: string) => {
    if (!slack || !placeholderTs) return;
    await slack.chat.update({ channel: input.channelId, ts: placeholderTs, text: text.slice(0, MAX_SLACK_TEXT) }).catch((e) => log.warn("chat.update failed", { error: String(e) }));
  };

  try {
    slack = await getSlack();
    if (interactive) {
      const r = await slack.chat.postMessage({ channel: input.channelId, thread_ts: replyThread, text: "_Thinking..._" });
      placeholderTs = r.ts;
    }
    const { tools, notes } = await assembleTools({ turnId, userId: input.userId, channelId: input.channelId, threadTs: replyThread ?? input.threadTs, scope, readOnly, orgConnectionsOnly });
    const { system, messages } = await buildContext(input, scope, notes);

    let lastEdit = 0;
    const throttled = (text: string) => {
      const now = Date.now();
      if (now - lastEdit < 1200) return;
      lastEdit = now;
      void edit(text);
    };
    const result = await runLoop({
      system, messages, tools,
      onStatus: (name) => { if (!input.isIm) throttled(`_Working: ${name.replace(/_+/g, " ")}..._`); },
      onText: (t) => { if (input.isIm && interactive && t.trim()) throttled(t); },
    });

    const reply = result.text;
    const silent = !reply || NO_REPLY.test(reply);
    if (silent && input.trigger === "chime") {
      // nothing worth saying: leave no trace
    } else {
      const text = (silent ? "I wasn't able to produce an answer for that. Try rephrasing?" : reply).slice(0, MAX_SLACK_TEXT);
      if (placeholderTs) await slack.chat.update({ channel: input.channelId, ts: placeholderTs, text });
      else await slack.chat.postMessage({ channel: input.channelId, thread_ts: replyThread, text });
    }

    await db.update(turns).set({
      status: result.waitingApproval ? "waiting_approval" : "done",
      toolCalls: result.toolCalls, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      finishedAt: result.waitingApproval ? null : new Date(),
    }).where(eq(turns.id, turnId));
    // approval.requestApproval already set waiting_approval; re-asserting above is idempotent unless the approval was resolved mid-turn

    if (!readOnly && !silent) {
      captureTurn({ scope, transcript: `${input.text}\n\nAssistant: ${reply}` })
        .catch((e) => log.warn("captureTurn failed", { turnId, error: String(e) }));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("turn failed", { turnId, error: msg });
    await edit(":warning: Something went wrong while working on that. Please try again.");
    if (!placeholderTs && interactive && slack) {
      await slack.chat.postMessage({ channel: input.channelId, thread_ts: replyThread, text: ":warning: Something went wrong while working on that. Please try again." }).catch(() => {});
    }
    await db.update(turns).set({ status: "error", error: msg.slice(0, 1000), finishedAt: new Date() }).where(eq(turns.id, turnId));
  }
}

// Approval/lease resolutions continue the thread through a normal (serialized) turn.
setFollowUp(async ({ channelId, threadTs, userId, text }) => {
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  await runTurn({
    trigger: "mention", channelId, threadTs: threadTs ?? undefined, ts: (Date.now() / 1000).toFixed(6),
    userId, text, isPrivate: ch?.isPrivate ?? false, isIm: ch?.isIm ?? false,
  });
});
