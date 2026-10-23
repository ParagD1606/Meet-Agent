// Memory eval report against a THROWAWAY database (it truncates every table):
//   DATABASE_URL=<throwaway db> bun scripts/memory-eval.ts [--judge]
// Prints JSON: per-category recall@k, scope-leak failures, latency, failed case ids and the baseline delta.
// --judge additionally has the configured LLM (getModel) answer each question from the recalled context and grade the
// answer against the expected facts. Off by default (needs a model key, costs tokens, not deterministic).
import { generateText } from "ai";
import { getModel } from "../src/llm";
import { pool } from "../src/db";
import { CASES } from "../test/memory-eval/cases";
import { resetDb } from "../test/db";
import { installEvalFakes, runAll, seedCorpus, summarize } from "../test/memory-eval/run";

installEvalFakes();
await resetDb();
await seedCorpus();
const results = await runAll();
const report: Record<string, unknown> = summarize(results);

const baseline = Bun.file(new URL("../test/memory-eval/baseline.json", import.meta.url).pathname);
if (await baseline.exists()) {
  const base = (await baseline.json()) as { recall: Record<string, number> };
  const recall = report.recall as Record<string, number>;
  report.deltaVsBaseline = Object.fromEntries(Object.entries(recall).map(([k, v]) => [k, Math.round((v - (base.recall[k] ?? 0)) * 1000) / 1000]));
}

if (process.argv.includes("--judge")) {
  const model = getModel("main");
  let right = 0;
  let graded = 0;
  for (const c of CASES.filter((x) => x.expect)) {
    const r = results.find((x) => x.id === c.id)!;
    const answer = (await generateText({ model, system: "Answer the question using only the memory context. If it is not there, say you do not know.", prompt: `${r.recall.text}\n\nQuestion: ${c.question}` })).text;
    const verdict = (await generateText({
      model, maxOutputTokens: 5,
      prompt: `Question: ${c.question}\nExpected facts: ${c.expect!.join("; ")}\nAnswer: ${answer}\nDoes the answer state every expected fact? Reply YES or NO.`,
    })).text;
    graded++;
    if (/^\s*yes/i.test(verdict)) right++;
  }
  report.judge = { graded, accuracy: Math.round((right / (graded || 1)) * 1000) / 1000 };
}

console.log(JSON.stringify(report, null, 2));
await pool.end();
