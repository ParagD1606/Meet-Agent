// (3) recall quality: 40 questions over the seeded "Orbital Tea Co." + extra ambient chat, answered by REAL turns and judged by an LLM.
// Also compares MEMORY_RERANK on vs off at the recall layer (does the recalled block contain the key facts?).
import { writeFileSync } from "node:fs";
import { seedDemo } from "../seed-demo";
import { buildRecall, clearRecallCache } from "../../src/memory/recall";
import { channelMembers } from "../../src/db/schema";
import { abstains, check, db, drain, finish, judge, mention, q, say, setup, slack, traffic } from "./harness";

await setup({ cast: false });
await seedDemo();
await db.insert(channelMembers).values(["UDEMO01", "UDEMO04", "UDEMO05"].map((userId) => ({ channelId: "CDEMO_FIN", userId })));
await db.insert(channelMembers).values(["UDEMO01", "UDEMO02", "UDEMO03", "UDEMO04", "UDEMO05"].flatMap((userId) => ["CDEMO_GEN", "CDEMO_ENG", "CDEMO_CS"].map((channelId) => ({ channelId, userId }))));

// extra realistic chat through the real ambient pipeline
const d = (s: string) => new Date(`${s}T15:00:00Z`);
await say({ at: d("2026-10-10"), channel: "CDEMO_ENG", user: "UDEMO02", text: "We decided to move transactional email from Mailgun to Postmark, cutover on 2026-10-28, I own it." });
await say({ at: d("2026-10-09"), channel: "CDEMO_GEN", user: "UDEMO04", text: "Pricing: the Reserve plan is $39 per month per office, approved by Dana on 2026-10-09." });
await say({ at: d("2026-10-11"), channel: "CDEMO_CS", user: "UDEMO03", text: "Juniper Offices asked to add a fourth site in Austin starting 2026-11-15." });
await say({ at: d("2026-10-05"), channel: "CDEMO_GEN", user: "UDEMO01", text: "New policy: expense reports over $500 need Dana's approval, effective 2026-10-15." });
await say({ at: d("2026-10-12"), channel: "CDEMO_GEN", user: "UDEMO05", text: "We are hiring a part-time warehouse lead in Columbus, Ohio, posted on 2026-10-12." });
await drain(["CDEMO_ENG", "CDEMO_GEN", "CDEMO_CS"]);
await say({ at: d("2026-10-13"), channel: "CDEMO_ENG", user: "UDEMO02", text: "Update: the Lantern beta start moved from October 14 to October 21 because of the Stripe webhook bug." });
await drain(["CDEMO_ENG"]);
console.log("facts:", (await q("select count(*)::int n from memories where kind='fact' and status='active'"))[0].n);

