import { and, eq, inArray, like, sql } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { commitments, meetingAudit, meetings, meetingTaskNotifications, memories, users } from "../db/schema";
import { log } from "../log";
import { ACTIVE, channelScope, getSetting, insertCommitment, putSetting, titleKey, type Commitment } from "../manager/commitments";
import { syncTaskFact } from "../manager/task-sync";
import { addFact } from "../memory/facts";
import { annotateItems } from "./detect";
import { asItems, autoApproves, clampThreshold, DEFAULT_AUTO_CONFIDENCE, dueAtOf, emptyAmbiguity, isAmbiguous, isUrgent, normalizeDue, type MeetingItem } from "./items";
import { resolveOwner } from "./owner";
import { meetingUrl } from "./urls";

/**
 * Meeting items -> real tasks and memory. Nothing becomes a commitment, a memory fact or a DM until the item is `approved`.
 * `meeting_task_approval`: auto (default) approves a confident, verified commitment with a resolved owner and no duplicate/conflict;
 * approve leaves everything proposed until a person approves it. Idempotent per (meeting, item id) through
 * commitments.source_ref = meeting:<meetingId>:<itemId>.
 */
export type ApprovalMode = "auto" | "approve";
const SETTING = "meeting_task_approval";
export const getApprovalMode = async (): Promise<ApprovalMode> => ((await getSetting<string>(SETTING)) === "approve" ? "approve" : "auto");
export const setApprovalMode = (mode: ApprovalMode) => putSetting(SETTING, mode);
/** Below this confidence an item waits for a human (default 0.6, admin range 0.3-0.95). */
export const getAutoThreshold = async (): Promise<number> => { const v = await getSetting<number>("meeting_auto_confidence"); return typeof v === "number" ? clampThreshold(v) : DEFAULT_AUTO_CONFIDENCE; };
export const setAutoThreshold = (n: number) => putSetting("meeting_auto_confidence", clampThreshold(n));

export const refOf = (meetingId: string, itemId: string) => `meeting:${meetingId}:${itemId}`;
type Meeting = typeof meetings.$inferSelect;
export type Reviewer = { userId: string; role: "owner" | "admin" | "member" };
export const canReview = (m: { organizerId: string | null; ownerId: string | null }, by: Reviewer) =>
  by.role === "admin" || by.role === "owner" || m.organizerId === by.userId || m.ownerId === by.userId;
export const isExt = (m: { channelId: string }) => m.channelId.startsWith("ext_");
/** Extension and web uploads never DM anyone automatically: the uploader presses "Send task DMs". */
export const noAuto = (m: { channelId: string; platform: string }) => isExt(m) || m.platform !== "slack";
export const scopeOf = async (m: Meeting) => (isExt(m) ? `user_${m.ownerId ?? m.channelId.slice(4)}` : channelScope(m.channelId)); // fail closed

export async function audit(meetingId: string, itemId: string | null, action: string, actorId: string | null, detail: Record<string, unknown> = {}) {
  await db.insert(meetingAudit).values({ meetingId, itemId, action, actorId, detail }).catch((e) => log.warn("meeting audit failed", { error: String(e).slice(0, 120) }));
}

const decisionsOf = (items: MeetingItem[]) => items.filter((i) => i.itemType === "decision" && i.approval !== "rejected" && !i.unverified).map((i) => i.title);
export async function saveItemsFor(meetingId: string, items: MeetingItem[]) {
  await db.update(meetings).set({ tasks: items, decisions: decisionsOf(items), updatedAt: new Date() }).where(eq(meetings.id, meetingId));
}
const approve = (i: MeetingItem, by: string | null): MeetingItem => ({ ...i, approval: "approved", approvedBy: by ?? "auto", approvedAt: new Date().toISOString() });

// ---------- sync ----------
export type SyncResult = { created: number; updated: number; dropped: number; proposed: number; approved: number; createdTaskIds: string[] };

