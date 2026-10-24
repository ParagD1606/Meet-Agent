import { streamText, type LanguageModel, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";
import { getModel, estimateCostMicros, thinkingLevel, withFallback } from "../llm";
import { log } from "../log";
import { createTurnBudget, type TurnBudget } from "../limits";
import { clearOldToolResults, spillIfLarge } from "./spill";
import type { Depth } from "./depth";
import { appendReceipts, claimTargets, targetBacked, type ToolOutput } from "./verify-answer";

const OUTPUT_CAP = 20_000; // chars kept per tool result
const OUTPUTS_TOTAL_CAP = 200_000;

export const MAX_STEPS = 60;
export const TURN_TIMEOUT_MS = 120_000;

export type ToolCallRecord = { name: string; ms: number; error?: boolean };

export type LoopResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  model: string;
  steps: number;
  toolCalls: ToolCallRecord[];
  waitingApproval: boolean;
  /** Why the loop stopped early, if it did. */
  stopped?: "ceiling" | "timeout" | "step_cap" | "cancelled";
  /** Messages this run added (assistant + tool results); lets a repair step continue where it left off. */
  responseMessages?: ModelMessage[];
  /** Text of every tool result this turn (capped): backs receipts, the citation allowlist and the tautology guard. */
  toolOutputs?: ToolOutput[];
  /** What the claim guard did (answer_checks). */
  guard?: { receiptMismatch?: boolean; receiptsAdded?: number };
};

let modelOverride: LanguageModel | undefined;
/** Test seam: use a mock language model. */
export const setLoopModel = (m?: LanguageModel) => { modelOverride = m; };

const modelName = (m: LanguageModel): string => (typeof m === "string" ? m : (m as { modelId?: string }).modelId ?? "unknown");

// ---- structured tool errors -------------------------------------------------------------------------------

export type ToolErrorKind = "invalid_arguments" | "remote_error" | "auth_required" | "timeout" | "unavailable" | "duplicate_call" | "internal_error";

export function toolError(tool: string, e: unknown): { status: "error"; kind: ToolErrorKind; tool: string; message: string; suggestion: string; retryable: boolean } {
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 400);
  const name = e instanceof Error ? e.name : "";
  const mk = (kind: ToolErrorKind, suggestion: string, retryable: boolean) => ({ status: "error" as const, kind, tool, message, suggestion, retryable });
  if (/abort|timeout|timed out/i.test(name + message)) return mk("timeout", "Retry once with a narrower request, or use another source.", true);
  if (/reauth|unauthori[sz]ed|\b401\b|\b403\b|forbidden|token/i.test(name + message)) return mk("auth_required", "The connection needs to be re-authorised; use request_connection and tell the user.", false);
  if (/invalid|required|expected|schema|validation|zod/i.test(name + message)) return mk("invalid_arguments", "Fix the arguments to match the tool schema and retry once.", true);
  if (/ECONN|ENOTFOUND|unavailable|5\d\d/i.test(message)) return mk("unavailable", "The service is unreachable; try another source or say what you could not reach.", true);
  return mk("remote_error", "Do not repeat the same call; try a different method or say what blocked you.", false);
}

const NO_SPILL = new Set(["read_tool_result", "post_update", "enable_tool_family"]);

/** Tools that write, notify, ask or save. A reply claiming an action needs one of these to have succeeded; Resolve buttons never follow one. */
export const ACTION_TOOL = /^(?!post_update$).*(assign|update|notify|ask_|remember|follow_up|forget|core_memory|create|delete|send|schedule|request_|call_tool)/;
const READ_CAP = 3; // same read tool, per turn: past this the model is thrashing, not learning
const CALL_TOOL_CAP = 6;
const LIVE_SLACK = /^(search_slack_live|read_thread)$/;

/**
 * Every tool call: exceptions become structured errors (never crash the loop), identical failing calls are
 * refused, and large outputs are spilled to `tool_results` (preview + handle) before they enter the context.
 */
