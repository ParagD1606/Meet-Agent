// Shared by eval.test.ts and scripts/memory-eval.ts: seed the corpus, run every case through buildRecall, score it.
import { db } from "../../src/db";
import { channelMembers, channels } from "../../src/db/schema";
import { setMemoryLlm } from "../../src/memory/llm";
import { buildRecall, clearRecallCache, type Recall } from "../../src/memory/recall";
import { addFact } from "../../src/memory/supersede";
import { installFakes } from "../memory/helpers";
import { type Case, CASES, CATEGORIES, CHANNELS, type Category, SCOPES } from "./cases";

export const K = 5;
export const BUDGET = 2500;

/** Fake embedder + a deterministic contradiction check that supersedes EXISTING lines containing the case's `replaces`. */
export function installEvalFakes() {
  installFakes();
  setMemoryLlm(async (a) => {
    if (a.system.includes("standalone search query")) {
      const q = /LATEST MESSAGE: (.*)$/m.exec(a.prompt)?.[1] ?? "";
      const rw = CASES.find((c) => c.question === q)?.rewrite;
      return JSON.stringify({ query: rw?.query ?? q, asOf: rw?.asOf ?? null });
    }
    const neu = /NEW: (.*)/.exec(a.prompt)?.[1] ?? "";
    const needle = replacing.find((r) => neu.includes(r.by))?.needle;
    const ids = needle ? [...a.prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].filter((m) => m[2]!.includes(needle)).map((m) => Number(m[1])) : [];
    return JSON.stringify({ superseded: ids });
  });
}
let replacing: { by: string; needle: string }[] = [];

/** Seeds channels and every case's facts (in case order) into the already-migrated, empty database. */
export async function seedCorpus() {
  for (const c of CHANNELS) {
    await db.insert(channels).values({ id: c.id, isPrivate: c.isPrivate, isIm: c.isIm });
    if (c.members.length) await db.insert(channelMembers).values(c.members.map((userId) => ({ channelId: c.id, userId })));
  }
  replacing = CASES.flatMap((c) => c.seed.filter((x) => x.replaces).map((x) => ({ by: x.text, needle: x.replaces! })));
  for (const c of CASES) {
    for (const f of c.seed) await addFact({ tag: f.tag, text: f.text, source: "eval", validAt: f.at ? new Date(f.at) : undefined });
  }
  clearRecallCache();
}

export type CaseResult = { id: string; category: Category; pass: boolean; leaked: boolean; ms: number; hits: string[]; recall: Recall };

const has = (texts: string[], sub: string) => texts.some((t) => t.toLowerCase().includes(sub.toLowerCase()));

export async function runCase(c: Case): Promise<CaseResult> {
  const t0 = performance.now();
  const recall = await buildRecall({ scope: SCOPES[c.scope], query: c.question, budgetTokens: BUDGET, threadTail: c.thread, asOf: c.asOf ? new Date(c.asOf) : undefined });
  const ms = performance.now() - t0;
  const hits = recall.hits.map((h) => h.text);
  const top = hits.slice(0, K);
  const forbid = c.forbid ?? [];
  const leaked = forbid.some((f) => (f === "*" ? hits.length > 0 : has(hits, f)));
  const found = (c.expect ?? []).every((e) => has(top, e));
  const firstOk = !c.first || has(hits.slice(0, 1), c.first);
  return { id: c.id, category: c.category, pass: found && firstOk && !leaked, leaked, ms, hits, recall };
}

export async function runAll(): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const c of CASES) out.push(await runCase(c));
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Per-category pass rate (expected facts in the top-K hits and nothing forbidden returned), plus latency and leak count. */
export function summarize(results: CaseResult[]) {
  const recall: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const cat of CATEGORIES) {
    const rs = results.filter((r) => r.category === cat);
    counts[cat] = rs.length;
    recall[cat] = round(rs.filter((r) => r.pass).length / (rs.length || 1));
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  return {
    k: K,
    cases: results.length,
    counts,
    recall,
    scopeLeakFailures: results.filter((r) => r.category === "scope-leak" && r.leaked).length,
    latencyMs: { mean: round(ms.reduce((a, b) => a + b, 0) / (ms.length || 1)), p95: round(ms[Math.floor(ms.length * 0.95)] ?? 0) },
    failed: results.filter((r) => !r.pass).map((r) => r.id),
  };
}
