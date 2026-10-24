/**
 * Seeds a believable fake company ("Orbital Tea Co.") through the real addFact / entity pipeline, for demos.
 *   bun run scripts/seed-demo.ts --yes [--force]
 * Idempotent: every fact is skipped when a memory with the same text already exists. Refuses NODE_ENV=production without --force.
 * Needs a working embedding provider (same env as the server). Every name, number and date below is invented.
 */
import { eq } from "drizzle-orm";

const args = new Set(process.argv.slice(2));
export const seedGuard = (a: Set<string>, env = process.env.NODE_ENV): string | null =>
  !a.has("--yes") ? "Refusing to run without --yes (this writes demo data into the database in DATABASE_URL)."
    : env === "production" && !a.has("--force") ? "Refusing to run with NODE_ENV=production without --force." : null;

type Fact = { tag: string; text: string; type?: "fact" | "decision" | "procedure" | "preference"; about?: string[]; at?: string; by?: string; importance?: number };
const S = "shared";
const USERS = [
  ["UDEMO01", "Priya Raman", "admin", "Head of Operations"], ["UDEMO02", "Marcus Lee", "member", "Engineering Lead"],
  ["UDEMO03", "Sofia Alvarez", "member", "Customer Success"], ["UDEMO04", "Tom Becker", "member", "Finance"], ["UDEMO05", "Dana Okafor", "owner", "CEO"],
] as const;
const CHANNELS = [
  ["CDEMO_GEN", "general", false], ["CDEMO_ENG", "engineering", false], ["CDEMO_CS", "customers", false], ["CDEMO_FIN", "finance-private", true],
] as const;