export function wrapTools(tools: ToolSet, turnId: string): ToolSet {
  const failed = new Set<string>();
  const used = new Map<string, number>();
  let haveTasks = false; // find_tasks already returned rows: live Slack search adds nothing
  const done = new Map<string, string>(); // successful results by call, so an identical repeat costs nothing and nudges the model to answer
  const out: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const exec = (t as { execute?: (input: unknown, opts: unknown) => unknown }).execute;
    if (!exec) { out[name] = t; continue; }
    out[name] = {
      ...t,
      execute: async (input: unknown, opts: unknown) => {
        const key = `${name}:${JSON.stringify(input)}`;
        if (failed.has(key)) {
          return { status: "error", kind: "duplicate_call", tool: name, message: "Identical call already failed this turn.", suggestion: "Change the arguments or use a different approach.", retryable: false };
        }
        const cached = done.get(key);
        if (cached !== undefined) return `${cached}\n\n[host] Already ran this exact call this turn; answer now with what you have.`;
        if (!NO_SPILL.has(name)) {
          if (LIVE_SLACK.test(name) && haveTasks) return "Tracked tasks already answered this; answer from them now (search Slack only if the user asked for live Slack).";
          const cap = name === "call_tool" ? CALL_TOOL_CAP : ACTION_TOOL.test(name) ? Infinity : READ_CAP;
          if ((used.get(name) ?? 0) >= cap) return "Enough searching: answer or act now with what you have.";
          used.set(name, (used.get(name) ?? 0) + 1);
        }
        try {
          const res = await exec(input, opts);
          if (NO_SPILL.has(name) || res == null) return res;
          if (typeof res === "object" && "status" in (res as object)) return res; // approvals, structured errors
          const text = typeof res === "string" ? res : JSON.stringify(res);
          if (text.startsWith("ERROR:")) failed.add(key);
          const kept = await spillIfLarge({ turnId, toolName: name, text });
          if (name === "find_tasks" && text.startsWith("- [")) haveTasks = true;
          if (!text.startsWith("ERROR:")) done.set(key, typeof kept === "string" ? kept : JSON.stringify(kept));
          return kept;
        } catch (e) {
          failed.add(key);
          log.warn("tool failed", { tool: name, error: String(e) });
          return toolError(name, e);
        }
      },
    } as typeof t;
  }
  return out;
}

// ---- the loop ---------------------------------------------------------------------------------------------

export type LoopArgs = {
  system: SystemModelMessage[] | string;
  messages: ModelMessage[];
  tools: ToolSet;
  turnId: string;
  role?: "main" | "triage";
  depth: Depth;
  maxSteps: number;
  maxOutputTokens: number;
  /** A's per-turn token budget (aborts the call at the ceiling). Created from admin limits when omitted. */
  budget?: TurnBudget;
  /** Names the model may see this step (enable_tool_family grows it). undefined = all. */
  activeTools?: () => string[] | undefined;
  timeoutMs?: number;
  onStatus?: (toolName: string) => void;
  onText?: (textSoFar: string) => void;
  abortSignal?: AbortSignal;
  /** grounding_receipts: the claim guard also checks WHO an action was claimed for, and write receipts are appended to the reply. Off = the original claim guard only. */
  receipts?: boolean;
};

/** Gemini 3.x spends hidden "thinking" tokens out of maxOutputTokens: on memory turns that was ~90% of the budget and cut answers mid-link. Keep it small for quick turns; deep turns keep the model default. Other providers ignore these keys. */
export const thinkingOptions = (depth: Depth) => {
  const level = depth === "direct" || depth === "memory" ? "minimal" : depth === "tools" ? "low" : undefined;
  return level ? thinkingLevel(level) : undefined;
};

const WRAP_UP = "[host] You are almost out of room for this request. Answer now with what you have found. Say plainly what you did not get to and what would let you go further. Do not call tools.";

