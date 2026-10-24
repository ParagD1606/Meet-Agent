import { and, desc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { id as newId, sha256 } from "../crypto";
import { db } from "../db";
import { channelMembers, channels, meetings, meetingTaskNotifications, users } from "../db/schema";
import { log } from "../log";
import { completeJson, completeText } from "../memory/llm";
import { config } from "../config";
import { openDm, postMessage, slackClient } from "../slack/client";

export type MeetingTask = {
  id: string;
  title: string;
  description: string;
  assigneeName: string | null;
  assigneeId: string | null;
  dueDate: string | null;
  jiraKey?: string | null;
  jiraUrl?: string | null;
  notification?: { status: "needs_assignee" | "pending" | "sent" | "acknowledged" | "declined" | "failed"; error?: string | null };
};

type NewMeetingTask = Omit<MeetingTask, "id" | "notification">;
type SendResult = { sent: number; skipped: number; failed: number };

type Actor = { userId: string; role: "owner" | "admin" | "member" };
type HuddleFile = Record<string, any>;

type HuddleSyncResult = { found: number; imported: number; failed: number };

const taskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(4000).default(""),
  assigneeName: z.string().trim().min(1).max(120).nullable().default(null),
  assigneeId: z.string().trim().min(1).max(40).nullable().default(null),
  dueDate: z.string().trim().min(1).max(40).nullable().default(null),
});
const analysisSchema = z.object({
  summary: z.string().trim().min(1).max(8_000),
  tasks: z.array(taskSchema).max(50),
});

const SUMMARY_SYSTEM = `You turn completed meeting source material (a transcript, or Slack AI Huddle notes) into useful meeting notes.
Use only the supplied text. Write a concise Markdown summary with headings for Decisions, Discussion, and Open questions when applicable.
Extract only explicit commitments as tasks. Never invent an owner or due date. If a speaker's Slack user id is shown, preserve it as assigneeId. Return JSON only: {"summary":"...","tasks":[{"title":"...","description":"...","assigneeName":null,"assigneeId":null,"dueDate":null}]}.`;

const admin = (a: Actor) => a.role === "owner" || a.role === "admin";
const asTasks = (meetingId: string, value: unknown): MeetingTask[] => !Array.isArray(value) ? [] : value.map((value, index) => {
  const task = value as Partial<NewMeetingTask & { id: string }>;
  // Old rows predate task ids. The deterministic fallback lets them participate in delivery safely.
  const fallback = `mtask_${sha256(`${meetingId}:${index}:${task.title ?? ""}`).slice(0, 24)}`;
  return {
    id: typeof task.id === "string" && task.id ? task.id : fallback,
    title: task.title ?? "Untitled task", description: task.description ?? "",
    assigneeName: task.assigneeName ?? null, assigneeId: task.assigneeId ?? null, dueDate: task.dueDate ?? null,
    jiraKey: task.jiraKey ?? null, jiraUrl: task.jiraUrl ?? null,
  };
});
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const decodeEntities = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/**
 * Slack names Huddle canvases ":headphones: Huddle notes: 10/24/26 in &lt;#C0123ABC&gt;". Turns that (and any other
 * title carrying entities, emoji codes or channel mentions) into "Huddle in #general · Oct 24".
 * Idempotent, so it is safe on already-clean titles. `channelName` is the stored name for the meeting's channel.
 */