const FACTS: Fact[] = [
  { tag: S, text: "Orbital Tea Co. sells loose-leaf tea subscriptions to offices and small cafes.", about: ["Orbital Tea Co."], importance: 0.8 },
  { tag: S, text: "Dana Okafor is the CEO of Orbital Tea Co.", about: ["Dana Okafor"], by: "UDEMO05" },
  { tag: S, text: "Priya Raman runs operations and owns the supplier relationships.", about: ["Priya Raman"] },
  { tag: S, text: "Marcus Lee leads engineering and owns the order-portal codebase.", about: ["Marcus Lee", "Order Portal"] },
  { tag: S, text: "Sofia Alvarez leads customer success and owns the Harbor Cafe account.", about: ["Sofia Alvarez", "Harbor Cafe"] },
  { tag: S, text: "Tom Becker handles finance and invoicing.", about: ["Tom Becker"] },
  { tag: S, text: "The Order Portal is a web app where customers manage their tea subscriptions.", about: ["Order Portal"] },
  { tag: S, text: "The Order Portal runs on Postgres and is deployed every Tuesday and Thursday.", about: ["Order Portal"], type: "procedure" },
  { tag: S, text: "Support tickets are triaged within 4 business hours; urgent ones are escalated to Sofia.", about: ["Sofia Alvarez"], type: "procedure" },
  { tag: S, text: "Harbor Cafe is a 12-location cafe chain and Orbital's largest customer.", about: ["Harbor Cafe"], importance: 0.8 },
  { tag: S, text: "Harbor Cafe pays on net-30 terms and renews every March.", about: ["Harbor Cafe"] },
  { tag: S, text: "Juniper Offices is a coworking customer with 3 sites on the monthly Sampler plan.", about: ["Juniper Offices"] },
  { tag: S, text: "Brightside Dental signed up in August for the weekly Classic plan.", about: ["Brightside Dental"] },
  { tag: S, text: "Orbital offers three plans: Sampler (monthly), Classic (weekly) and Reserve (twice weekly).", about: ["Sampler", "Classic", "Reserve"] },
  { tag: S, text: "Our main tea supplier is Kessler Farms; the backup supplier is Lotus Valley Imports.", about: ["Kessler Farms", "Lotus Valley Imports"], importance: 0.7 },
  { tag: S, text: "Kessler Farms ships on the first Monday of each month with a 10-day lead time.", about: ["Kessler Farms"] },
  { tag: S, text: "Project Lantern is the redesign of the Order Portal checkout, led by Marcus Lee.", about: ["Project Lantern", "Marcus Lee"], importance: 0.8 },
  { tag: S, text: "Project Lantern targets a 15% drop in checkout abandonment.", about: ["Project Lantern"] },
  { tag: S, text: "Project Kettle is the migration of billing from spreadsheets to the Order Portal, owned by Tom Becker.", about: ["Project Kettle", "Tom Becker"] },
  { tag: S, text: "The company all-hands is the first Friday of the month at 10:00 in the general channel huddle.", about: [], type: "procedure" },
  { tag: S, text: "Marcus prefers design reviews as written docs instead of live meetings.", about: ["Marcus Lee"], type: "preference" },
  { tag: S, text: "Priya prefers a short Friday status summary rather than daily updates.", about: ["Priya Raman"], type: "preference" },
  { tag: S, text: "Decision: we chose Stripe over a custom payments integration for the Order Portal.", about: ["Order Portal", "Stripe"], type: "decision", at: "2026-03-12" },
  { tag: S, text: "Decision: Project Lantern ships behind a feature flag and rolls out to Harbor Cafe first.", about: ["Project Lantern", "Harbor Cafe"], type: "decision", at: "2026-06-04" },
  { tag: S, text: "Decision: the Reserve plan launches in November with a free first month for existing customers.", about: ["Reserve"], type: "decision", at: "2026-09-18" },
  { tag: S, text: "Decision: all supplier contracts are reviewed by Priya and Tom before signing.", about: ["Priya Raman", "Tom Becker"], type: "decision", at: "2026-02-20" },
  { tag: S, text: "Meeting summary (Sept 30 planning huddle): Reserve launch is on track, Lantern beta starts October 14, and Tom will finish the Kettle invoice import by October 31. Sofia will collect Harbor Cafe feedback.", about: ["Reserve", "Project Lantern", "Project Kettle", "Harbor Cafe"], at: "2026-09-30" },
  { tag: S, text: "Orbital's support hours are 8am to 6pm Eastern, Monday to Friday.", about: [] },
  { tag: S, text: "The staging environment for the Order Portal is reset every Sunday night.", about: ["Order Portal"] },
  // channel-scoped (private finance channel -> its own tag only)
  { tag: "channel_CDEMO_FIN", text: "Q3 supplier spend was 8% under budget thanks to the Kessler Farms volume discount.", about: ["Kessler Farms"] },
  { tag: "channel_CDEMO_FIN", text: "Tom is evaluating a switch to annual billing for Juniper Offices.", about: ["Tom Becker", "Juniper Offices"] },
  { tag: "channel_CDEMO_FIN", text: "Payroll runs on the 15th and the last business day of each month.", about: [], type: "procedure" },
  { tag: "channel_CDEMO_FIN", text: "Decision: hold hiring for two marketing roles until the Reserve launch numbers are in.", about: ["Reserve"], type: "decision", at: "2026-10-02" },
  { tag: "channel_CDEMO_ENG", text: "The checkout flag for Project Lantern is named lantern_checkout_v2.", about: ["Project Lantern"] },
  { tag: "channel_CDEMO_ENG", text: "On-call rotation is weekly, handed over on Mondays at 9:30.", about: ["Marcus Lee"], type: "procedure" },
  { tag: "channel_CDEMO_ENG", text: "The portal's nightly job rebuilds the subscription renewal list at 02:00 UTC.", about: ["Order Portal"] },
  { tag: "channel_CDEMO_CS", text: "Harbor Cafe asked for a single consolidated invoice across all 12 locations.", about: ["Harbor Cafe"] },
  { tag: "channel_CDEMO_CS", text: "Brightside Dental wants delivery before 8am; Sofia confirmed the courier can do 7:30.", about: ["Brightside Dental", "Sofia Alvarez"] },
  { tag: "channel_CDEMO_CS", text: "The most common support question is how to pause a subscription for a holiday week.", about: [], type: "procedure" },
];
// A fact that the next one replaces (the second addFact normally supersedes the first via the contradiction check; forced below if the model did not).
const OLD = { tag: S, text: "The Reserve plan launches in October.", about: ["Reserve"], at: "2026-08-01" } satisfies Fact;
const NEW = { tag: S, text: "The Reserve plan launch moved from October to November.", about: ["Reserve"], at: "2026-09-18" } satisfies Fact;

