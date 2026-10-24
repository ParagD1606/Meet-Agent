// Anti-hallucination serving path, deterministic parts that sit around the model: feature flags, the <grounding> instruction
// block, the escalate-on-abstain rule and the answer_checks / recall_log writers. No model call anywhere in here.
import { db } from "../db";
import { answerChecks } from "../db/schema";
import { getSetting } from "../manager/commitments";
import { log } from "../log";
import type { Signal } from "../memory/signal";
import { isFactualQuestion, likelyFamilies, type Depth } from "./depth";

export type GroundingFlag = "grounding_signal" | "grounding_citations" | "grounding_receipts";
const cache = new Map<GroundingFlag, { at: number; on: boolean }>();
const TTL_MS = 10_000;
export const clearGroundingFlags = () => cache.clear();

/** Settings flag, default ON. Set the setting to false / "off" / "0" to switch the behaviour off (within ~10 s, no deploy). A read error keeps the default. */
export async function groundingFlag(key: GroundingFlag): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
  let on = true;
  try {
    const v = await getSetting<unknown>(key);
    on = !(v === false || v === 0 || (typeof v === "string" && /^(false|off|0|no)$/i.test(v.trim())));
  } catch (e) { log.warn("grounding flag read failed, using default", { key, error: String(e) }); }
  cache.set(key, { at: Date.now(), on });
  return on;
}

/**
 * The dynamic <grounding> block for a factual question, or "" when the evidence is fine. Lives in the dynamic suffix (not STATIC_SYSTEM)
 * so the cached prefix stays small and byte-identical.
 */
export function groundingBlock(signal: Signal | undefined, o: { depth: Depth; text: string }): string {
  if (!signal || signal.level === "strong" || o.depth === "direct" || !isFactualQuestion(o.text)) return "";
  if (signal.level === "weak") return "<grounding>\nEvidence is thin: say what you found, label uncertainty, do not extrapolate.\n</grounding>";
  const live = o.depth === "memory"
    ? ""
    : " Live tools may still have it: check them first, and claim only what they return.";
  return `<grounding>\nMemory has nothing relevant (anything stated earlier in this thread still counts).${live} Say plainly that you don't have it, say what you did check, and offer next steps (ask the likely owner with ask_teammate, or search connected tools; describe these in plain words, never tool names). Do not guess or fill in from general knowledge about this company.\n</grounding>`;
}

const ABSTAINS = /\b(don'?t|do not) (have|know)|no record|nothing (on|about|in|relevant)|(couldn'?t|can'?t|could not|cannot) (find|see)|not sure|no information|isn'?t in|haven'?t (got|seen)/i;
export const looksLikeAbstention = (reply: string) => ABSTAINS.test(reply);

/** A memory-depth turn that ended in "none" for a question that may live in a connected tool retries once at tools depth. */
export function shouldEscalate(a: { depth: Depth; signal: Signal | undefined; text: string; interactive: boolean; appNames: string[]; usedTools: boolean; replied: string }): boolean {
  if (a.depth !== "memory" || a.signal?.level !== "none" || !a.interactive || a.usedTools || !isFactualQuestion(a.text) || !looksLikeAbstention(a.replied)) return false;
  const t = a.text.toLowerCase();
  return likelyFamilies(a.text).length > 0 || a.appNames.some((n) => n.length >= 3 && t.includes(n.toLowerCase()));
}
/** "you can use GitHub (personal, read+write), Linear (workspace, read-only)" -> ["GitHub", "Linear"] */
export const appNamesOf = (notes: string[]): string[] =>
  notes.flatMap((n) => (n.startsWith("you can use ") ? n.slice(12).split(/\),\s*/).map((p) => p.split(" (")[0]!.trim()) : [])).filter(Boolean);

export type AnswerCheck = { turnId: string; signal?: string; abstained?: boolean; strippedLinks?: number; tautologyBlocked?: boolean; receiptMismatch?: boolean; escalated?: boolean };
/** Best effort, never throws. */
export async function logAnswerCheck(c: AnswerCheck): Promise<void> {
  try {
    await db.insert(answerChecks).values({
      turnId: c.turnId, signal: c.signal ?? null, abstained: !!c.abstained, strippedLinks: c.strippedLinks ?? 0,
      tautologyBlocked: !!c.tautologyBlocked, receiptMismatch: !!c.receiptMismatch, escalated: !!c.escalated,
    });
  } catch (e) { log.warn("answer check log failed", { turnId: c.turnId, error: String(e) }); }
}