type Q = { id: number; cat: string; ch: string; user: string; text: string; expected: string; must?: RegExp[]; abstain?: boolean; leak?: RegExp; followOf?: number };
const GEN = "CDEMO_GEN", ENG = "CDEMO_ENG", CS = "CDEMO_CS", FIN = "CDEMO_FIN";
const Qs: Q[] = [
  { id: 1, cat: "direct", ch: GEN, user: "UDEMO01", text: "Who is the CEO of Orbital Tea Co.?", expected: "Dana Okafor", must: [/Dana Okafor/] },
  { id: 2, cat: "direct", ch: GEN, user: "UDEMO02", text: "Who owns the Harbor Cafe account?", expected: "Sofia Alvarez", must: [/Sofia/] },
  { id: 3, cat: "direct", ch: GEN, user: "UDEMO03", text: "What days is the Order Portal deployed?", expected: "Tuesday and Thursday", must: [/Tuesday and Thursday/] },
  { id: 4, cat: "direct", ch: GEN, user: "UDEMO04", text: "Who is our main tea supplier and who is the backup?", expected: "Main Kessler Farms, backup Lotus Valley Imports", must: [/Kessler Farms; the backup/] },
  { id: 5, cat: "direct", ch: GEN, user: "UDEMO05", text: "What are our support hours?", expected: "8am to 6pm Eastern, Monday to Friday", must: [/8am to 6pm/] },
  { id: 6, cat: "direct", ch: GEN, user: "UDEMO01", text: "How quickly do we triage support tickets?", expected: "within 4 business hours", must: [/4 business hours/] },
  { id: 7, cat: "direct", ch: GEN, user: "UDEMO02", text: "Which payments provider did we pick for the Order Portal?", expected: "Stripe", must: [/Stripe over a custom/] },
  { id: 8, cat: "direct", ch: GEN, user: "UDEMO03", text: "What plans does Orbital offer?", expected: "Sampler (monthly), Classic (weekly), Reserve (twice weekly)", must: [/Sampler/] },
  { id: 9, cat: "direct", ch: GEN, user: "UDEMO04", text: "What is the lead time for Kessler Farms shipments?", expected: "10 days; ships the first Monday of each month", must: [/10-day lead/] },
  { id: 10, cat: "direct", ch: GEN, user: "UDEMO05", text: "When is the company all-hands?", expected: "first Friday of the month at 10:00", must: [/first Friday/] },
  { id: 11, cat: "direct", ch: GEN, user: "UDEMO01", text: "What payment terms does Harbor Cafe have?", expected: "net-30", must: [/net-30/] },
  { id: 12, cat: "direct", ch: GEN, user: "UDEMO02", text: "How does Marcus like design reviews run?", expected: "as written docs, not live meetings", must: [/written docs/] },
  { id: 13, cat: "extra", ch: GEN, user: "UDEMO03", text: "Which email provider are we moving to and when is the cutover?", expected: "Postmark, cutover 2026-10-28", must: [/Postmark/] },
  { id: 14, cat: "extra", ch: GEN, user: "UDEMO04", text: "How much does the Reserve plan cost?", expected: "$39 per month per office", must: [/\$39/] },
  { id: 15, cat: "extra", ch: GEN, user: "UDEMO05", text: "What did Juniper Offices ask for recently?", expected: "a fourth site in Austin starting 2026-11-15", must: [/Austin/] },
  { id: 16, cat: "extra", ch: GEN, user: "UDEMO01", text: "Who has to approve expense reports over $500?", expected: "Dana", must: [/Dana/] },
  { id: 17, cat: "extra", ch: GEN, user: "UDEMO02", text: "What role are we hiring for in Columbus?", expected: "a part-time warehouse lead", must: [/warehouse lead/] },
  { id: 18, cat: "temporal", ch: GEN, user: "UDEMO03", text: "When does the Reserve plan launch?", expected: "November (moved from October)", must: [/November/] },
  { id: 19, cat: "temporal", ch: GEN, user: "UDEMO04", text: "What was true in early September 2026 about when the Reserve plan would launch?", expected: "October (it was planned for October at that time, before it moved to November)", must: [/October/] },
  { id: 20, cat: "temporal", ch: GEN, user: "UDEMO05", text: "When does the Lantern beta start?", expected: "October 21 (moved from October 14)", must: [/October 21/] },
  { id: 21, cat: "temporal", ch: GEN, user: "UDEMO01", text: "What did we decide about payments back in March?", expected: "chose Stripe over a custom payments integration", must: [/Stripe/] },
  { id: 22, cat: "temporal", ch: GEN, user: "UDEMO02", text: "Back in August, which month was the Reserve plan supposed to launch in?", expected: "October", must: [/October/] },
  { id: 23, cat: "multihop", ch: GEN, user: "UDEMO03", text: "Who leads the project that redesigns the Order Portal checkout?", expected: "Marcus Lee (Project Lantern)", must: [/Lantern/, /Marcus/] },
  { id: 24, cat: "multihop", ch: GEN, user: "UDEMO04", text: "Which customer does Sofia own and how many locations does it have?", expected: "Harbor Cafe, 12 locations", must: [/Harbor Cafe/] },
  { id: 25, cat: "multihop", ch: GEN, user: "UDEMO05", text: "Who owns the billing migration and when is the invoice import due?", expected: "Tom Becker, October 31", must: [/Kettle/] },
  { id: 26, cat: "multihop", ch: ENG, user: "UDEMO02", text: "What feature flag does Project Lantern ship behind and who gets it first?", expected: "flag lantern_checkout_v2; Harbor Cafe first", must: [/lantern_checkout_v2/] },
  { id: 27, cat: "multihop", ch: GEN, user: "UDEMO01", text: "Who reviews supplier contracts, and which supplier ships on the first Monday of the month?", expected: "Priya and Tom review; Kessler Farms ships first Monday", must: [/reviewed by Priya and Tom/] },
  { id: 28, cat: "private", ch: FIN, user: "UDEMO04", text: "How did Q3 supplier spend look?", expected: "8% under budget thanks to the Kessler Farms volume discount", must: [/8% under budget/] },
  { id: 29, cat: "private-leak", ch: GEN, user: "UDEMO03", text: "How did Q3 supplier spend look?", expected: "", abstain: true, leak: /8%|under budget|volume discount/i },
  { id: 30, cat: "private", ch: FIN, user: "UDEMO05", text: "What did we decide about marketing hiring?", expected: "hold hiring for two marketing roles until Reserve launch numbers are in", must: [/hold hiring/] },
  { id: 31, cat: "private-leak", ch: GEN, user: "UDEMO02", text: "Are we holding marketing hires?", expected: "", abstain: true, leak: /hold hiring|two marketing roles|until the Reserve launch numbers/i },
  { id: 32, cat: "abstain", ch: GEN, user: "UDEMO01", text: "Who is our CTO?", expected: "", abstain: true },
  { id: 33, cat: "abstain", ch: GEN, user: "UDEMO02", text: "What was our revenue in Q4 2025?", expected: "", abstain: true },
  { id: 34, cat: "abstain", ch: GEN, user: "UDEMO03", text: "Which city is our Berlin office in?", expected: "", abstain: true },
  { id: 35, cat: "abstain", ch: GEN, user: "UDEMO04", text: "What is the office Wi-Fi password?", expected: "", abstain: true },
  { id: 36, cat: "abstain", ch: GEN, user: "UDEMO05", text: "What did we decide about the Series A?", expected: "", abstain: true },
  { id: 37, cat: "abstain", ch: GEN, user: "UDEMO01", text: "What is Marcus's phone number?", expected: "", abstain: true },
  { id: 38, cat: "followup", ch: GEN, user: "UDEMO03", text: "Who owns the Order Portal codebase?", expected: "Marcus Lee", must: [/Marcus/] },
  { id: 39, cat: "followup", ch: GEN, user: "UDEMO04", text: "Tell me about Harbor Cafe.", expected: "12-location cafe chain, largest customer", must: [/Harbor Cafe/] },
  { id: 40, cat: "followup", ch: GEN, user: "UDEMO05", text: "What is Project Lantern?", expected: "redesign of the Order Portal checkout led by Marcus Lee", must: [/Lantern/] },
];
const FOLLOW: Record<number, { text: string; expected: string; cat: string }> = {
  38: { text: "and when is it deployed?", expected: "Tuesday and Thursday", cat: "followup2" },
  39: { text: "who handles that account?", expected: "Sofia Alvarez", cat: "followup2" },
  40: { text: "what is its target?", expected: "a 15% drop in checkout abandonment", cat: "followup2" },
};

