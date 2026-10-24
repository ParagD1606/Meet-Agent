/**
 * Free heuristics that run BEFORE the triage model so most channel chatter costs zero tokens.
 * Default is to skip: only messages that look like a question/ask, a decision/incident, or an announcement reach the model.
 */
export type PrefilterInput = {
  text: string;
  botUserId: string;
  context: "thread" | "channel";
  /** Last human speaker in the thread before this message, if known (a reply between two people is not ours). */
  lastSpeakerId?: string | null;
  speakerId?: string | null;
  lastWasBot?: boolean;
};
export type PrefilterResult = { pass: true } | { pass: false; reason: string };

const ASK = /\b(anyone|anybody|someone|somebody|who (owns|knows|is|was|has|can)|what('?s| is| was| did| are)|when (is|was|did|are|do)|where (is|are|do|can)|how (do|does|did|can|should|many|much)|why (is|did|does|are)|can (we|you|someone|anyone)|could (we|you|someone)|do (we|you) (have|know)|does (anyone|anybody)|is there|are there|any (idea|update|news|luck)|status|remember (when|what)|did we (decide|agree)|need (help|a hand)|help me|(looking|search(ing)?) for|blocked|stuck)\b/i;
const SIGNAL = /\b(decid(ed|e|ion)|agreed|deadline|due (date|on|by)|owner|owns|incident|outage|down(time)?|sev ?[0-3]|postmortem|post-mortem|rollback|launch(ed)?|shipp?(ed|ing)|released?|migrat(e|ion)|(we|i)('ll| will) (own|take|handle)|action item|brain)\b/i;
const ANNOUNCE = /\b(welcome|congrats|congratulations|we (won|closed|signed|hit|did it)|just (shipped|launched|released|merged)|last day|farewell|milestone)\b/i;

const strip = (t: string) => t.replace(/<(?:https?:[^>]*|![^>]*|#[^>]*)>/g, " ").replace(/```[\s\S]*?```/g, " ").replace(/:[a-z0-9_+-]+:/gi, " ").replace(/<@[A-Z0-9]+>/g, "@").replace(/\s+/g, " ").trim();

export function triagePrefilter(i: PrefilterInput): PrefilterResult {
  const raw = i.text ?? "";
  const t = strip(raw);
  if (t.replace(/@/g, "").trim().length < 12 && !t.includes("?")) return { pass: false, reason: "too_short" };
  if (t.length > 2_000) return { pass: false, reason: "wall_of_text" };
  // addressed to another person: it belongs to them
  const mentions = [...raw.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]);
  if (mentions.some((m) => m !== i.botUserId)) return { pass: false, reason: "addressed_to_someone_else" };
  // mid-conversation between humans in a thread we are in: stay out unless it is a clear ask
  const isAsk = t.includes("?") || ASK.test(t);
  if (i.context === "thread" && !i.lastWasBot && i.lastSpeakerId && i.speakerId && i.lastSpeakerId !== i.speakerId && !isAsk) {
    return { pass: false, reason: "human_to_human" };
  }
  if (isAsk || SIGNAL.test(t) || ANNOUNCE.test(t)) return { pass: true };
  return { pass: false, reason: "no_signal" };
}

// ---- sampling: past a daily volume per channel, only a fraction of eligible messages go to the model ----
export const FULL_TRIAGE_PER_CHANNEL_DAY = 150;
const counts = new Map<string, { day: number; n: number }>();

/** Stable FNV-1a so a retried event cannot flip its own sample. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function sampleTriage(channelId: string, ts: string, nowMs = Date.now()): { sampled: boolean; ordinal: number } {
  const day = Math.floor(nowMs / 86_400_000);
  const c = counts.get(channelId);
  const cur = c && c.day === day ? c : { day, n: 0 };
  cur.n++;
  counts.set(channelId, cur);
  if (cur.n <= FULL_TRIAGE_PER_CHANNEL_DAY) return { sampled: true, ordinal: cur.n };
  return { sampled: hash(`${channelId}:${ts}`) % 5 === 0, ordinal: cur.n };
}
export const resetSampling = () => counts.clear();
