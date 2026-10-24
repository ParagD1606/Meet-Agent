// (5) consolidation v2 nightly run + undo, soft delete, review-queue paths (real embeddings + LLM).
import { sql } from "drizzle-orm";
import { consolidate, undoConsolidation } from "../../src/memory/consolidate";
import { embed } from "../../src/memory/embed";
import { addFact } from "../../src/memory/supersede";
import { deleteMemory } from "../../src/memory/graph";
import { decideReview, listReviews } from "../../src/memory/review";
import { getCoreBlocks } from "../../src/memory/core-blocks";
import { memories, episodes, memoryReviews } from "../../src/db/schema";
import { C, U, check, db, finish, q, setup } from "./harness";

await setup();
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
async function put(tag: string, text: string, o: Partial<typeof memories.$inferInsert> = {}): Promise<number> {
  const [v] = await embed([text]);
  const [r] = await db.insert(memories).values({ scopeTag: tag, text, embedding: v!, createdBy: U.ALICE, ...o }).returning({ id: memories.id });
  return r!.id;
}
const st = async (id: number) => (await q("select status, superseded_by, importance, invalid_at from memories where id=$1", [id]))[0];

// merge pair (near duplicates), keep the older/more-used
const m1 = await put("shared", "The Atlas service is deployed every Tuesday and Thursday afternoon.");
const m2 = await put("shared", "Atlas service deployments happen every Tuesday and Thursday afternoon.");
const sim = (await q("select 1 - (a.embedding <=> b.embedding) s from memories a, memories b where a.id=$1 and b.id=$2", [m1, m2]))[0].s;
console.log("merge pair similarity", sim);
// expired transient
const exp = await put("shared", "Office closed for the Diwali week with no deliveries.", { validAt: ago(120), validUntil: ago(60), factType: "fact" });
// stale cluster (>=8, low importance, never accessed, >180d old)
const stale: number[] = [];
const staleTexts = ["The 2025 offsite budget was $12k.", "The old Q1 2025 roadmap listed the Mercury module.", "In early 2025 the support inbox moved to Zendesk.", "The 2025 intern cohort had four people.", "A 2025 hackathon was won by the data team.", "The old lunch vendor was Greenleaf Catering.", "In 2025 the VPN was replaced by Tailscale.", "The 2025 holiday party was held at Pier 9.", "The 2025 security training was run by Cobalt Labs."];
for (const t of staleTexts) stale.push(await put("shared", t, { validAt: ago(260), importance: 0.2, createdAt: ago(260) }));
// cross-scope: a private-channel fact duplicating a NEWER shared fact
const priv = await put(`channel_${C.EXEC}`, "Our flagship plan costs $49 per seat per month.", { validAt: ago(40) });
const pub = await put("shared", "Our flagship plan costs $49 per seat per month.", { validAt: ago(5) });
// private fact with no shared twin must survive
const privKeep = await put(`channel_${C.EXEC}`, "The acquisition ceiling approved by the board is $4M for Orion Labs.", { validAt: ago(10) });
// hot shared fact -> promotion review
const hot = await put("shared", "Support tickets are triaged within 4 business hours.", { accessCount: 12, importance: 0.8 });
// episodes -> About block + procedures
const epTexts = ["Thread: engineers agreed releases go out after QA signs off, then the on-call posts in #eng and tags the release.", "Thread: to roll back a release the on-call reverts the tag, redeploys, and posts the incident summary in #eng.", "Thread: new services need a runbook, a dashboard and an on-call owner before launch."];
for (const [i, s] of epTexts.entries()) {
  const [v] = await embed([s]);
  await db.insert(episodes).values({ id: `ep${i}`, scopeTag: "shared", channelId: C.ENG, threadTs: `17000000${i}.0001`, summary: s, embedding: v!, endedAt: new Date(Date.now() - i * 3600_000) });
}
// entity summary: >=3 facts about an entity
for (const t of ["Zephyr Corp is our design partner for the beta.", "Zephyr Corp signed the pilot agreement on 2026-09-01.", "Zephyr Corp's main contact is Jo Lindqvist."]) await addFact({ tag: "shared", text: t, source: "slack", createdBy: U.BOB, entities: [{ name: "Zephyr Corp", type: "org" }] });
const nowActive = (await q("select count(*)::int n from memories where status='active'"))[0].n;

const r1 = await consolidate();
console.log("RUN1", JSON.stringify(r1));
check("near-duplicate merged (one superseded, one active)", [(await st(m1)).status, (await st(m2)).status].sort().join() === "active,superseded" || sim < 0.95, `${(await st(m1)).status}/${(await st(m2)).status} sim=${sim}`);
check("expired transient archived", (await st(exp)).status === "archived", JSON.stringify(await st(exp)));
check("stale cluster summarised, originals archived (not deleted)", r1.summarised >= 8 && (await q("select count(*)::int n from memories where id = any($1) and status='archived'", [stale]))[0].n >= 8, `summarised=${r1.summarised}`);
check("digest fact created from stale cluster", (await q("select count(*)::int n from memories where source='consolidation' and status='active' and kind='fact' and created_by='consolidation'"))[0].n >= 1);
check("private duplicate of NEWER shared fact superseded by it", (await st(priv)).status === "superseded" && Number((await st(priv)).superseded_by) === pub, JSON.stringify(await st(priv)));
check("private fact without shared twin untouched; shared fact never changed by private ones", (await st(privKeep)).status === "active" && (await st(pub)).status === "active");
check("hot fact queued for promotion via review (NOT written to the company block)", r1.promoted >= 1 && (await listReviews("pending")).some((r) => r.kind === "core_block" && (r.payload as any).text?.includes("triaged within 4")) && !(await getCoreBlocks({ channelId: "web", isPrivate: false, isIm: false, userId: null })).company!.text.includes("triaged"));
check("About block written for the channel from episodes", r1.aboutBlocks >= 1 && /^About: /m.test((await q("select text from core_blocks where scope_tag=$1", [`channel_${C.ENG}`]))[0]?.text ?? ""), (await q("select text from core_blocks where scope_tag=$1", [`channel_${C.ENG}`]))[0]?.text);
check("entity summary generated", r1.entitySummaries >= 1, `entitySummaries=${r1.entitySummaries}\n${JSON.stringify(await q("select summary from entity_summaries"))}`);
check("procedure candidates held for review, not live", r1.procedures === 0 || (await q("select count(*)::int n from memories where fact_type='procedure' and created_by='consolidation' and review_state='pending'"))[0].n === r1.procedures, `procedures=${r1.procedures}`);
check("decay applied to decayable facts", r1.decayed >= 1, `decayed=${r1.decayed}`);

