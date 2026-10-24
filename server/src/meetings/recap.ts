import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channelMembers, channels, commitments, meetings, meetingTaskNotifications, users } from "../db/schema";
import { log } from "../log";
import { ACTIVE, resolveCommitment, type Commitment } from "../manager/commitments";
import { notifyAssignerDone, syncTaskFact, userName } from "../manager/task-sync";
import { hasSecret } from "../memory/ambient";
import { openDm, postMessage, slackClient } from "../slack/client";
import { asItems, type MeetingItem } from "./items";
import { cleanTitle } from "./title";
import { chooseOwner, commitmentsFor, getApprovalMode, getAutoThreshold, patchMeetingItem, saveItemsFor, syncMeetingTasks } from "./tasks";
import { meetingUrl, slackText, tasksUrl } from "./urls";

/**
 * ONE recap DM per person: what happened in the meeting (decisions, key points, open questions, link), then THEIR tasks with
 * Acknowledge / Done / Not mine. The organizer's DM adds what needs a human: proposed items (Approve / Reject), unassigned tasks, and a
 * "Who owns ...?" card with up to 3 candidates for items whose owner is unclear.
 * Delivery state is one meeting_task_notifications row per (meeting, item, recipient): claimed before sending, retried up to 3 times.
 */
export type SendResult = { sent: number; skipped: number; failed: number };
const MAX_ITEMS = 8;
const MAX_ATTEMPTS = 3;
const MAX_BULLETS = 6;
const MAX_SUMMARY_CHARS = 1200;

// ---------- content ----------
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const prettyDate = (d: Date) => `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
const prettyDue = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? prettyDate(new Date(`${iso}T00:00:00Z`)) : iso);
const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const safe = (s: string) => slackText(s.replace(/[*_`~]/g, ""));

/** 3-6 short bullets: decisions first, then key discussion points, then open questions. No line that looks like a secret. Under ~1200 chars. */
export function recapBullets(summary: string | null, decisions: string[], questions: string[] = []): string[] {
  const discussion: string[] = [], open: string[] = [];
  let section = "";
  const prose: string[] = [];
  for (const raw of (summary ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^#{1,4}\s*(.+)$/.exec(line);
    if (h) { section = h[1]!.toLowerCase(); continue; }
    const b = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (!b) { prose.push(line); continue; }
    if (/related earlier|earlier context/.test(section)) continue;
    (/open|unresolved|question/.test(section) ? open : discussion).push(b[1]!);
  }
  if (!discussion.length && !open.length) for (const p of prose.join(" ").split(/(?<=[.!?])\s+/).slice(0, 2)) discussion.push(p);
  const qs = questions.length ? questions : open;
  const bullets = [
    ...decisions.slice(0, 3).map((d) => `Decision: ${d}`),
    ...discussion.slice(0, Math.max(1, 4 - Math.min(decisions.length, 3))),
    ...qs.slice(0, 2).map((q) => `Open question: ${q}`),
  ].map((b) => oneLine(b.replace(/\*\*/g, ""), 220)).filter((b) => b && !hasSecret(b));
  const out: string[] = []; let size = 0;
  for (const b of bullets.slice(0, MAX_BULLETS)) { if (size + b.length > MAX_SUMMARY_CHARS) break; out.push(b); size += b.length; }
  return out;
}

type Meeting = typeof meetings.$inferSelect;

/** May this person read the meeting itself? Same rules as the Meeting notes page: public channel, member of the private channel / DM, or the uploader. */
async function canReadMeeting(m: Meeting, userId: string): Promise<boolean> {
  if (m.channelId.startsWith("ext_")) return m.ownerId === userId;
  const [c] = await db.select({ p: channels.isPrivate, im: channels.isIm }).from(channels).where(eq(channels.id, m.channelId));
  if (c && !c.p && !c.im) return true;
  if (c?.im) return Array.isArray(m.participantIds) && (m.participantIds as unknown[]).includes(userId);
  const [mem] = await db.select({ u: channelMembers.userId }).from(channelMembers).where(and(eq(channelMembers.channelId, m.channelId), eq(channelMembers.userId, userId)));
  return !!mem;
}

type Note = typeof meetingTaskNotifications.$inferSelect;
type Item = { task: MeetingItem; note: Note; cm: Commitment | null };
type Layout = { merged: MeetingItem[]; meeting: Meeting; title: string; recipientId: string; includeSummary: boolean; readable: boolean; own: Item[]; attention: Item[]; questions: string[]; decisions: string[] };

const btn = (text: string, action_id: string, value: string, style?: "primary" | "danger") => ({ type: "button", ...(style ? { style } : {}), text: { type: "plain_text", text }, action_id, value });
const link = (text: string, url: string) => ({ type: "button", text: { type: "plain_text", text }, action_id: "meeting_link", url });
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } });

