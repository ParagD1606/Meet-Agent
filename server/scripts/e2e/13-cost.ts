// (13) cost ledger totals vs the REAL usage numbers Vertex returned, and the monthly spend alert posting once.
import { app } from "../../src/app";
import { checkSpendAlert, costReport, monthSpendUsd } from "../../src/cost";
import { addFact } from "../../src/memory/supersede";
import { estimateCostMicros } from "../../src/llm";
import { C, U, check, finish, mention, q, setup, slack } from "./harness";

// capture usageMetadata of every Vertex chat response, per model
const usage: Record<string, { in: number; out: number; cached: number; thoughts: number; calls: number }> = {};
const wrapped = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const res = await wrapped(input, init);
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  const m = /models\/([\w.-]+):(?:stream)?[gG]enerateContent/.exec(url);
  if (!m) return res;
  const model = m[1]!;
  const clone = res.clone();
  void clone.text().then((t) => {
    let last: any = null;
    for (const line of t.split("\n")) { if (!line.startsWith("data:")) continue; try { const j = JSON.parse(line.slice(5)); if (j.usageMetadata) last = j.usageMetadata; } catch {} }
    if (!last) return;
    const u = (usage[model] ??= { in: 0, out: 0, cached: 0, thoughts: 0, calls: 0 });
    u.in += last.promptTokenCount ?? 0; u.out += last.candidatesTokenCount ?? 0; u.thoughts += last.thoughtsTokenCount ?? 0; u.cached += last.cachedContentTokenCount ?? 0; u.calls++;
  });
  return res;
}) as typeof fetch;

await setup();
for (const t of ["Priya Sharma owns the Titan launch checklist.", "Titan launches 2026-11-16.", "Team plan costs $49 per seat per month."]) await addFact({ tag: "shared", text: t, source: "slack", createdBy: U.ALICE });
const prompts = ["who owns the Titan launch checklist?", "when does Titan launch?", "how much is the Team plan?", "who owns Titan load testing?", "thanks!"];
for (const p of prompts) await mention({ channel: C.ENG, user: U.ALICE, text: p });
await new Promise((r) => setTimeout(r, 1500)); // let the clones finish
const turns = await q("select model, count(*)::int n, sum(input_tokens)::int i, sum(output_tokens)::int o, sum(cache_read_tokens)::int cr, sum(cost_micros)::bigint c from turns where status='done' group by model");
console.log("LEDGER", JSON.stringify(turns), "\nVERTEX ", JSON.stringify(usage));
const main = turns.find((t) => /flash$|flash-lite$/.test(t.model) && t.n > 0 && t.model === "gemini-3.5-flash");
const real = usage["gemini-3.5-flash"];
check("turns recorded with the real model name", !!main, JSON.stringify(turns));
// the ledger counts main-role turn calls; classifier/rewrite calls on flash-lite are not turns. input within a few % of the real sum
if (main && real) {
  const ratioIn = main.i / real.in;
  const outReal = real.out + real.thoughts;
  const ratioOut = main.o / outReal;
  console.log(`input ledger/real=${ratioIn.toFixed(3)} output ledger/real(out+thoughts)=${ratioOut.toFixed(3)} (real out=${real.out}, thoughts=${real.thoughts}, calls=${real.calls}, turns=${main.n})`);
  check("input tokens in the ledger match the real usage (within 2%)", Math.abs(ratioIn - 1) < 0.02, `ledger ${main.i} vs real ${real.in}`);
  check("output tokens (incl. reasoning) in the ledger match the real usage (within 2%)", Math.abs(ratioOut - 1) < 0.02, `ledger ${main.o} vs real ${outReal}`);
  const expected = estimateCostMicros("gemini-3.5-flash", { inputTokens: real.in, outputTokens: real.out + real.thoughts, cacheReadTokens: real.cached });
  check("cost_micros equals price table x real usage (within 2%)", Math.abs(Number(main.c) / expected - 1) < 0.02, `ledger ${main.c} vs expected ${expected}`);
} else check("real usage captured", false, JSON.stringify(usage));

// report endpoint totals
const rep = await costReport(7);
const dbTotal = Number((await q("select coalesce(sum(cost_micros),0)::bigint s from turns"))[0].s) / 1e6;
check("costReport total == sum of ledger rows", Math.abs(rep.totalUsd - dbTotal) < 1e-9, `${rep.totalUsd} vs ${dbTotal}`);
check("month spend == ledger", Math.abs((await monthSpendUsd()) - dbTotal) < 1e-9);
check("by-model breakdown has the used models", rep.byModel.length >= 1 && rep.byModel.every((m) => m.turns > 0));

// spend alert
slack.calls.length = 0;
check("no alert below the threshold", (await checkSpendAlert(new Date(), 1000)) === false);
const results = await Promise.all(Array.from({ length: 6 }, () => checkSpendAlert(new Date(), 0.000001)));
const posted = slack.of("chat.postMessage").filter((c) => /Model spend this month/.test(c.args.text ?? ""));
check("alert posts exactly once even under concurrent turns", results.filter(Boolean).length === 1 && posted.length === 1, JSON.stringify(results));
check("alert goes to the admin home channel with the amount", posted[0]?.args.channel === "CHOME" && /\$0\.\d\d/.test(posted[0]?.args.text), posted[0]?.args.text);
check("a later check the same month stays silent", (await checkSpendAlert(new Date(), 0.000001)) === false);
// next month: spend resets (no turns in that month) so no alert
check("next month starts clean (no spend yet -> no alert)", (await checkSpendAlert(new Date(Date.now() + 40 * 86400_000), 0.000001)) === false);
finish("13 cost ledger");