/** A model sometimes writes a tool call as plain text (`call:name arg="x" /`, <tool_call>, ```tool_code```) instead of calling it. Never show that. */
const LEAK = /(^|\n)\s*call:[a-z_]+\b|<tool_call>|```tool_code/i;
export const leaksToolCall = (text: string) => LEAK.test(text);

const REPAIR = "[host] Your last message contained a raw tool call, not a real one: call the tool properly or answer in plain text.";
const CLAIM_NUDGE = "[host] You claimed an action but called no tool; call the right tool now or say plainly that you did not do it.";
/** First-person claims of having acted ("I've told him", "I'll let him know", "sent", "created the task"). */
const CLAIM = /\b(i'?ve|i have|i just)\s+(told|informed|messaged|notified|queued|asked|sent|updated|created|assigned|scheduled|passed (it|that) on|let \w+ know)\b|\bi (told|informed|messaged|notified|queued|passed (it|that) on)\b|\bi'?ll let (him|her|them|\w+) know\b/i;
/** "Dana has been notified", "assignee was told": a passive claim of acting (checked only with grounding_receipts). */
const PASSIVE_CLAIM = /\b(has|have)\s+(now |just |already )?been\s+(told|informed|notified|messaged|pinged|reminded)\b/i;
const claimsAction = (r: LoopResult) => CLAIM.test(r.text) && !r.waitingApproval && !r.toolCalls.some((t) => !t.error && ACTION_TOOL.test(t.name));
const claimSentencesOf = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).filter((s) => CLAIM.test(s) || PASSIVE_CLAIM.test(s));
/** Claimed actions for people (or ids) that no successful write result of this turn mentions. [] = nothing to repair. */
export function unbackedTargets(r: Pick<LoopResult, "text" | "waitingApproval" | "toolOutputs">): string[] {
  if (r.waitingApproval) return [];
  const targets = claimTargets(claimSentencesOf(r.text).join(" "));
  const acts = (r.toolOutputs ?? []).filter((o) => ACTION_TOOL.test(o.name));
  return targets.filter((t) => !targetBacked(t, acts));
}

export async function runLoop(a: LoopArgs): Promise<LoopResult> {
  const args = { ...a, budget: a.budget ?? await createTurnBudget() };
  let r = await runWithRecovery(args);
  // one repair step per failure shape: show the model its mistake, then let it continue
  const tools = args.activeTools?.() ?? Object.keys(args.tools);
  const repair = async (first: LoopResult, nudge: string): Promise<LoopResult> => {
    const msg: ModelMessage = { role: "user", content: `${nudge} Tools: ${tools.join(", ")}.` };
    try {
      const n = await runOnce({ ...args, messages: [...args.messages, ...(first.responseMessages ?? []), msg], maxSteps: Math.min(args.maxSteps, 3) }, modelOverride ?? getModel(args.role ?? "main"));
      return {
        ...n,
        inputTokens: first.inputTokens + n.inputTokens, outputTokens: first.outputTokens + n.outputTokens,
        cacheReadTokens: first.cacheReadTokens + n.cacheReadTokens, cacheWriteTokens: first.cacheWriteTokens + n.cacheWriteTokens,
        costMicros: first.costMicros + n.costMicros, steps: first.steps + n.steps, toolCalls: [...first.toolCalls, ...n.toolCalls],
        toolOutputs: [...(first.toolOutputs ?? []), ...(n.toolOutputs ?? [])],
        waitingApproval: first.waitingApproval || n.waitingApproval,
      };
    } catch (error) { log.warn("repair step failed", { turnId: args.turnId, error: String(error) }); return first; }
  };

  if (leaksToolCall(r.text)) {
    const first = r;
    r = await repair(r, REPAIR);
    if (leaksToolCall(r.text)) {
      const name = r.text.match(/call:([a-z_]+)/i)?.[1] ?? first.text.match(/call:([a-z_]+)/i)?.[1];
      log.warn("raw tool call text suppressed", { turnId: args.turnId, tool: name });
      r = { ...r, text: `I couldn't complete that action just now. Here's what I understood: you wanted me to ${name ? `use ${name.replace(/_/g, " ")}` : "do something with a tool"}, but it didn't go through. Could you say it again, or tell me exactly what you'd like me to do?` };
    }
  }
  const unbacked = (x: LoopResult) => (a.receipts && !x.stopped ? unbackedTargets(x) : []);
  if (!r.stopped && (claimsAction(r) || unbacked(r).length)) {
    const who = unbacked(r);
    r = await repair(r, who.length && !claimsAction(r) ? `[host] You said you told, notified or assigned ${who.join(", ")}, but no tool result this turn confirms it for them. Call the right tool now, or say plainly that you did not do it.` : CLAIM_NUDGE);
    if (who.length) r = { ...r, guard: { ...r.guard, receiptMismatch: true } };
    const still = unbacked(r);
    if (claimsAction(r) || still.length || leaksToolCall(r.text)) {
      log.warn("unbacked action claim suppressed", { turnId: args.turnId, targets: still });
      r = { ...r, text: "I didn't actually do that: no action went through on my side. Tell me what you'd like and I'll try again, or do it directly.", guard: { ...r.guard, receiptMismatch: r.guard?.receiptMismatch || still.length > 0 } };
    }
  }
  // receipts: what a write tool really returned (id, assignee, due, link), appended unless the reply already carries it
  if (a.receipts && !r.stopped && !r.waitingApproval && r.text) {
    const { text, added } = appendReceipts(r.text, r.toolOutputs ?? []);
    r = { ...r, text, guard: { ...r.guard, receiptsAdded: added } };
  }
  return r;
}

async function runWithRecovery(args: LoopArgs & { budget: TurnBudget }): Promise<LoopResult> {
  const attempt = (model: LanguageModel) => runOnce(args, model);
  const first = modelOverride ? await attempt(modelOverride) : await withFallback(args.role ?? "main", attempt);

  // A provider can finish successfully while returning only hidden reasoning or no text at all.
  // Recover once for lightweight, tool-free turns; never replay a turn that may have acted.
  if (first.text.trim() || /^\s*NO_REPLY\s*$/.test(first.text) || first.stopped || first.toolCalls.length || first.waitingApproval || !["direct", "memory"].includes(args.depth)) {
    return first;
  }

  const recoveryInstruction = "The previous response contained no user-visible answer. Answer the user's latest request directly and concisely using only the supplied context. If the context is insufficient, say what is missing. Do not return an empty answer or a control token.";
  const system = Array.isArray(args.system)
    ? [...args.system, { role: "system", content: recoveryInstruction } as SystemModelMessage]
    : `${args.system}\n\n${recoveryInstruction}`;
  try {
    const recovery = await runOnce({ ...args, system, tools: {}, maxSteps: 1, maxOutputTokens: Math.min(args.maxOutputTokens, 400), activeTools: undefined, onStatus: undefined }, getModel("triage"));
    return {
      ...recovery,
      text: recovery.text || first.text,
      inputTokens: first.inputTokens + recovery.inputTokens,
      outputTokens: first.outputTokens + recovery.outputTokens,
      cacheReadTokens: first.cacheReadTokens + recovery.cacheReadTokens,
      cacheWriteTokens: first.cacheWriteTokens + recovery.cacheWriteTokens,
      costMicros: first.costMicros + recovery.costMicros,
      model: recovery.text ? recovery.model : first.model,
      steps: first.steps + recovery.steps,
      toolCalls: first.toolCalls,
      waitingApproval: first.waitingApproval,
      stopped: recovery.stopped,
    };
  } catch (error) {
    log.warn("empty response recovery failed", {
      turnId: args.turnId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return first;
  }
}

async function runOnce(a: LoopArgs, model: LanguageModel): Promise<LoopResult> {
  const budget = a.budget ?? (await createTurnBudget());
  const cap = Math.max(1, Math.min(a.maxSteps, MAX_STEPS));
  const signals = [AbortSignal.timeout(a.timeoutMs ?? TURN_TIMEOUT_MS), budget.signal, ...(a.abortSignal ? [a.abortSignal] : [])];
  const abortSignal = AbortSignal.any(signals);
  let stopped: LoopResult["stopped"];
  let wrapUp = false; // the last-step "answer now" nudge was sent

  const res = streamText({
    model,
    system: a.system as never,
    messages: a.messages,
    tools: wrapTools(a.tools, a.turnId),
    maxOutputTokens: a.maxOutputTokens,
    ...(thinkingOptions(a.depth) ? { providerOptions: thinkingOptions(a.depth) } : {}),
    abortSignal,
    onStepFinish: (s: { usage: Parameters<TurnBudget["add"]>[0] }) => { budget.add(s.usage); },
    stopWhen: ({ steps }: { steps: unknown[] }) => budget.exceeded || steps.length >= cap,
    prepareStep: async ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) => {
      const msgs = clearOldToolResults(messages);
      if (cap > 1 && stepNumber >= cap - 1) {
        wrapUp = true;
        return { messages: [...msgs, { role: "user", content: WRAP_UP } as ModelMessage], activeTools: [] as never, toolChoice: "none" as const };
      }
      const active = a.activeTools?.();
      return { messages: msgs, ...(active ? { activeTools: active as never } : {}) };
    },
  } as never);

  let step = "";
  let last = "";
  let finish = ""; // finishReason of the latest step
  let waitingApproval = false;
  let streamError: unknown;
  const started = new Map<string, number>();
  const toolCalls: ToolCallRecord[] = [];
  const toolOutputs: ToolOutput[] = [];
  let outputChars = 0;
  try {
    for await (const part of (res as { fullStream: AsyncIterable<any> }).fullStream) {
      switch (part.type) {
        case "start-step":
          if (step.trim()) last = step;
          step = "";
          break;
        case "finish-step":
          finish = String(part.finishReason?.unified ?? part.finishReason ?? "");
          break;
        case "text-delta":
          step += part.text ?? part.delta ?? "";
          if (!LEAK.test(step)) a.onText?.(step); // never stream a raw pseudo tool call
          break;
        case "tool-call":
          started.set(part.toolCallId, Date.now());
          a.onStatus?.(part.toolName);
          break;
        case "tool-result":
        case "tool-error": {
          const t0 = started.get(part.toolCallId) ?? Date.now();
          const out = part.output;
          const failed = part.type === "tool-error" || (typeof out === "string" && out.startsWith("ERROR:")) || (out && typeof out === "object" && out.status === "error");
          toolCalls.push({ name: part.toolName, ms: Date.now() - t0, ...(failed ? { error: true } : {}) });
          if (outputChars < OUTPUTS_TOTAL_CAP) {
            const raw = part.type === "tool-error" ? String(part.error ?? "") : typeof out === "string" ? out : JSON.stringify(out ?? "");
            const text = raw.slice(0, OUTPUT_CAP);
            outputChars += text.length;
            toolOutputs.push({ name: part.toolName, text, ...(failed ? { error: true } : {}) });
          }
          if (out && typeof out === "object" && out.status === "awaiting_approval") waitingApproval = true;
          break;
        }
        case "error":
          streamError = part.error;
          break;
      }
    }
  } catch (e) { streamError ??= e; }

  if (budget.exceeded) stopped = "ceiling";
  else if (a.abortSignal?.aborted) stopped = "cancelled";
  else if (abortSignal.aborted) stopped = "timeout";
  // step_cap = the wrap-up step did NOT land a complete answer (empty, cut off, or still calling tools); a finished answer is just an answer
  else if (wrapUp && (!step.trim() || finish === "tool-calls" || finish === "length")) stopped = "step_cap";
  const text = (step.trim() ? step : last).trim();
  if (streamError && !stopped && !text) throw streamError instanceof Error ? streamError : new Error(String(streamError));
  if (streamError) log.warn("stream error after output", { error: String(streamError) });

  let steps: Awaited<typeof res.steps> = [];
  try { steps = await res.steps; } catch { /* aborted before any step finished */ }
  const sum = (f: (u: any) => number | undefined) => steps.reduce((n, s) => n + (f(s.usage) ?? 0), 0);
  const inputTokens = sum((u) => u.inputTokens);
  const outputTokens = sum((u) => u.outputTokens);
  const cacheReadTokens = sum((u) => u.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens = sum((u) => u.inputTokenDetails?.cacheWriteTokens);
  let responseMessages: ModelMessage[] | undefined;
  try { responseMessages = (await res.response).messages as ModelMessage[]; } catch { /* aborted */ }
  const name = modelName(model);
  const costMicros = estimateCostMicros(name, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
  return { text, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicros, model: name, steps: steps.length, toolCalls, waitingApproval, stopped, responseMessages, toolOutputs };
}