function ownState(i: Item): "done" | "dropped" | "declined" | "reassigned" | "acknowledged" | "open" {
  if (i.cm?.status === "done") return "done";
  if (i.cm?.status === "dropped") return "dropped";
  if (i.note.status === "declined") return "declined";
  if (i.task.assigneeId && i.task.assigneeId !== i.note.recipientUserId) return "reassigned";
  return i.note.status === "acknowledged" ? "acknowledged" : "open";
}

function ownBlocks(i: Item): unknown[] {
  const t = i.task;
  const desc = oneLine(t.description ?? "", 200);
  const urgent = i.cm?.priority === "urgent" || t.priority === "urgent";
  const due = i.cm?.dueAt ? prettyDate(i.cm.dueAt) : t.dueDate ? prettyDue(t.dueDate) : "no due date";
  const state = ownState(i);
  const status = { done: "\n:white_check_mark: Done", dropped: "\nDropped", declined: "\n:leftwards_arrow_with_hook: Sent back to the organizer", reassigned: "\nReassigned to someone else", acknowledged: "\n:thumbsup: Acknowledged", open: "" }[state];
  const tentative = t.label === "tentative" && state === "open";
  const restated = t.ambiguity.conflicts.find((c) => c.restated);
  const overlap = restated ? undefined : [...t.ambiguity.duplicateOf.map((d) => d.title), ...t.ambiguity.conflicts.map((c) => c.with.title)][0];
  const blocks: unknown[] = [section(`${urgent ? ":rotating_light: " : ":small_blue_diamond: "}*${safe(t.title)}*${urgent ? "  *URGENT*" : ""}${tentative ? "  _tentative_" : ""}${desc ? `\n${safe(desc)}` : ""}\nDue: ${due}${tentative ? "\n_Looks like you may own this. Press Not mine if it is not yours._" : ""}${overlap ? `\n:warning: Heads-up: this ${t.ambiguity.conflicts.length ? "conflicts with" : "overlaps"} ${safe(overlap)}` : ""}${restated ? `\n:warning: Heads-up: the ${restated.type === "due" ? "due date" : "owner"} changed during the meeting (earlier: ${safe(restated.type === "due" ? restated.with.dueDate ?? "?" : restated.with.ownerName ?? "?")}); the latest is used` : ""}${status}`)];
  if (state === "open" || state === "acknowledged") {
    blocks.push({ type: "actions", elements: [
      ...(state === "open" ? [btn("Acknowledge", "meeting_task_ack", i.note.id, "primary")] : []),
      btn("Done", "meeting_task_done", i.note.id, state === "acknowledged" ? "primary" : undefined),
      btn("Not mine", "meeting_task_decline", i.note.id),
    ] });
  }
  return blocks;
}