export function cleanTitle(raw: string, channelName?: string | null, fallbackDate?: Date | string | null): string {
  let t = decodeEntities(raw).replace(/(^|\s):[a-z0-9_+-]+:(?=\s|$)/gi, "$1").replace(/\s+/g, " ").trim();
  const mention = /<#([A-Z0-9]+)(?:\|([^>]+))?>/.exec(t);
  const channel = (mention?.[2] ?? channelName ?? "").replace(/^#/, "").trim();
  t = t.replace(/<#[A-Z0-9]+(?:\|[^>]+)?>/g, channel ? `#${channel}` : "a channel");
  const huddle = /^huddle notes\b:?\s*(.*)$/i.exec(t);
  if (!huddle) return t || "Meeting";
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(huddle[1]!);
  const d = fallbackDate ? new Date(fallbackDate) : null;
  const date = m ? `${MONTHS[Number(m[1]) - 1] ?? ""} ${Number(m[2])}`.trim()
    : d && !Number.isNaN(d.getTime()) ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : "";
  return ["Huddle" + (channel ? ` in #${channel}` : ""), date].filter(Boolean).join(" · ");
}

const taskSignature = (task: Pick<NewMeetingTask, "title" | "description">) => `${task.title.trim().toLowerCase()}\u0000${task.description.trim().toLowerCase()}`;
const slackText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function assignTaskIds(meetingId: string, fresh: NewMeetingTask[], previous: unknown): MeetingTask[] {
  const old = new Map(asTasks(meetingId, previous).map((task) => [taskSignature(task), task.id]));
  return fresh.map((task) => ({ ...task, id: old.get(taskSignature(task)) ?? newId("mtask_") }));
}

const cleanName = (name: string) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const similarity = (a: string, b: string) => {
  if (!a || !b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = saved;
    }
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length);
};

async function resolveAssignee(task: MeetingTask) {
  if (task.assigneeId) {
    const [user] = await db.select({ id: users.id, name: users.name }).from(users)
      .where(and(eq(users.id, task.assigneeId), eq(users.deactivated, false), eq(users.isBot, false))).limit(1);
    if (user) return user;
  }
  if (!task.assigneeName?.trim()) return null;
  const candidates = await db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.deactivated, false), eq(users.isBot, false)));
  const needle = cleanName(task.assigneeName);
  const exact = candidates.filter((u) => cleanName(u.name ?? "") === needle);
  if (exact.length === 1) return exact[0]!;
  const ranked = candidates.map((u) => ({ user: u, score: similarity(needle, cleanName(u.name ?? "")) }))
    .sort((a, b) => b.score - a.score);
  // Never pick a close misspelling if another teammate is almost as likely.
  return ranked[0] && ranked[0].score >= 0.9 && ranked[0].score - (ranked[1]?.score ?? 0) >= 0.08 ? ranked[0].user : null;
}

/** Public channels are visible to every member; private-channel records require membership. */
const readable = (actor: Actor) => admin(actor)
  ? undefined
  : or(eq(meetings.ownerId, actor.userId), eq(channels.isPrivate, false), eq(channelMembers.userId, actor.userId));

async function rowsFor(actor: Actor) {
  const q = db.select({ meeting: meetings, channelName: channels.name })
    .from(meetings)
    .leftJoin(channels, eq(meetings.channelId, channels.id))
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, meetings.channelId), eq(channelMembers.userId, actor.userId)));
  const where = readable(actor);
  return where ? q.where(where).orderBy(desc(meetings.endedAt), desc(meetings.createdAt)) : q.orderBy(desc(meetings.endedAt), desc(meetings.createdAt));
}

/** Meeting list intentionally omits the raw transcript. */
export async function listMeetings(actor: Actor) {
  const rows = await rowsFor(actor);
  return Promise.all(rows.map(({ meeting: { transcript: _transcript, ...meeting }, channelName }) => presentMeeting(meeting, channelName)));
}

export async function getMeeting(id: string, actor: Actor) {
  const rows = await rowsFor(actor);
  const found = rows.find((r) => r.meeting.id === id);
  const row = found?.meeting;
  return row ? presentMeeting(row, found!.channelName) : null;
}

async function presentMeeting(meeting: Omit<typeof meetings.$inferSelect, "transcript">, channelName?: string | null) {
  const tasks = asTasks(meeting.id, meeting.tasks);
  const notificationRows = tasks.length ? await db.select().from(meetingTaskNotifications)
    .where(and(eq(meetingTaskNotifications.meetingId, meeting.id), inArray(meetingTaskNotifications.taskId, tasks.map((t) => t.id)))) : [];
  const delivery = new Map(notificationRows.map((r) => [`${r.taskId}:${r.recipientUserId}`, r]));
  const lastByTask = new Map(notificationRows.map((r) => [r.taskId, r]));
  const withDelivery = tasks.map((task) => {
    const row = task.assigneeId ? delivery.get(`${task.id}:${task.assigneeId}`) : lastByTask.get(task.id);
    const status = row?.status === "declined" && !task.assigneeId ? "declined" : row?.status ?? (task.assigneeId ? "pending" : "needs_assignee");
    return { ...task, notification: { status: status as NonNullable<MeetingTask["notification"]>["status"], ...(row?.error ? { error: row.error } : {}) } };
  });
  return { ...meeting, title: cleanTitle(meeting.title, channelName, meeting.endedAt), tasks: withDelivery, participantIds: asStrings(meeting.participantIds) };
}

