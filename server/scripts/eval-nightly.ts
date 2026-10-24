// Nightly real-model evaluation (Vertex Gemini via ADC) against a THROWAWAY Postgres. It truncates every table.
//   MODEL_PROVIDER=vertex GOOGLE_APPLICATION_CREDENTIALS=<adc.json> GOOGLE_VERTEX_PROJECT=<project> \
//   DATABASE_URL=postgres://...:5433/... bun scripts/eval-nightly.ts [--budget 5] [--sets qa,abstention,...] [--limit N] [--out path] [--prev path] [--db <url>]
// Refuses to run unless DATABASE_URL contains "5433" or --db <url> is given explicitly (a sourced prod .env must never point it at production).
// Writes a JSON report (per-set metrics, deltas vs the previous report, answers to the two standing questions) and exits 1 on a regression
// (unsupported_claim_rate > 0.02, citation_validity < 1, trap abstention < 5/6, a recall metric down > 2 points), 3 when the budget is exhausted, 2 on bad usage.
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const explicitDb = opt("db");
if (explicitDb) process.env.DATABASE_URL = explicitDb;
const dbUrl = process.env.DATABASE_URL ?? "";
if (!explicitDb && !dbUrl.includes("5433")) {
  console.error('eval-nightly: refusing to run. DATABASE_URL must contain "5433" (throwaway database) or pass --db <url> explicitly. This script truncates every table.');
  process.exit(2);
}
process.env.MODEL_PROVIDER ??= "vertex";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.DB_POOL_MAX ??= "16";
delete process.env.EMBEDDING_BASE_URL; // Vertex embeddings only (a leftover base URL would silently switch embedders)
delete process.env.MODEL_BASE_URL;
if (process.env.MODEL_PROVIDER !== "vertex") { console.error("eval-nightly: MODEL_PROVIDER must be vertex"); process.exit(2); }

const { generateText } = await import("ai");
const { and, eq, isNull } = await import("drizzle-orm");
const { db, pool, lockPool } = await import("../src/db");
const { memories } = await import("../src/db/schema");
const { getModel, estimateCostMicros, auxThinking } = await import("../src/llm");
const { setMemoryLlm, parseModelJson } = await import("../src/memory/llm");
const { embed, embedStats } = await import("../src/memory/embed");
const { buildRecall, clearRecallCache } = await import("../src/memory/recall");
const { addFact } = await import("../src/memory/supersede");
const { captureTurn } = await import("../src/memory/writeback");
const { ambientText } = await import("../src/memory/ambient");
const { consolidate } = await import("../src/memory/consolidate");
const { thinkingOptions } = await import("../src/turn/loop");
const { buildDynamicContext, buildSystemMessages } = await import("../src/turn/prompt");
const { resetDb } = await import("../test/db");
const L = await import("../test/eval/lib");
import type { ExtractionScore } from "../test/eval/lib";
const { SCOPES } = await import("../test/memory-eval/cases");

const T0 = Date.now();
const BUDGET_USD = Number(opt("budget") ?? 5);
const LIMIT = opt("limit") ? Number(opt("limit")) : Infinity;
const SETS = new Set((opt("sets") ?? "qa,multihop,aggregation,temporal,abstention,supersede,drift,extraction").split(","));
const OUT = opt("out") ?? new URL("../test/eval/last-nightly.json", import.meta.url).pathname;
const PREV = opt("prev") ?? OUT;
const CONCURRENCY = Number(opt("concurrency") ?? 4);
const think = auxThinking; // as production: every auxiliary call runs on minimal thinking (Phase 0d)
const log = (...a: unknown[]) => console.error(`[${Math.round((Date.now() - T0) / 1000)}s]`, ...a);
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- cost + budget
class BudgetExceeded extends Error {}
const spend = { micros: 0, byPhase: {} as Record<string, number>, calls: 0 };
let phase = "setup";
function charge(model: unknown, usage: { inputTokens?: number; outputTokens?: number } | undefined) {
  const m = estimateCostMicros(model as { modelId?: string }, { inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens });
  spend.micros += m; spend.calls++;
  spend.byPhase[phase] = (spend.byPhase[phase] ?? 0) + m;
  if (spend.micros / 1e6 > BUDGET_USD) throw new BudgetExceeded(`budget $${BUDGET_USD} exceeded after ${spend.calls} calls in phase ${phase}`);
}
const modelId = (role: "main" | "extract" | "triage") => String((getModel(role) as { modelId?: string }).modelId ?? "unknown");