export async function seedDemo(): Promise<{ added: number; skipped: number }> {
  const { db } = await import("../src/db");
  const { channels, users, memories, commitments, meetings } = await import("../src/db/schema");
  const { addFact } = await import("../src/memory/supersede");
  let added = 0, skipped = 0;

  for (const [id, name, role, title] of USERS) await db.insert(users).values({ id, name, role, title }).onConflictDoNothing();
  for (const [id, name, isPrivate] of CHANNELS) await db.insert(channels).values({ id, name, isPrivate, botIsMember: true }).onConflictDoNothing();

  const put = async (f: Fact): Promise<number | null> => {
    const [have] = await db.select({ id: memories.id }).from(memories).where(eq(memories.text, f.text));
    if (have) { skipped++; return have.id; }
    const r = await addFact({
      tag: f.tag, text: f.text, source: "demo-seed", sourceRef: "seed-demo", createdBy: f.by ?? "UDEMO01", factType: f.type ?? "fact",
      validAt: f.at ? new Date(`${f.at}T12:00:00Z`) : undefined, importance: f.importance ?? 0.5, entities: (f.about ?? []).map((name) => ({ name })),
    });
    if (!r.deduped) added++;
    return r.id;
  };

  for (const f of FACTS) await put(f);
  const oldId = await put(OLD);
  const newId = await put(NEW);
  if (oldId && newId && oldId !== newId) {
    await db.update(memories).set({ status: "superseded", supersededBy: newId, invalidAt: new Date("2026-09-18T12:00:00Z") })
      .where(eq(memories.id, oldId)); // idempotent; also covers a model that missed the contradiction
  }

  await db.insert(meetings).values({
    id: "mt_demo_0930", sourceFileId: "F_DEMO_0930", channelId: "CDEMO_GEN", title: "Planning huddle (Sept 30)", status: "ready",
    transcript: "Priya: Reserve is on track for November. Marcus: Lantern beta starts October 14. Tom: I'll finish the Kettle invoice import by October 31. Sofia: I'll collect Harbor Cafe feedback.",
    summary: "Reserve launch on track for November; Lantern beta starts October 14; Tom finishes the Kettle invoice import by October 31; Sofia gathers Harbor Cafe feedback.",
    tasks: [{ title: "Finish Kettle invoice import", owner: "Tom Becker", due: "2026-10-31" }, { title: "Collect Harbor Cafe feedback", owner: "Sofia Alvarez" }],
    participantIds: ["UDEMO01", "UDEMO02", "UDEMO03", "UDEMO04"], startedAt: new Date("2026-09-30T14:00:00Z"), endedAt: new Date("2026-09-30T14:25:00Z"),
  }).onConflictDoNothing();

  await db.insert(commitments).values([
    { id: "cm_demo_1", ownerId: "UDEMO04", ownerName: "Tom Becker", text: "Finish the Project Kettle invoice import", dueAt: new Date("2026-10-31T17:00:00Z"), sourceType: "meeting", sourceRef: "seed-demo:meeting:1", channelId: "CDEMO_GEN", scopeTag: S },
    { id: "cm_demo_2", ownerId: "UDEMO03", ownerName: "Sofia Alvarez", text: "Send Harbor Cafe the consolidated invoice sample", dueAt: new Date("2026-11-07T17:00:00Z"), sourceType: "message", sourceRef: "seed-demo:message:2", channelId: "CDEMO_CS", scopeTag: S },
  ]).onConflictDoNothing();
  return { added, skipped };
}

if (import.meta.main) {
  const problem = seedGuard(args);
  if (problem) { console.error(problem); process.exit(1); }
  const out = await seedDemo();
  console.log(`demo workspace seeded: ${out.added} facts added, ${out.skipped} already present`);
  process.exit(0);
}
