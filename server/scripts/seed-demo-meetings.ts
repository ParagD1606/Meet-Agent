/**
 * Seeds the PS-4 demo: 3 processed meetings (clean kickoff, messy weekly sync, vendor call) with approved / proposed / rejected items,
 * duplicates, conflicts, a missing owner, an open question, plus a 4th meeting whose summary FAILED, and open / overdue commitments.
 *   bun run scripts/seed-demo-meetings.ts --yes [--force]
 * Idempotent: ids are fixed and rows are upserted (dates are re-based to "now" every run so the demo always shows overdue and upcoming work).
 * Everything is marked `demo:` (meetings.source_file_id, commitments.source_ref) so `scripts/reset-demo.ts --yes` removes exactly this and nothing else.
 * No LLM or embedding provider is needed. Refuses NODE_ENV=production without --force. Never touches non-demo rows.
 *
 * STORED SHAPE: the tree this was written against stores a meeting's tasks in the `tasks` jsonb column with the legacy fields
 * (id,title,description,assigneeName,assigneeId,dueDate). Each seeded task is the full MeetingItem superset, so the legacy readers keep working and the
 * unified pipeline's extra fields (kind,label,confidence,quote,approval,ambiguity,...) ride along. When the meetings table also has an `items`
 * column (the unified pipeline), the complete item list (tasks + decisions + questions) is written there too.
 */
import { sql } from "drizzle-orm";

const args = new Set(process.argv.slice(2));
export const seedGuard = (a: Set<string>, env = process.env.NODE_ENV): string | null =>
  !a.has("--yes") ? "Refusing to run without --yes (this writes demo data into the database in DATABASE_URL)."
    : env === "production" && !a.has("--force") ? "Refusing to run with NODE_ENV=production without --force." : null;

const DAY = 86_400_000;
const USERS = [
  ["UDEMO01", "Priya Raman", "admin", "Head of Operations"], ["UDEMO02", "Marcus Lee", "member", "Engineering Lead"],
  ["UDEMO03", "Sofia Alvarez", "member", "Customer Success"], ["UDEMO04", "Tom Becker", "member", "Finance"], ["UDEMO05", "Dana Okafor", "owner", "CEO"],
] as const;
const uid = Object.fromEntries(USERS.map(([id, name]) => [name.split(" ")[0]!, { id, name }])) as Record<string, { id: string; name: string }>;

type Dup = { id: string; title: string; ownerName: string | null; dueDate: string | null; source: "task" | "meeting" };
type Conflict = { type: "owner" | "due" | "decision"; with: { title: string; ownerName: string | null; dueDate: string | null } };
export type MeetingItem = {
  id: string; itemType: "task" | "decision" | "question"; title: string; description: string; assigneeId: string | null; assigneeName: string | null; dueDate: string | null;
  priority: "normal" | "urgent"; kind: "commitment" | "suggestion" | "decision" | "question"; label: "confirmed" | "tentative" | "suggestion" | "question"; confidence: number; reason: string;
  quote: string; evidence: number[]; unverified: boolean; followUp: boolean; approval: "proposed" | "approved" | "rejected"; approvedBy: string | null; approvedAt: string | null;
  ambiguity: { ownerMissing: boolean; ownerAmbiguous: boolean; ownerCandidates: { id: string; name: string }[]; dueMissing: boolean; duplicateOf: Dup[]; conflicts: Conflict[] };
  commitmentId: string | null; notification: { status: string } | null; externalRefs: { provider: string; id: string; url: string }[];
};

const day = (now: number, offset: number) => new Date(now + offset * DAY).toISOString().slice(0, 10);

/** Builds one item with sensible defaults; `p` overrides. Exported so the shape is checked in a test. */
export function item(id: string, title: string, p: Partial<MeetingItem> & { owner?: { id: string; name: string } | null } = {}): MeetingItem {
  const { owner = null, ...rest } = p;
  return {
    id, itemType: "task", title, description: "", assigneeId: owner?.id ?? null, assigneeName: owner?.name ?? null, dueDate: null, priority: "normal",
    kind: "commitment", label: "confirmed", confidence: 0.9, reason: "", quote: "", evidence: [], unverified: false, followUp: false,
    approval: "proposed", approvedBy: null, approvedAt: null,
    ambiguity: { ownerMissing: !owner, ownerAmbiguous: false, ownerCandidates: [], dueMissing: !p.dueDate, duplicateOf: [], conflicts: [] },
    commitmentId: null, notification: null, externalRefs: [], ...rest,
  };
}