const KIND = { commitment: "commitment", suggestion: "suggestion", question: "open question" } as const;
function flagLines(t: MeetingItem): string[] {
  const a = t.ambiguity;
  return [
    ...(a.ownerMissing ? ["owner unclear (nobody was named)"] : []), ...(a.ownerAmbiguous ? ["owner unclear (several people match)"] : []),
    ...(a.dueMissing && t.dueText ? [`date unclear (“${t.dueText}”)`] : []),
    ...a.duplicateOf.map((d) => `looks like an existing task: ${d.title}`),
    ...a.conflicts.map((c) => `conflicts with: ${c.with.title}${c.type === "owner" ? " (different owner)" : c.type === "due" ? " (different date)" : ""}`),
    ...(t.unverified ? ["no supporting quote found in the notes"] : []),
  ];
}
function attentionBlocks(i: Item, meeting: Meeting): unknown[] {
  const t = i.task;
  const flags = flagLines(t);
  const head = `:eyes: *${safe(t.title)}*  _(${KIND[t.kind]}, ${Math.round(t.confidence * 100)}% sure)_\nOwner: ${t.assigneeName ? safe(t.assigneeName) : "*nobody yet*"}${t.dueDate ? ` · due ${prettyDue(t.dueDate)}` : ""}${flags.length ? `\n:warning: ${safe(flags.join("; "))}` : ""}`;
  if (t.approval === "approved") {
    return [section(`${head}\n${t.assigneeId ? ":white_check_mark: Approved" : "Needs an owner: assign it in Tasks (or the meeting page)."}`),
      ...(t.assigneeId ? [] : [{ type: "actions", elements: [link("Assign in Tasks", tasksUrl()), link("Meeting notes", meetingUrl(meeting.id))] }])];
  }
  if (t.approval === "rejected") return [section(`${head}\nRejected`)];
  const value = `${meeting.id}:${t.id}`;
  if (t.ambiguity.ownerMissing || t.ambiguity.ownerAmbiguous) {
    const cands = t.ambiguity.ownerCandidates.slice(0, 3);
    return [section(`:question: *Who owns "${safe(t.title)}"?*${t.dueDate ? ` (due ${prettyDue(t.dueDate)})` : ""}${flags.length > 1 ? `\n:warning: ${safe(flags.filter((f) => !f.startsWith("owner")).join("; "))}` : ""}`),
      { type: "actions", elements: [...cands.map((c) => btn(c.name.slice(0, 70), "meeting_item_owner", `${value}:${c.id}`)), link("Assign in console", meetingUrl(meeting.id)), btn("Reject", "meeting_item_reject", value)] }];
  }
  const ok = !flags.length && !!t.assigneeId;
  return [section(head), { type: "actions", elements: [
    ...(ok ? [btn("Approve", "meeting_item_approve", value, "primary")] : [link("Review in console", meetingUrl(meeting.id))]),
    btn("Reject", "meeting_item_reject", value),
  ] }];
}

/** The Block Kit payload: header, What happened, Your tasks (max 8), what needs the organizer (max 8), links. Always <= 50 blocks. */
export function renderRecap(l: Layout): { text: string; blocks: unknown[] } {
  const m = l.meeting;
  const when = m.endedAt ?? m.startedAt ?? m.createdAt;
  const mins = m.startedAt && m.endedAt ? Math.round((m.endedAt.getTime() - m.startedAt.getTime()) / 60_000) : 0;
  const header = `Meeting recap: ${l.title} (${prettyDate(when)}${mins > 0 ? `, ${mins} min` : ""})`.slice(0, 150);
  const bullets = l.includeSummary && l.readable ? recapBullets(m.summary, l.decisions, l.questions) : [];
  const blocks: unknown[] = [{ type: "header", text: { type: "plain_text", text: header } }];
  if (bullets.length) blocks.push(section(`*What happened*\n${bullets.map((b) => `• ${safe(b)}`).join("\n")}`));
  if (l.own.length) {
    blocks.push(section(`*Your tasks* (${l.own.length})`));
    for (const i of l.own.slice(0, MAX_ITEMS)) blocks.push(...ownBlocks(i));
    if (l.own.length > MAX_ITEMS) blocks.push(section(`_and ${l.own.length - MAX_ITEMS} more: see Tasks_`));
  }
  if (l.merged.length && l.includeSummary) blocks.push(section(`_Already tracked, no new task made:_ ${l.merged.slice(0, 5).map((i) => `${safe(i.title)}${i.ambiguity.duplicateOf[0] ? ` (same as: ${safe(i.ambiguity.duplicateOf[0].title)})` : ""}`).join("; ")}`));
  if (l.attention.length) {
    blocks.push(section(`*Needs your decision* (${l.attention.length})`));
    for (const i of l.attention.slice(0, MAX_ITEMS)) blocks.push(...attentionBlocks(i, m));
    if (l.attention.length > MAX_ITEMS) blocks.push(section(`_and ${l.attention.length - MAX_ITEMS} more: open the meeting notes_`));
  }
  blocks.push({ type: "actions", elements: [...(l.readable ? [link("View notes", meetingUrl(m.id))] : []), link("Open Tasks", tasksUrl())] });
  const n = l.own.length, a = l.attention.length;
  return { text: `${header}. ${n ? `You have ${n} task${n === 1 ? "" : "s"}.` : ""}${a ? ` ${a} item${a === 1 ? " needs" : "s need"} your decision.` : ""}`.trim(), blocks };
}

