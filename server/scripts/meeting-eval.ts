/**
 * Meeting-extraction evaluation with REAL models (PS-4). Runs the pipeline's analysis function over the gold fixtures and scores it.
 *
 *   set -a; . ../.env; set +a; export GOOGLE_APPLICATION_CREDENTIALS=/path/to/application_default_credentials.json
 *   bun run scripts/meeting-eval.ts [--n 10] [--fixture id] [--mode final|live] [--dir fixtures-dir] [--budget 2] [--retries 1] [--json out.json] [--write]
 *
 * --write rewrites docs/qa/meeting-eval.md and test/meeting-eval/baseline.json from this run (only do that for a full, error-free run).
 * Needs no database: analyzeLiveMeeting is stateless. Cost is an UPPER-BOUND estimate (input chars/4 + the output cap) from the repo's price table;
 * the run stops before a meeting that would exceed --budget (default $2). Never prints credentials.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, type Mode } from "../test/meeting-eval/adapter";
import { addCounts, confusionTable, emptyCounts, type Fixture, markdownTable, metrics, scoreMeeting, validateFixture } from "../test/meeting-eval/lib";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const root = new URL("..", import.meta.url).pathname;
const goldDir = arg("dir") ?? join(root, "test/meeting-eval/gold");
const mode = (arg("mode") ?? "final") as Mode;
const budget = Number(arg("budget") ?? 2);
const only = arg("fixture");
const retries = Number(arg("retries") ?? 1);

let fixtures: Fixture[] = readdirSync(goldDir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(goldDir, f), "utf8")));
for (const f of fixtures) { const e = validateFixture(f); if (e.length) { console.error(e.join("\n")); process.exit(1); } }
if (only) fixtures = fixtures.filter((f) => f.id === only);
if (arg("n")) fixtures = fixtures.slice(0, Number(arg("n")));
if (!fixtures.length) { console.error("no fixtures selected"); process.exit(1); }

const { getModel, estimateCostMicros } = await import("../src/llm");
const modelId = (getModel("main") as { modelId?: string }).modelId ?? "unknown";
const estimate = (fx: Fixture) => estimateCostMicros(modelId, { inputTokens: Math.ceil((fx.transcript.reduce((n, l) => n + l.text.length + l.speaker.length + 8, 0) + 7_000) / 4), outputTokens: 1_800 }) / 1e6;

let total = emptyCounts(), okTotal = emptyCounts();
let spent = 0, target = "", skippedForBudget = 0, failed = 0, firstFailed = 0;
const notes = new Set<string>();
const rows: { id: string; ms: number; error?: string; m?: ReturnType<typeof metrics>; pred?: unknown }[] = [];
for (const fx of fixtures) {
  if (spent + estimate(fx) > budget) { skippedForBudget++; rows.push({ id: fx.id, ms: 0, error: "skipped: budget cap" }); continue; }
  spent += estimate(fx);
  const t0 = performance.now();
  try {
    // One retry (--retries, default 1): a parse failure from a temperature-0 model is usually, not always, repeatable. First-attempt failures are reported.
    let a: Awaited<ReturnType<typeof analyze>> | undefined, last: unknown;
    for (let attempt = 0; attempt <= retries && !a; attempt++) {
      try { a = await analyze(fx, mode); } catch (e) { last = e; if (attempt === 0) firstFailed++; spent += estimate(fx); }
    }
    if (!a) throw last;
    const ms = performance.now() - t0;
    target = a.target; a.notes.forEach((n) => notes.add(n));
    const c = scoreMeeting(fx, a.pred, { ms });
    total = addCounts(total, c); okTotal = addCounts(okTotal, c);
    rows.push({ id: fx.id, ms, m: metrics(c), pred: a.pred });
    console.error(`${fx.id}: ${a.pred.tasks.length} items, ${Math.round(ms)} ms`);
  } catch (err) {
    // A crashed analysis is a failed extraction: score it as an empty result so reliability shows up in recall instead of being dropped.
    const ms = performance.now() - t0;
    const issues = (() => { try { const j = JSON.parse(String((err as Error).message)); return Array.isArray(j) ? j.map((i: { path?: unknown[]; message?: string }) => `${(i.path ?? []).join(".")}: ${i.message}`).slice(0, 2).join("; ") : null; } catch { return null; } })();
    const msg = `${issues ? `reply failed schema validation (${issues})` : String(err).replace(/\s+/g, " ")}`.slice(0, 200);
    const c = scoreMeeting(fx, { tasks: [], decisions: [], capabilities: { classification: true, duplicates: false, conflicts: false, quotes: false, approval: false } }, { ms });
    total = addCounts(total, c); failed++;
    rows.push({ id: fx.id, ms, m: metrics(c), error: `FAILED (scored as empty): ${msg}` });
    console.error(`${fx.id}: ${msg}`);
  }
}

const M = metrics(total);
const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${(v * 100).toFixed(0)}%`);
const K = metrics(okTotal);
const exFailed = failed ? `\n\nExcluding the ${failed} failed run(s) (${okTotal.meetings} meetings): task P/R/F1 ${pct(K.taskPrecision)}/${pct(K.taskRecall)}/${pct(K.taskF1)}, owner ${pct(K.ownerAccuracy)}, due ${pct(K.dueAccuracy)}, classification ${pct(K.classificationAccuracy)}, decision F1 ${pct(K.decisionF1)}.` : "";
const scored = rows.filter((r) => r.m).length;
const errors = rows.filter((r) => r.error && r.m).map((r) => `${r.id}: ${r.error}`);
const perMeeting = `| Meeting | Task P | Task R | Owner | Due | Class. | Dec. F1 | ms |\n|---|---|---|---|---|---|---|---|\n${rows.map((r) => r.m ? `| ${r.id}${r.error ? " (failed)" : ""} | ${pct(r.m.taskPrecision)} | ${pct(r.m.taskRecall)} | ${pct(r.m.ownerAccuracy)} | ${pct(r.m.dueAccuracy)} | ${pct(r.m.classificationAccuracy)} | ${pct(r.m.decisionF1)} | ${Math.round(r.ms)} |` : `| ${r.id} | ${r.error} | | | | | | |`).join("\n")}`;
const summary = `Mode: ${mode} -> ${target || "n/a"} | model: ${modelId} | meetings scored: ${scored}/${fixtures.length} (failed on first attempt: ${firstFailed}; still failing after ${retries} retry, scored as empty: ${failed}) | estimated cost (upper bound): $${spent.toFixed(3)} of $${budget.toFixed(2)}`;

console.log(`${summary}\n\n${markdownTable(M)}\n\nConfusion matrix (rows gold, columns predicted; matched tasks only)\n${confusionTable(M.confusion)}${exFailed}\n\n${perMeeting}${notes.size + errors.length ? `\n\nNotes:\n${[...notes, ...errors].map((n) => `- ${n}`).join("\n")}` : ""}`);

if (arg("json")) writeFileSync(arg("json")!, `${JSON.stringify({ mode, target, model: modelId, spent, metrics: M, perMeeting: rows, notes: [...notes] }, null, 2)}\n`);

if (flag("write")) {
  if (scored !== fixtures.length || skippedForBudget) { console.error("refusing --write: not every fixture was scored"); process.exit(1); }
  const date = new Date().toISOString().slice(0, 10);
  const keep = (k: keyof typeof M) => M[k];
  const baseline = {
    mode, target, model: modelId, date, fixtures: fixtures.length, goldTasks: total.goldTasks,
    metrics: Object.fromEntries((["taskPrecision", "taskRecall", "taskF1", "ownerAccuracy", "ownerAccuracyNamed", "dueAccuracy", "dueAccuracyDated", "classificationAccuracy", "decisionPrecision", "decisionRecall", "decisionF1", "duplicateDetectionRate", "falseDuplicateRate", "conflictDetectionRate", "hallucinationRate", "approvalSafety"] as const).map((k) => [k, keep(k)])),
  };
  writeFileSync(join(root, "test/meeting-eval/baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
  const doc = readFileSync(join(root, "../docs/qa/meeting-eval.md"), "utf8");
  const start = "<!-- RESULTS:START -->", end = "<!-- RESULTS:END -->";
  const block = `${start}\n_Generated by \`bun run scripts/meeting-eval.ts --write\` on ${date}._\n\n**${summary}**\n\n${markdownTable(M)}\n\nConfusion matrix (rows gold, columns predicted; matched tasks only):\n\n${confusionTable(M.confusion)}${exFailed}\n\nPer meeting:\n\n${perMeeting}\n${notes.size + errors.length ? `\nNotes from this run:\n\n${[...notes, ...errors].map((n) => `- ${n}`).join("\n")}\n` : ""}${end}`;
  writeFileSync(join(root, "../docs/qa/meeting-eval.md"), doc.includes(start) ? doc.replace(new RegExp(`${start}[\\s\\S]*${end}`), () => block) : `${doc}\n${block}\n`);
  console.error("wrote docs/qa/meeting-eval.md and test/meeting-eval/baseline.json");
}
process.exit(0);
