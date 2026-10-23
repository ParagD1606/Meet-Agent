// Token-efficiency benchmark (CONTRACTS "Token efficiency & management").
// Replays a scripted 30-message thread and prints, per checkpoint, the per-component prompt breakdown for
//   BEFORE = the pass-1 assembly modelled here (raw 30-message history, all 40 retrieval candidates with ids/scores, every tool listed)
//   AFTER  = the shipped assembly (depth router, rolling summary + token window, packed recall, tool diet)
// and, when a model is reachable, the provider-reported input tokens for both.
//
//   MODEL_BASE_URL=http://localhost:11434/v1 MODEL_NAME=llama3.2:3b bun scripts/bench-tokens.ts
//   (any OpenAI-compatible endpoint; or MODEL_API_KEY for a hosted provider)
// Needs no database for the core numbers; with DATABASE_URL reachable it also measures the real tool schemas.
// With no reachable model it still prints the estimated breakdown and says so; exit code is 0 unless a target fails.
process.env.DATABASE_URL ??= "postgres://brain:brain@127.0.0.1:5432/brain";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.EMBEDDING_BASE_URL ??= process.env.MODEL_BASE_URL ?? "http://localhost:0/v1";

const { generateText } = await import("ai");
const { z } = await import("zod");
const { breakdown, estimateTokens, packToBudget } = await import("../src/memory/budget");
const { renderHit, DEFAULT_RECALL_BUDGET } = await import("../src/memory/recall");
const { STATIC_SYSTEM } = await import("../src/turn/prompt");
const { DEPTH_CONFIG, heuristicDepth } = await import("../src/turn/depth");
const { getModel, probeModel } = await import("../src/llm");

type Msg = { role: "user" | "assistant"; text: string };
type MemoryHit = Parameters<typeof renderHit>[0];

// ---------- scripted thread: 15 exchanges = 30 messages, with the noise the diet is meant to remove ----------
const BLOB = Array.from({ length: 40 }, (_, i) => `2026-03-0${(i % 9) + 1} 12:0${i % 10} INFO billing-worker job=${i} status=ok latency=${100 + i}ms`).join("\n");
const QUESTIONS = [
  "hey brain", "who owns the billing migration?", "what did we decide about pricing last week?",
  "<@U02ABC> thanks, can you check https://status.example.com/incidents for the outage?", "when is the launch deadline?",
  `here is the log from prod:\n${BLOB}`, "why did the nightly job fail?", "which customers were affected?",
  "what's the status of the refund policy doc?", "do we have a runbook for this?", "who is on call this week?",
  "remind me what Mahesh said about the pricing page", "is there an owner for the Q3 roadmap?", "thanks!", "what changed since yesterday?",
];
const ANSWERS = (q: string) =>
  `> ${q.slice(0, 80)}\nHere is what I found. The billing migration is owned by Priya's team, the deadline is Friday, and the pricing decision from last week was to keep $400/mo usage based. ` +
  "I checked the incident page and the runbook. Details: " + "the migration moves invoices to the new ledger, backfills 18 months of history, and keeps the old tables read-only for a week. ".repeat(3);
const thread: Msg[] = QUESTIONS.flatMap((q) => [{ role: "user" as const, text: `<@U01XYZ>: ${q}` }, { role: "assistant" as const, text: ANSWERS(q) }]);

// ---------- fixtures ----------
const FACTS: MemoryHit[] = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1, scopeTag: "shared", source: i % 3 ? "slack" : "upload", sourceRef: null, score: 1 - i / 60, kind: "fact", status: "active",
  createdAt: new Date(Date.UTC(2026, 0, 1 + i)), validAt: new Date(Date.UTC(2026, 0, 1 + i)),
  text: `Billing migration note ${i}: owner is team ${i % 6}, deadline moved to day ${i + 3}, pricing stays $400/mo. ${"Extra context sentence about the ledger backfill. ".repeat(1 + (i % 4))}`,
} as unknown as MemoryHit));
const CORE = ["Company: B2B payments platform, ~120 people, billing in EU+US.", "Channel: #billing - migration war room.", "User: prefers terse answers."].join("\n");
const WORKSPACE = "Always cite the source channel. Escalate outages to #incidents. Fiscal year starts in April.";
const SKILLS = "- weekly-digest: summarise the week\n- incident-brief: write an incident summary";

