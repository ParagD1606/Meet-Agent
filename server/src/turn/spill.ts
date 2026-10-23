import { tool, type ModelMessage } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { toolResults, turns } from "../db/schema";
import { log } from "../log";

/** Results at/below this many chars (after minifying) go to the model verbatim. */
export const SPILL_THRESHOLD = 3000;
export const PREVIEW_CHARS = 1500;
/** Per-turn aggregate of tool output we let into the context; past it every result is a short preview. */
export const TURN_RESULT_BUDGET = 24_000;
const OVER_BUDGET_PREVIEW = 400;
const READ_MAX = 4000;

const used = new Map<string, number>();
/** Forget a turn's running total (call from the turn's `finally`). */
export const endTurnSpill = (turnId: string) => void used.delete(turnId);

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune).filter((x) => !isEmpty(x));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (!isEmpty(p)) o[k] = p;
    }
    return o;
  }
  return v;
}

/** Drops nulls/empty fields from JSON, strips HTML to text, collapses whitespace. Pure. */
export function minifyToolOutput(text: string): string {
  const t = text.trim();
  if (/^[[{]/.test(t)) {
    try { return JSON.stringify(prune(JSON.parse(t))); } catch { /* not JSON */ }
  }
  let s = text;
  if (/<\/?(html|body|div|p|span|script|style|table|ul|li|a)\b/i.test(s)) {
    s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  }
  return s.replace(/[ \t]+/g, " ").replace(/\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Tool-result diet: minify; if it fits (per call and per-turn budget) return it, otherwise store the full text in
 * `tool_results` and return a ~1.5k-char preview plus a handle for `read_tool_result`.
 */
export async function spillIfLarge(a: { turnId: string; toolName: string; text: string; maxChars?: number }): Promise<string> {
  const min = minifyToolOutput(a.text);
  const total = used.get(a.turnId) ?? 0;
  const over = total >= TURN_RESULT_BUDGET;
  if (min.length <= (a.maxChars ?? SPILL_THRESHOLD) && total + min.length <= TURN_RESULT_BUDGET) {
    used.set(a.turnId, total + min.length);
    return min;
  }
  const preview = min.slice(0, over ? OVER_BUDGET_PREVIEW : PREVIEW_CHARS);
  used.set(a.turnId, total + preview.length);
  const handle = newId("tr_");
  try {
    await db.insert(toolResults).values({ id: handle, turnId: a.turnId, toolName: a.toolName, content: min, bytes: Buffer.byteLength(min) });
  } catch (e) {
    log.warn("tool result spill failed", { err: String(e) });
    return `${preview}\n[truncated: ${preview.length} of ${min.length} chars shown]`;
  }
  return `${preview}\n[truncated: ${preview.length} of ${min.length} chars shown. read_tool_result({handle:"${handle}", offset:${preview.length}}) for more]`;
}

/** Reads a slice of a spilled result. When `channelId` is given, only results produced in that channel are readable. */
export async function readToolResult(a: { handle: string; offset?: number; length?: number; channelId?: string }): Promise<string> {
  const [row] = await db.select({ content: toolResults.content, turnChannel: turns.channelId })
    .from(toolResults).leftJoin(turns, eq(turns.id, toolResults.turnId)).where(eq(toolResults.id, a.handle));
  if (!row || (a.channelId && row.turnChannel !== a.channelId)) return "No stored result with that handle.";
  const offset = Math.max(0, a.offset ?? 0);
  const len = Math.min(READ_MAX, Math.max(1, a.length ?? 2000));
  const slice = row.content.slice(offset, offset + len);
  const end = offset + slice.length;
  return end < row.content.length
    ? `${slice}\n[chars ${offset}-${end} of ${row.content.length}; next offset ${end}]`
    : `${slice}\n[end of result, ${row.content.length} chars]`;
}

export function readToolResultTool(ctx: { channelId: string }) {
  return {
    read_tool_result: tool({
      description: "Read more of a truncated tool result by its handle.",
      inputSchema: z.object({ handle: z.string(), offset: z.number().int().min(0).optional(), length: z.number().int().min(1).max(READ_MAX).optional() }),
      execute: async (i) => readToolResult({ ...i, channelId: ctx.channelId }),
    }),
  };
}

const textOf = (output: unknown): string => {
  const o = output as { value?: unknown } | undefined;
  const v = o && typeof o === "object" && "value" in o ? o.value : output;
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
};

/**
 * Between-steps diet: replaces every tool result except the most recent `keepLast` tool messages with a one-line stub
 * (keeping any read_tool_result handle so the model can still fetch it). Pure; returns a new array.
 */
export function clearOldToolResults(messages: ModelMessage[], keepLast = 1): ModelMessage[] {
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const clear = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keepLast)));
  if (!clear.size) return messages;
  return messages.map((m, i) => {
    if (!clear.has(i) || m.role !== "tool") return m;
    return {
      ...m,
      content: m.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const body = textOf(part.output);
        if (body.startsWith("[cleared")) return part;
        const handle = /handle:"(tr_[A-Za-z0-9_-]+)"/.exec(body)?.[1];
        const stub = `[cleared ${part.toolName} result, ${body.length} chars, already used${handle ? `; full text: read_tool_result handle ${handle}` : ""}]`;
        return { ...part, output: { type: "text" as const, value: stub } };
      }),
    };
  });
}

/** Per-turn totals for observability (`turns.promptBreakdown.toolResults`). */
export const turnSpillChars = (turnId: string) => used.get(turnId) ?? 0;