// idempotent
const r2 = await consolidate();
console.log("RUN2", JSON.stringify(r2));
check("second run changes nothing (merged/cross/decayed/expired/summarised/promoted/procedures all 0)", r2.merged + r2.crossScope + r2.decayed + r2.expired + r2.summarised + r2.promoted + r2.procedures === 0, JSON.stringify(r2));

// undo
const logs = await q("select id, action, undone_at from consolidation_log where run_id=$1 order by id", [r1.runId]);
const undo = async (action: string) => { const l = logs.find((x) => x.action === action); return l ? undoConsolidation(l.id) : { ok: false, error: "no log" }; };
check("undo cross_scope restores the private fact", (await undo("cross_scope")).ok && (await st(priv)).status === "active" && (await st(priv)).superseded_by === null, JSON.stringify(await st(priv)));
check("undo cross_scope is idempotent (second call refused)", (await undo("cross_scope")).error === "already_undone");
check("undo expire restores", (await undo("expire")).ok && (await st(exp)).status === "active");
const sumLog = logs.find((x) => x.action === "summarise");
check("undo summarise restores originals and soft-deletes the digest", (await undo("summarise")).ok && (await q("select count(*)::int n from memories where id = any($1) and status='active'", [stale]))[0].n === stale.length && (await q("select count(*)::int n from memories where created_by='consolidation' and kind='fact' and status='active' and source='consolidation' and fact_type='fact'"))[0].n === 0, `log=${sumLog?.id}`);
const decayBefore = (await q("select importance from memories where id=$1", [hot]))[0].importance;
check("undo decay restores importance", (await undo("decay")).ok && (await q("select importance from memories where id=$1", [hot]))[0].importance >= decayBefore);
check("undo promote rejects the pending review", (await undo("promote")).ok && !(await listReviews("pending")).some((r) => r.kind === "core_block" && (r.payload as any).text?.includes("triaged within 4")));
check("undo about_block removes the generated line", (await undo("about_block")).ok && !/^About: /m.test((await q("select text from core_blocks where scope_tag=$1", [`channel_${C.ENG}`]))[0]?.text ?? ""));

// ---- soft delete ----
const a = await addFact({ tag: "shared", text: "The Hermes migration is owned by Dana.", source: "slack", createdBy: U.DANA });
const b = await addFact({ tag: "shared", text: "The Hermes migration is now owned by Bob.", source: "slack", createdBy: U.BOB });
const sup = (await st(a.id)).status === "superseded";
check("contradiction supersedes the old owner and queues a supersede review", sup && !!b.reviewId, JSON.stringify({ a: await st(a.id), b }));
check("soft delete of the new fact restores the old one (history kept)", (await deleteMemory(b.id)) && (await st(b.id)).status === "deleted" && (await st(a.id)).status === "active");
check("row still in table after delete (never hard-deleted)", (await q("select count(*)::int n from memories where id=$1", [b.id]))[0].n === 1);
check("double delete is a no-op", (await deleteMemory(b.id)) === false);

// ---- review queue paths ----
const c1 = await addFact({ tag: "shared", text: "The Hermes migration is now owned by Priya.", source: "slack", createdBy: U.PRIYA });
const rv = c1.reviewId!;
check("supersede review pending", (await listReviews("pending")).some((r) => r.id === rv && r.kind === "supersede"));
const rej = await decideReview(rv, U.ADMIN, false);
check("reject supersede review reactivates the old fact and rejects the new one", rej.ok && (await q("select review_state from memories where id=$1", [c1.id]))[0].review_state === "rejected" && (await st(a.id)).status === "active", JSON.stringify(rej));
check("second decision refused", (await decideReview(rv, U.ADMIN, true)).error === "already_decided");
const low = await addFact({ tag: "shared", text: "Rumor: the office will move to Denver next spring.", source: "slack", createdBy: U.BOB, confidence: 0.3 });
check("low-confidence shared write is held pending", low.heldForReview === true && (await q("select review_state from memories where id=$1", [low.id]))[0].review_state === "pending");
check("held fact is invisible to recall search", !(await q("select 1 from memories where id=$1 and review_state='ok'", [low.id])).length);
const ap = await decideReview(low.reviewId!, U.ADMIN, true);
check("approve makes it live", ap.ok && (await q("select review_state from memories where id=$1", [low.id]))[0].review_state === "ok");
const auto = await addFact({ tag: "shared", text: "Automation proposes: standups move to 09:15 daily.", source: "slack", createdBy: "bot", agentContext: "automation" });
check("automation write to shared is held for review", auto.heldForReview === true);
finish("05 consolidation v2");