// ---------- tool schemas (real when DB reachable, else skipped) ----------
type ToolSetLike = Record<string, { description?: string; inputSchema?: unknown }>;
const schemaTokens = (tools: ToolSetLike, names?: string[]) =>
  (names ?? Object.keys(tools)).reduce((n, k) => {
    const t = tools[k];
    let schema = "";
    try { schema = JSON.stringify(z.toJSONSchema(t?.inputSchema as never)); } catch { schema = "x".repeat(120); }
    return n + estimateTokens(`${k} ${t?.description ?? ""} ${schema}`);
  }, 0);

let toolsAfter: ((text: string, depth: "tools" | "deep") => Promise<number>) | null = null;
let toolsBefore = 0;
try {
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");
  await Promise.race([db.execute(sql`select 1`), new Promise((_, r) => setTimeout(() => r(new Error("db timeout")), 3000))]);
  const { assembleTools, buildTools } = await import("../src/turn/tools");
  const ctx = { turnId: "bench", userId: "UBENCH", channelId: "CBENCH", scope: { channelId: "CBENCH", isPrivate: false, isIm: false, userId: "UBENCH" }, readOnly: false, orgConnectionsOnly: false, trigger: "mention" as const };
  toolsBefore = schemaTokens((await buildTools(ctx as never)) as ToolSetLike);
  toolsAfter = async (text, depth) => {
    const a = await assembleTools({ ...ctx, depth } as never, { depth, text });
    return schemaTokens(a.tools as ToolSetLike, a.active());
  };
} catch (e) {
  console.log(`note: database/tools not available (${(e as Error).message}); tool-schema numbers are skipped.\n`);
}

// ---------- context assembly: before vs after ----------
const flat = (ms: Msg[]) => ms.map((m) => `${m.role === "user" ? "U" : "A"}: ${m.text}`).join("\n");
// shipped history diet = rolling summary + recent verbatim window (turn/compact.ts); markup stripping is NOT modelled
const stripNoise = (t: string) => t;
const WINDOW_TOKENS = 1500;

function historyAfter(prior: Msg[]): { text: string; summaryTokens: number } {
  const recent: Msg[] = [];
  let t = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const c = estimateTokens(stripNoise(prior[i]!.text)) + 4;
    if (t + c > WINDOW_TOKENS) break;
    recent.unshift({ ...prior[i]!, text: stripNoise(prior[i]!.text).slice(0, 1200) });
    t += c;
  }
  const older = prior.length - recent.length;
  const summary = older > 0 ? `[REFERENCE ONLY summary of ${older} earlier messages] Active task: billing migration Q&A. Decisions: pricing $400/mo. Owner: Priya's team. Pending: refund doc status.` : "";
  return { text: `${summary}\n${flat(recent)}`.trim(), summaryTokens: estimateTokens(summary) };
}

type Row = { label: string; depth: string; before: ReturnType<typeof breakdown>; after: ReturnType<typeof breakdown>; promptBefore: string; promptAfter: string; calls: number };

async function checkpoint(n: number): Promise<Row> {
  const prior = thread.slice(0, n - 1); // messages before the n-th user message
  const q = thread[n - 1]!.text;
  const text = q.replace(/^<@U01XYZ>:\s*/, "");
  const depth = heuristicDepth({ trigger: "mention", text, hasHistory: prior.length > 0 }) ?? "memory";
  const plan = DEPTH_CONFIG[depth];

  const recallBefore = FACTS.map((h) => `- [id=${h.id} score=${h.score.toFixed(3)} scope=${h.scopeTag}] ${h.text} (${h.source})`).join("\n");
  const packed = packToBudget(FACTS, DEFAULT_RECALL_BUDGET - 40, renderHit);
  const recallAfter = plan.recall ? `<memory-context>\n${packed.lines.join("\n")}\n</memory-context>` : "";

  const toolsB = toolsBefore;
  const toolsA = plan.tools && toolsAfter ? await toolsAfter(text, depth === "deep" ? "deep" : "tools") : 0;

  const histB = flat(prior.slice(-30));
  const histA = plan.recall || plan.tools || depth !== "direct" ? historyAfter(prior).text : flat(prior.slice(-4).map((m) => ({ ...m, text: stripNoise(m.text).slice(0, 300) })));

  const before = breakdown({ system: STATIC_SYSTEM, coreBlocks: `${CORE}\n${WORKSPACE}`, skills: SKILLS, toolSchemas: toolsB, history: histB, recall: recallBefore, user: q });
  const after = breakdown({ system: STATIC_SYSTEM, coreBlocks: `${CORE}\n${WORKSPACE}`, skills: SKILLS, toolSchemas: toolsA, history: histA, recall: recallAfter, user: text });
  return {
    label: `msg ${n}`, depth, before, after,
    calls: 1, // one model call for direct/memory; tool depths add steps, not first-step prompt
    promptBefore: [STATIC_SYSTEM, CORE, WORKSPACE, SKILLS, histB, recallBefore, q].join("\n\n"),
    promptAfter: [STATIC_SYSTEM, WORKSPACE, SKILLS, CORE, histA, recallAfter, text].filter(Boolean).join("\n\n"),
  };
}

