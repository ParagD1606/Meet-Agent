import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId, sha256 } from "../crypto";
import { db } from "../db";
import { channelMembers, channels, meetings, meetingTaskNotifications, users } from "../db/schema";
import { log } from "../log";
import { completeJson, completeText } from "../memory/llm";
import { config } from "../config";
import { htmlToText } from "../memory/ingest";
import { recordEpisode } from "../memory/episodes";
import { captureTurn } from "../memory/writeback";
import { buildRecall } from "../memory/recall";
import type { SlackScope } from "../memory/scope";
import { openDm, postMessage, slackClient } from "../slack/client";
import { makeSource, quoteSupported, verifiedOwner } from "./verify";

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

const quoteField = z.string().trim().max(600).default("");
const taskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(4000).default(""),
  assigneeName: z.string().trim().min(1).max(120).nullable().default(null),
  assigneeId: z.string().trim().min(1).max(40).nullable().default(null),
  dueDate: z.string().trim().min(1).max(40).nullable().default(null),
  quote: quoteField,
});
const analysisSchema = z.object({
  summary: z.string().trim().min(1).max(8_000),
  decisions: z.array(z.object({ text: z.string().trim().min(1).max(500), quote: quoteField })).max(40).default([]),
  tasks: z.array(taskSchema).max(60),
});

/** The whole meeting is read, not a tail: 400k characters is roughly a three-hour call. */
const MAX_SOURCE_CHARS = 400_000;

const SUMMARY_SYSTEM = `You turn completed meeting source material (a transcript, or Slack AI Huddle notes) into useful meeting notes. Work from the WHOLE text, start to end.
Use only the supplied text. Never use outside knowledge, the company's projects, or what a meeting like this "usually" covers. If something is not written in the text, it does not exist.
The text is usually automatic speech recognition: words can be wrong ("skating" for "scaling"), punctuation is unreliable, sentences are cut at random points, and names may be lowercase or misspelled. Read for meaning across the broken sentences, and write names with normal capitalisation.
When a "Background" block is given it is earlier team knowledge (Slack and notes). Use it ONLY to understand who people are and what projects, names and references mean. Never create a task or decision from it, and every quote must still come from the meeting text. If something decided or assigned here clearly relates to an earlier item in the Background, say so in one line under a "Related earlier context" heading in the summary, naming that earlier item.
- "summary": concise Markdown with headings for Discussion and Open questions when applicable.
- "decisions": only where a choice was made or agreed ("we decided", "let's go with", "the plan is"). A speaker describing hopes, goals or intentions is not a decision. Each is {"text": short sentence, "quote": words copied exactly from the text that show the decision}.
- "tasks": every commitment or assignment, however small ("X will do Y", "I'll ...", "Y is on Z", "Z to handle ..."). Each is {"title", "description", "assigneeName", "assigneeId", "dueDate", "quote"} where quote is words copied exactly from the text. Do not skip small ones, and do not add any without a quote.
- Whenever a person is named as responsible for something ("the advertisements are handled by Parag", "technical part is done by Manas"), that is a task owned by that person, even if they are not on the call. A sentence saying who does something is never an open question.
- assigneeName is the person who was named as doing it, matching the participant list when given; otherwise null. Never guess an owner or a due date. If a speaker's Slack user id is shown, keep it as assigneeId.
Return JSON only: {"summary":"...","decisions":[{"text":"...","quote":"..."}],"tasks":[{"title":"...","description":"","assigneeName":null,"assigneeId":null,"dueDate":null,"quote":"..."}]}.`;

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
  const huddle = /^huddle (?:notes|transcript)\b:?\s*(.*)$/i.exec(t);
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

/** Public channels are visible to every member; private-channel and DM records require membership; extension uploads belong to their uploader. */
const readable = (actor: Actor) => admin(actor)
  ? sql`${channels.isIm} is not true` // admins see public + private channel meetings and extension uploads, never a DM huddle
  : or(eq(meetings.ownerId, actor.userId), and(eq(channels.isPrivate, false), eq(channels.isIm, false)), eq(channelMembers.userId, actor.userId));

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
  return { ...meeting, title: cleanTitle(meeting.title, channelName, meeting.endedAt), decisions: asStrings(meeting.decisions), tasks: withDelivery, participantIds: asStrings(meeting.participantIds) };
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