const results: any[] = [];
const run = async (qq: { id: number; cat: string; ch: string; user: string; text: string; expected: string; abstain?: boolean; leak?: RegExp }, thread?: string) => {
  const t0 = Date.now();
  const ts = await mention({ channel: qq.ch, user: qq.user, text: qq.text, thread_ts: thread });
  const root = thread ?? ts;
  const answer = slack.reply(qq.ch, root);
  const ms = Date.now() - t0;
  let ok: boolean, why = "";
  if (qq.abstain) {
    ok = abstains(answer) && !(qq.leak?.test(answer));
    if (!ok) { const j = await judge(qq.text, answer, "The assistant says it does not know / has no record, and states no specific fact."); ok = j.correct && !(qq.leak?.test(answer)); why = j.reason ?? ""; }
  } else { const j = await judge(qq.text, answer, qq.expected); ok = j.correct; why = j.reason ?? ""; }
  results.push({ id: qq.id, cat: qq.cat, q: qq.text, ok, ms, answer: answer.slice(0, 400), why });
  console.log(`${ok ? "PASS" : "FAIL"} #${qq.id} [${qq.cat}] ${ms}ms  ${qq.text}\n      -> ${answer.replace(/\n+/g, " ").slice(0, 260)}${ok ? "" : `\n      judge: ${why}`}`);
  return root;
};