// ---------- model ----------
const probe = await probeModel("main", 15_000).catch((e) => ({ ok: false, model: "none", ms: 0, error: String(e) }));
if (!probe.ok) {
  console.log(`note: no model reachable (${(probe as { error?: string }).error ?? "unconfigured"}). Set MODEL_BASE_URL (+ MODEL_NAME) for any OpenAI-compatible endpoint, or MODEL_API_KEY.`);
  console.log("      Showing estimated token breakdown only; provider-reported usage is skipped.\n");
} else {
  console.log(`model: ${probe.model} (${probe.ms}ms probe)\n`);
}
async function realInput(prompt: string, system: string): Promise<number | null> {
  if (!probe.ok) return null;
  try {
    const r = await generateText({ model: getModel("main"), system, prompt, maxOutputTokens: 16, abortSignal: AbortSignal.timeout(60_000) });
    return r.usage.inputTokens ?? null;
  } catch { return null; }
}

// ---------- run ----------
const checkpoints = [1, 7, 13, 21, 27, 29]; // 1-based message index of the user message being answered
const rows: Row[] = [];
for (const n of checkpoints) rows.push(await checkpoint(n));

const pad = (s: string | number, w: number) => String(s).padStart(w);
const cols = ["system", "coreBlocks", "skills", "toolSchemas", "history", "recall", "user", "total"] as const;
console.log("per-component tokens (estimated)  [before -> after]");
console.log(["checkpoint", "depth", ...cols].map((c, i) => (i < 2 ? c.padEnd(i ? 8 : 11) : pad(c, 14))).join(" "));
let sumB = 0, sumA = 0, realB = 0, realA = 0, realN = 0;
for (const r of rows) {
  console.log([r.label.padEnd(11), r.depth.padEnd(8), ...cols.map((c) => pad(`${r.before[c]}->${r.after[c]}`, 14))].join(" "));
  sumB += r.before.total; sumA += r.after.total;
  const [rb, ra] = [await realInput(r.promptBefore, ""), await realInput(r.promptAfter, "")];
  if (rb != null && ra != null) { realB += rb; realA += ra; realN++; }
}
const cut = 1 - sumA / sumB;
console.log(`\ninput tokens over ${rows.length} checkpoints (estimated): ${sumB} -> ${sumA}  (${(cut * 100).toFixed(1)}% lower)`);
if (realN) console.log(`input tokens over ${realN} checkpoints (provider-reported, system folded into prompt): ${realB} -> ${realA}  (${((1 - realA / realB) * 100).toFixed(1)}% lower)`);

// ---------- target checks ----------
const long = rows.filter((r) => r.label !== "msg 1");
const results: [string, boolean, string][] = [
  [">=50% fewer input tokens on the long thread", 1 - long.reduce((a, r) => a + r.after.total, 0) / long.reduce((a, r) => a + r.before.total, 0) >= 0.5, `${(100 * (1 - long.reduce((a, r) => a + r.after.total, 0) / long.reduce((a, r) => a + r.before.total, 0))).toFixed(1)}%`],
  ["recall <= 2.5k tokens", rows.every((r) => r.after.recall <= 2500), `max ${Math.max(...rows.map((r) => r.after.recall))}`],
  ["trivial turn: direct depth, no recall, no tools, 1 call", rows[0]!.depth === "direct" && rows[0]!.after.recall === 0 && rows[0]!.after.toolSchemas === 0 && rows[0]!.calls === 1, `depth=${rows[0]!.depth}`],
];
if (toolsAfter) {
  const t = await toolsAfter("check the github issues", "tools");
  results.push(["tool schemas <= 1.5k tokens for a tools turn", t <= 1500, `${t} (all tools: ${toolsBefore})`]);
}
console.log("\ntargets");
for (const [name, ok, detail] of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  [${detail}]`);
console.log("  (prefix byte-identical across users: asserted by test/turn/budgets.test.ts)");
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
