import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import type { z } from "zod";
import { auxThinking, type ModelRole, withFallback } from "../llm";
import { log } from "../log";

export type MemoryLlm = (a: { system: string; prompt: string; role?: ModelRole }) => Promise<string>;

let override: MemoryLlm | null = null;
/** Test seam: replace the LLM call used for contradiction checks, fact extraction and summaries. */
export function setMemoryLlm(fn: MemoryLlm | null): void {
  override = fn;
}

const TIMEOUT_MS = 60_000;

/** Plain-text completion on a cheap role with timeout, output cap and cross-provider fallback. */
export async function completeText(a: { system: string; prompt: string; role?: ModelRole; maxOutputTokens?: number; providerOptions?: Record<string, any> }): Promise<string> {
  if (override) return override(a);
  const { text } = await withFallback(a.role ?? "extract", (model) =>
    generateText({
      model, system: a.system, prompt: a.prompt, temperature: 0,
      maxOutputTokens: a.maxOutputTokens ?? 1200, providerOptions: (a.providerOptions ?? auxThinking) as never, abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    }));
  return text;
}

/** First balanced `{...}` in `raw` (string-aware), or null when the object never closes. */
function firstBalanced(raw: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

/**
 * Parses the first JSON object in a model reply against `schema`. Small/local models drop closing braces, add prose or
 * code fences, so: balanced object -> as-is -> jsonrepair of everything from the first `{`. Throws only when none validate.
 */
export function parseModelJson<S extends z.ZodType>(raw: string, schema: S): z.infer<S> {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("LLM reply contained no JSON object");
  const attempts: (() => unknown)[] = [];
  const balanced = firstBalanced(raw, start);
  if (balanced) attempts.push(() => JSON.parse(balanced));
  attempts.push(() => JSON.parse(jsonrepair(raw.slice(start))));
  attempts.push(() => JSON.parse(jsonrepair(balanced ?? raw.slice(start, raw.lastIndexOf("}") + 1 || undefined))));
  let last: unknown;
  for (const a of attempts) {
    try { return schema.parse(a()); } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Runs the LLM and parses the first JSON object in its reply against `schema`. Throws on any failure. */
export async function completeJson<S extends z.ZodType>(
  a: { system: string; prompt: string; role?: ModelRole; maxOutputTokens?: number; providerOptions?: Record<string, any> },
  schema: S,
): Promise<z.infer<S>> {
  const raw = await completeText(a);
  try {
    return parseModelJson(raw, schema);
  } catch (e) {
    log.warn("memory llm reply not parseable", { reply: raw.slice(0, 300), err: String(e).slice(0, 120) });
    throw e;
  }
}
