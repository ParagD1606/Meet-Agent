import type { ModelMessage } from "ai";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channels, turns, users } from "../db/schema";
import { checkSpendAlert } from "../cost";
import { acquireTurnSlot, BUSY_MESSAGE, checkRate, CEILING_MESSAGE, dailyCapStatus, getLimits, recordUsage, releaseTurnSlot } from "../limits";
import { log } from "../log";
import type { AgentContext } from "../memory/core-blocks";
import { breakdown } from "../memory/budget";
import { scheduleCapture } from "../memory/writeback";
import { botUserId, getWorkspace } from "../slack/client";
import { resolveActions } from "../slack/cards";
import { prepareReply, createReplySink } from "../slack/stream";
import { buildContext } from "./context";
import { maybeCompact } from "./compact";
import { DEPTH_CONFIG, routeDepth, type Depth } from "./depth";
import { memoryTools } from "./memory-tools";
import { setFollowUp } from "./followup";
import { ACTION_TOOL, runLoop } from "./loop";
import { getPersona } from "../persona";
import { buildDynamicContext, buildSystemMessages, type Trigger } from "./prompt";
import { serialize } from "./queue";
import { getSlack } from "./slack";
import { askTeammateTool } from "./ask-teammate";
import { openAsksFor } from "../slack/teammate";
import { isActionAck } from "../slack/resolve";
import { assembleTools, type ToolContext } from "./tools";

export { handleBlockAction, resumePending, expireStale } from "./approval";
export { buildTools, type ToolContext } from "./tools";

export type TurnInput = {
  trigger: Trigger;
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
  /** Who is acting for memory-write purposes. Default "primary" (a human is waiting for this turn). */
  agentContext?: AgentContext;
  /** Slack assistant-pane thread: progress goes through assistant.threads.setStatus. */
  assistant?: boolean;
  /** Slack Real-time Search action token from the triggering event (live user-scoped search). */
  actionToken?: string;
  /** Aborted when the user steers the running turn ("stop" or a replacing message); reason says which. */
  abortSignal?: AbortSignal;
};

const NO_REPLY = /^\s*NO_REPLY\s*$/;
const STEP_CAP_HINT = "\n\n_I ran out of working room on this one. Say \"continue\" and I'll pick up from here._";
const TIMEOUT_MSG = "That took longer than I'm allowed to spend on one request, so I stopped. Try narrowing it down, or say \"continue\" to have me pick it up.";
/** Resolve buttons belong under factual answers only: never after a turn that wrote, notified, asked or saved something. */
const RECALL_TOOL = /^(memory_search|find_tasks|entity_lookup|search_threads)$/;
const QUESTION = /\?|^\s*(what|who|when|where|why|how|which|is|are|does|do|did|can|could|tell me|explain)\b/i;
const FAIL_MSG = ":warning: Something went wrong while working on that. Please try again.";

/** One turn at a time per (channel, thread): in-process FIFO plus a pg advisory lock for multi-process safety. */
export function runTurn(input: TurnInput): Promise<void> {
  const key = `turn:${input.channelId}:${input.threadTs ?? (input.isIm ? "dm" : input.ts)}`;
  return serialize(key, () => execute(input));
}

