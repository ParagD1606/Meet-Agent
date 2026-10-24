import { streamText, type LanguageModel, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";
import { getModel, estimateCostMicros, withFallback } from "../llm";
import { log } from "../log";
import { createTurnBudget, type TurnBudget } from "../limits";
import { clearOldToolResults, spillIfLarge } from "./spill";
import type { Depth } from "./depth";

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

/**
 * Every tool call: exceptions become structured errors (never crash the loop), identical failing calls are
 * refused, and large outputs are spilled to `tool_results` (preview + handle) before they enter the context.
 */
export function wrapTools(tools: ToolSet, turnId: string): ToolSet {
  const failed = new Set<string>();
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
        try {
          const res = await exec(input, opts);
          if (NO_SPILL.has(name) || res == null) return res;
          if (typeof res === "object" && "status" in (res as object)) return res; // approvals, structured errors
          const text = typeof res === "string" ? res : JSON.stringify(res);
          if (text.startsWith("ERROR:")) failed.add(key);
          return await spillIfLarge({ turnId, toolName: name, text });
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
};

const WRAP_UP = "[host] You are almost out of room for this request. Answer now with what you have found. Say plainly what you did not get to and what would let you go further. Do not call tools.";

export async function runLoop(a: LoopArgs): Promise<LoopResult> {
  const args = { ...a, budget: a.budget ?? await createTurnBudget() };
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

  const res = streamText({
    model,
    system: a.system as never,
    messages: a.messages,
    tools: wrapTools(a.tools, a.turnId),
    maxOutputTokens: a.maxOutputTokens,
    abortSignal,
    onStepFinish: (s: { usage: Parameters<TurnBudget["add"]>[0] }) => { budget.add(s.usage); },
    stopWhen: ({ steps }: { steps: unknown[] }) => budget.exceeded || steps.length >= cap,
    prepareStep: async ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) => {
      const msgs = clearOldToolResults(messages);
      if (cap > 1 && stepNumber >= cap - 1) {
        stopped ??= "step_cap";
        return { messages: [...msgs, { role: "user", content: WRAP_UP } as ModelMessage], activeTools: [] as never, toolChoice: "none" as const };
      }
      const active = a.activeTools?.();
      return { messages: msgs, ...(active ? { activeTools: active as never } : {}) };
    },
  } as never);

  let step = "";
  let last = "";
  let waitingApproval = false;
  let streamError: unknown;
  const started = new Map<string, number>();
  const toolCalls: ToolCallRecord[] = [];
  try {
    for await (const part of (res as { fullStream: AsyncIterable<any> }).fullStream) {
      switch (part.type) {
        case "start-step":
          if (step.trim()) last = step;
          step = "";
          break;
        case "text-delta":
          step += part.text ?? part.delta ?? "";
          a.onText?.(step);
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
  const name = modelName(model);
  const costMicros = estimateCostMicros(name, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
  return { text, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costMicros, model: name, steps: steps.length, toolCalls, waitingApproval, stopped };
}