/**
 * Brings a meeting's items and their commitments / memory in step. Never sends a DM. Safe to repeat: matches by source_ref (item id),
 * adopts old index-based refs, never duplicates, and drops (only) open, never-acknowledged tasks that a re-analysis no longer contains.
 * `forceOwner`: item ids whose owner was just edited on the page (the edit wins over the commitment).
 */
export async function syncMeetingTasks(meetingId: string, o: { forceOwner?: string[]; silent?: boolean } = {}): Promise<SyncResult> {
  const out: SyncResult = { created: 0, updated: 0, dropped: 0, proposed: 0, approved: 0, createdTaskIds: [] };
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!m) return out;
  const mode = await getApprovalMode();
  const threshold = await getAutoThreshold();
  const ext = isExt(m);
  const scopeTag = await scopeOf(m);
  const link = meetingUrl(m.id);
  let items = asItems(m.id, m.tasks);
  // decisions of an older meeting live as plain strings: they become items once
  if (!items.some((i) => i.itemType === "decision") && Array.isArray(m.decisions)) {
    const old = (m.decisions as unknown[]).filter((d): d is string => typeof d === "string");
    items = [...items, ...old.map((title): MeetingItem => ({ id: newId("mdec_"), itemType: "decision", title, description: "", assigneeId: null, assigneeName: null, dueDate: null, priority: "normal", kind: "commitment", label: "confirmed", confidence: 0.75, reason: "", quote: "", evidence: [], unverified: false, followUp: false, ambiguity: emptyAmbiguity(), commitmentId: null, externalRefs: [] }))];
  }
  // owners: a name that is now a unique real person (or an id) becomes that person; a close call stays ambiguous with candidates
  for (let n = 0; n < items.length; n++) {
    const i = items[n]!;
    if (i.itemType !== "task" || i.approval === "rejected") continue;
    if (!i.assigneeId && !i.assigneeName) continue;
    const r = await resolveOwner(i);
    if (r.user && (i.assigneeId !== r.user.id || i.assigneeName !== r.user.name)) items[n] = { ...i, assigneeId: r.user.id, assigneeName: r.user.name, ambiguity: { ...i.ambiguity, ownerAmbiguous: false, ownerCandidates: [] } };
    else if (!r.user && i.assigneeId) items[n] = { ...i, assigneeId: null };
    else if (!r.user && !i.assigneeId) items[n] = { ...i, ambiguity: { ...i.ambiguity, ownerAmbiguous: r.ambiguous, ownerCandidates: r.candidates.length ? r.candidates : i.ambiguity.ownerCandidates } };
  }
  items = await annotateItems(m, items, scopeTag);
  // the gate
  const autoIds: string[] = [];
  items = items.map((i) => {
    if (i.approval === "approved" || i.approval === "rejected") return i;
    if (autoApproves(i, mode, threshold)) { out.approved++; autoIds.push(i.id); return approve(i, null); }
    return { ...i, approval: "proposed" as const };
  });

  for (const id of autoIds) await audit(m.id, id, "approve", null, { approvedBy: "auto", mode });
  const rows = await db.select().from(commitments).where(like(commitments.sourceRef, `meeting:${m.id}:%`));
  const byRef = new Map(rows.map((r) => [r.sourceRef, r]));
  let taskIndex = -1;
  for (let n = 0; n < items.length; n++) {
    let t = items[n]!;
    if (t.itemType !== "task") continue;
    taskIndex++;
    if (t.approval === "proposed") { out.proposed++; continue; }
    if (t.approval !== "approved") continue;
    const ref = refOf(m.id, t.id);
    let row = byRef.get(ref);
    if (!row) { // a row written by the older index-based sync: adopt it when it is the same task
      const legacy = byRef.get(`meeting:${m.id}:${taskIndex}`);
      if (legacy && legacy.titleKey === titleKey(t.title)) {
        [row] = await db.update(commitments).set({ sourceRef: ref }).where(eq(commitments.id, legacy.id)).returning();
        byRef.delete(legacy.sourceRef); if (row) byRef.set(ref, row);
      }
    }
    const dueAt = dueAtOf(t.dueDate);
    const priority = isUrgent(t) ? "urgent" : "normal";
    if (!row) { // an auto-merged duplicate: the existing task is this task, no second one is made
      const into = await mergeTarget(m.id, t, items);
      if (into) { items[n] = { ...t, merged: true, commitmentId: into }; if (t.assigneeId) await markNotified(m.id, t.id, t.assigneeId); continue; }
    }
    if (row) {
      const patch: Partial<typeof commitments.$inferInsert> = {};
      if ((ACTIVE as readonly string[]).includes(row.status)) {
        if (row.text !== t.title.slice(0, 500)) Object.assign(patch, { text: t.title.slice(0, 500), titleKey: titleKey(t.title) });
        if (dueAt && row.dueAt?.getTime() !== dueAt.getTime()) Object.assign(patch, { dueAt, nudgeCount: 0, lastNudgedAt: null });
        if (row.priority !== priority && priority === "urgent") patch.priority = priority;
        if (o.forceOwner?.includes(t.id) && row.ownerId !== (t.assigneeId ?? null)) Object.assign(patch, { ownerId: t.assigneeId ?? null, ownerName: t.assigneeName ?? null, nudgeCount: 0, lastNudgedAt: null });
      }
      if (Object.keys(patch).length) { [row] = await db.update(commitments).set(patch).where(eq(commitments.id, row!.id)).returning(); await syncTaskFact(row!); out.updated++; }
      // the commitment is the source of truth for the owner (the Tasks tab can reassign)
      if (row && (row.ownerId ?? null) !== (t.assigneeId ?? null)) {
        t = { ...t, assigneeId: row.ownerId, assigneeName: row.ownerName };
        if (row.ownerId) await markNotified(m.id, t.id, row.ownerId); // told by the Tasks-tab assignment already
      }
      items[n] = { ...t, commitmentId: row?.id ?? t.commitmentId };
      continue;
    }
    const created = await insertCommitment({
      ownerId: t.assigneeId, ownerName: t.assigneeName, text: t.title, dueAt, sourceType: "meeting", sourceRef: ref, permalink: link,
      channelId: ext ? null : m.channelId, threadTs: m.threadTs, scopeTag, assignerId: m.organizerId ?? null, priority,
    });
    if (created) {
      out.created++; out.createdTaskIds.push(t.id); items[n] = { ...t, commitmentId: created.id };
      if (o.silent && t.assigneeId) await markNotified(m.id, t.id, t.assigneeId, "skipped"); // backfill: the task exists, nobody is told unless an admin sends the recap
      continue;
    }
    // the same owner + title is already an active task (made elsewhere): this item is that task, nothing new is created
    const key = titleKey(t.title);
    if (t.assigneeId && key) {
      const [dup] = await db.select({ id: commitments.id }).from(commitments).where(and(eq(commitments.ownerId, t.assigneeId), eq(commitments.titleKey, key), inArray(commitments.status, [...ACTIVE]))).limit(1);
      if (dup) { await markNotified(m.id, t.id, t.assigneeId); items[n] = { ...t, commitmentId: dup.id }; }
    }
  }
  const live = new Set(items.filter((i) => i.itemType === "task").map((i) => refOf(m.id, i.id)));
  for (const r of byRef.values()) { // tasks the (re-)analysis no longer contains
    if (live.has(r.sourceRef) || !["open", "overdue"].includes(r.status)) continue;
    const taskId = r.sourceRef.split(":")[2]!;
    const [ack] = await db.select({ id: meetingTaskNotifications.id }).from(meetingTaskNotifications)
      .where(and(eq(meetingTaskNotifications.meetingId, m.id), eq(meetingTaskNotifications.taskId, taskId), eq(meetingTaskNotifications.status, "acknowledged"))).limit(1);
    if (ack) continue;
    const [gone] = await db.update(commitments).set({ status: "dropped", completedAt: new Date() }).where(and(eq(commitments.id, r.id), inArray(commitments.status, ["open", "overdue"]))).returning();
    if (gone) { await syncTaskFact(gone); out.dropped++; log.info("meeting task dropped: no longer in the notes and never acknowledged", { meetingId: m.id, commitmentId: gone.id }); }
  }
  if (o.silent && m.organizerId) for (const i of items) if (i.itemType === "task" && i.approval === "proposed") await markNotified(m.id, i.id, m.organizerId, "skipped", "organizer"); // backfill tells the organizer nothing either
  await rememberDecisions(m, items.filter((i) => i.itemType === "decision" && i.approval === "approved").map((i) => i.title), scopeTag);
  await saveItemsFor(m.id, items);
  return out;
}

