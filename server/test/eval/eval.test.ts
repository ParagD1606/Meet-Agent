// Deterministic PR subset of the evaluation program: gold-file schema checks, scorer unit tests and fake-embedder recall
// on qa / abstention / multihop / aggregation / temporal plus the drift timelines, compared with baseline.json (fail on a > 2-point drop).
//   DATABASE_URL=<throwaway db> bun test test/eval
//   UPDATE_BASELINE=1 bun test test/eval   # rewrite baseline.json from the current numbers
// The real-model counterpart is scripts/eval-nightly.ts.
import "../turn/env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { removeFakes } from "../memory/helpers";
import { resetDb } from "../db";
import { consolidate } from "../../src/memory/consolidate";
import { CASES } from "../memory-eval/cases";
import {
  type AbstentionRow, type Baseline, DRIFT_FILES, type DriftOp, type ExtractionRow, type SupersedeRow, abstentionCases, citationCheck, cosine, driftLlm,
  installFakeLlm, itemRecall, judgePrompt, loadCorpus, loadGold, looksLikeAbstention, mentionsCount, nightlyFailures, parseJudge, passRate, regressions,
  runDrift, runRecall, scoreExtraction, seedCases, sumExtraction, sumFaithfulness, sumSupersede, supersedeCorrect, tokensIn, urlsIn, TOLERANCE, type RecallResult,
} from "./lib";

const BASELINE = new URL("./baseline.json", import.meta.url).pathname;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const unique = (ids: string[]) => new Set(ids).size === ids.length;