// every memory-pipeline LLM call (extraction, contradiction check, rewrite, consolidation) goes through here so it is counted
setMemoryLlm(async (a) => {
  const model = getModel(a.role ?? "extract");
  const r = await generateText({
    model, system: a.system, prompt: a.prompt, temperature: 0, maxOutputTokens: (a as { maxOutputTokens?: number }).maxOutputTokens ?? 1200,
    maxRetries: 6, abortSignal: AbortSignal.timeout(60_000), providerOptions: ((a as { providerOptions?: object }).providerOptions ?? think) as never,
  });
  charge(model, r.totalUsage ?? r.usage);
  return r.text;
});

async function pmap<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await f(items[i]!, i); }
  }));
  return out;
}

const errors: Record<string, number> = {};
/** pmap that survives a failing item (429s that outlast the retries, judge timeouts): the item is dropped and counted; a budget stop still aborts. */
async function pmapSafe<T, R>(set: string, items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = await pmap(items, n, async (x, i) => {
    try { return await f(x, i); } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      errors[set] = (errors[set] ?? 0) + 1; log(`${set} item failed`, String(e).slice(0, 160)); return undefined;
    }
  });
  return out.filter((x): x is Awaited<R> => x !== undefined) as R[];
}
/** Embeds texts concurrently (with backoff) into the embedding cache so the sequential addFact path finds them cached. */
async function warm(texts: string[]) {
  await pmap([...new Set(texts)], 8, async (t) => {
    for (let a = 0; a < 6; a++) { try { await embed([t]); return; } catch { await Bun.sleep(1000 * 2 ** a); } }
  });
}
/** A phase failing for any reason other than the budget is recorded and the next phase still runs. */
const phaseErrors: Record<string, string> = {};
async function guarded(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    phaseErrors[name] = String(e).slice(0, 300); log(`phase ${name} FAILED`, phaseErrors[name]);
  }
}

// ---------------------------------------------------------------- answer + judge
const now = new Date();
const answerModelId = modelId("main");
const judgeRole: "main" | "extract" = answerModelId.includes("flash-lite") ? "main" : "extract"; // always a different model from the answerer
const judgeModelId = modelId(judgeRole);
if (judgeModelId === answerModelId) { console.error("eval-nightly: judge model equals answer model"); process.exit(2); }

/** A runTurn-like memory turn: the real system prompt, the per-turn context block, the recalled memory and the question; no tools. An empty reply is retried once and counted. */
const emptyAnswers = { firstTry: 0, final: 0, byFinish: {} as Record<string, number>, total: 0 };
async function answer(question: string, recallText: string): Promise<string> {
  const ctx = buildDynamicContext({ now, botUserId: "UBOT", asker: { id: "UEVAL", name: "Eval" }, channelName: "general", trigger: "mention", isIm: false, isPrivate: false, readOnly: true, depth: "memory", connectionNotes: [] });
  const model = getModel("main");
  emptyAnswers.total++;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await generateText({
      model, system: buildSystemMessages(), prompt: `${ctx}\n\n${recallText}\n\n${question}`, temperature: 0, maxOutputTokens: 1500,
      maxRetries: 6, abortSignal: AbortSignal.timeout(90_000), providerOptions: thinkingOptions("memory") as never,
    });
    charge(model, r.totalUsage ?? r.usage);
    if (r.text.trim()) return r.text.trim();
    if (attempt === 0) emptyAnswers.firstTry++;
    emptyAnswers.byFinish[String(r.finishReason)] = (emptyAnswers.byFinish[String(r.finishReason)] ?? 0) + 1;
  }
  emptyAnswers.final++;
  return "";
}
async function judge(system: string, prompt: string): Promise<string> {
  const model = getModel(judgeRole);
  const r = await generateText({ model, system, prompt, temperature: 0, maxOutputTokens: 1500, maxRetries: 6, abortSignal: AbortSignal.timeout(90_000), ...(think ? { providerOptions: think } : {}) });
  charge(model, r.totalUsage ?? r.usage);
  return r.text;
}

