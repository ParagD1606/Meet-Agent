// Retrieval-confidence signal: strong / weak / none, computed deterministically from the ranked recall list (no model call).
// "none" means memory has nothing relevant: the turn must say so instead of guessing (see turn/grounding.ts).
import { lookupTokens } from "./search";
import { normName } from "./entities";

export type SignalLevel = "strong" | "weak" | "none";
export type SignalFeatures = {
  /** best raw rank (RRF x recency x importance, before any rerank) over all candidates */
  topRank: number;
  /** topRank / median raw rank of the candidates that passed the floors: how far the best hit stands out */
  gap: number;
  /** candidates whose rank is at/above MIN_RANK */
  aboveMin: number;
  /** packed hits */
  count: number;
  /** a packed hit matched the query by keyword (AND tsquery) or by name/id trigram */
  lexical: boolean;
  /** most content words (stemmed) the question shares with one packed hit */
  shared: number;
  /** max cosine over packed hits that came from the vector list (0 when none did) */
  maxCos: number;
  /** capitalised names / ids in the question, and how many of them appear in a hit's text or entity aliases */
  named: number;
  covered: number;
};
export type Signal = { level: SignalLevel; reason: string; features: SignalFeatures };

// ---- thresholds (calibrated on test/memory-eval/cases.ts and the real-embedding run, see docs/guide/grounding.md) ----
/** A vector-only hit below this cosine is topical noise: with no keyword/entity support the answer is "none". Real gemini-embedding-001 puts unrelated company text at ~0.45-0.62 and on-topic text above 0.68. */
export const COS_NONE = 0.66;
/** Cosine at/above which a hit without keyword support is still strong evidence (paraphrased question). */
export const COS_STRONG = 0.74;
/** Best-hit rank at/above which one keyword-supported hit alone is "strong" (RRF of rank 0 in two lists ~0.5 before decay). */
export const TOP_STRONG = 0.3;
/** Keyword-supported hits with a clearly standing-out top hit (top / median >= this) are strong even at a modest rank. */
export const GAP_STRONG = 1.5;

/** A hit sharing this many content words with the question counts as keyword support even when the AND query missed (paraphrase: "supplies" vs "vendor for"). One shared word is noise. */
export const SHARED_MIN = 2;

/** Pure decision, unit-tested on fixtures. */
export function classify(f: SignalFeatures): Signal {
  const mk = (level: SignalLevel, reason: string): Signal => ({ level, reason, features: f });
  if (!f.count) return mk("none", "no_hits");
  // the question names someone/something that no recalled fact or entity alias mentions: whatever came back is about something else
  if (f.named > 0 && f.covered === 0) return mk("none", "unknown_entity");
  const support = f.lexical || f.covered > 0 || f.shared >= SHARED_MIN;
  if (!support && f.maxCos < COS_NONE) return mk("none", "no_support");
  const partial = f.named > f.covered; // some named thing is unknown
  if (support && !partial && (f.topRank >= TOP_STRONG || f.maxCos >= COS_STRONG || f.gap >= GAP_STRONG)) return mk("strong", "supported");
  if (!support && f.maxCos >= COS_STRONG && !partial) return mk("strong", "semantic");
  return mk("weak", partial ? "partial_entity" : "thin");
}

// ---- question entities ----
const MONTHS_DAYS = new Set("january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday".split(" "));
const GENERIC = new Set("slack github notion linear jira google gmail sentry posthog drive calendar summarise summarize please thanks hello".split(" "));
/** Names and ids the question talks about (capitalised mid-sentence words, ids with digits/dashes). Acronyms (CEO, API), dates and tool names are not entities. */
export function namedTokens(q: string): string[] {
  return lookupTokens(q).filter((t) => {
    const n = t.toLowerCase();
    if (MONTHS_DAYS.has(n) || GENERIC.has(n)) return false;
    if (/^\p{Lu}{2,5}$/u.test(t)) return false;
    return true;
  });
}

const words = (s: string) => normName(s).split(" ").filter(Boolean);
/** Edit distance <= 1 (typos like Quigly/Quigley) for names of 5+ letters; exact otherwise. */
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

/** How many of `names` appear (word-level, typo-tolerant) in any hit text or entity alias. */
export function coverage(names: string[], haystacks: string[]): number {
  const bag = new Set(haystacks.flatMap(words));
  const list = [...bag];
  return names.filter((n) => words(n).every((w) => bag.has(w) || (w.length >= 5 && list.some((x) => near(w, x))))).length;
}

const STOP = new Set("the a an of for to in on at by with from and or is are was were be been do does did can could our we you your my what which who whom whose when where why how this that these those it its about any there their them they has have had not no".split(" "));
export const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? "" : m));
/** Content words of a text, lightly stemmed (plural/-ing/-ed), stopwords and 1-2 letter words dropped. */
export const contentStems = (s: string): Set<string> => new Set(words(s).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));
/** How many content words the question shares with a hit (>= 2 means the hit is about the same thing, not one stray word). */
export function sharedWords(q: Set<string>, text: string): number {
  const t = contentStems(text);
  let n = 0;
  for (const w of q) if (t.has(w)) n++;
  return n;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
export const medianRank = median;