const lineText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(lineText).filter(Boolean).join("");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const key of ["text", "contents", "content", "value"]) if (o[key] !== undefined) {
      const text = lineText(o[key]);
      if (text) return text;
    }
  }
  return "";
};

const transcription = (file: HuddleFile) => file.huddle_transcription ?? file.transcription?.huddle_transcription ?? null;

const unixDate = (n: unknown) => typeof n === "number" ? new Date(n * 1000) : undefined;

/** Slack AI notes are a Canvas. `files.info` only exposes its metadata; Canvas content needs canvases:read. */
async function huddleCanvasText(client: Awaited<ReturnType<typeof slackClient>>, file: HuddleFile) {
  if (!file.is_huddle_canvas || typeof file.id !== "string") return null;
  const response = await client.apiCall("canvases.getContent", { canvas_id: file.id, content_type: "markdown" }) as { content?: unknown };
  if (typeof response.content !== "string" || !response.content.trim()) return null;
  const channelId = Array.isArray(file.channels) && typeof file.channels[0] === "string" ? file.channels[0] : undefined;
  return {
    text: response.content.trim(),
    participantIds: asStrings(file.huddle_participant_ids),
    channelId,
    startedAt: unixDate(file.huddle_date_start),
    endedAt: unixDate(file.huddle_date_end),
  };
}

function transcriptText(file: HuddleFile): { text: string; participantIds: string[]; channelId?: string; startedAt?: Date; endedAt?: Date } | null {
  const t = transcription(file);
  const lines = Array.isArray(t?.lines) ? t.lines : [];
  const text = lines.map((line: Record<string, unknown>) => {
    const words = lineText(line.contents ?? line.content ?? line.text).trim();
    if (!words) return "";
    const speaker = typeof line.speaker_name === "string" ? line.speaker_name
      : typeof line.user_name === "string" ? line.user_name
      : typeof line.user_id === "string" ? `<@${line.user_id}>` : "";
    return speaker ? `${speaker}: ${words}` : words;
  }).filter(Boolean).join("\n").trim();
  if (!text) return null;
  return {
    text,
    participantIds: asStrings(t?.participant_ids ?? file.huddle_participant_ids),
    channelId: typeof t?.channel_id === "string" ? t.channel_id : undefined,
    startedAt: unixDate(t?.date_start ?? file.huddle_date_start),
    endedAt: unixDate(t?.date_end ?? file.huddle_date_end),
  };
}

const meetingUrl = (id: string) => `${config.PUBLIC_URL.replace(/\/$/, "")}/meetings?meeting=${encodeURIComponent(id)}`;

const dmBlocks = (meeting: typeof meetings.$inferSelect, task: MeetingTask, notificationId: string) => ([
  { type: "section", text: { type: "mrkdwn", text: `*Meeting task assigned to you*\n*${slackText(task.title)}*` } },
  ...(task.description ? [{ type: "section", text: { type: "mrkdwn", text: slackText(task.description) } }] : []),
  { type: "context", elements: [{ type: "mrkdwn", text: `From <${meetingUrl(meeting.id)}|${slackText(meeting.title)}>${task.dueDate ? ` · Due: ${slackText(task.dueDate)}` : ""}` }] },
  { type: "actions", elements: [
    { type: "button", style: "primary", text: { type: "plain_text", text: "Acknowledge" }, action_id: "meeting_task_ack", value: notificationId },
    { type: "button", text: { type: "plain_text", text: "Not mine" }, action_id: "meeting_task_decline", value: notificationId },
  ] },
]);