// ---------- layout from database state ----------
async function layoutFor(m: Meeting, recipientId: string, notes: Note[], includeSummary: boolean): Promise<Layout> {
  const all = asItems(m.id, m.tasks);
  const tasks = new Map(all.map((t) => [t.id, t]));
  const cms = await commitmentsFor(m.id);
  const items = (kind: "task" | "organizer") => notes.filter((n) => n.kind === kind).flatMap((note) => {
    const task = tasks.get(note.taskId);
    return task ? [{ task, note, cm: cms.get(task.id) ?? null }] : [];
  });
  const [ch] = await db.select({ name: channels.name }).from(channels).where(eq(channels.id, m.channelId));
  const live = all.filter((i) => i.approval !== "rejected" && !i.unverified);
  return {
    merged: all.filter((i) => i.merged && i.assigneeId === recipientId && i.approval === "approved"),
    meeting: m, title: cleanTitle(m.title, ch?.name, m.endedAt), recipientId, includeSummary, readable: await canReadMeeting(m, recipientId),
    own: items("task"), attention: items("organizer"),
    decisions: live.filter((i) => i.itemType === "decision" && i.approval === "approved").map((i) => i.title),
    questions: live.filter((i) => i.itemType === "question").map((i) => i.title),
  };
}

// ---------- sending ----------
type Want = { own: MeetingItem[]; attention: MeetingItem[] };

/**
 * Sends the recap DMs that are due. One message per person. Only unsent / failed (< 3 attempts) / re-assigned items are claimed, so a
 * retry or a repeated sync never repeats a DM. `force` (the "Resend recap" button) also re-sends delivered ones. Extension uploads are
 * never DMed automatically: they need `manual` (the uploader pressing "Send task DMs"). Only APPROVED items reach their owners.
 */