export function buildDemo(now = Date.now()) {
  const approvedAt = new Date(now - 2 * DAY).toISOString();
  const ok = { approval: "approved" as const, approvedBy: "UDEMO01", approvedAt };

  // 1) Clean kickoff: everything approved, commitments created, DMs sent.
  const k = (n: number) => `mtask_demo_kick_${n}`;
  const kickoff: MeetingItem[] = [
    item(k(1), "Draft the Reserve plan launch checklist", { owner: uid.Priya, dueDate: day(now, 5), quote: "Priya: I'll draft the launch checklist by Friday.", evidence: [4], ...ok, commitmentId: "cm_demo_mtg_1", notification: { status: "acknowledged" } }),
    item(k(2), "Set up Stripe webhook alerts", { owner: uid.Marcus, dueDate: day(now, -2), quote: "Marcus: I'll set up the webhook alerts this week.", evidence: [7], ...ok, commitmentId: "cm_demo_mtg_2", notification: { status: "sent" } }),
    item(k(3), "Send the invoice sample to Harbor Cafe", { owner: uid.Sofia, dueDate: day(now, 9), quote: "Sofia: I'll send Harbor the invoice sample next week.", evidence: [11], ...ok, commitmentId: "cm_demo_mtg_3", notification: { status: "sent" }, externalRefs: [{ provider: "trello", id: "demo-card-1", url: "https://trello.com/c/demo0001" }] }),
    item("mdec_demo_kick_1", "Reserve launches in November with a free first month for existing customers", { itemType: "decision", kind: "decision", assigneeId: null, assigneeName: null, quote: "Priya: so the decision is November, free first month.", evidence: [3], ...ok, ambiguity: { ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [], dueMissing: false, duplicateOf: [], conflicts: [] } }),
  ];

  // 2) Messy weekly sync: the interesting states (proposed / rejected / duplicate / conflict / missing owner / question / suggestion).
  const s = (n: number) => `mtask_demo_sync_${n}`;
  const friday = day(now, 3), monday = day(now, 6);
  const sync: MeetingItem[] = [
    item(s(1), "Fix the duplicate invoice bug", { owner: uid.Tom, dueDate: day(now, 1), confidence: 0.95, reason: "Clear first-person commitment with a date.", quote: "Tom: yeah I'll take that, should have a fix out tomorrow.", evidence: [14] }),
    item(s(2), "Send the Kessler order form", { owner: uid.Tom, dueDate: friday, confidence: 0.9, quote: "Tom: I'll send the order form by Friday.", evidence: [22], ambiguity: { ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [], dueMissing: false, duplicateOf: [], conflicts: [{ type: "due", with: { title: "Send the Kessler order form", ownerName: "Tom Becker", dueDate: monday } }] } }),
    item(s(3), "Send the Kessler order form", { owner: uid.Tom, dueDate: monday, confidence: 0.85, reason: "Same task restated with a different day.", quote: "Tom: sorry, Monday. The finance cut-off.", evidence: [41], ambiguity: { ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [], dueMissing: false, duplicateOf: [{ id: s(2), title: "Send the Kessler order form", ownerName: "Tom Becker", dueDate: friday, source: "meeting" }], conflicts: [{ type: "due", with: { title: "Send the Kessler order form", ownerName: "Tom Becker", dueDate: friday } }] } }),
    item(s(4), "Update the on-call rotation document", { owner: uid.Dana, label: "tentative", confidence: 0.55, reason: "'probably' and 'I might not get to it'.", quote: "Dana: I'll probably do that at some point this week.", evidence: [38] }),
    item(s(5), "Move the staging reset to Saturday night", { kind: "suggestion", label: "suggestion", confidence: 0.6, reason: "'maybe we should' and nobody agreed.", quote: "Marcus: maybe we should move the staging reset to Saturday night?", evidence: [33], approval: "proposed" }),
    item(s(6), "Who is going to renew the SSL certificate?", { itemType: "question", kind: "question", label: "question", confidence: 0.8, reason: "Asked; nobody took it.", quote: "Dana: Who is going to renew the SSL certificate?", evidence: [29] }),
    item(s(7), "Write the beta announcement for the Harbor Cafe email", { owner: null, confidence: 0.7, reason: "Someone should write it but no owner was named.", quote: "Dana: we still need the beta announcement out to Harbor.", evidence: [26], ambiguity: { ownerMissing: true, ownerAmbiguous: true, ownerCandidates: [{ id: uid.Priya.id, name: uid.Priya.name }, { id: uid.Sofia.id, name: uid.Sofia.name }], dueMissing: true, duplicateOf: [], conflicts: [] } }),
    item(s(8), "Buy mugs for the all-hands", { owner: uid.Sofia, label: "tentative", confidence: 0.35, reason: "A joke; low confidence.", quote: "Sofia: I could, I could buy mugs for the all-hands, ha.", evidence: [48], approval: "rejected", approvedBy: "UDEMO01", approvedAt }),
    item(s(9), "Review the checkout pull request", { owner: uid.Marcus, dueDate: day(now, 0), confidence: 0.92, quote: "Marcus: I'll review the checkout PR myself by end of day.", evidence: [18], ...ok, commitmentId: "cm_demo_mtg_4", notification: { status: "sent" } }),
    item("mdec_demo_sync_1", "Deploys stay on Tuesday and Thursday", { itemType: "decision", kind: "decision", assigneeId: null, assigneeName: null, quote: "Dana: Alright, stays Tuesday and Thursday. Decided.", evidence: [21], ambiguity: { ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [], dueMissing: false, duplicateOf: [], conflicts: [] } }),
  ];

  // 3) Vendor call: a duplicate of a task in the kickoff meeting (cross-meeting) and an owner conflict.
  const v = (n: number) => `mtask_demo_vendor_${n}`;
  const vendor: MeetingItem[] = [
    item(v(1), "Draft the Reserve launch checklist", { owner: uid.Sofia, dueDate: day(now, 5), confidence: 0.8, quote: "Sofia: I can draft the launch checklist too.", evidence: [9], ambiguity: { ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [], dueMissing: false, duplicateOf: [{ id: k(1), title: "Draft the Reserve plan launch checklist", ownerName: "Priya Raman", dueDate: day(now, 5), source: "meeting" }], conflicts: [{ type: "owner", with: { title: "Draft the Reserve plan launch checklist", ownerName: "Priya Raman", dueDate: day(now, 5) } }] } }),
    item(v(2), "Negotiate the volume discount with Lotus Valley", { owner: uid.Dana, confidence: 0.9, quote: "Dana: I'll negotiate the volume discount.", evidence: [30], ...ok, commitmentId: "cm_demo_mtg_5", notification: { status: "sent" } }),
    item(v(3), "Run the sample quality check", { owner: uid.Marcus, dueDate: day(now, 7), confidence: 0.9, quote: "Marcus: I will run the sample quality check.", evidence: [37] }),
    item("mdec_demo_vendor_1", "Lotus Valley Imports is the backup supplier", { itemType: "decision", kind: "decision", assigneeId: null, assigneeName: null, quote: "Dana: Lotus Valley is the backup supplier. Decision made.", evidence: [12], ambiguity: { ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [], dueMissing: false, duplicateOf: [], conflicts: [] } }),
  ];

  const lines = (rows: [string, string][]) => rows.map(([a, b]) => `${a}: ${b}`).join("\n");
  const meetings = [
    { key: "clean", id: "mt_demo_clean", file: "demo:clean-kickoff", title: "Reserve launch kickoff (clean transcript)", status: "ready" as const, started: -3, items: kickoff,
      summary: "## Discussion\nReserve launch plan and Stripe monitoring.\n\n## Decisions\nReserve launches in November with a free first month.",
      transcript: lines([["Priya", "So the decision is November, free first month for existing customers."], ["Priya", "I'll draft the launch checklist by Friday."], ["Marcus", "I'll set up the webhook alerts this week."], ["Sofia", "I'll send Harbor the invoice sample next week."]]) },
    { key: "sync", id: "mt_demo_sync", file: "demo:messy-sync", title: "Weekly sync (messy transcript)", status: "ready" as const, started: -1, items: sync,
      summary: "## Discussion\nInvoice bug, deploy cadence, supplier order form, SSL certificate ownership.\n\n## Open questions\nWho renews the SSL certificate.",
      transcript: lines([["Tom", "Yeah, I'll take that, should have a fix out tomorrow."], ["Tom", "I'll send the order form by Friday."], ["Tom", "Sorry, Monday. The finance cut-off."], ["Dana", "Who is going to renew the SSL certificate?"], ["Marcus", "Maybe we should move the staging reset to Saturday night?"]]) },
    { key: "vendor", id: "mt_demo_vendor", file: "demo:vendor-call", title: "Backup supplier call", status: "ready" as const, started: -2, items: vendor,
      summary: "## Discussion\nLotus Valley chosen as the backup supplier; discount and sample check assigned.",
      transcript: lines([["Dana", "Lotus Valley is the backup supplier. Decision made."], ["Sofia", "I can draft the launch checklist too."], ["Dana", "I'll negotiate the volume discount."], ["Marcus", "I will run the sample quality check."]]) },
    { key: "failed", id: "mt_demo_failed", file: "demo:failed-summary", title: "Customer workshop prep (summary failed)", status: "failed" as const, started: -1, items: [] as MeetingItem[],
      summary: null, transcript: lines([["Sofia", "We need the slides for the workshop."], ["Tom", "I can do the numbers."]]) },
  ];

  const open = [
    { id: "cm_demo_mtg_1", text: "Draft the Reserve plan launch checklist", owner: uid.Priya, due: 5, ref: "demo:meeting:mt_demo_clean:1", status: "open" as const },
    { id: "cm_demo_mtg_2", text: "Set up Stripe webhook alerts", owner: uid.Marcus, due: -2, ref: "demo:meeting:mt_demo_clean:2", status: "overdue" as const }, // overdue on purpose
    { id: "cm_demo_mtg_3", text: "Send the invoice sample to Harbor Cafe", owner: uid.Sofia, due: 9, ref: "demo:meeting:mt_demo_clean:3", status: "open" as const },
    { id: "cm_demo_mtg_4", text: "Review the checkout pull request", owner: uid.Marcus, due: 0, ref: "demo:meeting:mt_demo_sync:9", status: "in_progress" as const },
    { id: "cm_demo_mtg_5", text: "Negotiate the volume discount with Lotus Valley", owner: uid.Dana, due: null, ref: "demo:meeting:mt_demo_vendor:2", status: "open" as const }, // no due date
  ];
  return { meetings, open };
}