/** Sends only unsent or failed task notifications. Already delivered tasks are never duplicated. */
export async function sendMeetingTaskDms(meetingId: string, taskIds?: string[]): Promise<SendResult> {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!meeting) throw new Error("meeting not found");
  const selected = asTasks(meeting.id, meeting.tasks).filter((task) => !taskIds || taskIds.includes(task.id));
  let tasks = selected;
  let sent = 0; let skipped = 0; let failed = 0; let changed = false;
  for (let i = 0; i < tasks.length; i++) {
    let task = tasks[i]!;
    const assignee = await resolveAssignee(task);
    if (!assignee) { skipped += 1; continue; }
    if (task.assigneeId !== assignee.id || task.assigneeName !== assignee.name) {
      task = { ...task, assigneeId: assignee.id, assigneeName: assignee.name ?? task.assigneeName };
      tasks[i] = task; changed = true;
    }
    const [existing] = await db.select().from(meetingTaskNotifications)
      .where(and(eq(meetingTaskNotifications.meetingId, meeting.id), eq(meetingTaskNotifications.taskId, task.id), eq(meetingTaskNotifications.recipientUserId, assignee.id))).limit(1);
    if (existing?.status === "sent" || existing?.status === "acknowledged") { skipped += 1; continue; }
    const notificationId = existing?.id ?? newId("mtn_");
    if (!existing) {
      const [claimed] = await db.insert(meetingTaskNotifications).values({ id: notificationId, meetingId: meeting.id, taskId: task.id, recipientUserId: assignee.id, status: "failed", error: "Preparing Slack DM" })
        .onConflictDoNothing().returning({ id: meetingTaskNotifications.id });
      // Automatic delivery and a viewer's manual retry can race; the winner owns this one DM.
      if (!claimed) { skipped += 1; continue; }
    }
    try {
      const channel = await openDm(assignee.id);
      if (!channel) throw new Error("Could not open a Slack DM with the assignee");
      const message = await postMessage({ channel, text: `Meeting task: ${task.title}`, blocks: dmBlocks(meeting, task, notificationId) });
      if (!message.ts) throw new Error("Slack did not return a message timestamp");
      await db.update(meetingTaskNotifications).set({ status: "sent", dmChannelId: channel, messageTs: message.ts, error: null, sentAt: new Date(), updatedAt: new Date() })
        .where(eq(meetingTaskNotifications.id, notificationId));
      sent += 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await db.update(meetingTaskNotifications).set({ status: "failed", error, updatedAt: new Date() }).where(eq(meetingTaskNotifications.id, notificationId));
      log.warn("meeting task DM failed", { meetingId: meeting.id, taskId: task.id, userId: assignee.id, error });
      failed += 1;
    }
  }
  if (changed) {
    const updated = asTasks(meeting.id, meeting.tasks).map((task) => tasks.find((next) => next.id === task.id) ?? task);
    await db.update(meetings).set({ tasks: updated, updatedAt: new Date() }).where(eq(meetings.id, meeting.id));
  }
  return { sent, skipped, failed };
}

/** Called after task extraction. It is intentionally detached from ingestion so Slack event ACKs stay fast. */
function queueMeetingTaskDms(meetingId: string) {
  void sendMeetingTaskDms(meetingId).catch((err) => log.warn("automatic meeting task DMs failed", { meetingId, error: err instanceof Error ? err.message : String(err) }));
}

export async function updateMeetingTaskAssignee(meetingId: string, taskId: string, assigneeId: string | null): Promise<void> {
  const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!meeting) throw new Error("meeting not found");
  let assignee: { id: string; name: string | null } | null = null;
  if (assigneeId) {
    [assignee] = await db.select({ id: users.id, name: users.name }).from(users)
      .where(and(eq(users.id, assigneeId), eq(users.deactivated, false), eq(users.isBot, false))).limit(1);
    if (!assignee) throw new Error("assignee not found");
  }
  let found = false;
  const tasks = asTasks(meeting.id, meeting.tasks).map((task) => {
    if (task.id !== taskId) return task;
    found = true;
    return { ...task, assigneeId: assignee?.id ?? null, assigneeName: assignee?.name ?? null };
  });
  if (!found) throw new Error("task not found");
  await db.update(meetings).set({ tasks, updatedAt: new Date() }).where(eq(meetings.id, meeting.id));
}

export async function meetingAssigneeCandidates(q: string) {
  const needle = q.trim().toLowerCase();
  const rows = await db.select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl }).from(users)
    .where(and(eq(users.deactivated, false), eq(users.isBot, false))).orderBy(users.name);
  return rows.filter((u) => !needle || (u.name ?? "").toLowerCase().includes(needle)).slice(0, 20);
}

