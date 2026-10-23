import { z } from "zod";
import { log } from "../log";
import { completeJson } from "./llm";
import { type SlackScope, writeTag } from "./scope";
import { addFact } from "./supersede";

const MAX_FACTS = 8;
const MAX_TRANSCRIPT = 24_000;
const schema = z.object({ facts: z.array(z.string()) });

const SYSTEM = `You extract durable company knowledge from a Slack conversation between teammates and an AI assistant.
Extract only facts worth remembering weeks from now: decisions made, owners/assignees, deadlines and dates, commitments, customer or project status, preferences, stable how-things-work knowledge.
Each fact must be ONE self-contained sentence that is understandable alone: name people and things explicitly, resolve "he/it/that/tomorrow" into names and absolute dates when the conversation allows, and never include Slack user ids or @-mention tokens.
Skip greetings, small talk, questions, transient results, speculation, instructions to the assistant, secrets (passwords, tokens, keys) and anything already trivial.
Return at most ${MAX_FACTS} facts. Reply with JSON only: {"facts":["..."]}. Use {"facts":[]} when nothing is durable.`;

/** Extracts durable facts from a finished turn and stores them in the scope's write tag. Returns #new facts stored. Never throws. */
export async function captureTurn(a: { scope: SlackScope; transcript: string; sourceRef?: string }): Promise<number> {
  const tag = writeTag(a.scope);
  if (!tag) return 0;
  const transcript = a.transcript.trim();
  if (!transcript) return 0;
  let facts: string[];
  try {
    const out = await completeJson(
      { system: SYSTEM, prompt: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nCONVERSATION:\n${transcript.slice(-MAX_TRANSCRIPT)}` },
      schema,
    );
    facts = [...new Set(out.facts.map((f) => f.trim()).filter((f) => f.length >= 8))].slice(0, MAX_FACTS);
  } catch (e) {
    log.warn("captureTurn extraction failed", { err: String(e) });
    return 0;
  }
  let stored = 0;
  for (const text of facts) {
    try {
      const r = await addFact({ tag, text, source: "slack", sourceRef: a.sourceRef ?? a.scope.channelId });
      if (!r.deduped) stored++;
    } catch (e) {
      log.warn("captureTurn addFact failed", { err: String(e) });
    }
  }
  return stored;
}