/**
 * Feeds a finished meeting into memory via the public captureTurn (facts) + recordEpisode in the channel's write scope: public -> shared,
 * private -> channel_X. An unknown channel is treated as private (never widens). Best effort: memory failure never fails the meeting.
 */
export async function rememberMeeting(a: { channelId: string; fileId: string; title: string; summary: string; label?: string; scope?: SlackScope; tasks: { title: string; assigneeName?: string | null; dueDate?: string | null }[] }): Promise<void> {
  try {
    const [ch] = a.scope ? [] : await db.select({ isPrivate: channels.isPrivate, isIm: channels.isIm }).from(channels).where(eq(channels.id, a.channelId));
    const scope = a.scope ?? { channelId: a.channelId, isPrivate: ch ? ch.isPrivate : true, isIm: ch?.isIm ?? false, userId: null };
    const tasks = a.tasks.map((t) => `- ${t.title}${t.assigneeName ? ` (owner: ${t.assigneeName})` : ""}${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("\n");
    // tasks are commitments made in the meeting; their live status is not stored here
    const transcript = `${a.label ?? "Slack Huddle"} "${a.title}"\n\n${a.summary}${tasks ? `\n\nAction items agreed:\n${tasks}` : ""}`;
    await captureTurn({ scope, transcript, sourceRef: `meeting:${a.fileId}`, createdBy: "bot" });
    await recordEpisode({ scope, channelId: a.channelId, threadTs: `huddle_${a.fileId}`, transcript });
  } catch (err) {
    log.warn("meeting memory write failed", { fileId: a.fileId, error: err instanceof Error ? err.message : String(err) });
  }
}

const MAX_CANVAS_BYTES = 2 * 1024 * 1024;
export const MAX_HUDDLE_IMPORTS = 20;
let syncing: Promise<HuddleSyncResult> | null = null;
const SLACK_HOST = /(^|\.)(slack\.com|slack-files\.com|slack-edge\.com)$/i;

/** files.info that reports a missing OAuth scope clearly (which scope is needed) instead of a generic failure. */
async function fileInfo(client: Awaited<ReturnType<typeof slackClient>>, file: string): Promise<HuddleFile | undefined> {
  try {
    return (await client.files.info({ file })).file as HuddleFile | undefined;
  } catch (err) {
    const data = (err as { data?: { error?: string; needed?: string; provided?: string } }).data;
    if (data?.error === "missing_scope") {
      log.error("slack files.info missing scope: add the needed scope to the app and reinstall", { fileId: file, needed: data.needed ?? "files:read", provided: data.provided });
      throw new Error(`Slack app is missing the "${data.needed ?? "files:read"}" scope (needed to read Huddle notes); add it and reinstall`);
    }
    throw err;
  }
}

/**
 * Huddle notes/transcripts are Slack canvases (quip files) with no inline lines: their content is only reachable through
 * url_private(_download) with the bot token. Only Slack hosts are contacted; redirects are followed manually so the token
 * never leaves Slack. Returns plain text (speakers/timestamps stay as the canvas lays them out), or null.
 */
async function downloadedText(client: Awaited<ReturnType<typeof slackClient>>, file: HuddleFile): Promise<{ text: string } | null> {
  let url: string | undefined = typeof file.url_private_download === "string" ? file.url_private_download : typeof file.url_private === "string" ? file.url_private : undefined;
  const token = (client as unknown as { token?: string }).token;
  if (!url || !token) return null;
  for (let hop = 0; hop < 5; hop++) {
    const u: URL = new URL(url);
    if (u.protocol !== "https:" || !SLACK_HOST.test(u.hostname)) throw new Error(`refusing to fetch canvas from non-Slack host ${u.hostname}`);
    const res: Response = await fetch(u, { headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = new URL(res.headers.get("location")!, u).toString(); continue; }
    if (!res.ok) throw new Error(`canvas download ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_CANVAS_BYTES) throw new Error("canvas too large");
    const body = new TextDecoder().decode(buf);
    const text = (/html|xml/i.test(res.headers.get("content-type") ?? "") || /^\s*</.test(body) ? htmlToText(body) : body).replace(/\n{3,}/g, "\n\n").trim();
    return text ? { text } : null;
  }
  throw new Error("too many redirects fetching canvas");
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

async function analyze(sourceFileId: string, text: string, participants: string[] = [], background = ""): Promise<void> {
  try {
    const header = `${participants.length ? `Participants: ${participants.join(", ")}\n\n` : ""}${background ? `Background (earlier team knowledge; see the rules above):\n${background}\n\n` : ""}`;
    const raw = await completeJson({ system: SUMMARY_SYSTEM, prompt: header + text.slice(-MAX_SOURCE_CHARS), role: "main", maxOutputTokens: 2_400 }, analysisSchema);
    // Keep only what the text itself supports; an unsupported item is dropped, never "fixed".
    const src = makeSource(text);
    const firstOfEach = <T,>(items: T[], title: (t: T) => string) => items.filter((it, i) => !items.slice(0, i).some((o) => similar(title(o), title(it))));
    const decisions = firstOfEach(raw.decisions.filter((d) => quoteSupported(src, d.quote)), (d) => d.text).map((d) => d.text);
    const found: NewMeetingTask[] = firstOfEach(raw.tasks.filter((k) => quoteSupported(src, k.quote)), (k) => k.title).map(({ quote, ...k }) => ({
      ...k, assigneeName: verifiedOwner(src, participants, k.assigneeName),
      description: [k.description, `Said: “${quote}”`].filter(Boolean).join("\n"),
    }));
    const dropped = raw.decisions.length + raw.tasks.length - decisions.length - found.length; // unsupported or repeated
    if (dropped) log.warn("meeting items dropped: quote not found in the source", { fileId: sourceFileId, dropped });
    const [meeting] = await db.select({ id: meetings.id, tasks: meetings.tasks }).from(meetings).where(eq(meetings.sourceFileId, sourceFileId)).limit(1);
    if (!meeting) return;
    const tasks = assignTaskIds(meeting.id, found, meeting.tasks);
    await db.update(meetings).set({ summary: raw.summary, decisions, tasks, status: "ready", updatedAt: new Date() }).where(eq(meetings.id, meeting.id));
    const [saved] = await db.select({ channelId: meetings.channelId, title: meetings.title }).from(meetings).where(eq(meetings.id, meeting.id)).limit(1);
    if (saved && !saved.channelId.startsWith("ext_")) await rememberMeeting({ channelId: saved.channelId, fileId: sourceFileId, title: saved.title, summary: raw.summary, tasks: found });
    // Extension meetings are remembered too, but only for the person who held them (their private scope), so they can ask about them later.
    else if (saved) await rememberMeeting({ channelId: saved.channelId, fileId: sourceFileId, title: saved.title, label: "Meeting", scope: personScope(saved.channelId.slice(4)),
      summary: decisions.length ? `${raw.summary}\n\nDecisions:\n${decisions.map((d) => `- ${d}`).join("\n")}` : raw.summary, tasks: found });
  } catch (err) {
    await db.update(meetings).set({ status: "failed", updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
    log.warn("meeting summary failed", { fileId: sourceFileId, error: err instanceof Error ? err.message : String(err) });
  }
}

const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
function similar(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n) >= 0.6;
}

/** Adds what the user approved in the side panel to the AI's final pass; the user's wording wins over near-duplicates. */
async function mergeUserNotes(sourceFileId: string, t: ExtensionTranscript): Promise<void> {
  const [row] = await db.select({ id: meetings.id, summary: meetings.summary, tasks: meetings.tasks, decisions: meetings.decisions, status: meetings.status }).from(meetings).where(eq(meetings.sourceFileId, sourceFileId));
  if (!row) return;
  // An owner picked in the panel from the suggestions carries a Slack user id; only real, active people are linked.
  const ids = [...new Set((t.tasks ?? []).map((k) => k.assigneeId).filter((v): v is string => !!v))];
  const real = new Map((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, ids), eq(users.deactivated, false), eq(users.isBot, false))) : []).map((u) => [u.id, u.name]));
  const mine: NewMeetingTask[] = (t.tasks ?? []).map((k) => ({
    title: k.title, description: k.done ? "Marked done during the call." : "",
    assigneeName: (k.assigneeId && real.get(k.assigneeId)) || k.assignee?.trim() || null, assigneeId: k.assigneeId && real.has(k.assigneeId) ? k.assigneeId : null, dueDate: k.due?.trim() || null,
  }));
  const existing = asTasks(row.id, row.tasks);
  const fresh: NewMeetingTask[] = [...mine, ...existing.filter((k) => !mine.some((m) => similar(m.title, k.title))).map(({ id: _id, notification: _notification, ...task }) => task)];
  const tasks = assignTaskIds(row.id, fresh, existing);
  const myDecisions = t.decisions ?? [];
  const decisions = [...myDecisions, ...asStrings(row.decisions).filter((d) => !myDecisions.some((m) => similar(m, d)))];
  await db.update(meetings).set({ tasks, decisions, status: row.summary || decisions.length || tasks.length ? "ready" : row.status, updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
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
  /** Display names of everyone seen on the call, so the final pass names owners correctly. */
  participants?: string[];
  tasks?: { title: string; assignee?: string; assigneeId?: string; due?: string; done?: boolean }[];
};

/** Stores a transcript captured by the browser extension and summarizes it. Private to its uploader (and admins). */
export async function ingestExtensionTranscript(userId: string, t: ExtensionTranscript): Promise<{ id: string; done: Promise<void> }> {
  const text = t.lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join("\n");
  // Namespaced by user so one person's id can never overwrite another's record.
  const sourceFileId = `ext:${userId}:${t.platform}:${t.externalId}`;
  const base = {
    channelId: `ext_${userId}`, platform: t.platform, ownerId: userId, title: t.title, transcript: text, participantIds: (t.participants ?? []).slice(0, 100),
    startedAt: t.startedAt ?? null, endedAt: t.endedAt ?? new Date(), updatedAt: new Date(),
  };
  const [row] = await db.insert(meetings).values({ id: newId("mt_"), sourceFileId, threadTs: null, ...base, status: "processing", tasks: [] })
    .onConflictDoUpdate({ target: meetings.sourceFileId, set: { ...base, status: "processing", summary: null, decisions: [], tasks: [] } })
    .returning({ id: meetings.id });
  // The upload is saved; the model reads the whole transcript afterwards so the request returns at once.
  // No task DMs go out from here: a model's guess at an owner must not message a real person. Use "Send task DMs" on the page.
  const done = recallForMeeting(userId, `${t.title}\n${(t.participants ?? []).join(", ")}\n${text.slice(0, 300)}`, { budgetTokens: 1_500 })
    .then((mem) => analyze(sourceFileId, text, t.participants ?? [], mem.text))
    .then(() => (t.decisions?.length || t.tasks?.length ? mergeUserNotes(sourceFileId, t) : undefined))
    .catch((err) => log.warn("meeting finalize failed", { fileId: sourceFileId, error: String(err) }));
  return { id: row!.id, done };
}

/** Ingests a Huddle transcript exposed by Slack's files API (inline lines, or the canvas download). Other files are ignored. */
export async function ingestHuddleFile(fileId: string, hintedChannelId?: string): Promise<boolean> {
  const client = await slackClient();
  let file = await fileInfo(client, fileId);
  if (!file) return false;
  const notes = file;
  let parsed: ReturnType<typeof transcriptText> = transcriptText(file);
  if (!parsed) parsed = await huddleCanvasText(client, file);
  // A Huddle notes canvas may point to a distinct transcript file.
  if (!parsed && typeof file.huddle_transcript_file_id === "string") {
    file = await fileInfo(client, file.huddle_transcript_file_id);
    if (!file) return false;
    parsed = transcriptText(file);
  }
  if (!parsed) {
    const dl = await downloadedText(client, file) ?? (file !== notes ? await downloadedText(client, notes) : null);
    if (!dl) return false;
    const date = (n: unknown) => typeof n === "number" ? new Date(n * 1000) : undefined;
    parsed = { text: dl.text, participantIds: asStrings(notes.huddle_participant_ids), startedAt: date(notes.huddle_date_start), endedAt: date(notes.huddle_date_end) };
  }
  // Slack's own record of where the file lives wins over the caller's hint (a hint comes from whoever posted the message)
  const channelId = parsed.channelId ?? (Array.isArray(file.channels) ? file.channels[0] : undefined) ?? (Array.isArray(notes.channels) ? notes.channels[0] : undefined) ?? hintedChannelId;
  if (!channelId) return false;
  const [known] = await db.select({ bot: channels.botIsMember }).from(channels).where(eq(channels.id, channelId));
  if (!known?.bot) { log.warn("huddle skipped: bot is not in the channel", { channelId }); return false; }
  const sourceFileId = String(file.id ?? fileId);
  const title = typeof file.title === "string" && file.title.trim() ? file.title.trim() : "Slack Huddle";
  const base = {
    channelId, title, transcript: parsed.text, participantIds: parsed.participantIds,
    startedAt: parsed.startedAt ?? null, endedAt: parsed.endedAt ?? new Date(), updatedAt: new Date(),
  };
  await db.insert(meetings).values({ id: newId("mt_"), sourceFileId, threadTs: null, ...base, status: "processing", tasks: [] })
    .onConflictDoUpdate({ target: meetings.sourceFileId, set: { ...base, channelId: sql`${meetings.channelId}`, status: "processing", summary: null, tasks: [] } }); // a re-import never moves a meeting to another channel
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
export function syncRecentHuddles(opts: { force?: boolean; maxPages?: number } = {}): Promise<HuddleSyncResult> {
  // single flight: concurrent callers share one run (each import is an LLM call)
  syncing ??= syncHuddles(opts).finally(() => { syncing = null; });
  return syncing;
}

async function syncHuddles(opts: { force?: boolean; maxPages?: number }): Promise<HuddleSyncResult> {
  const client = await slackClient();
  const files: HuddleFile[] = [];
  // files.list is page-numbered, newest first; walk every page (capped) so older huddles are found too
  for (let page = 1, pages = 1; page <= Math.min(pages, opts.maxPages ?? 50); page++) {
    const r = await client.files.list({ count: 100, page });
    files.push(...((r.files ?? []) as HuddleFile[]));
    pages = r.paging?.pages ?? 1;
  }
  const candidates = files.filter((file) => Boolean(file.is_huddle_canvas || file.huddle_transcription || file.huddle_transcript_file_id));
  const done = new Set(opts.force ? [] : (await db.select({ id: meetings.sourceFileId }).from(meetings).where(eq(meetings.status, "ready"))).map((r) => r.id));
  let imported = 0;
  let failed = 0;
  for (const file of candidates) {
    if (imported + failed >= MAX_HUDDLE_IMPORTS) break; // the rest is picked up by the next call
    if (typeof file.id !== "string" || done.has(file.id) || (typeof file.huddle_transcript_file_id === "string" && done.has(file.huddle_transcript_file_id))) continue; // rows are keyed by the transcript file when notes point to one
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

/** The extension acts for one signed-in person, so it reads memory as a DM with them: shared, their own DMs, and private channels they belong to. */
export const personScope = (userId: string): SlackScope => ({ channelId: `ext_${userId}`, isPrivate: false, isIm: true, userId });

/** Slack stores people as <@U123ABC>; turn those into names so neither the model nor the reader sees raw ids. */
async function withNames(texts: string[]): Promise<(t: string) => string> {
  const ids = [...new Set(texts.flatMap((t) => [...t.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!)))];
  const names = new Map(ids.length ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
  return (t) => t.replace(/<@([A-Z0-9_]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `@${names.get(id) || label || "a teammate"}`);
}

export type MemorySource = { text: string; source: string; date: string; url?: string };
/** What the team already knows (Slack and Brain memory) that this person may read, with its sources. Never throws: no memory just means no background. */
export async function recallForMeeting(userId: string, query: string, opts: { rewrite?: boolean; budgetTokens?: number; sourceChars?: number } = {}): Promise<{ text: string; sources: MemorySource[] }> {
  try {
    const r = await buildRecall({ scope: personScope(userId), query, budgetTokens: opts.budgetTokens ?? 1_800, rewrite: opts.rewrite ?? false });
    const name = await withNames([r.text, ...r.hits.map((h) => h.text)]);
    return {
      text: name(r.text),
      sources: r.hits.slice(0, 8).map((h) => ({ text: name(h.text).slice(0, opts.sourceChars ?? 240), source: h.source, date: (h.validAt ?? h.createdAt).toISOString().slice(0, 10), ...(h.permalink && /^https?:\/\//.test(h.permalink) ? { url: h.permalink } : {}) })),
    };
  } catch (err) {
    log.warn("meeting memory recall failed", { error: err instanceof Error ? err.message : String(err) });
    return { text: "", sources: [] };
  }
}

const LIVE_ASK_SYSTEM = `You are a meeting assistant sitting in on a live call. Answer the user's question using only the transcript and the meeting context provided.
"I", "me" and "my" in a question mean the person asking (named under "The person asking"): if they ask who they are, tell them their name and what they said or did in this meeting, when the transcript shows it. For what is happening in THIS meeting, the transcript is the truth. For questions about earlier conversations, decisions, people or projects, use the team memory block when one is given and say it comes from memory, with its date; if the transcript and memory disagree about this meeting, the transcript wins.
Be brief and concrete, name people when relevant, and say plainly when neither the transcript nor memory covers the question. Never invent facts, owners or dates.`;

const LIVE_ANALYZE_SYSTEM = `You read the WHOLE transcript of a meeting and flag items for a human to approve. Transcript lines are numbered like [12]. Use only what is written there; never outside knowledge or what such a meeting "usually" covers.
The transcript is usually automatic speech recognition: words can be wrong, punctuation is unreliable, sentences are cut at random points, names may be lowercase or misspelled. Read for meaning across the broken sentences and write names with normal capitalisation.
Return decisions that were actually made (a choice made or agreed; a speaker describing hopes or intentions is not one), tasks someone took on or was assigned, and open questions nobody has answered yet.
A sentence saying who does something ("the advertisements are handled by Parag") is a task owned by that person, even if they are not on the call; it is never an open question.
For each item:
- "kind": "task" | "decision" | "question".
- "label": "confirmed" (a clear commitment or final decision), "tentative" (maybe/likely/"I'll try"), or "suggestion" (proposed, nobody agreed). Questions use "suggestion".
- "reason": one short sentence saying why you classified it that way.
- "quote": words copied exactly from the transcript that support it. No quote, no item.
- "evidence": the line numbers that support it.
- "assignee": the one person the transcript names as responsible, spelled as in the roster when they are in it; otherwise null. Never guess an owner.
- "due": an ISO date (YYYY-MM-DD) when a date was said and can be resolved from the meeting's start time (for example "next Friday"); otherwise the words that were said; otherwise null. Never invent a date.
Do not repeat anything listed under "Already tracked". Return JSON only: {"items":[{"kind":"task","label":"confirmed","title":"...","reason":"...","quote":"...","evidence":[3],"assignee":null,"due":null}]}.`;

const liveAnalysisSchema = z.object({
  items: z.array(z.object({
    kind: z.enum(["task", "decision", "question"]),
    label: z.enum(["confirmed", "tentative", "suggestion"]).default("tentative"),
    title: z.string().trim().min(1).max(300),
    reason: z.string().trim().max(300).default(""),
    quote: z.string().trim().max(600).default(""),
    evidence: z.array(z.number().int().min(1)).max(6).default([]),
    assignee: z.string().trim().min(1).max(120).nullable().default(null),
    due: z.string().trim().min(1).max(60).nullable().default(null),
  })).max(40),
});

export type LiveLine = { speaker: string; text: string };
export type LiveContext = { title?: string; startedAt?: string; roster?: string[]; /** the person using the assistant, so "me", "I" and "who am I" can be answered */ me?: string };

/** Numbered transcript, keeping the most recent ~50k characters and the original numbering. */
function numbered(lines: LiveLine[]): string {
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    const row = `[${i + 1}] ${l.speaker ? `${l.speaker}: ` : ""}${l.text}`;
    if (size + row.length > MAX_SOURCE_CHARS) break;
    out.push(row); size += row.length + 1;
  }
  return out.reverse().join("\n");
}

function contextBlock(ctx: LiveContext): string {
  const start = ctx.startedAt ? new Date(ctx.startedAt) : null;
  const when = start && !Number.isNaN(start.getTime())
    ? `${start.toISOString()} (${start.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} UTC)` : "unknown";
  return [`Meeting: ${ctx.title ?? "untitled"}`, `Started: ${when}`, `Roster: ${(ctx.roster ?? []).join(", ") || "unknown"}`, ...(ctx.me ? [`The person asking: ${ctx.me}`] : [])].join("\n");
}

/** Answers a question about an in-progress call. Nothing is stored. */
export async function askLiveMeeting(lines: LiveLine[], question: string, history: { role: "user" | "assistant"; text: string }[] = [], ctx: LiveContext & { notes?: string } = {}, memory = ""): Promise<string> {
  const convo = history.slice(-6).map((h) => `${h.role === "user" ? "Q" : "A"}: ${h.text}`).join("\n");
  const prompt = `${contextBlock(ctx)}\n${memory ? `Team memory (earlier than this meeting; each line has its source and date):\n${memory}\n` : ""}${ctx.notes ? `Tracked so far:\n${ctx.notes.slice(0, 4_000)}\n` : ""}\nTranscript so far:\n${numbered(lines)}\n\n${convo ? `Earlier in this chat:\n${convo}\n\n` : ""}Question: ${question}`;
  return (await completeText({ system: LIVE_ASK_SYSTEM, prompt, role: "main", maxOutputTokens: 700 })).trim();
}

/** Extracts classified, evidenced decisions/tasks/questions from an in-progress call. Nothing is stored. */
export async function analyzeLiveMeeting(lines: LiveLine[], ctx: LiveContext, known: string[] = [], background = "") {
  const tracked = known.length ? `\nAlready tracked:\n${known.slice(0, 100).map((k) => `- ${k}`).join("\n")}\n` : "";
  const prompt = `${contextBlock(ctx)}\n${background ? `Background (earlier team knowledge: use ONLY to understand names, projects and references; never make an item from it):\n${background}\n` : ""}${tracked}\nTranscript so far:\n${numbered(lines)}`;
  const out = await completeJson({ system: LIVE_ANALYZE_SYSTEM, prompt, role: "main", maxOutputTokens: 1_800 }, liveAnalysisSchema);
  // Keep only items whose quote is really in the transcript, evidence that points at a real line, and owners from the roster.
  const src = makeSource(lines.map((l) => `${l.speaker}: ${l.text}`).join("\n"));
  const roster = ctx.roster ?? [];
  return { items: out.items.filter((i) => quoteSupported(src, i.quote)).map(({ quote, ...i }) => ({ ...i, evidence: i.evidence.filter((n) => n <= lines.length), assignee: verifiedOwner(src, roster, i.assignee) })) };
}

const LIVE_NOTES_SYSTEM = `You keep running notes for a live meeting. You get the previous notes and the transcript lines added since (numbered like [12]).
Return the updated notes in Markdown, replacing the old ones: keep what is still true, fold in the new lines, drop nothing that matters.
Write ONLY "## Topics" (short bullets of what is being discussed, in the order it came up) and, if something was asked and not answered, "## Open questions". Plain words, no more than about 200 words.
Do NOT list decisions, tasks, action items or owners: those are produced once, at the end, from the whole transcript.
Use only the transcript. Never add anything that was not said. Output the notes only, no preamble.`;

/** Rolls the previous live notes forward with the lines added since. `offset` is how many lines came before `lines`. */
export async function updateLiveNotes(lines: LiveLine[], offset: number, previous: string, ctx: LiveContext): Promise<string> {
  const fresh = lines.map((l, i) => `[${offset + i + 1}] ${l.speaker ? `${l.speaker}: ` : ""}${l.text}`).join("\n").slice(-40_000);
  const prompt = `${contextBlock(ctx)}\n\nPrevious notes:\n${previous.trim() || "(none yet)"}\n\nNew transcript lines:\n${fresh}`;
  return (await completeText({ system: LIVE_NOTES_SYSTEM, prompt, role: "summarize", maxOutputTokens: 900 })).trim();
}

/** What the extension shows after the final pass: only the uploader's own meeting. */
export async function getOwnExtensionMeeting(userId: string, id: string) {
  const [row] = await db.select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.ownerId, userId)));
  return row ? { id: row.id, title: row.title, status: row.status, summary: row.summary, decisions: asStrings(row.decisions), tasks: asTasks(row.id, row.tasks) } : null;
}
