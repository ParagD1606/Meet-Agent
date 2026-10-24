import { z } from "zod";
import { log } from "../log";
import { completeJson } from "./llm";

const reply = z.object({ query: z.string().min(1), asOf: z.string().nullish() });

const SYSTEM = `You turn the latest Slack message plus the tail of its thread into ONE standalone search query for a company knowledge base.
The tail may be recent channel messages; when the message points at them ("this info", "above", "are you aware") search the shared TOPIC of those messages (a short query of their key nouns, under 12 words), not the literal words.
Resolve pronouns and follow-ups ("and the second one?", "what about its deadline?") using the thread. Keep names, ids and distinctive nouns verbatim. Do not answer the question and do not add facts.
If the question asks what was true at a past time ("in March", "last quarter", "before the migration"), also give "asOf": the YYYY-MM-DD END of that period, resolved against the given current date. Otherwise null.
Reply with JSON only: {"query":"...","asOf":"YYYY-MM-DD"|null}.`;

/** Words that make a rewrite worthwhile even without thread history (anaphora, relative or past time). */
const NEEDS_REWRITE = /\b(it|its|that|this|those|these|them|they|he|she|him|her|one|ones|info|above|aware|other|same|also|too|again|still|yesterday|last (week|month|quarter|year)|in (january|february|march|april|may|june|july|august|september|october|november|december)|back in|used to|before|as of|ago|previously)\b/i;

export type Rewritten = { query: string; asOf?: Date; rewritten: boolean };

/**
 * One cheap-model call: message + thread tail -> standalone query (+ optional time constraint). Skipped when the message
 * already stands alone (no thread tail and no anaphora/time words). Any failure, timeout or empty reply falls back to the raw text.
 */
export async function rewriteQuery(a: { query: string; threadTail?: string[]; now?: Date }): Promise<Rewritten> {
  const raw = a.query.trim();
  const tail = (a.threadTail ?? []).map((t) => t.replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean).slice(-6);
  if (!raw || (!tail.length && !NEEDS_REWRITE.test(raw))) return { query: raw, rewritten: false };
  const now = a.now ?? new Date();
  try {
    const out = await completeJson({
      system: SYSTEM, role: "triage", maxOutputTokens: 120,
      prompt: `Current date: ${now.toISOString().slice(0, 10)}\n\nTHREAD TAIL:\n${tail.join("\n") || "(none)"}\n\nLATEST MESSAGE: ${raw}`,
    }, reply);
    const query = out.query.trim().slice(0, 500);
    const d = out.asOf && /^\d{4}-\d{2}-\d{2}/.test(out.asOf) ? new Date(`${out.asOf.slice(0, 10)}T23:59:59.999Z`) : undefined;
    return { query: query || raw, asOf: d && !Number.isNaN(d.getTime()) && d < now ? d : undefined, rewritten: !!query && query !== raw };
  } catch (e) {
    log.warn("query rewrite failed, using raw text", { err: String(e).slice(0, 120) });
    return { query: raw, rewritten: false };
  }
}