type Item = {
  id: string; set: string; kind?: string; retrievalPass: boolean; answer: string; abstained: boolean; correctJudge: boolean | null; correctToken: boolean;
  claims: number; unsupported: string[]; urls: number; invalidUrls: string[]; ms: number;
};
const failures: Record<string, unknown[]> = {};

/** Recall (real rewrite + hybrid search) -> answer -> judge, for one case. */
async function runItem(c: Awaited<ReturnType<typeof L.loadCorpus>>["all"][number]): Promise<Item> {
  const t0 = performance.now();
  // the real query rewrite derives time constraints itself: no pre-resolved asOf
  const rc = { ...c, asOf: undefined };
  const rr = await L.runRecall(rc);
  const recallText = rr.recall.text;
  const exp = c.set === "aggregation" ? (c.items ?? []) : (c.expect ?? (c.first ? [c.first] : []));
  const ans = await answer(c.question, recallText);
  if (!ans) return { id: c.id, set: c.set, kind: c.kind, retrievalPass: rr.pass, answer: "", abstained: false, correctJudge: false, correctToken: false, claims: 0, unsupported: [], urls: 0, invalidUrls: [], ms: Math.round(performance.now() - t0) };
  const j = L.parseJudge(await judge(L.JUDGE_SYSTEM, L.judgePrompt({ question: c.question, context: recallText, expect: exp, answer: ans })));
  const allow = L.permalinksOf(rr.recall);
  const cite = L.citationCheck(ans, allow);
  const abstained = j?.abstains ?? L.looksLikeAbstention(ans);
  const token = c.set === "aggregation" ? L.itemRecall(ans, exp) === 1 && (c.kind !== "count" || c.count == null || L.mentionsCount(ans, c.count))
    : exp.length ? exp.every((e) => ans.toLowerCase().includes(e.toLowerCase())) && !(c.forbid ?? []).filter((f) => f !== "*").some((f) => ans.toLowerCase().includes(f.toLowerCase())) : abstained;
  return {
    id: c.id, set: c.set, kind: c.kind, retrievalPass: rr.pass, answer: ans, abstained, correctJudge: j ? j.correct : null, correctToken: token,
    claims: j?.claims.length ?? 0, unsupported: j?.claims.filter((x) => !x.supported).map((x) => x.text) ?? [], urls: cite.urls, invalidUrls: cite.invalid, ms: Math.round(performance.now() - t0),
    ...(j ? {} : { judgeFailed: true }),
  } as Item;
}

const frac = (a: number, b: number) => L.rate(a, b);
function summarizeItems(items: Item[], answerable: boolean) {
  const judged = items.filter((i) => i.correctJudge !== null);
  const faith = L.sumFaithfulness(items.map((i) => (i.correctJudge === null ? null : { abstains: i.abstained, correct: !!i.correctJudge, claims: [...i.unsupported.map((text) => ({ text, supported: false })), ...Array.from({ length: i.claims - i.unsupported.length }, () => ({ text: "", supported: true }))] })));
  return {
    n: items.length,
    retrieval_pass: L.passRate(items.map((i) => ({ pass: i.retrievalPass }))),
    ...(answerable ? {
      answer_correct_judge: frac(judged.filter((i) => i.correctJudge).length, judged.length),
      answer_correct_token: frac(items.filter((i) => i.correctToken).length, items.length),
      false_abstain_rate: frac(items.filter((i) => i.abstained).length, items.length),
    } : {}),
    unsupported_claim_rate: faith.unsupported_claim_rate, claims: faith.claims, unsupported_claims: faith.unsupported_claims, judge_failures: faith.judge_failures,
    citation_validity: frac(items.filter((i) => i.invalidUrls.length === 0).length, items.length), urls_in_answers: items.reduce((a, i) => a + i.urls, 0),
    invalid_urls: items.reduce((a, i) => a + i.invalidUrls.length, 0), latency_ms_mean: Math.round(items.reduce((a, i) => a + i.ms, 0) / (items.length || 1)),
  };
}
const keepFailures = (set: string, items: Item[], bad: (i: Item) => boolean) => {
  failures[set] = items.filter(bad).slice(0, 12).map((i) => ({ id: i.id, answer: i.answer.slice(0, 300), unsupported: i.unsupported, invalidUrls: i.invalidUrls, retrievalPass: i.retrievalPass }));
};