async function execute(input: TurnInput): Promise<void> {
  const turnId = newId("turn_");
  const readOnly = !!input.readOnly;
  const agentContext: AgentContext = input.agentContext ?? "primary";
  const interactive = input.trigger === "mention" || input.trigger === "dm";
  await db.insert(turns).values({ id: turnId, channelId: input.channelId, threadTs: input.threadTs ?? null, userId: input.userId, trigger: input.trigger });

  const scope = { channelId: input.channelId, isPrivate: input.isPrivate, isIm: input.isIm, userId: input.userId };
  // where the reply goes: DMs reply inline, channels reply in thread, automations post top-level
  const replyThread = input.trigger === "automation" || input.trigger === "research" ? input.threadTs : input.isIm ? input.threadTs : (input.threadTs ?? input.ts);
  const finishRow = (set: Partial<typeof turns.$inferInsert>) => db.update(turns).set({ finishedAt: new Date(), ...set }).where(eq(turns.id, turnId));

  let sink: ReturnType<typeof createReplySink> | undefined;
  let slot = false;
  let stage = "setup";
  try {
    const slack = await getSlack();
    const ws = await getWorkspace().catch(() => null);
    const say = async (text: string) => { // a reply before/without a sink
      for (const c of prepareReply(text)) await slack.chat.postMessage({ channel: input.channelId, thread_ts: replyThread, text: c });
    };

    // ---- admission: per-user rate, daily caps, global concurrency (cost controls, A) ----
    if (input.userId && interactive) {
      const rate = await checkRate({ userId: input.userId, channelId: input.channelId, kind: "turn" });
      if (!rate.ok) { await say(rate.message); await finishRow({ status: "done", depth: "denied" }); return; }
    }
    if (input.userId) {
      stage = "admission";
      const cap = await dailyCapStatus(input.userId);
      if (!cap.ok) { if (interactive) await say(cap.message); await finishRow({ status: "done", depth: "denied" }); return; }
    }
    slot = await acquireTurnSlot();
    if (!slot) { if (interactive) await say(BUSY_MESSAGE); await finishRow({ status: "done", depth: "denied" }); return; }

    // ---- depth router: decide how much work this turn deserves before spending anything ----
    stage = "depth";
    // previous turn in this thread/DM: a bare "ok" or "continue" must not drop to a tool-less depth after an action
    const [last] = interactive ? await db.select({ depth: turns.depth, toolCalls: turns.toolCalls }).from(turns)
      .where(and(eq(turns.channelId, input.channelId), input.threadTs ? eq(turns.threadTs, input.threadTs) : isNull(turns.threadTs), ne(turns.id, turnId)))
      .orderBy(desc(turns.startedAt)).limit(1) : [];
    const openAsk = input.userId && interactive ? (await openAsksFor(input.userId).catch(() => [])).length > 0 : false;
    const prev = last?.depth ? { depth: last.depth as Depth, usedTools: Array.isArray(last.toolCalls) && last.toolCalls.length > 0, openAsk } : undefined;
    const { depth, by } = await routeDepth({ trigger: input.trigger, text: input.text, hasFiles: !!input.files?.length, hasHistory: !!input.threadTs, readOnly, prev });
    const plan = DEPTH_CONFIG[depth];
    const limits = await getLimits();
    const maxSteps = depth === "direct" ? 1 : Math.min(60, limits.maxStepsByDepth[depth]);
    log.info("turn depth", { turnId, depth, by });

    sink = createReplySink({
      slack, channel: input.channelId, threadTs: replyThread, teamId: ws?.id, userId: input.userId,
      native: interactive && input.isIm && (depth === "direct" || depth === "memory"),
      assistant: !!input.assistant && input.isIm,
      placeholder: interactive && depth !== "direct",
      idemKey: interactive ? input.ts : undefined,
    });
    stage = "reply_begin";
    if (interactive) await sink.begin();

    const ctx: ToolContext = {
      turnId, userId: input.userId, channelId: input.channelId, threadTs: replyThread ?? input.threadTs, scope,
      readOnly, orgConnectionsOnly: !!input.orgConnectionsOnly, agentContext, trigger: input.trigger, depth, userText: input.text,
      actionToken: input.actionToken,
    };
    const narrate = interactive ? sink.narrate : undefined;
    stage = "tools";
    const assembled = plan.tools ? await assembleTools(ctx, { depth, text: input.text, narrate }) : undefined;
    // memory depth: no live tools, but the read-only memory_search + find_tasks so the model can dig past the auto-recalled block
    const tools = assembled?.tools ?? (plan.memorySearch
      ? { ...(({ memory_search, find_tasks }) => ({ memory_search: memory_search!, find_tasks: find_tasks! }))(memoryTools(ctx as never)), ...(interactive && !readOnly && input.userId ? { ask_teammate: askTeammateTool(ctx) } : {}) }
      : {});

    // ---- context: frozen prefix (static prompt + core blocks) / dynamic suffix (time, recall, history, message) ----
    stage = "context";
    const bc = await buildContext(input, { ...ctx, skipRecall: !plan.recall });
    if (bc.recallExternal || bc.recentChannelText) ctx.untrustedContext = true;
    const [self, asker, chan] = await Promise.all([
      botUserId().catch(() => null),
      input.userId ? db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, input.userId)).then((r) => r[0] ?? { id: input.userId!, name: null }) : Promise.resolve(null),
      db.select({ name: channels.name }).from(channels).where(eq(channels.id, input.channelId)).then((r) => r[0]),
    ]);
    const dynamic = buildDynamicContext({
      now: new Date(), botUserId: self, asker, channelName: chan?.name, trigger: input.trigger, isIm: input.isIm, isPrivate: input.isPrivate,
      readOnly, depth, connectionNotes: assembled?.notes ?? [],
    });
    const open = input.userId && interactive ? await openAsksFor(input.userId).catch(() => []) : [];
    const pending = open.map((a) => `\nYou asked this user a question for <@${a.asker}>: "${a.question}". Their message may be the answer, but you cannot relay it from here, so never say you passed anything on.`).join("");
    const recall = plan.recall ? [bc.recallText, bc.recentChannelText].filter(Boolean).join("\n") : "";
    const files = (input.files ?? []).map((f) => `\n\n[attachment: ${f.name} (${f.mimeType})]\n${f.text.slice(0, 20_000)}`).join("");
    const speaker = input.userId && interactive ? `<@${input.userId}>: ` : "";
    const userContent = `${dynamic}${pending}\n${recall ? `${recall}\n` : ""}${speaker}${input.text}${files}`;
    const history: ModelMessage[] = depth === "direct" ? bc.history.slice(-4) : bc.history;
    const messages: ModelMessage[] = [...history, { role: "user", content: userContent }];
    const system = buildSystemMessages(bc.frozenPrefixBlocks, await getPersona());

    stage = "model";
    const result = await runLoop({
      system, messages, tools, turnId, role: plan.role, depth, maxSteps, maxOutputTokens: plan.maxOutputTokens,
      activeTools: assembled?.active, abortSignal: input.abortSignal,
      onStatus: (name) => { if (interactive) sink!.status(`Working: ${name.replace(/_+/g, " ")}...`); },
      onText: (t) => { if (interactive && (depth === "direct" || depth === "memory")) sink!.text(t); },
    });

    // ---- reply (sanitised, mrkdwn, chunked inside the sink) ----
    let reply = result.text;
    const silent = !reply || NO_REPLY.test(reply);
    let out = reply;
    if (result.stopped === "cancelled") out = input.abortSignal?.reason === "replace" ? "_Dropped that; picking up your newer message._" : "_Stopped._";
    else if (result.stopped === "ceiling") out = reply && !silent ? `${reply}\n\n${CEILING_MESSAGE}` : CEILING_MESSAGE;
    else if (result.stopped === "timeout") out = reply && !silent ? reply : TIMEOUT_MSG;
    else if (result.stopped === "step_cap" && !silent && (depth === "tools" || depth === "deep")) out = reply + STEP_CAP_HINT;
    else if (silent) out = "I couldn't generate a reply just now. Please try again in a moment.";
    const cancelled = result.stopped === "cancelled";
    const quiet = silent && !result.stopped && input.trigger === "chime"; // nothing worth saying: leave no trace
    stage = "reply_finish";
    // "Resolved / Not quite" under a real answer (not small talk, errors, cut-off or approval-pending runs)
    const answered = interactive && !!input.userId && !silent && (!result.stopped || (result.stopped === "step_cap" && depth === "memory")) && !result.waitingApproval && depth !== "direct"
      && !result.toolCalls.some((t) => ACTION_TOOL.test(t.name)) && !isActionAck(reply)
      && (QUESTION.test(input.text.replace(/<@[A-Z0-9]+>/g, "").trim()) || result.toolCalls.some((t) => RECALL_TOOL.test(t.name)));
    if (!quiet) await sink.finish(out, answered ? { actions: resolveActions({ u: input.userId!, q: input.text, t: replyThread }) } : undefined);
    reply = silent ? "" : reply;

    await finishRow({
      status: result.waitingApproval ? "waiting_approval" : "done",
      toolCalls: result.toolCalls, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens, cacheWriteTokens: result.cacheWriteTokens, costMicros: result.costMicros,
      model: result.model, steps: result.steps, depth,
      promptBreakdown: breakdown({
        system: system.map((m) => m.content).join("\n"), coreBlocks: "", toolSchemas: schemaTokens(tools, assembled?.active()),
        history: history.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"), recall, user: userContent,
      }),
      ...(result.waitingApproval ? { finishedAt: null } : {}),
    });
    void checkSpendAlert().catch((e) => log.warn("spend alert failed", { error: String(e) }));
    if (input.userId) await recordUsage({ userId: input.userId, inputTokens: result.inputTokens, outputTokens: result.outputTokens }).catch((e) => log.warn("recordUsage failed", { error: String(e) }));

    // ---- learn: only primary turns on shared-safe data; never from personal/leased tool use ----
    const canLearn = agentContext === "primary" && !readOnly && !silent && !cancelled && !ctx.touchedPrivateData && depth !== "direct";
    const threadKey = replyThread ?? input.ts;
    if (canLearn) {
      const transcript = `${input.text}\n\nAssistant: ${reply}`;
      void scheduleCapture({ scope, channelId: input.channelId, threadTs: threadKey, transcript, userText: input.text })
        .catch((e) => log.warn("capture failed", { turnId, error: String(e) }));
    }
    if (depth !== "direct" && bc.compactHistory.length > 6) {
      void maybeCompact({ channelId: input.channelId, threadTs: threadKey, messages: [
        ...bc.compactHistory,
        { ts: input.ts, role: "user", text: input.text },
        { ts: (Date.now() / 1000).toFixed(6), role: "assistant", text: reply },
      ] })
        .catch((e) => log.warn("compaction failed", { turnId, error: String(e) }));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const details = e as { name?: unknown; statusCode?: unknown; status?: unknown; code?: unknown; responseBody?: unknown };
    let providerCode: unknown, providerType: unknown, providerParam: unknown;
    if (typeof details.responseBody === "string") {
      try {
        const body = JSON.parse(details.responseBody) as { error?: Record<string, unknown> };
        const error = body.error ?? {};
        providerCode = error.code;
        providerType = error.type;
        providerParam = error.param;
      } catch { /* never log raw provider response bodies */ }
    }
    const safeLabel = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(v) ? v : undefined;
    log.error("turn failed", {
      turnId, stage, error: msg,
      ...(safeLabel(details.name) ? { errorName: details.name } : {}),
      ...(typeof (details.statusCode ?? details.status) === "number" ? { httpStatus: details.statusCode ?? details.status } : {}),
      ...(safeLabel(details.code) ? { errorCode: details.code } : {}),
      ...(safeLabel(providerCode) ? { providerCode } : {}),
      ...(safeLabel(providerType) ? { providerType } : {}),
      ...(safeLabel(providerParam) ? { providerParam } : {}),
    });
    if (interactive) await (sink?.fail(FAIL_MSG) ?? getSlack().then((s) => s.chat.postMessage({ channel: input.channelId, thread_ts: replyThread, text: FAIL_MSG })).catch(() => undefined));
    await finishRow({ status: "error", error: msg.slice(0, 1000) });
  } finally {
    if (slot) releaseTurnSlot();
  }
}

function schemaTokens(tools: Record<string, unknown>, active?: string[]): number {
  const names = active ?? Object.keys(tools);
  return Math.ceil(names.reduce((n, k) => n + k.length + String((tools[k] as { description?: string })?.description ?? "").length + 120, 0) / 4);
}

// Approval/lease resolutions continue the thread through a normal (serialized) turn. They may report, never act.
setFollowUp(async ({ channelId, threadTs, userId, text, readOnly }) => {
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  await runTurn({
    trigger: "mention", channelId, threadTs: threadTs ?? undefined, ts: (Date.now() / 1000).toFixed(6),
    userId, text, isPrivate: ch?.isPrivate ?? true /* unknown => private (fail closed) */, isIm: ch?.isIm ?? false,
    readOnly: readOnly ?? true,
  });
});

export type { Depth };
