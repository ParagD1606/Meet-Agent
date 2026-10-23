import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { getModel } from "../llm";

export const MAX_STEPS = 20;

export type LoopResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: { name: string; ms: number; error?: boolean }[];
  waitingApproval: boolean;
};

let modelOverride: LanguageModel | undefined;
/** Test seam: use a mock language model. */
export const setLoopModel = (m?: LanguageModel) => { modelOverride = m; };

/**
 * Tool loop on the Vercel ai SDK. Only the text of the final step is the reply; text written between
 * tool calls is working thought and is discarded. onStatus fires per tool call, onText with the current step's text.
 */
export async function runLoop(a: {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  onStatus?: (toolName: string) => void;
  onText?: (textSoFar: string) => void;
  abortSignal?: AbortSignal;
}): Promise<LoopResult> {
  const res = streamText({
    model: modelOverride ?? getModel("thorough"),
    system: a.system,
    messages: a.messages,
    tools: a.tools,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal: a.abortSignal,
  });

  let step = "";
  let last = "";
  let waitingApproval = false;
  let streamError: unknown;
  const started = new Map<string, number>();
  const toolCalls: LoopResult["toolCalls"] = [];

  for await (const part of res.fullStream as AsyncIterable<any>) {
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
        const failed = part.type === "tool-error" || (typeof part.output === "string" && part.output.startsWith("ERROR:"));
        toolCalls.push({ name: part.toolName, ms: Date.now() - t0, ...(failed ? { error: true } : {}) });
        if (part.output && typeof part.output === "object" && part.output.status === "awaiting_approval") waitingApproval = true;
        break;
      }
      case "error":
        streamError = part.error;
        break;
    }
  }
  if (streamError && !step.trim() && !last.trim()) throw streamError instanceof Error ? streamError : new Error(String(streamError));
  const usage = await res.totalUsage;
  return {
    text: (step.trim() ? step : last).trim(),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    toolCalls,
    waitingApproval,
  };
}