// ---------------------------------------------------------------- phases
const report: Record<string, any> = { version: 1, at: now.toISOString(), sets: {} };
const allItems: Item[] = [];
let aborted: string | null = null;

async function run() {
  const corpus = await L.loadCorpus(now);
  const cut = <T,>(xs: T[]) => xs.slice(0, LIMIT);
  const want = (s: string) => SETS.has(s);

  // 1. corpus sets: seeded through the real addFact path (real embeddings + real contradiction check)
  if (["qa", "multihop", "aggregation", "temporal"].some(want)) await guarded("corpus", async () => {
    phase = "seed"; log("resetting db, seeding corpus", corpus.all.length, "cases");
    await resetDb(); await L.seedChannels();
    await warm(corpus.all.flatMap((c) => c.seed.map((s) => s.text)));
    const n = await L.seedCases(corpus.all);
    report.seeded_facts = n; log("seeded", n, "facts");
    for (const [set, cases] of [["qa", corpus.qa], ["multihop", corpus.multihop], ["aggregation", corpus.aggregation], ["temporal", corpus.temporal]] as const) {
      if (!want(set)) continue;
      phase = set; log("running", set);
      const items = await pmapSafe(set, cut(cases), CONCURRENCY, runItem);
      allItems.push(...items);
      report.sets[set] = summarizeItems(items, true);
      keepFailures(set, items, (i) => !i.correctToken || i.invalidUrls.length > 0 || i.unsupported.length > 0);
      if (set === "temporal") report.sets[set].by_kind = Object.fromEntries(["asof", "relative", "latest"].map((k) => [k, frac(items.filter((i) => i.kind === k && i.correctToken).length, items.filter((i) => i.kind === k).length)]));
    }
  });

  // 2. abstention: its own corpus (the old memory-eval seeds mention a Berlin office)
  if (want("abstention")) await guarded("abstention", async () => {
    phase = "abstention"; log("abstention: reseeding");
    await resetDb(); clearRecallCache();
    await warm(corpus.abstentionCorpus.flatMap((c) => c.seed.map((s) => s.text)));
    await L.seedCases(corpus.abstentionCorpus);
    const items = await pmapSafe("abstention", cut(corpus.abstention), CONCURRENCY, runItem);
    allItems.push(...items);
    const traps = items.filter((i) => i.kind === "trap");
    const hit = (xs: Item[]) => xs.filter((i) => i.abstained && i.unsupported.length === 0).length;
    report.sets.abstention = {
      ...summarizeItems(items, false),
      abstention_recall: frac(hit(items), items.length),
      trap_recall: traps.length ? frac(hit(traps), traps.length) : 1, trap_hits: `${hit(traps)}/${traps.length}`,
      by_kind: Object.fromEntries(["trap", "unknown", "secret"].map((k) => { const xs = items.filter((i) => i.kind === k); return [k, `${hit(xs)}/${xs.length}`]; })),
      grounded_retrieval: frac(items.filter((i) => i.retrievalPass).length, items.length),
    };
    keepFailures("abstention", items, (i) => !(i.abstained && i.unsupported.length === 0));
  });

  // 3. supersede pairs: does 0.97 drop corrections, how much do paraphrases churn
  if (want("supersede")) await guarded("supersede", async () => {
    phase = "supersede"; log("supersede pairs");
    await resetDb();
    const allRows = cut((await L.loadGold<import("../test/eval/lib").SupersedeRow>("supersede")).rows);
    await warm(allRows.flatMap((r) => [r.old, r.new]));
    const done = await pmapSafe("supersede", allRows, CONCURRENCY, async (r, i) => {
      const tag = `channel_CSUP${i}`;
      const [vo, vn] = await embed([r.old, r.new]);
      const first = await addFact({ tag, text: r.old, source: "eval" });
      const second = await addFact({ tag, text: r.new, source: "eval" });
      const [old] = await db.select({ status: memories.status, inv: memories.invalidAt }).from(memories).where(eq(memories.id, first.id));
      const out: import("../test/eval/lib").SupersedeOutcome = { oldActive: old!.status === "active" && old!.inv === null, newStored: !second.deduped, deduped: second.deduped, cosine: L.cosine(vo!, vn!) };
      return { r, out };
    });
    const rows = done.map((d) => d.r), outs = done.map((d) => d.out);
    const sum = L.sumSupersede(rows, outs);
    const byKind: Record<string, { n: number; cosMin: number; cosMax: number; cosMean: number; correct: number }> = {};
    rows.forEach((r, i) => {
      const k = (byKind[r.kind] ??= { n: 0, cosMin: 1, cosMax: 0, cosMean: 0, correct: 0 });
      k.n++; k.cosMin = Math.min(k.cosMin, outs[i]!.cosine); k.cosMax = Math.max(k.cosMax, outs[i]!.cosine); k.cosMean += outs[i]!.cosine; if (L.supersedeCorrect(r, outs[i]!)) k.correct++;
    });
    for (const k of Object.values(byKind)) { k.cosMean = round(k.cosMean / k.n); k.cosMin = round(k.cosMin); k.cosMax = round(k.cosMax); }
    report.sets.supersede = { ...sum, by_kind: byKind };
    const pairInfo = (id: string) => { const i = rows.findIndex((r) => r.id === id); return i < 0 ? null : { old: rows[i]!.old, new: rows[i]!.new, cosine: round(outs[i]!.cosine, 4), deduped_as_duplicate: outs[i]!.deduped, old_superseded: !outs[i]!.oldActive, new_stored: outs[i]!.newStored }; };
    const key = pairInfo("sup-01"), titan = pairInfo("sup-02");
    const corrections = rows.map((r, i) => ({ r, o: outs[i]! })).filter((x) => x.r.expect === "supersede");
    report.questions = {
      cosine_gate_097: {
        question: "Does cosine >= 0.97 on real embeddings drop 'launch is Sept 22' -> 'launch moved to Sept 15'?",
        threshold: 0.97, pair: key, titan_pair: titan,
        answer: key ? (key.deduped_as_duplicate ? `YES: cosine ${key.cosine} >= 0.97, the correction was discarded as a duplicate and the old date stays live` : `NO: cosine ${key.cosine} < 0.97, the correction was stored (old fact ${key.old_superseded ? "superseded" : "NOT superseded by the contradiction check"})`) : "pair missing (limited run)",
        corrections_total: corrections.length, corrections_dropped_as_duplicate: corrections.filter((x) => x.o.deduped).length,
        correction_cosine: { min: round(Math.min(...corrections.map((x) => x.o.cosine))), mean: round(corrections.reduce((a, x) => a + x.o.cosine, 0) / (corrections.length || 1)), max: round(Math.max(...corrections.map((x) => x.o.cosine))) },
      },
      paraphrase_churn: {
        question: "How often do paraphrases of an existing fact create a second live row (churn) instead of being deduped?",
        paraphrases: rows.filter((r) => r.kind === "paraphrase").length, churn_rate: sum.paraphrase_churn_rate, deduped_rate: sum.paraphrase_deduped_rate,
        superseded_rate: sum.paraphrase_superseded_rate, cosine: sum.paraphrase_cosine,
        separable_at_097: sum.paraphrase_cosine.min >= 0.97 && round(Math.max(...corrections.map((x) => x.o.cosine))) < 0.97,
      },
    };
    failures.supersede = rows.map((r, i) => ({ r, o: outs[i]! })).filter((x) => !L.supersedeCorrect(x.r, x.o)).map((x) => ({ id: x.r.id, kind: x.r.kind, old: x.r.old, new: x.r.new, expect: x.r.expect, ...x.o, cosine: round(x.o.cosine, 4) }));
  });

  // 4. drift timelines (retrieval only), run concurrently; consolidation is serialised
  if (want("drift")) await guarded("drift", async () => {
    phase = "drift"; log("drift timelines");
    await resetDb(); clearRecallCache();
    let chain: Promise<unknown> = Promise.resolve();
    const serial = () => (chain = chain.then(() => consolidate()).catch((e) => log("consolidate failed", String(e).slice(0, 120)))); // one consolidation at a time (it is global)
    const files = L.DRIFT_FILES.slice(0, Number.isFinite(LIMIT) ? 1 : 5);
    const results = await pmapSafe("drift", files, 5, async (f, i) => {
      const { header, rows } = await L.loadGold<import("../test/eval/lib").DriftOp>(f);
      const ops = Number.isFinite(LIMIT) ? rows.slice(0, LIMIT * 10) : rows;
      await warm(ops.flatMap((o) => (o.op === "add" || o.op === "update" || o.op === "dup" ? [o.text] : [o.op === "query" ? o.question : ""]).filter(Boolean)));
      return L.runDrift(i + 1, header, ops, async () => { await serial(); }, now);
    });
    const mean = (k: "current_recall" | "stale_leak_rate" | "dup_rate" | "supersede_miss_rate" | "expired_leak_rate" | "exact_dup_dedupe_rate") => round(results.reduce((a, r) => a + r[k], 0) / results.length);
    report.sets.drift = {
      timelines: results.length, facts: results.reduce((a, r) => a + r.facts, 0), queries: results.reduce((a, r) => a + r.queries, 0),
      current_recall: mean("current_recall"), stale_leak_rate: mean("stale_leak_rate"), expired_leak_rate: mean("expired_leak_rate"), dup_rate: mean("dup_rate"),
      supersede_miss_rate: mean("supersede_miss_rate"), exact_dup_dedupe_rate: mean("exact_dup_dedupe_rate"), active_facts: results.map((r) => r.active_facts),
    };
    failures.drift = results.flatMap((r, i) => r.failed.slice(0, 4).map((f) => `drift-${i + 1}: ${f}`));
  });

  // 5. extraction through the ambient path (secret/trivial filter -> captureTurn) and, for secret transcripts, the raw extractor
  if (want("extraction")) await guarded("extraction", async () => {
    phase = "extraction"; log("extraction");
    await resetDb();
    const rows = cut((await L.loadGold<import("../test/eval/lib").ExtractionRow>("extraction")).rows);
    const storedFor = async (ref: string) => (await db.select({ text: memories.text, validAt: memories.validAt }).from(memories).where(and(eq(memories.sourceRef, ref), eq(memories.kind, "fact")))).map((m) => ({ text: m.text, validAt: m.validAt?.toISOString() ?? null }));
    const results = await pmapSafe("extraction", rows, CONCURRENCY, async (r, i) => {
      const scope = { channelId: `C_EX${i}`, isPrivate: true, isIm: false, userId: null };
      const lines = (filter: boolean) => r.messages.map((m) => { const t = filter ? ambientText(m.text) : m.text; return t ? `${m.user}: ${t}` : null; }).filter((x): x is string => !!x);
      const at = new Date(r.messages.at(-1)!.ts);
      const kept = lines(true);
      if (kept.length) await captureTurn({ scope, transcript: kept.join("\n"), sourceRef: r.id, createdBy: "observe", confidence: 0.8, importance: 0.4, at });
      const facts = await storedFor(r.id);
      let raw: ExtractionScore | null = null;
      if (r.tags.includes("secret")) { // the extractor on its own: do the prompt and scanMemoryText keep secrets out when the regex filter is bypassed?
        const rawScope = { channelId: `C_EXR${i}`, isPrivate: true, isIm: false, userId: null };
        await captureTurn({ scope: rawScope, transcript: lines(false).join("\n"), sourceRef: `${r.id}:raw`, createdBy: "observe", confidence: 0.8, importance: 0.4, at });
        raw = L.scoreExtraction(r, await storedFor(`${r.id}:raw`));
      }
      // precision: is every stored fact supported by the conversation (judge model differs from the extractor)
      let supported = facts.length;
      if (facts.length) {
        const model = getModel("main");
        const res = await generateText({ model, system: L.PRECISION_SYSTEM, prompt: L.precisionPrompt(r.messages.map((m) => `${m.user}: ${m.text}`).join("\n"), facts.map((f) => f.text), at.toISOString().slice(0, 10)), temperature: 0, maxOutputTokens: 800, maxRetries: 6, abortSignal: AbortSignal.timeout(90_000), ...(think ? { providerOptions: think } : {}) });
        charge(model, res.totalUsage ?? res.usage);
        try { supported = parseModelJson(res.text, L.precisionSchema).supported.filter(Boolean).length; } catch { supported = facts.length; }
      }
      return { row: r, score: L.scoreExtraction(r, facts), raw, extracted: facts.length, supported, facts: facts.map((f) => f.text), filtered: r.messages.length - kept.length };
    });
    const sum = L.sumExtraction(results.map((x) => x.score), rows);
    const rawSecret = results.filter((x) => x.raw);
    report.sets.extraction = {
      ...sum, fact_precision_judge: frac(results.reduce((a, x) => a + x.supported, 0), results.reduce((a, x) => a + x.extracted, 0)),
      facts_per_transcript: round(results.reduce((a, x) => a + x.extracted, 0) / (results.length || 1), 2),
      messages_dropped_by_ambient_filter: results.reduce((a, x) => a + x.filtered, 0),
      secrets_stored_raw_extractor: rawSecret.reduce((a, x) => a + (x.raw?.secretsLeaked ?? 0), 0), secret_transcripts: rawSecret.length,
    };
    failures.extraction = results.filter((x) => x.score.found < x.score.expected || x.score.forbidden.length).slice(0, 15).map((x) => ({ id: x.row.id, missing: x.row.expect.filter((e) => !x.facts.some((f) => L.tokensIn(f, e.tokens))).map((e) => e.tokens.join("+")), forbidden: x.score.forbidden, facts: x.facts }));
  });
}