export async function handleMeetingTaskAction(payload: { user?: { id?: string }; actions?: { action_id?: string; value?: string }[] }): Promise<boolean> {
  const action = payload.actions?.find((a) => a.action_id === "meeting_task_ack" || a.action_id === "meeting_task_decline");
  if (!action?.value || !payload.user?.id) return false;
  const [notification] = await db.select().from(meetingTaskNotifications).where(eq(meetingTaskNotifications.id, action.value)).limit(1);
  if (!notification || notification.recipientUserId !== payload.user.id) return true;
  if (notification.status !== "sent") return true;
  const decline = action.action_id === "meeting_task_decline";
  const now = new Date();
  await db.update(meetingTaskNotifications).set({ status: decline ? "declined" : "acknowledged", updatedAt: now, ...(decline ? { declinedAt: now } : { acknowledgedAt: now }) })
    .where(and(eq(meetingTaskNotifications.id, notification.id), eq(meetingTaskNotifications.status, "sent")));
  if (decline) {
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, notification.meetingId)).limit(1);
    if (meeting) {
      const tasks = asTasks(meeting.id, meeting.tasks).map((task) => task.id === notification.taskId && task.assigneeId === notification.recipientUserId
        ? { ...task, assigneeId: null, assigneeName: null } : task);
      await db.update(meetings).set({ tasks, updatedAt: now }).where(eq(meetings.id, meeting.id));
    }
  }
  if (notification.dmChannelId && notification.messageTs) {
    await (await slackClient()).chat.update({ channel: notification.dmChannelId, ts: notification.messageTs,
      text: decline ? "Task declined — it needs reassignment." : "Task acknowledged.", blocks: [] }).catch((err) => log.warn("meeting task DM update failed", { notificationId: notification.id, error: String(err) }));
  }
  return true;
}

