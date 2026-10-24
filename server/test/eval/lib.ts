// Evaluation program: gold-set loader, corpus seeding, recall runners and scorers.
// Used by eval.test.ts (deterministic, fake embedder + stubbed LLM, runs in `bun test test/eval`) and
// scripts/eval-nightly.ts (real Vertex models). Scorers are pure so they are unit-tested offline.
import { z } from "zod";
import { db } from "../../src/db";
import { channelMembers, channels, memories } from "../../src/db/schema";
import { setMemoryLlm, parseModelJson } from "../../src/memory/llm";
import { buildRecall, clearRecallCache, type Recall } from "../../src/memory/recall";
import { addFact } from "../../src/memory/supersede";
import { and, eq, isNull, sql } from "drizzle-orm";
import { installFakes } from "../memory/helpers";
import { type Case, CASES, CHANNELS, SCOPES, type Seed } from "../memory-eval/cases";

export const K = 5;
export const BUDGET = 2500;
const DAY = 86_400_000;
const GOLD_DIR = new URL("./gold/", import.meta.url).pathname;

// ---------------------------------------------------------------- gold loading
export type Header = { _header: true; set: string; version: number; date: string };
export const headerSchema = z.object({ _header: z.literal(true), set: z.string().min(1), version: z.number().int().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** Reads `gold/<name>.jsonl`: first line is the versioned header, every other line one JSON row. Throws with the line number on bad JSON. */
export async function loadGold<T = Record<string, unknown>>(name: string): Promise<{ header: Header & Record<string, unknown>; rows: T[] }> {
  const text = await Bun.file(`${GOLD_DIR}${name}.jsonl`).text();
  const lines = text.split("\n").filter((l) => l.trim());
  const parse = (l: string, i: number) => { try { return JSON.parse(l); } catch (e) { throw new Error(`${name}.jsonl line ${i + 1}: ${String(e)}`); } };
  const header = headerSchema.passthrough().parse(parse(lines[0]!, 0)) as Header & Record<string, unknown>;
  return { header, rows: lines.slice(1).map((l, i) => parse(l, i + 1) as T) };
}

export type GoldSeed = Seed & { agoDays?: number };
export type ExpectedFact = { tokens: string[]; date?: string; kind: string };
export type ExtractionRow = {
  id: string; visibility: "public" | "private"; tags: string[]; noFacts: boolean;
  messages: { user: string; ts: string; text: string }[];
  expect: ExpectedFact[]; forbid: { tokens: string[]; why: string }[];
};
export type SupersedeRow = { id: string; kind: "date" | "numeric" | "owner" | "update" | "paraphrase" | "unrelated" | "retraction"; old: string; new: string; expect: "supersede" | "equivalent" | "coexist"; key?: boolean };
export type AbstentionRow = { id: string; kind: "trap" | "unknown" | "secret"; ref?: string; question?: string; entity?: string[]; seed?: GoldSeed[]; note?: string };
export type MultihopRow = { id: string; hops: number; seed: GoldSeed[]; question: string; expect: string[] };
export type AggregationRow = { id: string; kind: "list" | "count"; seed: GoldSeed[]; question: string; items: string[]; count: number | null };
export type TemporalRow = {
  id: string; kind: "asof" | "relative" | "latest"; seed: GoldSeed[]; question: string; expect: string[]; forbid: string[];
  asOf: string | null; asOfAgoDays: number | null; rewrite: { query: string; asOfAgoDays?: number } | null;
};
export type QaRow = (Omit<Case, "seed"> & { seed: GoldSeed[] }) | { id: string; ref: string };
export type DriftOp =
  | { day: number; op: "add" | "dup"; key: string; entity: string; attr: string; value: string; text: string; forgetAfterDay?: number; exact?: boolean }
  | { day: number; op: "update"; key: string; entity: string; attr: string; value: string; text: string; old: string; forgetAfterDay?: undefined; exact?: undefined }
  | { day: number; op: "consolidate" }
  | { day: number; op: "query"; entity?: string; attr?: string; question: string; expect: string[]; forbid: string[]; asOfDay: number | null; kind?: string };

export const SETS = ["extraction", "qa", "supersede", "abstention", "multihop", "aggregation", "temporal"] as const;
export const DRIFT_FILES = [1, 2, 3, 4, 5].map((i) => `drift/drift-${i}`);

// ---------------------------------------------------------------- cases (seeded into one shared corpus)
export type EvalCase = Omit<Case, "category" | "seed"> & {
  set: string; category: string; seed: Seed[];
  items?: string[]; count?: number | null; entity?: string[]; strict?: boolean; kind?: string;
};
const refs = () => new Map(CASES.map((c) => [c.id, c]));

const seedAt = (s: GoldSeed, now: Date): Seed => {
  const { agoDays, ...rest } = s;
  return agoDays != null ? { ...rest, at: new Date(now.getTime() - agoDays * DAY).toISOString() } : rest;
};
const iso = (now: Date, ago: number) => new Date(now.getTime() - ago * DAY).toISOString();

export function qaCases(rows: QaRow[], now = new Date()): EvalCase[] {
  const byId = refs();
  return rows.map((r) => {
    if ("ref" in r) {
      const c = byId.get(r.ref);
      if (!c) throw new Error(`qa ref ${r.ref} not found in memory-eval/cases.ts`);
      return { ...c, id: r.id, set: "qa" };
    }
    return { ...r, set: "qa", seed: r.seed.map((s) => seedAt(s, now)) } as EvalCase;
  });
}
export const multihopCases = (rows: MultihopRow[], now = new Date()): EvalCase[] =>
  rows.map((r) => ({ id: r.id, set: "multihop", category: "multi-hop", scope: "pub", seed: r.seed.map((s) => seedAt(s, now)), question: r.question, expect: r.expect, kind: `${r.hops}-hop` }));
export const aggregationCases = (rows: AggregationRow[], now = new Date()): EvalCase[] =>
  rows.map((r) => ({ id: r.id, set: "aggregation", category: "aggregation", scope: "pub", seed: r.seed.map((s) => seedAt(s, now)), question: r.question, items: r.items, count: r.count, kind: r.kind }));
export const temporalCases = (rows: TemporalRow[], now = new Date()): EvalCase[] =>
  rows.map((r) => {
    const asOf = r.asOfAgoDays != null ? iso(now, r.asOfAgoDays) : r.asOf ?? undefined;
    const rw = r.rewrite && { query: r.rewrite.query, asOf: r.rewrite.asOfAgoDays != null ? iso(now, r.rewrite.asOfAgoDays) : undefined };
    // relative questions get their asOf from the (stubbed or real) query rewrite; absolute ones also pass it directly in the deterministic run
    return { id: r.id, set: "temporal", category: "temporal", scope: "pub", seed: r.seed.map((s) => seedAt(s, now)), question: r.question, expect: r.expect, forbid: r.forbid, asOf: r.kind === "relative" ? undefined : asOf, rewrite: rw ?? undefined, kind: r.kind };
  });
/** Abstention rows: a ref points at an existing memory-eval abstain case (strict: no hit at all); new rows seed distractors only. */
export function abstentionCases(rows: AbstentionRow[], now = new Date()): EvalCase[] {
  const byId = refs();
  return rows.map((r) => {
    if (r.ref) {
      const c = byId.get(r.ref);
      if (!c) throw new Error(`abstention ref ${r.ref} not found`);
      return { ...c, id: r.id, set: "abstention", category: "abstention", kind: r.kind, strict: true };
    }
    return { id: r.id, set: "abstention", category: "abstention", scope: "pub", seed: (r.seed ?? []).map((s) => seedAt(s, now)), question: r.question!, entity: r.entity, kind: r.kind } as EvalCase;
  });
}

/** Everything seeded into one corpus: the whole existing memory-eval corpus (91 cases, also scope-leak distractors) plus every new set. */
export async function loadCorpus(now = new Date()) {
  const qa = qaCases((await loadGold<QaRow>("qa")).rows, now);
  const multihop = multihopCases((await loadGold<MultihopRow>("multihop")).rows, now);
  const aggregation = aggregationCases((await loadGold<AggregationRow>("aggregation")).rows, now);
  const temporal = temporalCases((await loadGold<TemporalRow>("temporal")).rows, now);
  const abstention = abstentionCases((await loadGold<AbstentionRow>("abstention")).rows, now);
  const existing = CASES.map((c) => ({ ...c, set: "memory-eval" }) as EvalCase);
  const fresh = [...qa.filter((c) => c.id.startsWith("qa-new-")), ...multihop, ...aggregation, ...temporal];
  // abstention runs in a second corpus WITHOUT the old memory-eval seeds (one of them mentions a Berlin office, which would defeat the Berlin trap)
  return { qa, multihop, aggregation, temporal, abstention, abstentionCorpus: [...fresh, ...abstention], all: [...existing, ...qa.filter((c) => c.id.startsWith("qa-new-")), ...multihop, ...aggregation, ...temporal, ...abstention] };
}

// ---------------------------------------------------------------- seeding + LLM stubs
/** Fake embedder + scripted LLM: rewrite from the case's `rewrite`, entity tie-break by surname, contradiction = supersede lines containing `replaces`. */
export function installFakeLlm(cases: EvalCase[]) {
  installFakes();
  const replacing = cases.flatMap((c) => c.seed.filter((x) => x.replaces).map((x) => ({ by: x.text, needle: x.replaces! })));
  const rewrites = new Map(cases.filter((c) => c.rewrite).map((c) => [c.question, c.rewrite!]));
  setMemoryLlm(async (a) => {
    if (a.system.includes("standalone search query")) {
      const q = /LATEST MESSAGE: (.*)$/m.exec(a.prompt)?.[1] ?? "";
      const rw = rewrites.get(q);
      return JSON.stringify({ query: rw?.query ?? q, asOf: rw?.asOf ?? null });
    }
    if (a.system.includes("resolve entity mentions")) {
      const last = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").trim().split(/\s+/).pop();
      const m = last(/MENTION: (.*) \(/.exec(a.prompt)?.[1] ?? "");
      const c = [...a.prompt.matchAll(/^(\d+)\. (.*?) \(/gm)].find((x) => last(x[2]!) === m);
      return JSON.stringify({ match: c ? Number(c[1]) : null });
    }
    const neu = /NEW: (.*)/.exec(a.prompt)?.[1] ?? "";
    const needle = replacing.find((r) => neu.includes(r.by))?.needle;
    const ids = needle ? [...a.prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].filter((m) => m[2]!.includes(needle)).map((m) => Number(m[1])) : [];
    return JSON.stringify({ superseded: ids });
  });
}

export async function seedChannels() {
  for (const c of CHANNELS) {
    await db.insert(channels).values({ id: c.id, isPrivate: c.isPrivate, isIm: c.isIm });
    if (c.members.length) await db.insert(channelMembers).values(c.members.map((userId) => ({ channelId: c.id, userId })));
  }
}

export const evalLink = (n: number) => `https://eval.example.slack.com/archives/CEVAL/p${1_700_000_000 + n}000100`;

/** Seeds each case's facts in order through addFact (with a unique permalink per fact so citations can be validated). Returns the number of facts written. */
export async function seedCases(cases: EvalCase[]): Promise<number> {
  let n = 0;
  for (const c of cases) {
    for (const f of c.seed) {
      await addFact({ tag: f.tag, text: f.text, source: "eval", permalink: evalLink(++n), validAt: f.at ? new Date(f.at) : undefined, entities: f.ents?.map((name) => ({ name })) });
    }
  }
  clearRecallCache();
  return n;
}

// ---------------------------------------------------------------- recall runners (deterministic part)
const has = (texts: string[], sub: string) => texts.some((t) => t.toLowerCase().includes(sub.toLowerCase()));
export type RecallResult = { id: string; set: string; pass: boolean; hits: string[]; recall: Recall; detail?: string };

/** Pass criteria per set (all on the recalled hits, no answering model): qa/multihop/temporal = expected facts in top-K and nothing forbidden;
 *  abstention = the asked entity never appears in a hit (strict refs: no hit at all); aggregation = every item appears somewhere in the recalled pack. */
export async function runRecall(c: EvalCase): Promise<RecallResult> {
  const recall = await buildRecall({ scope: SCOPES[c.scope], query: c.question, budgetTokens: BUDGET, threadTail: c.thread, asOf: c.asOf ? new Date(c.asOf) : undefined });
  const hits = recall.hits.map((h) => h.text);
  const top = hits.slice(0, K);
  let pass: boolean;
  if (c.set === "abstention") pass = c.strict ? hits.length === 0 : !(c.entity ?? []).some((e) => has(hits, e));
  else if (c.set === "aggregation") pass = (c.items ?? []).every((i) => has(hits, stripGeneric(i)));
  else {
    const forbid = c.forbid ?? [];
    const leaked = forbid.some((f) => (f === "*" ? hits.length > 0 : has(hits, f)));
    pass = (c.expect ?? []).every((e) => has(top, e)) && (!c.first || has(hits.slice(0, 1), c.first)) && !leaked;
  }
  return { id: c.id, set: c.set, pass, hits, recall };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
export const rate = (num: number, den: number) => (den ? round(num / den) : 0);
export const passRate = (rs: { pass: boolean }[]) => rate(rs.filter((r) => r.pass).length, rs.length);

// ---------------------------------------------------------------- text scorers (pure)
/** An alternation "a|b" matches either; all tokens must appear in ONE text (case-insensitive). */
export function tokensIn(text: string, tokens: string[]): boolean {
  const t = text.toLowerCase();
  return tokens.every((tok) => tok.split("|").some((alt) => t.includes(alt.trim().toLowerCase())));
}
/** "Ingest service" -> "Ingest": trailing generic nouns are not required verbatim in an answer. */
export const stripGeneric = (item: string) => item.replace(/\s+(service|team)$/i, "");

export type ExtractedFact = { text: string; validAt?: string | null };

export type ExtractionScore = {
  expected: number; found: number; dateExpected: number; dateOk: number;
  forbidden: string[]; falsePositives: number; extracted: number; matchedExtracted: number; secretsLeaked: number;
};
/** Scores one transcript's extracted facts against its expectations. Date accuracy: the matched fact carries the ISO date in its text or validAt. */
export function scoreExtraction(row: Pick<ExtractionRow, "expect" | "forbid" | "noFacts" | "tags">, facts: ExtractedFact[]): ExtractionScore {
  let found = 0, dateExpected = 0, dateOk = 0;
  const matched = new Set<number>();
  for (const e of row.expect) {
    const idx = facts.findIndex((f) => tokensIn(f.text, e.tokens) && (!e.date || f.text.includes(e.date) || !!f.validAt?.startsWith(e.date)));
    const loose = idx >= 0 ? idx : facts.findIndex((f) => tokensIn(f.text, e.tokens));
    if (loose >= 0) { found++; matched.add(loose); }
    if (e.date) { dateExpected++; if (idx >= 0) dateOk++; }
  }
  const forbidden = row.forbid.filter((f) => facts.some((x) => tokensIn(x.text, f.tokens))).map((f) => f.why || f.tokens.join(" "));
  const secretsLeaked = row.tags.includes("secret") ? forbidden.length : 0;
  return {
    expected: row.expect.length, found, dateExpected, dateOk, forbidden, extracted: facts.length, matchedExtracted: matched.size,
    falsePositives: row.noFacts ? facts.length : 0, secretsLeaked,
  };
}
export function sumExtraction(scores: (ExtractionScore & { noFacts?: boolean })[], rows: Pick<ExtractionRow, "noFacts">[]) {
  const sum = (f: (s: ExtractionScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  const emptyRows = rows.filter((r) => r.noFacts).length;
  return {
    transcripts: scores.length,
    fact_recall: rate(sum((s) => s.found), sum((s) => s.expected)),
    fact_precision_token: rate(sum((s) => s.matchedExtracted), sum((s) => s.extracted)),
    date_accuracy: rate(sum((s) => s.dateOk), sum((s) => s.dateExpected)),
    forbidden_stored: sum((s) => s.forbidden.length),
    secrets_stored: sum((s) => s.secretsLeaked),
    empty_transcript_fp_rate: rate(scores.filter((s, i) => rows[i]!.noFacts && s.extracted > 0).length, emptyRows),
  };
}

// citations --------------------------------------------------------------------------------------------------------
const URL_RE = /https?:\/\/[^\s<>|)\]]+/g;
export const urlsIn = (answer: string): string[] => [...new Set((answer.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];
/** Every URL in the answer must be one the answerer was shown (recalled permalinks / tool results). */
export function citationCheck(answer: string, allow: Iterable<string>): { urls: number; invalid: string[] } {
  const ok = new Set([...allow].map((u) => u.replace(/[.,;:!?]+$/, "")));
  const urls = urlsIn(answer);
  return { urls: urls.length, invalid: urls.filter((u) => !ok.has(u)) };
}
export const permalinksOf = (r: Recall): string[] => r.hits.map((h) => h.permalink).filter((u): u is string => !!u);

// abstention ---------------------------------------------------------------------------------------------------------
const ABSTAIN_RE = /\b(i (do not|don'?t|can'?t|cannot|couldn'?t|could not) (have|find|see|know)|no (record|information|mention|facts?|data)|not (stored|in (my )?memory|something i)|nothing (in|about|on)|unable to find|isn'?t (in|something)|no one has told me|haven'?t (been told|learned|seen))\b/i;
export const looksLikeAbstention = (answer: string) => ABSTAIN_RE.test(answer);
export const itemRecall = (answer: string, items: string[]) => rate(items.filter((i) => answer.toLowerCase().includes(stripGeneric(i).toLowerCase())).length, items.length);
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const mentionsCount = (answer: string, n: number) => new RegExp(`\\b(${n}|${NUMBER_WORDS[n] ?? n})\\b`, "i").test(answer);

// supersede ---------------------------------------------------------------------------------------------------------------
export type SupersedeOutcome = { oldActive: boolean; newStored: boolean; deduped: boolean; cosine: number };
export function supersedeCorrect(row: Pick<SupersedeRow, "expect">, o: SupersedeOutcome): boolean {
  if (row.expect === "supersede") return !o.oldActive && o.newStored;
  if (row.expect === "equivalent") return o.oldActive; // either deduped or stored beside it, but never superseded
  return o.oldActive && o.newStored && !o.deduped; // coexist
}
export function sumSupersede(rows: SupersedeRow[], outs: SupersedeOutcome[], gate = 0.97) {
  const idx = (f: (r: SupersedeRow) => boolean) => rows.map((r, i) => (f(r) ? i : -1)).filter((i) => i >= 0);
  const must = idx((r) => r.expect === "supersede"), para = idx((r) => r.kind === "paraphrase");
  const correct = rows.filter((r, i) => supersedeCorrect(r, outs[i]!)).length;
  return {
    pairs: rows.length,
    supersede_accuracy: rate(correct, rows.length),
    correction_supersede_rate: rate(must.filter((i) => !outs[i]!.oldActive && outs[i]!.newStored).length, must.length),
    corrections_dropped_as_duplicate: must.filter((i) => outs[i]!.deduped).map((i) => rows[i]!.id),
    corrections_above_gate: must.filter((i) => outs[i]!.cosine >= gate).map((i) => rows[i]!.id),
    paraphrase_superseded_rate: rate(para.filter((i) => !outs[i]!.oldActive).length, para.length),
    paraphrase_churn_rate: rate(para.filter((i) => outs[i]!.newStored && !outs[i]!.deduped).length, para.length), // stored as a second row (duplicate churn)
    paraphrase_deduped_rate: rate(para.filter((i) => outs[i]!.deduped).length, para.length),
    paraphrase_cosine: { min: round(Math.min(...para.map((i) => outs[i]!.cosine))), max: round(Math.max(...para.map((i) => outs[i]!.cosine))), mean: round(para.reduce((a, i) => a + outs[i]!.cosine, 0) / (para.length || 1)) },
  };
}
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// judge (offline LLM) ---------------------------------------------------------------------------------------------------------
export const JUDGE_SYSTEM = `You grade an assistant's answer for a company-memory evaluation. You see the QUESTION, the CONTEXT the assistant was shown, EXPECTED facts (may be empty) and the ANSWER.
Reply with JSON only: {"abstains":<true if the answer says it does not have / cannot find the information instead of asserting it>,"correct":<true if the answer states every EXPECTED fact and contradicts none; true for an abstention when EXPECTED is empty>,"claims":[{"text":"<one atomic factual claim the answer asserts about the company>","supported":<true only if the CONTEXT states or directly implies it>}]}.
Claims are atomic statements of fact (names, dates, numbers, decisions). Ignore pleasantries, offers to help, citations and statements about what is missing. Check every claim against the CONTEXT only, never against your own knowledge.`;
export const judgeSchema = z.object({ abstains: z.boolean(), correct: z.boolean(), claims: z.array(z.object({ text: z.string(), supported: z.boolean() })).default([]) });
export type Judged = z.infer<typeof judgeSchema>;
export const judgePrompt = (a: { question: string; context: string; expect: string[]; answer: string }) =>
  `QUESTION: ${a.question}\n\nCONTEXT:\n${a.context || "(empty)"}\n\nEXPECTED: ${a.expect.length ? a.expect.join("; ") : "(none: the information does not exist)"}\n\nANSWER:\n${a.answer}`;
export function parseJudge(raw: string): Judged | null {
  try { return parseModelJson(raw, judgeSchema); } catch { return null; }
}
export function sumFaithfulness(judged: (Judged | null)[]) {
  const ok = judged.filter((j): j is Judged => !!j);
  const claims = ok.reduce((a, j) => a + j.claims.length, 0);
  const bad = ok.reduce((a, j) => a + j.claims.filter((c) => !c.supported).length, 0);
  return { answers_judged: ok.length, judge_failures: judged.length - ok.length, claims, unsupported_claims: bad, unsupported_claim_rate: rate(bad, claims), answers_with_unsupported: ok.filter((j) => j.claims.some((c) => !c.supported)).length };
}

export const PRECISION_SYSTEM = `You check facts extracted from a Slack conversation. For each numbered FACT say whether the CONVERSATION supports it (stated or directly implied, with relative dates resolved against the given date). Reply with JSON only: {"supported":[<true|false per fact, in order>]}.`;
export const precisionSchema = z.object({ supported: z.array(z.boolean()) });
export const precisionPrompt = (transcript: string, facts: string[], at: string) =>
  `Date of the last message: ${at}\n\nCONVERSATION:\n${transcript}\n\nFACTS:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;

// ---------------------------------------------------------------- drift
export type DriftResult = {
  facts: number; queries: number; current_recall: number; stale_leak_rate: number; expired_leak_rate: number; dup_rate: number;
  supersede_miss_rate: number; exact_dup_dedupe_rate: number; active_facts: number; failed: string[];
};
export const driftLlm = (ops: DriftOp[]) => {
  const upd = ops.filter((o): o is Extract<DriftOp, { op: "update" }> => o.op === "update");
  setMemoryLlm(async (a) => {
    if (a.system.includes("standalone search query")) return JSON.stringify({ query: /LATEST MESSAGE: (.*)$/m.exec(a.prompt)?.[1] ?? "x", asOf: null });
    const neu = /NEW: (.*)/.exec(a.prompt)?.[1] ?? "";
    const u = upd.find((o) => o.text === neu);
    const ids = u ? [...a.prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].filter((m) => m[2]!.includes(u.entity) && m[2]!.includes(u.attr) && m[2]!.includes(u.old)).map((m) => Number(m[1])) : [];
    return JSON.stringify({ superseded: ids, facts: [] });
  });
};

/**
 * Replays one timeline: adds/updates/duplicates through addFact with validAt on the simulated day, consolidation runs at its marks,
 * queries use asOf = that simulated day (end-of-timeline queries use "now"). Facts live in a private-channel tag of their own.
 */
export async function runDrift(idx: number, header: Record<string, unknown>, ops: DriftOp[], consolidate: () => Promise<unknown>, now = new Date()): Promise<DriftResult> {
  const tag = `channel_C_DRIFT${idx}`;
  const scope = { channelId: `C_DRIFT${idx}`, isPrivate: true, isIm: false, userId: null };
  const start = now.getTime() - Number(header.startAgoDays ?? 90) * DAY;
  const date = (d: number) => new Date(start + d * DAY);
  let facts = 0, exactTotal = 0, exactDeduped = 0, q = 0, curOk = 0, curTotal = 0, staleLeaks = 0, staleTotal = 0, expLeaks = 0, expTotal = 0;
  const failed: string[] = [];
  for (const o of ops) {
    if (o.op === "consolidate") { await consolidate(); continue; }
    if (o.op === "query") {
      q++;
      const r = await buildRecall({ scope, query: o.question, budgetTokens: BUDGET, rewrite: false, asOf: o.asOfDay != null ? date(o.asOfDay) : undefined });
      // values like "gold" or "L5" are shared by many entities: only a top hit about THIS entity and attribute counts
      const top = r.hits.slice(0, K).map((h) => h.text).filter((x) => !o.entity || (x.includes(o.entity) && x.includes(o.attr!)));
      if (o.kind === "stale") { expTotal++; if (o.forbid.some((f) => has(r.hits.map((h) => h.text), f))) { expLeaks++; failed.push(`${o.question}@${o.day}`); } continue; }
      curTotal++;
      if (o.expect.every((e) => has(top, e))) curOk++; else failed.push(`${o.question}@${o.day}`);
      if (o.forbid.length) { staleTotal++; if (o.forbid.some((f) => has(top, f))) staleLeaks++; }
      continue;
    }
    facts++;
    const res = await addFact({ tag, text: o.text, source: "eval", validAt: date(o.day), validUntil: o.forgetAfterDay != null ? date(o.forgetAfterDay) : undefined });
    if (o.op === "dup" && o.exact) { exactTotal++; if (res.deduped) exactDeduped++; }
  }
  // end state, straight from the table: per (entity, attr) the number of live rows, and updates whose old value is still live
  const live = await db.select({ text: memories.text }).from(memories).where(and(eq(memories.scopeTag, tag), eq(memories.status, "active"), isNull(memories.invalidAt), eq(memories.kind, "fact")));
  const texts = live.map((l) => l.text);
  const keys = new Map<string, { entity: string; attr: string }>();
  for (const o of ops) if ((o.op === "add") && o.attr !== "override") keys.set(o.key, o);
  let dups = 0;
  for (const o of keys.values()) dups += Math.max(0, texts.filter((t) => t.includes(o.entity) && t.includes(o.attr)).length - 1);
  const upds = ops.filter((o): o is Extract<DriftOp, { op: "update" }> => o.op === "update");
  const missed = upds.filter((u) => texts.some((t) => t.includes(u.entity) && t.includes(u.attr) && t.includes(u.old) && !t.includes("is now"))).length;
  return {
    facts, queries: q, current_recall: rate(curOk, curTotal), stale_leak_rate: rate(staleLeaks, staleTotal), expired_leak_rate: rate(expLeaks, expTotal),
    dup_rate: rate(dups, keys.size), supersede_miss_rate: rate(missed, upds.length), exact_dup_dedupe_rate: rate(exactDeduped, exactTotal), active_facts: texts.length, failed,
  };
}
export const liveCount = async (tag: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(memories).where(and(eq(memories.scopeTag, tag), eq(memories.status, "active"), isNull(memories.invalidAt))))[0]!.n;

// ---------------------------------------------------------------- baselines + regression thresholds
export const TOLERANCE = 0.02;
export type Baseline = { k: number; recall: Record<string, number>; drift: { current_recall: number; stale_leak_rate: number; dup_rate: number } };
/** Metrics that dropped by more than `tol` against the baseline (higher is better for recall, lower for the drift leak/dup rates). */
export function regressions(cur: Baseline, base: Baseline, tol = TOLERANCE): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(base.recall)) if ((cur.recall[k] ?? 0) < v - tol) out.push(`recall.${k} ${cur.recall[k]} < ${v} - ${tol}`);
  if (cur.drift.current_recall < base.drift.current_recall - tol) out.push(`drift.current_recall ${cur.drift.current_recall} < ${base.drift.current_recall} - ${tol}`);
  for (const k of ["stale_leak_rate", "dup_rate"] as const) if (cur.drift[k] > base.drift[k] + tol) out.push(`drift.${k} ${cur.drift[k]} > ${base.drift[k]} + ${tol}`);
  return out;
}

export type NightlyHeadline = {
  unsupported_claim_rate: number; citation_validity: number; abstention_recall_traps: number; trap_hits: string; recall_drop: number;
};
/** Nightly alert rules from the plan: unsupported claims > 2%, any invalid citation, trap abstention < 5/6, any recall metric down > 2 points vs the previous run. */
export function nightlyFailures(h: NightlyHeadline): string[] {
  const out: string[] = [];
  if (h.unsupported_claim_rate > 0.02) out.push(`unsupported_claim_rate ${h.unsupported_claim_rate} > 0.02`);
  if (h.citation_validity < 1) out.push(`citation_validity ${h.citation_validity} < 1`);
  if (h.abstention_recall_traps < 5 / 6) out.push(`abstention recall on traps ${h.trap_hits} < 5/6`);
  if (h.recall_drop > 0.02) out.push(`recall dropped ${round(h.recall_drop)} > 0.02 vs previous run`);
  return out;
}
