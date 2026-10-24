import { z } from "zod";
import { log } from "../log";
import { completeJson } from "./llm";

const reply = z.object({ ranked: z.array(z.number().int()) });

const SYSTEM = `You rerank candidate company-memory facts for a search query. Return the ids of the candidates that help answer the query, most useful first. Omit candidates that are irrelevant. Reply with JSON only: {"ranked":[<ids>]}.`;

/** Off by default (extra latency + cost per turn); enable with MEMORY_RERANK=true once the eval shows it pays off. */
export const rerankEnabled = () => /^(1|true|on)$/i.test(process.env.MEMORY_RERANK ?? "");
export const RERANK_TOP = 30;

/**
 * Listwise LLM rerank through the same cheap-model seam as the rest of memory (completeJson, "triage" role). Takes the head
 * of an already-ranked list and returns only the candidates the model kept, in its order (an empty list means nothing
 * is relevant, which is how it helps abstention). Ids it invents are ignored. Any failure returns the input order unchanged.
 */
export async function rerank<T extends { id: number; text: string }>(query: string, items: T[], top = RERANK_TOP): Promise<T[]> {
  const head = items.slice(0, top);
  if (head.length < 2) return items;
  try {
    const out = await completeJson({
      system: SYSTEM, role: "triage", maxOutputTokens: 200,
      prompt: `QUERY: ${query}\n\nCANDIDATES:\n${head.map((h) => `[${h.id}] ${h.text.slice(0, 300)}`).join("\n")}`,
    }, reply);
    const byId = new Map(head.map((h) => [h.id, h]));
    const kept = [...new Set(out.ranked)].map((id) => byId.get(id)).filter((h): h is T => !!h);
    return kept;
  } catch (e) {
    log.warn("rerank failed, keeping fused order", { err: String(e).slice(0, 120) });
    return items;
  }
}