/** The existing commitment a flagged duplicate points at (an open task, or the task another item / meeting already made), if there is one. */
async function mergeTarget(meetingId: string, t: MeetingItem, items: MeetingItem[]): Promise<string | null> {
  for (const d of t.ambiguity.duplicateOf) {
    if (d.source === "task") { const [c] = await db.select({ id: commitments.id }).from(commitments).where(and(eq(commitments.id, d.id), inArray(commitments.status, [...ACTIVE]))).limit(1); if (c) return c.id; continue; }
    if (d.meetingId === meetingId && items.find((i) => i.id === d.id)?.merged) continue;
    const [c] = await db.select({ id: commitments.id }).from(commitments).where(and(eq(commitments.sourceRef, refOf(d.meetingId ?? meetingId, d.id)), inArray(commitments.status, [...ACTIVE]))).limit(1);
    if (c) return c.id;
  }
  return null;
}

/** Records that this person already knows about the task (it must not be announced again). */
async function markNotified(meetingId: string, taskId: string, userId: string, status: "sent" | "skipped" = "sent", kind: "task" | "organizer" = "task") {
  await db.insert(meetingTaskNotifications).values({ id: newId("mtn_"), meetingId, taskId, recipientUserId: userId, kind, status, ...(status === "sent" ? { sentAt: new Date() } : {}) }).onConflictDoNothing();
}