try { await run(); } catch (e) {
  aborted = e instanceof BudgetExceeded ? e.message : `error: ${String(e).slice(0, 300)}`;
  log("ABORTED", aborted);
}

// ---------------------------------------------------------------- report
const prev = await Bun.file(PREV).json().catch(() => null) as Record<string, any> | null;
const S = report.sets;
const agg = allItems;
const faith = L.sumFaithfulness(agg.map((i) => (i.correctJudge === null ? null : { abstains: i.abstained, correct: !!i.correctJudge, claims: [...i.unsupported.map((text) => ({ text, supported: false })), ...Array.from({ length: i.claims - i.unsupported.length }, () => ({ text: "", supported: true }))] })));
const headline = {
  unsupported_claim_rate: faith.unsupported_claim_rate,
  citation_validity: agg.length ? frac(agg.filter((i) => i.invalidUrls.length === 0).length, agg.length) : 1,
  abstention_recall_traps: S.abstention ? S.abstention.trap_recall : 1, trap_hits: S.abstention?.trap_hits ?? "n/a",
  abstention_recall: S.abstention?.abstention_recall ?? null,
  false_abstain_rate: agg.filter((i) => i.set === "qa" || i.set === "multihop" || i.set === "temporal").length ? frac(agg.filter((i) => ["qa", "multihop", "temporal"].includes(i.set) && i.abstained).length, agg.filter((i) => ["qa", "multihop", "temporal"].includes(i.set)).length) : null,
  answers_judged: faith.answers_judged, judge_failures: faith.judge_failures, claims: faith.claims,
  empty_answer_first_try_rate: frac(emptyAnswers.firstTry, emptyAnswers.total), empty_answer_final_rate: frac(emptyAnswers.final, emptyAnswers.total),
};
// metrics tracked run over run (higher is better)
const tracked = (s: Record<string, any>) => ({
  "qa.retrieval": s.qa?.retrieval_pass, "qa.answer_correct": s.qa?.answer_correct_judge, "multihop.retrieval": s.multihop?.retrieval_pass, "multihop.answer_correct": s.multihop?.answer_correct_judge,
  "aggregation.retrieval": s.aggregation?.retrieval_pass, "aggregation.answer_correct": s.aggregation?.answer_correct_token, "temporal.retrieval": s.temporal?.retrieval_pass, "temporal.answer_correct": s.temporal?.answer_correct_judge,
  "abstention.recall": s.abstention?.abstention_recall, "supersede.accuracy": s.supersede?.supersede_accuracy, "drift.current_recall": s.drift?.current_recall,
  "extraction.fact_recall": s.extraction?.fact_recall, "extraction.date_accuracy": s.extraction?.date_accuracy,
});
const cur = tracked(S), old = prev?.sets ? tracked(prev.sets) : {};
const deltas: Record<string, number> = {};
let drop = 0;
for (const [k, v] of Object.entries(cur)) if (typeof v === "number" && typeof (old as any)[k] === "number") { deltas[k] = round(v - (old as any)[k]); drop = Math.max(drop, (old as any)[k] - v); }
const failuresList = L.nightlyFailures({ ...headline, abstention_recall_traps: headline.abstention_recall_traps as number, recall_drop: drop });
if (S.extraction?.secrets_stored > 0) failuresList.push(`secrets stored through the ambient path: ${S.extraction.secrets_stored}`);
for (const [k, v] of Object.entries(phaseErrors)) failuresList.push(`phase ${k} failed: ${v.slice(0, 160)}`);
if (Object.keys(errors).length) failuresList.push(`items errored (dropped from metrics): ${JSON.stringify(errors)}`);
if (aborted) failuresList.push(aborted);