export async function sendMeetingRecaps(meetingId: string, o: { taskIds?: string[]; force?: boolean; manual?: boolean } = {}): Promise<SendResult> {
  let [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!m) throw new Error("meeting not found");
  if (m.status === "ready" && asItems(m.id, m.tasks).some((i) => !i.approval)) { // rows from before approval existed: settle the gate first
    await syncMeetingTasks(m.id);
    [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  }
  const res: SendResult = { sent: 0, skipped: 0, failed: 0 };
  if (m.channelId.startsWith("ext_") && !o.manual) return res;
  if (m.status !== "ready") return res;
  const mode = await getApprovalMode();
  const threshold = await getAutoThreshold();
  const cms = await commitmentsFor(m.id);
  const existingNotes = await db.select().from(meetingTaskNotifications).where(eq(meetingTaskNotifications.meetingId, m.id));
  const want = new Map<string, Want>();
  const push = (uid: string, kind: keyof Want, t: MeetingItem) => { const w = want.get(uid) ?? { own: [], attention: [] }; w[kind].push(t); want.set(uid, w); };
  for (const t of asItems(m.id, m.tasks)) {
    if (t.itemType !== "task" || (o.taskIds && !o.taskIds.includes(t.id))) continue;
    const cm = cms.get(t.id);
    if (t.merged) { res.skipped++; continue; } // a duplicate of an existing task: its owner already has that task
    if (t.approval === "approved" && t.assigneeId && (!cm || (ACTIVE as readonly string[]).includes(cm.status))) push(t.assigneeId, "own", t);
    else if (m.organizerId && ((t.approval === "approved" && !t.assigneeId && !existingNotes.some((n) => n.taskId === t.id && n.status === "declined")) // a "Not mine" already told the organizer
      || (t.approval === "proposed" && !t.unverified && (mode === "approve" ? t.kind !== "question" : t.kind === "commitment" && t.confidence >= threshold && (t.ambiguity.ownerMissing || t.ambiguity.ownerAmbiguous))))) push(m.organizerId, "attention", t);
    else res.skipped++;
  }
  const existing = await db.select().from(meetingTaskNotifications).where(eq(meetingTaskNotifications.meetingId, m.id));
  for (const [recipient, w] of want) {
    const claimed: Note[] = [];
    for (const [kind, list] of [["task", w.own], ["organizer", w.attention]] as const) {
      for (const t of list) {
        const row = existing.find((n) => n.taskId === t.id && n.recipientUserId === recipient);
        const due = !row || (row.status === "failed" && (o.force || row.attempts < MAX_ATTEMPTS)) || (row.kind !== kind && row.status !== "failed")
          || (row.status === "declined" && kind === "task") || (row.status === "skipped" && !!o.manual) || (!!o.force && (row.status === "sent" || row.status === "acknowledged"));
        if (!due) { res.skipped++; continue; }
        let claim: Note | undefined;
        if (!row) {
          [claim] = await db.insert(meetingTaskNotifications).values({ id: newId("mtn_"), meetingId: m.id, taskId: t.id, recipientUserId: recipient, kind, status: "failed", error: "Preparing Slack DM", attempts: 1 }).onConflictDoNothing().returning();
        } else {
          // claim by compare-and-set on updated_at: the winner of an automatic send racing a manual one owns this DM
          [claim] = await db.update(meetingTaskNotifications).set({ kind, status: "failed", error: "Preparing Slack DM", attempts: o.force ? 1 : row.attempts + 1, declinedAt: null, updatedAt: new Date() })
            .where(and(eq(meetingTaskNotifications.id, row.id), sql`date_trunc('milliseconds', ${meetingTaskNotifications.updatedAt}) = ${row.updatedAt.toISOString()}::timestamptz`)).returning();
        }
        if (!claim) { res.skipped++; continue; }
        claimed.push(claim);
      }
    }
    if (!claimed.length) continue;
    const earlier = existing.some((n) => n.recipientUserId === recipient && n.messageTs && !claimed.some((c) => c.id === n.id));
    try {
      const layout = await layoutFor(m, recipient, claimed, !earlier || !!o.force);
      const msg = renderRecap(layout);
      const channel = await openDm(recipient);
      if (!channel) throw new Error("Could not open a Slack DM with the recipient");
      const posted = await postMessage({ channel, text: msg.text, blocks: msg.blocks });
      if (!posted.ts) throw new Error("Slack did not return a message timestamp");
      await db.update(meetingTaskNotifications).set({ status: "sent", dmChannelId: channel, messageTs: posted.ts, error: null, sentAt: new Date(), updatedAt: new Date() }).where(inArray(meetingTaskNotifications.id, claimed.map((c) => c.id)));
      res.sent++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await db.update(meetingTaskNotifications).set({ status: "failed", error, updatedAt: new Date() }).where(inArray(meetingTaskNotifications.id, claimed.map((c) => c.id)));
      log.warn("meeting recap DM failed", { meetingId: m.id, userId: recipient, error });
      res.failed++;
    }
  }
  return res;
}

/** Failed recap DMs below the attempt limit are tried again (called from the huddle sync and the hourly manager job). */
export async function retryFailedRecaps(): Promise<number> {
  const rows = await db.selectDistinct({ id: meetingTaskNotifications.meetingId }).from(meetingTaskNotifications)
    .where(and(eq(meetingTaskNotifications.status, "failed"), lt(meetingTaskNotifications.attempts, MAX_ATTEMPTS), lt(meetingTaskNotifications.updatedAt, new Date(Date.now() - 60_000))));
  let n = 0;
  for (const r of rows) { const s = await sendMeetingRecaps(r.id).catch(() => null); n += s?.sent ?? 0; }
  return n;
}

/** Re-renders every delivered recap of this meeting from current state (buttons give way to the outcome). */
export async function rerenderMeetingDms(meetingId: string): Promise<void> {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!m) return;
  const rows = await db.select().from(meetingTaskNotifications).where(and(eq(meetingTaskNotifications.meetingId, meetingId), isNotNull(meetingTaskNotifications.messageTs)));
  if (!rows.length) return;
  const groups = new Map<string, Note[]>();
  for (const r of rows) { const k = `${r.recipientUserId}|${r.dmChannelId}|${r.messageTs}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const firstTs = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0))) if (!firstTs.has(r.recipientUserId)) firstTs.set(r.recipientUserId, r.messageTs!);
  const slack = await slackClient();
  for (const notes of groups.values()) {
    const first = notes[0]!;
    const layout = await layoutFor(m, first.recipientUserId, notes, firstTs.get(first.recipientUserId) === first.messageTs);
    const msg = renderRecap(layout);
    await slack.chat.update({ channel: first.dmChannelId!, ts: first.messageTs!, text: msg.text, blocks: msg.blocks as never })
      .catch((err: unknown) => log.warn("meeting recap update failed", { meetingId, error: String(err) }));
  }
}

// ---------- buttons ----------
const ACTIONS = new Set(["meeting_task_ack", "meeting_task_done", "meeting_task_decline", "meeting_item_approve", "meeting_item_reject", "meeting_item_owner", "meeting_link"]);
type Payload = { user?: { id?: string }; actions?: { action_id?: string; value?: string }[] };

/** Acknowledge / Done / Not mine (owner) and Approve / Reject / owner choice (organizer or admin). Returns true when the payload was one of ours. */
export async function handleMeetingTaskAction(payload: Payload): Promise<boolean> {
  const action = payload.actions?.find((a) => a.action_id && ACTIONS.has(a.action_id));
  if (!action) return false;
  const uid = payload.user?.id;
  if (!uid || !action.value || action.action_id === "meeting_link") return true;
  if (action.action_id === "meeting_item_approve" || action.action_id === "meeting_item_reject" || action.action_id === "meeting_item_owner") {
    const [meetingId, taskId, ownerId] = action.value.split(":");
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, uid));
    const by = { userId: uid, role: u?.role ?? "member" };
    if (meetingId && taskId) {
      const r = action.action_id === "meeting_item_owner" && ownerId ? await chooseOwner(meetingId, taskId, ownerId, by)
        : await patchMeetingItem(meetingId, taskId, { approval: action.action_id === "meeting_item_approve" ? "approved" : "rejected" }, by);
      if (!r.ok) log.warn("meeting item review refused", { meetingId, taskId, reason: r.error });
    }
    return true;
  }
  const [note] = await db.select().from(meetingTaskNotifications).where(eq(meetingTaskNotifications.id, action.value)).limit(1);
  if (!note || note.recipientUserId !== uid || note.kind !== "task") return true;
  if (note.status !== "sent" && note.status !== "acknowledged") return true;
  const [m] = await db.select().from(meetings).where(eq(meetings.id, note.meetingId)).limit(1);
  if (!m) return true;
  const now = new Date();
  const cm = (await commitmentsFor(m.id)).get(note.taskId) ?? null;
  const set = (status: "acknowledged" | "declined") => db.update(meetingTaskNotifications).set({ status, updatedAt: now, ...(status === "declined" ? { declinedAt: now } : { acknowledgedAt: now }) }).where(eq(meetingTaskNotifications.id, note.id));
  if (action.action_id === "meeting_task_ack") await set("acknowledged");
  else if (action.action_id === "meeting_task_done") {
    await set("acknowledged");
    if (cm) { const row = await resolveCommitment(cm.id, "done", { id: uid }); if (row) await notifyAssignerDone(row, uid); }
  } else {
    await set("declined");
    const items = asItems(m.id, m.tasks).map((t) => (t.id === note.taskId && t.assigneeId === uid ? { ...t, assigneeId: null, assigneeName: null, ambiguity: { ...t.ambiguity, ownerMissing: true } } : t));
    await saveItemsFor(m.id, items);
    if (cm && cm.ownerId === uid) {
      const [row] = await db.update(commitments).set({ ownerId: null, ownerName: null, nudgeCount: 0, lastNudgedAt: null }).where(eq(commitments.id, cm.id)).returning();
      if (row) await syncTaskFact(row);
    }
    await notifyDeclined(m, items.find((t) => t.id === note.taskId), uid, cm?.assignerId ?? null);
  }
  await rerenderMeetingDms(m.id);
  return true;
}

/** Tells the organizer (assigner) that the owner pushed back, and how to reassign. */
async function notifyDeclined(m: Meeting, task: MeetingItem | undefined, declinedBy: string, assigner: string | null) {
  const to = assigner ?? m.organizerId;
  if (!to || to === declinedBy || !task) return;
  try {
    const channel = await openDm(to);
    if (!channel) return;
    const who = (await userName(declinedBy)) ?? "A teammate";
    const text = `:raised_hand: ${slackText(who)} says the task *${safe(task.title)}* from the meeting is not theirs. It is now unassigned: assign someone else in Tasks, or on the meeting notes page.`;
    await postMessage({ channel, text: `${who} says task "${task.title}" is not theirs: assign someone else`, blocks: [section(text), { type: "actions", elements: [link("Assign in Tasks", tasksUrl()), link("Meeting notes", meetingUrl(m.id))] }] });
  } catch (err) { log.warn("decline notice failed", { meetingId: m.id, error: String(err) }); }
}