async function analyze(sourceFileId: string, text: string): Promise<void> {
  try {
    const analysis = await completeJson({ system: SUMMARY_SYSTEM, prompt: text.slice(-50_000), role: "summarize", maxOutputTokens: 1_400 }, analysisSchema);
    const [meeting] = await db.select({ id: meetings.id, tasks: meetings.tasks }).from(meetings).where(eq(meetings.sourceFileId, sourceFileId)).limit(1);
    if (!meeting) return;
    const tasks = assignTaskIds(meeting.id, analysis.tasks, meeting.tasks);
    await db.update(meetings).set({ summary: analysis.summary, tasks, status: "ready", updatedAt: new Date() }).where(eq(meetings.id, meeting.id));
  } catch (err) {
    await db.update(meetings).set({ status: "failed", updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
    log.warn("meeting summary failed", { fileId: sourceFileId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Adds the user's own decisions and tasks to the AI result; their entries win over duplicate AI ones. */
async function mergeUserNotes(sourceFileId: string, t: ExtensionTranscript): Promise<void> {
  const [row] = await db.select({ id: meetings.id, summary: meetings.summary, tasks: meetings.tasks, status: meetings.status }).from(meetings).where(eq(meetings.sourceFileId, sourceFileId));
  if (!row) return;
  const mine: NewMeetingTask[] = (t.tasks ?? []).map((k) => ({
    title: k.title, description: k.done ? "Marked done during the call." : "",
    assigneeName: k.assignee?.trim() || null, assigneeId: null, dueDate: k.due?.trim() || null,
  }));
  const seen = new Set(mine.map((k) => k.title.toLowerCase()));
  const existing = asTasks(row.id, row.tasks);
  const fresh: NewMeetingTask[] = [...mine, ...existing.filter((k) => !seen.has(k.title.toLowerCase())).map(({ id: _id, notification: _notification, ...task }) => task)];
  const tasks = assignTaskIds(row.id, fresh, existing);
  const decisions = (t.decisions ?? []).map((d) => `- ${d}`).join("\n");
  const section = decisions ? `## Decisions recorded in the call\n${decisions}` : "";
  const summary = [section, row.summary ?? ""].filter(Boolean).join("\n\n") || null;
  await db.update(meetings).set({ tasks, summary, status: summary ? "ready" : row.status, updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
}

export type ExtensionTranscript = {
  /** Stable per-call id from the extension; re-sending the same id replaces the earlier upload. */
  externalId: string;
  platform: string;
  title: string;
  lines: { speaker: string; text: string }[];
  startedAt?: Date;
  endedAt?: Date;
  /** Decisions and tasks the user recorded in the side panel; kept alongside the AI summary. */
  decisions?: string[];
  tasks?: { title: string; assignee?: string; due?: string; done?: boolean }[];
};

/** Stores a transcript captured by the browser extension and summarizes it. Private to its uploader (and admins). */
export async function ingestExtensionTranscript(userId: string, t: ExtensionTranscript): Promise<{ id: string }> {
  const text = t.lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join("\n");
  // Namespaced by user so one person's id can never overwrite another's record.
  const sourceFileId = `ext:${userId}:${t.platform}:${t.externalId}`;
  const base = {
    channelId: `ext_${userId}`, platform: t.platform, ownerId: userId, title: t.title, transcript: text, participantIds: [] as string[],
    startedAt: t.startedAt ?? null, endedAt: t.endedAt ?? new Date(), updatedAt: new Date(),
  };
  const [row] = await db.insert(meetings).values({ id: newId("mt_"), sourceFileId, threadTs: null, ...base, status: "processing", tasks: [] })
    .onConflictDoUpdate({ target: meetings.sourceFileId, set: { ...base, status: "processing", summary: null, tasks: [] } })
    .returning({ id: meetings.id });
  await analyze(sourceFileId, text);
  if (t.decisions?.length || t.tasks?.length) await mergeUserNotes(sourceFileId, t);
  queueMeetingTaskDms(row!.id);
  return { id: row!.id };
}

/** Ingests a Huddle transcript exposed by Slack's files API. Other files are ignored. */
export async function ingestHuddleFile(fileId: string, hintedChannelId?: string): Promise<boolean> {
  const client = await slackClient();
  let file = (await client.files.info({ file: fileId })).file as HuddleFile | undefined;
  if (!file) return false;
  let parsed = transcriptText(file);
  if (!parsed) parsed = await huddleCanvasText(client, file);
  // A Huddle notes canvas may point to a distinct transcript file.
  if (!parsed && typeof file.huddle_transcript_file_id === "string") {
    file = (await client.files.info({ file: file.huddle_transcript_file_id })).file as HuddleFile | undefined;
    if (!file) return false;
    parsed = transcriptText(file);
  }
  if (!parsed) return false;
  const channelId = parsed.channelId ?? hintedChannelId ?? (Array.isArray(file.channels) ? file.channels[0] : undefined);
  if (!channelId) return false;
  const sourceFileId = String(file.id ?? fileId);
  const title = typeof file.title === "string" && file.title.trim() ? file.title.trim() : "Slack Huddle";
  const base = {
    channelId, title, transcript: parsed.text, participantIds: parsed.participantIds,
    startedAt: parsed.startedAt ?? null, endedAt: parsed.endedAt ?? new Date(), updatedAt: new Date(),
  };
  await db.insert(meetings).values({ id: newId("mt_"), sourceFileId, threadTs: null, ...base, status: "processing", tasks: [] })
    .onConflictDoUpdate({ target: meetings.sourceFileId, set: { ...base, status: "processing", summary: null, tasks: [] } });
  await analyze(sourceFileId, parsed.text);
  const [saved] = await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.sourceFileId, sourceFileId)).limit(1);
  if (saved) queueMeetingTaskDms(saved.id);
  return true;
}

/**
 * Finds Huddle canvases/transcripts the installed bot can currently see and imports them.
 * This is deliberately callable on demand: Slack does not replay file events that happened
 * before an app subscribed, and a Huddle transcript can finish processing after its first event.
 */
export async function syncRecentHuddles(limit = 100): Promise<HuddleSyncResult> {
  const client = await slackClient();
  const response = await client.files.list({ count: Math.min(Math.max(limit, 1), 100) });
  const files = (response.files ?? []) as HuddleFile[];
  const candidates = files.filter((file) => Boolean(file.is_huddle_canvas || file.huddle_transcription || file.huddle_transcript_file_id));
  let imported = 0;
  let failed = 0;
  for (const file of candidates) {
    if (typeof file.id !== "string") continue;
    try {
      const channelId = Array.isArray(file.channels) && typeof file.channels[0] === "string" ? file.channels[0] : undefined;
      if (await ingestHuddleFile(file.id, channelId)) imported += 1;
    } catch (err) {
      failed += 1;
      log.warn("meeting sync item failed", { fileId: file.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.info("meeting sync completed", { found: candidates.length, imported, failed });
  return { found: candidates.length, imported, failed };
}

const LIVE_ASK_SYSTEM = `You are a meeting assistant sitting in on a live call. Answer the user's question using only the transcript and the meeting context provided.
Be brief and concrete, name people when relevant, and say plainly when the transcript does not cover the question. Never invent facts, owners or dates.`;

const LIVE_ANALYZE_SYSTEM = `You track a live meeting and flag items for a human to approve. Transcript lines are numbered like [12].
Return decisions that were actually made, tasks someone took on or was asked to take, and open questions nobody has answered yet.
For each item:
- "kind": "task" | "decision" | "question".
- "label": "confirmed" (a clear commitment or final decision), "tentative" (maybe/likely/"I'll try"), or "suggestion" (proposed, nobody agreed). Questions use "suggestion".
- "reason": one short sentence saying why you classified it that way.
- "evidence": the line numbers that support it.
- "assignee": exactly one name from the provided roster only when the transcript makes the owner clear; otherwise null. Never guess an owner.
- "due": an ISO date (YYYY-MM-DD) when a date was said and can be resolved from the meeting's start time (for example "next Friday"); otherwise the words that were said; otherwise null. Never invent a date.
Do not repeat anything listed under "Already tracked". Return JSON only: {"items":[{"kind":"task","label":"confirmed","title":"...","reason":"...","evidence":[3],"assignee":null,"due":null}]}.`;

const liveAnalysisSchema = z.object({
  items: z.array(z.object({
    kind: z.enum(["task", "decision", "question"]),
    label: z.enum(["confirmed", "tentative", "suggestion"]).default("tentative"),
    title: z.string().trim().min(1).max(300),
    reason: z.string().trim().max(300).default(""),
    evidence: z.array(z.number().int().min(1)).max(6).default([]),
    assignee: z.string().trim().min(1).max(120).nullable().default(null),
    due: z.string().trim().min(1).max(60).nullable().default(null),
  })).max(40),
});

export type LiveLine = { speaker: string; text: string };
export type LiveContext = { title?: string; startedAt?: string; roster?: string[] };

/** Numbered transcript, keeping the most recent ~50k characters and the original numbering. */
function numbered(lines: LiveLine[]): string {
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    const row = `[${i + 1}] ${l.speaker ? `${l.speaker}: ` : ""}${l.text}`;
    if (size + row.length > 50_000) break;
    out.push(row); size += row.length + 1;
  }
  return out.reverse().join("\n");
}

function contextBlock(ctx: LiveContext): string {
  const start = ctx.startedAt ? new Date(ctx.startedAt) : null;
  const when = start && !Number.isNaN(start.getTime())
    ? `${start.toISOString()} (${start.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} UTC)` : "unknown";
  return [`Meeting: ${ctx.title ?? "untitled"}`, `Started: ${when}`, `Roster: ${(ctx.roster ?? []).join(", ") || "unknown"}`].join("\n");
}

/** Answers a question about an in-progress call. Nothing is stored. */
export async function askLiveMeeting(lines: LiveLine[], question: string, history: { role: "user" | "assistant"; text: string }[] = [], ctx: LiveContext & { notes?: string } = {}): Promise<string> {
  const convo = history.slice(-6).map((h) => `${h.role === "user" ? "Q" : "A"}: ${h.text}`).join("\n");
  const prompt = `${contextBlock(ctx)}\n${ctx.notes ? `Tracked so far:\n${ctx.notes.slice(0, 4_000)}\n` : ""}\nTranscript so far:\n${numbered(lines)}\n\n${convo ? `Earlier in this chat:\n${convo}\n\n` : ""}Question: ${question}`;
  return (await completeText({ system: LIVE_ASK_SYSTEM, prompt, role: "main", maxOutputTokens: 700 })).trim();
}

/** Extracts classified, evidenced decisions/tasks/questions from an in-progress call. Nothing is stored. */
export async function analyzeLiveMeeting(lines: LiveLine[], ctx: LiveContext, known: string[] = []) {
  const tracked = known.length ? `\nAlready tracked:\n${known.slice(0, 100).map((k) => `- ${k}`).join("\n")}\n` : "";
  const prompt = `${contextBlock(ctx)}\n${tracked}\nTranscript so far:\n${numbered(lines)}`;
  const out = await completeJson({ system: LIVE_ANALYZE_SYSTEM, prompt, role: "summarize", maxOutputTokens: 1_800 }, liveAnalysisSchema);
  // Keep only evidence that points at a real line, and only owners from the roster.
  const roster = new Map((ctx.roster ?? []).map((n) => [n.toLowerCase(), n]));
  return { items: out.items.map((i) => ({ ...i, evidence: i.evidence.filter((n) => n <= lines.length), assignee: i.assignee ? roster.get(i.assignee.toLowerCase()) ?? null : null })) };
}