export async function seedDemoMeetings(now = Date.now()): Promise<{ meetings: number; items: number; commitments: number; itemsColumn: boolean }> {
  const { db } = await import("../src/db");
  const { channels, commitments, meetings, meetingTaskNotifications, users } = await import("../src/db/schema");
  const { sha256 } = await import("../src/crypto");
  const { meetings: ms, open } = buildDemo(now);

  for (const [id, name, role, title] of USERS) await db.insert(users).values({ id, name, role, title }).onConflictDoNothing();
  await db.insert(channels).values({ id: "CDEMO_GEN", name: "general", isPrivate: false, botIsMember: true }).onConflictDoNothing();
  const col = await db.execute(sql`select 1 from information_schema.columns where table_name = 'meetings' and column_name = 'items'`);
  const itemsColumn = col.rows.length > 0;

  let nItems = 0;
  for (const m of ms) {
    const startedAt = new Date(now + m.started * DAY), endedAt = new Date(startedAt.getTime() + 30 * 60_000);
    const tasks = m.items.filter((i) => i.itemType === "task");
    const row = {
      id: m.id, sourceFileId: m.file, channelId: "CDEMO_GEN", platform: "slack", title: m.title, transcript: m.transcript, summary: m.summary,
      tasks, decisions: m.items.filter((i) => i.itemType === "decision").map((i) => i.title), participantIds: ["UDEMO01", "UDEMO02", "UDEMO03", "UDEMO04", "UDEMO05"],
      status: m.status, startedAt, endedAt, updatedAt: new Date(),
    };
    await db.insert(meetings).values(row).onConflictDoUpdate({ target: meetings.sourceFileId, set: { ...row, id: undefined } });
    if (itemsColumn) await db.execute(sql`update meetings set items = ${JSON.stringify(m.items)}::jsonb where id = ${m.id}`);
    nItems += m.items.length;
    for (const t of m.items.filter((i) => i.notification && i.assigneeId)) {
      await db.insert(meetingTaskNotifications).values({
        id: `mtn_demo_${sha256(t.id).slice(0, 16)}`, meetingId: m.id, taskId: t.id, recipientUserId: t.assigneeId!,
        status: t.notification!.status === "acknowledged" ? "acknowledged" : "sent", sentAt: new Date(now - DAY), acknowledgedAt: t.notification!.status === "acknowledged" ? new Date(now - DAY / 2) : null,
      }).onConflictDoNothing();
    }
  }
  for (const c of open) {
    const row = {
      id: c.id, ownerId: c.owner.id, ownerName: c.owner.name, text: c.text, dueAt: c.due == null ? null : new Date(now + c.due * DAY), sourceType: "meeting" as const, sourceRef: c.ref,
      channelId: "CDEMO_GEN", scopeTag: "shared", status: c.status, titleKey: c.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    };
    await db.insert(commitments).values(row).onConflictDoUpdate({ target: commitments.sourceRef, set: { ...row, id: undefined } });
  }
  return { meetings: ms.length, items: nItems, commitments: open.length, itemsColumn };
}

if (import.meta.main) {
  const problem = seedGuard(args);
  if (problem) { console.error(problem); process.exit(1); }
  const out = await seedDemoMeetings();
  console.log(`demo meetings seeded: ${out.meetings} meetings (3 processed + 1 failed summary), ${out.items} items, ${out.commitments} commitments (one overdue, one without a due date)${out.itemsColumn ? "; wrote meetings.items" : "; no meetings.items column in this schema, items stored in meetings.tasks"}`);
  process.exit(0);
}