// 4 at a time (different users/threads; replies are matched by thread root)
const main = Qs;
for (let i = 0; i < main.length; i += 4) {
  const roots = await Promise.all(main.slice(i, i + 4).map((x) => run(x)));
  for (const [k, root] of roots.entries()) {
    const f = FOLLOW[main[i + k]!.id];
    if (f) { const base = main[i + k]!; await run({ ...base, id: base.id + 100, text: f.text, expected: f.expected, cat: f.cat }, root); }
  }
}

const by = new Map<string, { n: number; ok: number }>();
for (const r of results) { const b = by.get(r.cat) ?? { n: 0, ok: 0 }; b.n++; if (r.ok) b.ok++; by.set(r.cat, b); }
console.log("\nCATEGORY ACCURACY:", [...by].map(([c, b]) => `${c} ${b.ok}/${b.n}`).join(" | "));
const total = results.filter((r) => r.ok).length;
console.log(`TOTAL ${total}/${results.length}  avg latency ${Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length)}ms`);
const tok = await q("select depth, count(*)::int n, round(avg(input_tokens))::int avg_in, round(avg(output_tokens))::int avg_out, round(avg(steps),1) steps, round(avg(cost_micros))::int cost_micros from turns group by depth");
console.log("TURNS:", JSON.stringify(tok));
const bd = await q("select max((prompt_breakdown->>'total')::int) mx, round(avg((prompt_breakdown->>'total')::int)) av from turns where prompt_breakdown is not null");
console.log("PROMPT TOKENS (estimated):", JSON.stringify(bd));
check("answers judged correct >= 85%", total / results.length >= 0.85, `${total}/${results.length}`);
check("no private leak", results.filter((r) => r.cat === "private-leak").every((r) => r.ok), JSON.stringify(results.filter((r) => r.cat === "private-leak").map((r) => r.answer)));

// ---- rerank on vs off (recall layer only; no answer LLM) ----
const hit = async (rerankOn: boolean) => {
  process.env.MEMORY_RERANK = rerankOn ? "true" : "";
  clearRecallCache();
  let got = 0, n = 0, tokens = 0;
  const t0 = Date.now();
  const missed: number[] = [];
  for (const x of Qs.filter((x) => x.must)) {
    const r = await buildRecall({ scope: { channelId: x.ch, isPrivate: x.ch === FIN, isIm: false, userId: x.user }, query: x.text, budgetTokens: 3500, rewrite: true });
    n++; tokens += r.tokens;
    if (x.must!.every((m) => m.test(r.text))) got++; else missed.push(x.id);
  }
  return { got, n, avgTokens: Math.round(tokens / n), ms: Date.now() - t0, missed };
};
const off = await hit(false), on = await hit(true);
console.log("RERANK OFF:", JSON.stringify(off));
console.log("RERANK ON :", JSON.stringify(on));
process.env.MEMORY_RERANK = "";
writeFileSync("/tmp/claude-1000/e2e-recall.json", JSON.stringify({ results, off, on }, null, 1));
check("recall block contains the key fact for >= 90% (rerank off)", off.got / off.n >= 0.9, JSON.stringify(off));
finish("03 recall quality");