Object.assign(report, {
  durationSec: Math.round((Date.now() - T0) / 1000),
  models: { answer: answerModelId, judge: judgeModelId, extract: modelId("extract"), rewrite: modelId("triage"), embedding: `${process.env.GOOGLE_VERTEX_EMBED_MODEL ?? "gemini-embedding-001"} @ ${process.env.EMBEDDING_DIM ?? 1536} dims`, thinking: "minimal on every call, as production" },
  budget: { limitUsd: BUDGET_USD, spentUsd: round(spend.micros / 1e6, 4), byPhaseUsd: Object.fromEntries(Object.entries(spend.byPhase).map(([k, v]) => [k, round(v / 1e6, 4)])), llmCalls: spend.calls, embeddingCalls: embedStats.calls, embeddingMisses: embedStats.misses, note: "LLM cost from provider usage x llm.ts cost table; embeddings (~$0.15/M tokens) not included" },
  headline, deltasVsPrevious: deltas, previousAt: prev?.at ?? null, regressions: failuresList, failures, errors, phaseErrors, emptyAnswers, partial: !!aborted || SETS.size < 8 || LIMIT !== Infinity,
});
await Bun.write(OUT, `${JSON.stringify(report, null, 2)}\n`);

console.error(`\neval-nightly: report written to ${OUT}`);
console.error(`  spent $${report.budget.spentUsd} of $${BUDGET_USD}, ${report.durationSec}s, answer=${answerModelId} judge=${judgeModelId}`);
console.error(`  unsupported_claim_rate=${headline.unsupported_claim_rate} citation_validity=${headline.citation_validity} trap_abstention=${headline.trap_hits} false_abstain=${headline.false_abstain_rate}`);
if (report.questions) console.error(`  0.97 gate: ${report.questions.cosine_gate_097.answer}`);
console.error(failuresList.length ? `  REGRESSIONS:\n   - ${failuresList.join("\n   - ")}` : "  no regressions");
console.log(JSON.stringify(report));

await pool.end().catch(() => {});
await lockPool.end().catch(() => {});
process.exit(aborted?.startsWith("budget") ? 3 : failuresList.length ? 1 : 0);
