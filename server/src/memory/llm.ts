import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import type { z } from "zod";
import { type ModelRole, withFallback } from "../llm";
import { log } from "../log";

export type MemoryLlm = (a: { system: string; prompt: string; role?: ModelRole }) => Promise<string>;

let override: MemoryLlm | null = null;
/** Test seam: replace the LLM call used for contradiction checks, fact extraction and summaries. */
export function setMemoryLlm(fn: MemoryLlm | null): void {
  override = fn;
}

const TIMEOUT_MS = 60_000;

/** Plain-text completion on a cheap role with timeout, output cap and cross-provider fallback. */
export async function completeText(a: { system: string; prompt: string; role?: ModelRole; maxOutputTokens?: number }): Promise<string> {
  if (override) return override(a);
  const { text } = await withFallback(a.role ?? "extract", (model) =>
    generateText({
      model, system: a.system, prompt: a.prompt, temperature: 0,
      maxOutputTokens: a.maxOutputTokens ?? 1200, abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    }));
  return text;
}

/** Runs the LLM and parses the first JSON object in its reply against `schema`. Throws on any failure. */
export async function completeJson<S extends z.ZodType>(
  a: { system: string; prompt: string; role?: ModelRole; maxOutputTokens?: number },
  schema: S,
): Promise<z.infer<S>> {
  const raw = await completeText(a);
  const start = raw.indexOf("{");
  if (start < 0) {
    log.warn("memory llm reply had no JSON object", { reply: raw.slice(0, 300) });
    throw new Error("LLM reply contained no JSON object");
  }
  // Small/local models often drop a closing brace or wrap the JSON in prose; repair rather than lose the write.
  const body = raw.slice(start, raw.lastIndexOf("}") + 1 || undefined);
  try {
    return schema.parse(JSON.parse(body));
  } catch {
    return schema.parse(JSON.parse(jsonrepair(raw.slice(start))));
  }
}