/** The commitment each task of this meeting became, keyed by item id. */
export async function commitmentsFor(meetingId: string): Promise<Map<string, Commitment>> {
  const rows = await db.select().from(commitments).where(like(commitments.sourceRef, `meeting:${meetingId}:%`));
  return new Map(rows.map((r) => [r.sourceRef.split(":")[2]!, r]));
}

/** Each approved decision is its own fact_type 'decision' memory with the meeting page as source. A re-analysis supersedes decisions that are gone. */
export async function rememberDecisions(m: { id: string; title: string }, decisions: string[], scopeTag: string): Promise<void> {
  try {
    const ref = `meeting-decision:${m.id}`;
    const written: number[] = [];
    for (const d of decisions) {
      const r = await addFact({ tag: scopeTag, text: `Decision in "${m.title}": ${d}`, source: "slack", sourceRef: ref, createdBy: "bot", permalink: meetingUrl(m.id), factType: "decision", confidence: 0.9, agentContext: "primary" });
      written.push(r.id);
    }
    const old = await db.select({ id: memories.id }).from(memories).where(and(eq(memories.sourceRef, ref), eq(memories.status, "active"), eq(memories.scopeTag, scopeTag)));
    const stale = old.map((o) => o.id).filter((id) => !written.includes(id));
    if (stale.length) await db.update(memories).set({ status: "superseded", invalidAt: new Date() }).where(inArray(memories.id, stale));
  } catch (err) {
    log.warn("meeting decision memory failed", { meetingId: m.id, error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------- human review ----------
export type ItemPatch = {
  title?: string; description?: string; dueDate?: string | null; assigneeId?: string | null; priority?: "normal" | "urgent";
  kind?: "commitment" | "suggestion" | "question"; approval?: "proposed" | "approved" | "rejected"; confirm?: boolean;
};
export type ReviewResult = { ok: true } | { ok: false; error: "not_found" | "forbidden" | "needs_owner" | "needs_review" | "bad_request"; message?: string };

async function load(meetingId: string) {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  return m ? { m, items: asItems(m.id, m.tasks) } : null;
}

/** Applies field edits to one item (no gating). Owner / date edits resolve the matching ambiguity. */
async function applyEdits(m: Meeting, item: MeetingItem, p: ItemPatch): Promise<MeetingItem> {
  let next = { ...item };
  if (p.title?.trim()) next.title = p.title.trim().slice(0, 240);
  if (p.description !== undefined) next.description = p.description.slice(0, 2000);
  if (p.priority) next.priority = p.priority;
  if (p.kind && next.itemType !== "decision") {
    next.kind = p.kind;
    next.itemType = p.kind === "question" ? "question" : "task";
    next.label = p.kind === "commitment" ? "tentative" : p.kind === "question" ? "question" : "suggestion"; // promoted by a person: tentative, then the normal rules apply
  }
  if (p.assigneeId !== undefined) {
    if (p.assigneeId) {
      const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.id, p.assigneeId), eq(users.deactivated, false), eq(users.isBot, false))).limit(1);
      if (!u) throw new Error("assignee not found");
      next = { ...next, assigneeId: u.id, assigneeName: u.name, ambiguity: { ...next.ambiguity, ownerMissing: false, ownerAmbiguous: false, ownerCandidates: [] } };
    } else next = { ...next, assigneeId: null, assigneeName: null, ambiguity: { ...next.ambiguity, ownerMissing: true } };
  }
  if (p.dueDate !== undefined) {
    const iso = p.dueDate ? normalizeDue(p.dueDate, m.endedAt ?? m.createdAt) : null;
    next = { ...next, dueDate: iso, dueText: p.dueDate && !iso ? p.dueDate : null, ambiguity: { ...next.ambiguity, dueMissing: !iso } };
  }
  return next;
}

/** After a review change: tasks/memory are synced, owners told (never for extension uploads), delivered DMs refreshed. */
async function afterChange(m: Meeting, o: { forceOwner?: string[]; notify?: boolean } = {}) {
  await syncMeetingTasks(m.id, { forceOwner: o.forceOwner });
  if (o.notify !== false && !noAuto(m)) queueRecaps(m.id);
  await refreshDms(m.id);
}

/**
 * PATCH one item: edit fields and/or approve / reject. Approving an ambiguous item (owner missing or unclear, duplicate, conflict)
 * needs an explicit owner in the same request (assigneeId); a decision with a conflict needs confirm. Questions cannot be approved
 * (change their kind first). Only the meeting's owner, organizer or an admin may.
 */
export async function patchMeetingItem(meetingId: string, itemId: string, p: ItemPatch, by: Reviewer | null): Promise<ReviewResult> {
  const l = await load(meetingId);
  if (!l) return { ok: false, error: "not_found" };
  if (by && !canReview(l.m, by)) return { ok: false, error: "forbidden" };
  const idx = l.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return { ok: false, error: "not_found" };
  let item: MeetingItem;
  try { item = await applyEdits(l.m, l.items[idx]!, p); } catch (e) { return { ok: false, error: "bad_request", message: e instanceof Error ? e.message : String(e) }; }
  const who = by?.userId ?? null;
  if (p.approval === "approved" && item.approval !== "approved") {
    if (item.itemType === "question") return { ok: false, error: "needs_review", message: "An open question cannot be approved: change its kind first." };
    const a = item.ambiguity;
    if (item.itemType === "task" && (a.ownerMissing || a.ownerAmbiguous || !item.assigneeId) && !p.assigneeId) return { ok: false, error: "needs_owner", message: "Choose an owner to approve this item." };
    if (item.unverified && !p.confirm) return { ok: false, error: "needs_review", message: "No supporting quote was found in the notes: confirm it explicitly to approve." };
    item = approve(item, who);
    await audit(l.m.id, item.id, "approve", who, { title: item.title, assigneeId: item.assigneeId });
  } else if (p.approval === "rejected") {
    item = { ...item, approval: "rejected", rejectedBy: who, rejectedAt: new Date().toISOString() };
    let note: string | undefined;
    if (l.items[idx]!.approval === "approved" && item.itemType === "task") { // undo: the task made from it is dropped (never DMed again)
      const [cm] = await db.select().from(commitments).where(eq(commitments.sourceRef, refOf(l.m.id, item.id))).limit(1);
      if (cm && (ACTIVE as readonly string[]).includes(cm.status)) {
        const [gone] = await db.update(commitments).set({ status: "dropped", completedAt: new Date() }).where(eq(commitments.id, cm.id)).returning();
        if (gone) await syncTaskFact(gone);
        note = `undone by ${by ? ((await db.select({ n: users.name }).from(users).where(eq(users.id, by.userId)))[0]?.n ?? by.userId) : "an admin"}`;
      }
    }
    await audit(l.m.id, item.id, "reject", who, { title: item.title, ...(note ? { note } : {}) });
  } else if (p.approval === "proposed" && item.approval === "rejected") {
    item = { ...item, approval: "proposed", approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null };
    await audit(l.m.id, item.id, "reopen", who);
  } else if (Object.keys(p).some((k) => k !== "approval" && k !== "confirm")) await audit(l.m.id, item.id, "edit", who, { fields: Object.keys(p) });
  l.items[idx] = item;
  await saveItemsFor(l.m.id, l.items);
  await afterChange(l.m, { forceOwner: p.assigneeId !== undefined ? [item.id] : [] });
  return { ok: true };
}

export type BulkResult = { approved: string[]; skipped: { id: string; reason: string }[] };
/** Bulk approve: only unambiguous, verified, confirmed commitments (and clean decisions). Everything else is skipped with the reason, never approved. */
export async function approveItems(meetingId: string, o: { itemIds?: string[]; all?: "confirmed" }, by: Reviewer | null): Promise<BulkResult> {
  const l = await load(meetingId);
  if (!l) throw new Error("meeting not found");
  if (by && !canReview(l.m, by)) throw new Error("forbidden");
  const res: BulkResult = { approved: [], skipped: [] };
  const picked = o.itemIds ? new Set(o.itemIds) : null;
  const items = l.items.map((i) => {
    if (picked ? !picked.has(i.id) : o.all !== "confirmed") return i;
    if (i.approval === "approved" || i.approval === "rejected") return i;
    const why = i.itemType === "question" ? "open question" : i.unverified ? "no supporting quote" : isAmbiguous(i) ? "ambiguous" : i.itemType === "task" && (i.kind !== "commitment" || i.label !== "confirmed" || !i.assigneeId) ? "not a confirmed commitment with an owner" : null;
    if (why) { res.skipped.push({ id: i.id, reason: why }); return i; }
    res.approved.push(i.id);
    return approve(i, by?.userId ?? null);
  });
  if (res.approved.length) {
    await saveItemsFor(l.m.id, items);
    await audit(l.m.id, null, "approve-bulk", by?.userId ?? null, { ids: res.approved, skipped: res.skipped.length });
    await afterChange(l.m);
  }
  return res;
}

/** Folds a duplicate item into another one (keeps the target; fills its missing owner / date). */
export async function mergeItems(meetingId: string, itemId: string, intoId: string, by: Reviewer | null): Promise<ReviewResult> {
  const l = await load(meetingId);
  if (!l) return { ok: false, error: "not_found" };
  if (by && !canReview(l.m, by)) return { ok: false, error: "forbidden" };
  const from = l.items.find((i) => i.id === itemId), into = l.items.find((i) => i.id === intoId);
  if (!from || !into || from.id === into.id || from.itemType !== into.itemType) return { ok: false, error: "not_found" };
  if (from.approval === "approved") return { ok: false, error: "bad_request", message: "an approved item is already a task: reject or edit it instead" };
  const merged: MeetingItem = { ...into, assigneeId: into.assigneeId ?? from.assigneeId, assigneeName: into.assigneeId ? into.assigneeName : from.assigneeName, dueDate: into.dueDate ?? from.dueDate, evidence: [...new Set([...into.evidence, ...from.evidence])].slice(0, 8) };
  await saveItemsFor(l.m.id, l.items.filter((i) => i.id !== from.id).map((i) => (i.id === into.id ? merged : i)));
  await audit(l.m.id, from.id, "merge", by?.userId ?? null, { into: into.id });
  await afterChange(l.m, { notify: false });
  return { ok: true };
}

/** "These are not duplicates / the conflict is fine": clears the flags and remembers the dismissal so they do not come back. */
export async function dismissDuplicate(meetingId: string, itemId: string, by: Reviewer | null, what: "duplicate" | "conflict" | "both" = "both"): Promise<ReviewResult> {
  const l = await load(meetingId);
  if (!l) return { ok: false, error: "not_found" };
  if (by && !canReview(l.m, by)) return { ok: false, error: "forbidden" };
  const item = l.items.find((i) => i.id === itemId);
  if (!item) return { ok: false, error: "not_found" };
  const dup = what !== "conflict", con = what !== "duplicate";
  const ids = [...(dup ? item.ambiguity.duplicateOf.map((d) => d.id) : []), ...(con ? item.ambiguity.conflicts.map((c) => c.with.id) : [])];
  const wasMerged = item.merged === true && dup;
  const next: MeetingItem = { ...item, ...(wasMerged ? { merged: false, commitmentId: null } : {}), ambiguity: { ...item.ambiguity, duplicateOf: dup ? [] : item.ambiguity.duplicateOf, conflicts: con ? [] : item.ambiguity.conflicts, dismissed: [...new Set([...(item.ambiguity.dismissed ?? []), ...ids])] } };
  await saveItemsFor(l.m.id, l.items.map((i) => (i.id === itemId ? next : i)));
  if (wasMerged) await db.delete(meetingTaskNotifications).where(and(eq(meetingTaskNotifications.meetingId, l.m.id), eq(meetingTaskNotifications.taskId, itemId), sql`${meetingTaskNotifications.messageTs} is null`)); // it was never really announced: the separate task will be
  await audit(l.m.id, itemId, "dismiss-duplicate", by?.userId ?? null, { ids, unmerged: wasMerged });
  await afterChange(l.m);
  return { ok: true };
}

/** The "Who owns ...?" card: sets the owner only. The item stays proposed unless the auto-approve conditions now hold. Idempotent. */
export async function chooseOwner(meetingId: string, itemId: string, userId: string, by: Reviewer): Promise<ReviewResult> {
  const l = await load(meetingId);
  if (!l) return { ok: false, error: "not_found" };
  if (!canReview(l.m, by)) return { ok: false, error: "forbidden" };
  const idx = l.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return { ok: false, error: "not_found" };
  if (l.items[idx]!.assigneeId === userId) return { ok: true };
  let item: MeetingItem;
  try { item = await applyEdits(l.m, l.items[idx]!, { assigneeId: userId }); } catch (e) { return { ok: false, error: "bad_request", message: String(e) }; }
  l.items[idx] = item;
  await saveItemsFor(l.m.id, l.items);
  await audit(l.m.id, itemId, "choose-owner", by.userId, { assigneeId: userId });
  await afterChange(l.m, { forceOwner: [itemId] });
  return { ok: true };
}

/** Old API: set or clear a task's owner from the meeting page. */
export async function updateMeetingTaskAssignee(meetingId: string, taskId: string, assigneeId: string | null): Promise<void> {
  const r = await patchMeetingItem(meetingId, taskId, { assigneeId }, null);
  if (!r.ok) throw new Error(r.error === "not_found" ? "task not found" : r.message ?? r.error);
}

async function refreshDms(meetingId: string) {
  const { rerenderMeetingDms } = await import("./recap");
  await rerenderMeetingDms(meetingId).catch((err) => log.warn("recap refresh failed", { meetingId, error: String(err) }));
}

/** Detached: Slack event ACKs and HTTP responses never wait for DMs. */
export function queueRecaps(meetingId: string) {
  void import("./recap").then((r) => r.sendMeetingRecaps(meetingId)).catch((err) => log.warn("automatic meeting recap DMs failed", { meetingId, error: err instanceof Error ? err.message : String(err) }));
}