// ---------------------------------------------------------------- gold file schemas
describe("gold files", () => {
  test("extraction: 60 transcripts with timestamps, expectations, secrets and retractions", async () => {
    const { header, rows } = await loadGold<ExtractionRow>("extraction");
    expect(header.set).toBe("extraction");
    expect(rows).toHaveLength(60);
    expect(unique(rows.map((r) => r.id))).toBe(true);
    const row = z.object({
      id: z.string(), visibility: z.enum(["public", "private"]), noFacts: z.boolean(), tags: z.array(z.string()),
      messages: z.array(z.object({ user: z.string().min(1), ts: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/), text: z.string().min(1) })).min(1),
      expect: z.array(z.object({ tokens: z.array(z.string().min(1)).min(1), kind: z.string(), date: z.string().regex(ISO).optional() })),
      forbid: z.array(z.object({ tokens: z.array(z.string().min(1)).min(1), why: z.string() })),
    });
    for (const r of rows) {
      row.parse(r);
      expect(r.noFacts || r.expect.length > 0, `${r.id} has no expectations`).toBe(true);
      const ts = r.messages.map((m) => m.ts);
      expect([...ts].sort(), `${r.id} timestamps out of order`).toEqual(ts);
    }
    const has = (tag: string) => rows.filter((r) => r.tags.includes(tag)).length;
    expect(has("secret")).toBeGreaterThanOrEqual(8);
    expect(has("retraction")).toBeGreaterThanOrEqual(5);
    expect(has("coref")).toBeGreaterThanOrEqual(6);
    expect(rows.flatMap((r) => r.expect).filter((e) => e.date).length).toBeGreaterThanOrEqual(15);
    expect(rows.flatMap((r) => r.expect).filter((e) => e.kind === "correction").length).toBeGreaterThanOrEqual(6);
    // every secret literal the transcript contains is forbidden in stored facts
    for (const r of rows.filter((x) => x.tags.includes("secret"))) expect(r.forbid.length, r.id).toBeGreaterThan(0);
  });

  test("qa: 80 questions = 54 refs into memory-eval/cases.ts + 26 new", async () => {
    const { rows } = await loadGold<{ id: string; ref?: string }>("qa");
    expect(rows).toHaveLength(80);
    expect(unique(rows.map((r) => r.id))).toBe(true);
    const refs = rows.filter((r) => r.ref);
    expect(refs).toHaveLength(54);
    for (const r of refs) expect(CASES.some((c) => c.id === r.ref), `unknown ref ${r.ref}`).toBe(true);
    const { qa } = await loadCorpus();
    expect(qa).toHaveLength(80);
    for (const c of qa.filter((x) => x.id.startsWith("qa-new-"))) { expect(c.seed.length).toBeGreaterThan(0); expect(c.expect?.length || c.first).toBeTruthy(); }
  });

  test("supersede: 40 pairs covering every kind", async () => {
    const { rows } = await loadGold<SupersedeRow>("supersede");
    expect(rows).toHaveLength(40);
    expect(unique(rows.map((r) => r.id))).toBe(true);
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ["date", "numeric", "owner", "paraphrase", "unrelated", "retraction"]) expect(kinds.has(k as SupersedeRow["kind"]), k).toBe(true);
    for (const r of rows) { expect(r.old.length).toBeGreaterThan(5); expect(r.new).not.toBe(r.old); expect(["supersede", "equivalent", "coexist"]).toContain(r.expect); }
    expect(rows.filter((r) => r.kind === "paraphrase").every((r) => r.expect === "equivalent")).toBe(true);
    expect(rows.some((r) => /launch is sept 22/i.test(r.old) && /moved to sept 15/i.test(r.new))).toBe(true);
  });

  test("abstention: 30 with at least 6 tautology traps, secrets and unknown entities", async () => {
    const { rows } = await loadGold<AbstentionRow>("abstention");
    expect(rows).toHaveLength(30);
    expect(unique(rows.map((r) => r.id))).toBe(true);
    expect(rows.filter((r) => r.kind === "trap").length).toBeGreaterThanOrEqual(6);
    expect(rows.filter((r) => r.kind === "secret").length).toBeGreaterThanOrEqual(5);
    expect(rows.some((r) => r.question === "Which city is our Berlin office in?")).toBe(true);
    for (const r of rows.filter((x) => !x.ref)) expect(r.entity?.length, r.id).toBeGreaterThan(0);
    expect(abstentionCases(rows)).toHaveLength(30);
  });

  test("multihop 15, aggregation 15, temporal 20", async () => {
    const mh = await loadGold<{ id: string; hops: number; seed: unknown[]; expect: string[] }>("multihop");
    expect(mh.rows).toHaveLength(15);
    for (const r of mh.rows) { expect(r.hops === 2 || r.hops === 3).toBe(true); expect(r.seed).toHaveLength(r.hops); expect(r.expect.length).toBeGreaterThan(0); }
    const ag = await loadGold<{ id: string; items: string[]; count: number | null; seed: unknown[] }>("aggregation");
    expect(ag.rows).toHaveLength(15);
    for (const r of ag.rows) { expect(r.items.length).toBeGreaterThanOrEqual(2); expect(r.seed.length).toBeGreaterThanOrEqual(r.items.length); }
    const tp = await loadGold<{ id: string; kind: string; expect: string[]; asOf: string | null; asOfAgoDays: number | null }>("temporal");
    expect(tp.rows).toHaveLength(20);
    for (const r of tp.rows) { expect(r.expect.length).toBeGreaterThan(0); if (r.asOf) expect(r.asOf).toMatch(ISO); }
    expect(tp.rows.filter((r) => r.kind === "relative").length).toBeGreaterThanOrEqual(5);
    for (const f of [mh, ag, tp]) expect(unique(f.rows.map((r) => r.id))).toBe(true);
  });

  test("drift: 5 timelines of 200+ facts with updates, duplicates, expiries, consolidation and queries", async () => {
    expect(DRIFT_FILES).toHaveLength(5);
    for (const f of DRIFT_FILES) {
      const { header, rows } = await loadGold<DriftOp>(f);
      expect(header.version).toBeGreaterThanOrEqual(1);
      const facts = rows.filter((r) => r.op === "add" || r.op === "update" || r.op === "dup");
      expect(facts.length, f).toBeGreaterThanOrEqual(200);
      for (const op of ["update", "dup", "consolidate", "query"]) expect(rows.some((r) => r.op === op), `${f} ${op}`).toBe(true);
      expect(rows.some((r) => r.op === "add" && r.forgetAfterDay != null), `${f} expiries`).toBe(true);
      const days = rows.map((r) => r.day);
      expect([...days].sort((a, b) => a - b)).toEqual(days);
      for (const r of rows) if (r.op === "update") expect(r.old && r.old !== r.value).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- scorers
describe("scorers", () => {
  test("tokensIn: alternation and case-insensitivity, all tokens in one text", () => {
    expect(tokensIn("Marigold go-live moved to June 29", ["marigold", "june 29|2026-06-29"])).toBe(true);
    expect(tokensIn("Marigold go-live moved", ["marigold", "june 29"])).toBe(false);
  });

  test("extraction scoring: recall, date accuracy, stale value and secret leaks", () => {
    const row = {
      noFacts: false, tags: ["secret"],
      expect: [{ tokens: ["Marigold", "go-live"], date: "2026-06-29", kind: "correction" }, { tokens: ["Stripe Tax"], kind: "decision" }],
      forbid: [{ tokens: ["Wh1teRabbit"], why: "password stored" }, { tokens: ["June 15"], why: "stale value" }],
    };
    const good = scoreExtraction(row, [{ text: "Marigold go-live moved to 2026-06-29" }, { text: "We chose Stripe Tax" }]);
    expect(good).toMatchObject({ found: 2, dateOk: 1, dateExpected: 1, forbidden: [], secretsLeaked: 0 });
    const bad = scoreExtraction(row, [{ text: "Marigold go-live is June 15" }, { text: "admin password Wh1teRabbit!42" }]);
    expect(bad.found).toBe(1);
    expect(bad.dateOk).toBe(0); // right fact, wrong date
    expect(bad.forbidden).toEqual(["password stored", "stale value"]);
    expect(bad.secretsLeaked).toBe(2);
    // date can come from validAt
    expect(scoreExtraction(row, [{ text: "Marigold go-live moved", validAt: "2026-06-29T00:00:00Z" }]).dateOk).toBe(1);
    const chat = scoreExtraction({ noFacts: true, tags: [], expect: [], forbid: [] }, [{ text: "someone had ramen" }]);
    expect(chat.falsePositives).toBe(1);
    const sum = sumExtraction([good, bad, chat], [{ noFacts: false }, { noFacts: false }, { noFacts: true }]);
    expect(sum.fact_recall).toBe(0.75);
    expect(sum.date_accuracy).toBe(0.5);
    expect(sum.empty_transcript_fp_rate).toBe(1);
    expect(sum.secrets_stored).toBe(2);
  });

  test("citation validity: every URL must be in the allowlist", () => {
    const allow = ["https://eval.example.slack.com/archives/CEVAL/p1"];
    expect(citationCheck("Priya owns it. Sources: <https://eval.example.slack.com/archives/CEVAL/p1|Slack thread, Oct 3>", allow)).toEqual({ urls: 1, invalid: [] });
    expect(citationCheck("See <https://made.up/x|doc> and https://eval.example.slack.com/archives/CEVAL/p1.", allow).invalid).toEqual(["https://made.up/x"]);
    expect(citationCheck("No links here", allow).urls).toBe(0);
    expect(urlsIn("a https://x.example/a, b https://x.example/a")).toEqual(["https://x.example/a"]);
  });

  test("abstention detector separates the Berlin tautology from an honest abstention", () => {
    expect(looksLikeAbstention("Our Berlin office is in Berlin, Germany.")).toBe(false);
    expect(looksLikeAbstention("I don't have anything about a Berlin office in memory, only Munich and Lisbon.")).toBe(true);
    expect(looksLikeAbstention("That is not stored anywhere I can see. Ask IT.")).toBe(true);
    expect(looksLikeAbstention("The wifi password is hunter2")).toBe(false);
  });

  test("aggregation item recall and counts", () => {
    expect(itemRecall("Brightwave, Hollis Dental and Marlowe Group", ["Brightwave", "Hollis Dental", "Fenwick Logistics", "Marlowe Group"])).toBe(0.75);
    expect(itemRecall("The ingest and billing services", ["Ingest service", "Billing service"])).toBe(1);
    expect(mentionsCount("There are five offices", 5)).toBe(true);
    expect(mentionsCount("There are 4 offices", 5)).toBe(false);
  });

  test("supersede accuracy, paraphrase churn and the 0.97 gate", () => {
    const rows: SupersedeRow[] = [
      { id: "a", kind: "date", old: "x is 1", new: "x moved to 2", expect: "supersede" },
      { id: "b", kind: "date", old: "y is 1", new: "y moved to 2", expect: "supersede" },
      { id: "c", kind: "paraphrase", old: "z is q", new: "q is z", expect: "equivalent" },
      { id: "d", kind: "paraphrase", old: "w is q", new: "w equals q", expect: "equivalent" },
      { id: "e", kind: "unrelated", old: "m", new: "n", expect: "coexist" },
    ];
    const outs = [
      { oldActive: false, newStored: true, deduped: false, cosine: 0.9 }, // correct
      { oldActive: true, newStored: false, deduped: true, cosine: 0.98 }, // correction swallowed by the dedupe gate
      { oldActive: true, newStored: false, deduped: true, cosine: 0.99 }, // paraphrase deduped: fine
      { oldActive: true, newStored: true, deduped: false, cosine: 0.9 }, // paraphrase stored twice: churn
      { oldActive: true, newStored: true, deduped: false, cosine: 0.1 },
    ];
    expect(rows.map((r, i) => supersedeCorrect(r, outs[i]!))).toEqual([true, false, true, true, true]);
    const s = sumSupersede(rows, outs);
    expect(s.supersede_accuracy).toBe(0.8);
    expect(s.correction_supersede_rate).toBe(0.5);
    expect(s.corrections_dropped_as_duplicate).toEqual(["b"]);
    expect(s.corrections_above_gate).toEqual(["b"]);
    expect(s.paraphrase_churn_rate).toBe(0.5);
    expect(s.paraphrase_superseded_rate).toBe(0);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  test("judge output parsing and claim-level faithfulness", () => {
    const j = parseJudge('Sure: {"abstains":false,"correct":true,"claims":[{"text":"Priya owns billing","supported":true},{"text":"since 2020","supported":false}]}');
    expect(j).not.toBeNull();
    expect(parseJudge("no json at all")).toBeNull();
    const f = sumFaithfulness([j, null, { abstains: true, correct: true, claims: [] }]);
    expect(f).toMatchObject({ answers_judged: 2, judge_failures: 1, claims: 2, unsupported_claims: 1, unsupported_claim_rate: 0.5, answers_with_unsupported: 1 });
    expect(judgePrompt({ question: "q", context: "", expect: [], answer: "a" })).toContain("(none: the information does not exist)");
  });

  test("baseline regressions fail only beyond 2 points; nightly alert rules", () => {
    const base: Baseline = { k: 5, recall: { qa: 0.9, temporal: 1 }, drift: { current_recall: 0.9, stale_leak_rate: 0.1, dup_rate: 0.05 } };
    expect(regressions(base, base)).toEqual([]);
    expect(regressions({ ...base, recall: { qa: 0.885, temporal: 1 } }, base)).toEqual([]);
    expect(regressions({ ...base, recall: { qa: 0.87, temporal: 1 } }, base)).toHaveLength(1);
    expect(regressions({ ...base, drift: { ...base.drift, stale_leak_rate: 0.2 } }, base)).toHaveLength(1);
    expect(TOLERANCE).toBe(0.02);
    const ok = { unsupported_claim_rate: 0.02, citation_validity: 1, abstention_recall_traps: 5 / 6, trap_hits: "5/6", recall_drop: 0.02 };
    expect(nightlyFailures(ok)).toEqual([]);
    expect(nightlyFailures({ ...ok, unsupported_claim_rate: 0.03, citation_validity: 0.98, abstention_recall_traps: 4 / 6, recall_drop: 0.05 })).toHaveLength(4);
  });
});

// ---------------------------------------------------------------- deterministic recall + drift vs baseline.json
let recallResults: Record<string, RecallResult[]> = {};
let current: Baseline;
let driftDetail: Record<string, unknown> = {};

describe("deterministic recall and drift (fake embedder)", () => {
  beforeAll(async () => {
    const corpus = await loadCorpus();
    installFakeLlm(corpus.all);
    await resetDb();
    await (await import("./lib")).seedChannels();
    await seedCases(corpus.all);
    for (const [set, cases] of [["qa", corpus.qa], ["multihop", corpus.multihop], ["aggregation", corpus.aggregation], ["temporal", corpus.temporal]] as const) {
      recallResults[set] = [];
      for (const c of cases) recallResults[set]!.push(await runRecall(c));
    }
    await resetDb(); // abstention: second corpus without the old memory-eval seeds
    await seedCases(corpus.abstentionCorpus);
    recallResults.abstention = [];
    for (const c of corpus.abstention) recallResults.abstention.push(await runRecall(c));
    // drift: its own empty database
    await resetDb();
    const results: Awaited<ReturnType<typeof runDrift>>[] = [];
    for (const [i, f] of DRIFT_FILES.entries()) {
      const { header, rows } = await loadGold<DriftOp>(f);
      driftLlm(rows);
      const t0 = performance.now();
      results.push(await runDrift(i + 1, header, rows, () => consolidate()));
      if (process.env.EVAL_TIMING) console.log(`drift-${i + 1} ${Math.round(performance.now() - t0)}ms`);
    }
    const mean = (k: "current_recall" | "stale_leak_rate" | "dup_rate") => Math.round((results.reduce((a, r) => a + r[k], 0) / results.length) * 1000) / 1000;
    driftDetail = Object.fromEntries(results.map((r, i) => [`drift-${i + 1}`, { ...r, failed: r.failed.slice(0, 5) }]));
    current = {
      k: 5,
      recall: Object.fromEntries(Object.entries(recallResults).map(([k, v]) => [k, passRate(v)])),
      drift: { current_recall: mean("current_recall"), stale_leak_rate: mean("stale_leak_rate"), dup_rate: mean("dup_rate") },
    };
    if (process.env.UPDATE_BASELINE) await Bun.write(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  }, 240_000);
  afterAll(removeFakes);

  test("every set ran with the expected case counts", () => {
    expect(Object.fromEntries(Object.entries(recallResults).map(([k, v]) => [k, v.length]))).toEqual({ qa: 80, multihop: 15, aggregation: 15, temporal: 20, abstention: 30 });
  });

  test("recall has not regressed more than 2 points against baseline.json", async () => {
    const base = (await Bun.file(BASELINE).json()) as Baseline;
    const failed = Object.fromEntries(Object.entries(recallResults).map(([k, v]) => [k, v.filter((r) => !r.pass).map((r) => r.id)]));
    const bad = regressions(current, base);
    expect(bad, `${bad.join("; ")}\nfailed: ${JSON.stringify(failed)}\ndrift: ${JSON.stringify(driftDetail)}`).toEqual([]);
  });

  test("tautology traps never recall a fact about the asked entity", () => {
    const traps = recallResults.abstention!.filter((r) => r.id >= "ab-11" && r.id <= "ab-18");
    expect(traps).toHaveLength(8);
    expect(traps.filter((r) => !r.pass).map((r) => r.id)).toEqual([]);
  });
});
