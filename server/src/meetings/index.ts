import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channelMembers, channels, commitments, meetings, meetingTaskNotifications, users } from "../db/schema";
import { log } from "../log";
import { completeJson, completeText } from "../memory/llm";
import { htmlToText } from "../memory/ingest";
import { recordEpisode } from "../memory/episodes";
import { captureTurn } from "../memory/writeback";
import { buildRecall } from "../memory/recall";
import type { SlackScope } from "../memory/scope";
import { slackClient } from "../slack/client";
import { analyzeMeeting, rosterFor } from "./analyze";
import { asItems, counts, emptyAmbiguity, jaccard, normalizeDue, similar, type MeetingItem } from "./items";
import { linesToText, MAX_BODY_BYTES, numberedLines, parseTranscript, type Format, type Line } from "./parse";
import { resolveOwner } from "./owner";
import { retryFailedRecaps, sendMeetingRecaps } from "./recap";
import { canReview, getApprovalMode, getAutoThreshold, noAuto, queueRecaps, syncMeetingTasks } from "./tasks";
import { makeSource, quoteSupported, verifiedOwner } from "./verify";

export { cleanTitle } from "./title";
export { meetingUrl, slackText } from "./urls";
export { asItems, type MeetingItem, type MeetingTask } from "./items";
export { handleMeetingTaskAction, sendMeetingRecaps } from "./recap";
export { updateMeetingTaskAssignee } from "./tasks";
export const resolveAssignee = (t: { assigneeId?: string | null; assigneeName?: string | null }) => resolveOwner(t).then((r) => r.user);
/** Older name: sends the recap DMs (one per person). */
export const sendMeetingTaskDms = sendMeetingRecaps;
export { similar };
import { cleanTitle } from "./title";
import { meetingUrl } from "./urls";

type Actor = { userId: string; role: "owner" | "admin" | "member" };
type HuddleFile = Record<string, any>;
type HuddleSyncResult = { found: number; imported: number; failed: number };

/** The whole meeting is read, not a tail: 400k characters is roughly a three-hour call (long ones are analysed in overlapping chunks). */
export const MAX_SOURCE_CHARS = 400_000;

const admin = (a: Actor) => a.role === "owner" || a.role === "admin";
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

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

/** Meeting list: no raw transcript. Rows carry items, counts, status and failedReason. */
export async function listMeetings(actor: Actor) {
  const rows = await rowsFor(actor);
  const mode = await getApprovalMode(), autoConfidence = await getAutoThreshold();
  return Promise.all(rows.map(({ meeting: { transcript: _transcript, ...meeting }, channelName }) => presentMeeting(meeting, channelName, { mode, autoConfidence, actor })));
}

export async function getMeeting(id: string, actor: Actor) {
  const rows = await rowsFor(actor);
  const found = rows.find((r) => r.meeting.id === id);
  if (!found) return null;
  const { transcript, ...row } = found.meeting;
  return presentMeeting(row, found.channelName, { mode: await getApprovalMode(), autoConfidence: await getAutoThreshold(), actor, lines: transcript?.trim() ? numberedLines(transcript) : null });
}

type NotifStatus = "pending" | "sent" | "acknowledged" | "declined" | "failed" | "skipped";
async function presentMeeting(meeting: Omit<typeof meetings.$inferSelect, "transcript">, channelName: string | null | undefined, o: { mode: string; autoConfidence: number; actor: Actor; lines?: { n: number; speaker: string; text: string }[] | null }) {
  const items = asItems(meeting.id, meeting.tasks);
  const rows = items.length ? await db.select().from(meetingTaskNotifications).where(eq(meetingTaskNotifications.meetingId, meeting.id)) : [];
  const cms = items.length ? await db.select({ id: commitments.id, status: commitments.status, ref: commitments.sourceRef }).from(commitments).where(sql`${commitments.sourceRef} like ${`meeting:${meeting.id}:%`}`) : [];
  const cmByItem = new Map(cms.map((c) => [c.ref.split(":")[2]!, c]));
  const quiet = noAuto(meeting);
  const presented = items.map((item) => {
    const approval = item.approval ?? "proposed";
    const row = rows.find((r) => r.taskId === item.id && (item.assigneeId ? r.recipientUserId === item.assigneeId : true)) ?? rows.find((r) => r.taskId === item.id);
    let notification: { status: NotifStatus; error: string | null; sentAt: string | null } | null = null;
    if (row) notification = { status: row.status as NotifStatus, error: row.status === "failed" ? row.error : null, sentAt: row.sentAt?.toISOString() ?? null };
    else if (item.itemType === "task" && approval === "approved") notification = { status: quiet ? "skipped" : item.assigneeId ? "pending" : "skipped", error: null, sentAt: null };
    const cm = cmByItem.get(item.id);
    return { ...item, approval, commitmentId: item.commitmentId ?? cm?.id ?? null, commitmentStatus: cm?.status ?? null, notification, approvedBy: item.approvedBy ?? null, approvedAt: item.approvedAt ?? null };
  });
  return {
    ...meeting, title: cleanTitle(meeting.title, channelName, meeting.endedAt), decisions: presented.filter((i) => i.itemType === "decision" && i.approval !== "rejected" && !i.unverified).map((i) => i.title),
    tasks: presented, items: presented, counts: counts(presented), mode: o.mode, autoConfidence: o.autoConfidence, canApprove: canReview(meeting, o.actor), participantIds: asStrings(meeting.participantIds), failedReason: meeting.failedReason ?? null,
    ...(o.lines !== undefined ? { lines: o.lines, transcript: o.lines ? o.lines.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join("\n") : "" } : {}),
  };
}

export async function meetingAssigneeCandidates(q: string) {
  const needle = q.trim().toLowerCase();
  const rows = await db.select({ id: users.id, name: users.name, avatarUrl: users.avatarUrl }).from(users)
    .where(and(eq(users.deactivated, false), eq(users.isBot, false))).orderBy(users.name);
  return rows.filter((u) => !needle || (u.name ?? "").toLowerCase().includes(needle)).slice(0, 20);
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


/**
 * Feeds a finished meeting into memory via the public captureTurn (facts) + recordEpisode in the channel's write scope: public -> shared,
 * private -> channel_X. An unknown channel is treated as private (never widens). Only APPROVED tasks and decisions are listed; one episode
 * per meeting (a re-analysis replaces it). Best effort: memory failure never fails the meeting.
 */
export async function rememberMeeting(a: { channelId: string; fileId: string; title: string; summary: string; label?: string; scope?: SlackScope; tasks: { title: string; assigneeName?: string | null; dueDate?: string | null }[]; decisions?: string[]; permalink?: string }): Promise<void> {
  try {
    const [ch] = a.scope ? [] : await db.select({ isPrivate: channels.isPrivate, isIm: channels.isIm }).from(channels).where(eq(channels.id, a.channelId));
    const scope = a.scope ?? { channelId: a.channelId, isPrivate: ch ? ch.isPrivate : true, isIm: ch?.isIm ?? false, userId: null };
    const tasks = a.tasks.map((t) => `- ${t.title}${t.assigneeName ? ` (owner: ${t.assigneeName})` : ""}${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("\n");
    const decisions = (a.decisions ?? []).map((d) => `- ${d}`).join("\n");
    const transcript = `${a.label ?? "Slack Huddle"} "${a.title}"\n\n${a.summary}${decisions ? `\n\nDecisions:\n${decisions}` : ""}${tasks ? `\n\nAction items agreed:\n${tasks}` : ""}`;
    await captureTurn({ scope, transcript, sourceRef: `meeting:${a.fileId}`, createdBy: "bot" });
    await recordEpisode({ scope, channelId: a.channelId, threadTs: `huddle_${a.fileId}`, transcript, permalink: a.permalink });
  } catch (err) {
    log.warn("meeting memory write failed", { fileId: a.fileId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * After a successful analysis: items -> tasks (approval gate), summary + approved decisions + approved tasks -> memory, then the recap DMs
 * (detached; never for extension / web uploads, which only DM when the uploader presses "Send task DMs").
 */
export async function finalizeMeeting(meetingId: string, o: { notify: boolean }): Promise<void> {
  await syncMeetingTasks(meetingId);
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!m?.summary) return;
  const items = asItems(m.id, m.tasks).filter((i) => i.approval === "approved");
  const ext = m.channelId.startsWith("ext_");
  await rememberMeeting({
    channelId: m.channelId, fileId: m.sourceFileId, title: cleanTitle(m.title, null, m.endedAt), summary: m.summary, permalink: meetingUrl(m.id),
    ...(ext ? { label: "Meeting", scope: personScope(m.channelId.slice(4)) } : m.platform !== "slack" ? { label: "Meeting" } : {}),
    tasks: items.filter((i) => i.itemType === "task"), decisions: items.filter((i) => i.itemType === "decision").map((i) => i.title),
  });
  if (o.notify && !noAuto(m)) queueRecaps(m.id);
}

/** analysis -> (the uploader's own notes) -> tasks, memory and DMs. Returns true when the notes are ready. */
export async function processMeeting(meetingId: string, o: { background?: string; notify?: boolean; user?: { id: string; notes: ExtensionTranscript } } = {}): Promise<boolean> {
  const ok = await analyzeMeeting(meetingId, { background: o.background });
  const hasNotes = !!(o.user && (o.user.notes.decisions?.length || o.user.notes.tasks?.length));
  if (!ok && !hasNotes) return false; // what the person approved in the side panel survives a failed AI pass
  try {
    if (o.user && hasNotes) await mergeUserNotes(meetingId, o.user.id, o.user.notes);
    await finalizeMeeting(meetingId, { notify: o.notify ?? false });
  } catch (err) {
    log.warn("meeting finalize failed", { meetingId, error: err instanceof Error ? err.message : String(err) });
  }
  return ok || hasNotes;
}

/** Adds what the user approved in the side panel to the AI's final pass: their wording wins over near-duplicates, and their items arrive approved. */
async function mergeUserNotes(meetingId: string, userId: string, t: ExtensionTranscript): Promise<void> {
  const [row] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (!row) return;
  const ai = asItems(row.id, row.tasks);
  const ids = [...new Set((t.tasks ?? []).map((k) => k.assigneeId).filter((v): v is string => !!v))];
  const real = new Map((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(and(inArray(users.id, ids), eq(users.deactivated, false), eq(users.isBot, false))) : []).map((u) => [u.id, u.name]));
  const ref = row.endedAt ?? row.createdAt;
  const at = new Date().toISOString();
  const used = new Set<string>();
  const mine = (itemType: "task" | "decision", title: string, extra: Partial<MeetingItem> = {}): MeetingItem => {
    const match = ai.find((a) => !used.has(a.id) && a.itemType === itemType && similar(a.title, title));
    if (match) used.add(match.id);
    return {
      id: match?.id ?? newId(itemType === "task" ? "mtask_" : "mdec_"), itemType, title, description: "", assigneeId: null, assigneeName: null, dueDate: null, priority: "normal",
      kind: "commitment", label: "confirmed", confidence: 1, reason: "Approved by the uploader during the call.", quote: match?.quote ?? "", evidence: match?.evidence ?? [],
      unverified: false, followUp: false, approval: "approved", approvedBy: userId, approvedAt: at, ambiguity: emptyAmbiguity(), commitmentId: match?.commitmentId ?? null, externalRefs: match?.externalRefs ?? [], ...extra,
    };
  };
  const tasks = (t.tasks ?? []).map((k) => {
    const iso = normalizeDue(k.due, ref);
    const id = k.assigneeId && real.has(k.assigneeId) ? k.assigneeId : null;
    return mine("task", k.title, { description: k.done ? "Marked done during the call." : "", assigneeId: id, assigneeName: (id && real.get(id)) || k.assignee?.trim() || null, dueDate: iso, dueText: !iso && k.due?.trim() ? k.due.trim() : null });
  });
  const decisions = (t.decisions ?? []).map((d) => mine("decision", d));
  const rest = ai.filter((a) => !used.has(a.id));
  await db.update(meetings).set({ status: "ready", failedReason: null, tasks: [...tasks, ...decisions, ...rest], decisions: [...decisions.map((d) => d.title), ...rest.filter((r) => r.itemType === "decision" && r.approval !== "rejected").map((r) => r.title)], updatedAt: new Date() }).where(eq(meetings.id, meetingId));
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

/** Stores a transcript captured by the browser extension and analyses it. Private to its uploader (and admins); no automatic DMs. */
export async function ingestExtensionTranscript(userId: string, t: ExtensionTranscript): Promise<{ id: string; done: Promise<void> }> {
  const text = linesToText(t.lines);
  // Namespaced by user so one person's id can never overwrite another's record.
  const sourceFileId = `ext:${userId}:${t.platform}:${t.externalId}`;
  const base = {
    channelId: `ext_${userId}`, platform: t.platform, ownerId: userId, organizerId: userId, title: t.title, transcript: text, participantIds: (t.participants ?? []).slice(0, 100),
    startedAt: t.startedAt ?? null, endedAt: t.endedAt ?? new Date(), updatedAt: new Date(),
  };
  // a re-send keeps the earlier items so ids, approvals and tasks carry over
  const [row] = await db.insert(meetings).values({ id: newId("mt_"), sourceFileId, threadTs: null, ...base, status: "processing", tasks: [] })
    .onConflictDoUpdate({ target: meetings.sourceFileId, set: { ...base, status: "processing", failedReason: null } })
    .returning({ id: meetings.id });
  // The upload is saved; the model reads the whole transcript afterwards so the request returns at once.
  const done = recallForMeeting(userId, `${t.title}\n${(t.participants ?? []).join(", ")}\n${text.slice(0, 300)}`, { budgetTokens: 1_500 })
    .then((mem) => processMeeting(row!.id, { background: mem.text, notify: false, user: { id: userId, notes: t } }))
    .then(() => undefined)
    .catch((err) => log.warn("meeting finalize failed", { fileId: sourceFileId, error: String(err) }));
  return { id: row!.id, done };
}

export class UploadError extends Error {
  constructor(readonly code: "empty" | "too_large" | "forbidden", message: string) { super(message); }
}

/**
 * A signed-in member uploads a transcript (pasted text, a file's text, or parsed lines). Private to the uploader unless `channelId` is given
 * and they are a member of it (then scoped like that channel). Analysis runs afterwards; no automatic DMs (the uploader sends them).
 */
export async function createUploadedMeeting(user: Actor, b: { title: string; text?: string; lines?: Line[]; format?: Format; platform?: string; startedAt?: Date; channelId?: string }): Promise<{ id: string; done: Promise<void> }> {
  if ((b.text?.length ?? 0) > MAX_BODY_BYTES) throw new UploadError("too_large", "The transcript is larger than 2 MB.");
  const lines = b.lines?.length ? b.lines.slice(0, 20_000) : parseTranscript(b.text ?? "", b.format ?? "auto");
  if (!lines.length) throw new UploadError("empty", "The transcript has no text.");
  let channelId = `ext_${user.userId}`;
  if (b.channelId) {
    const [ch] = await db.select({ id: channels.id, im: channels.isIm }).from(channels).where(eq(channels.id, b.channelId));
    const [mem] = await db.select({ u: channelMembers.userId }).from(channelMembers).where(and(eq(channelMembers.channelId, b.channelId), eq(channelMembers.userId, user.userId)));
    if (!ch || ch.im || !mem) throw new UploadError("forbidden", "You can only attach an upload to a channel you are a member of.");
    channelId = ch.id;
  }
  const text = linesToText(lines);
  const speakers = [...new Set(lines.map((l) => l.speaker).filter(Boolean))].slice(0, 100);
  const [row] = await db.insert(meetings).values({
    id: newId("mt_"), sourceFileId: `web:${user.userId}:${newId("up_")}`, channelId, platform: b.platform?.trim() || "web", ownerId: user.userId, organizerId: user.userId,
    title: b.title.trim().slice(0, 240) || "Meeting", transcript: text, participantIds: speakers, startedAt: b.startedAt ?? null, endedAt: new Date(), status: "processing", tasks: [],
  }).returning({ id: meetings.id });
  const done = recallForMeeting(user.userId, `${b.title}\n${speakers.join(", ")}\n${text.slice(0, 300)}`, { budgetTokens: 1_500 })
    .then((mem) => processMeeting(row!.id, { background: mem.text, notify: false })).then(() => undefined)
    .catch((err) => log.warn("uploaded meeting analysis failed", { meetingId: row!.id, error: String(err) }));
  return { id: row!.id, done };
}

/** Runs the analysis again on the stored transcript (also the retry of a failed summary). Items, approvals and tasks carry over; nothing is duplicated. */
export async function reanalyzeMeeting(meetingId: string, by: Actor, o: { onlyFailed?: boolean } = {}): Promise<{ done: Promise<void> } | null> {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!m) return null;
  const may = admin(by) || m.ownerId === by.userId || m.organizerId === by.userId;
  if (!may) throw new UploadError("forbidden", "Only the meeting's owner or an admin can run the analysis again.");
  if (o.onlyFailed && m.status !== "failed") throw new UploadError("forbidden", "Only a failed summary can be retried.");
  await db.update(meetings).set({ status: "processing", failedReason: null, updatedAt: new Date() }).where(eq(meetings.id, m.id));
  const done = (m.ownerId ? recallForMeeting(m.ownerId, `${m.title}\n${m.transcript.slice(0, 300)}`, { budgetTokens: 1_500 }) : Promise.resolve({ text: "" }))
    .then((mem) => processMeeting(m.id, { background: mem.text, notify: !noAuto(m) })).then(() => undefined)
    .catch((err) => log.warn("meeting reanalysis failed", { meetingId: m.id, error: String(err) }));
  return { done };
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
    parsed = { text: dl.text, participantIds: asStrings(notes.huddle_participant_ids), startedAt: unixDate(notes.huddle_date_start), endedAt: unixDate(notes.huddle_date_end) };
  }
  // Slack's own record of where the file lives wins over the caller's hint (a hint comes from whoever posted the message)
  const channelId = parsed.channelId ?? (Array.isArray(file.channels) ? file.channels[0] : undefined) ?? (Array.isArray(notes.channels) ? notes.channels[0] : undefined) ?? hintedChannelId;
  if (!channelId) return false;
  const [known] = await db.select({ bot: channels.botIsMember }).from(channels).where(eq(channels.id, channelId));
  if (!known?.bot) { log.warn("huddle skipped: bot is not in the channel", { channelId }); return false; }
  const sourceFileId = String(file.id ?? fileId);
  const title = typeof file.title === "string" && file.title.trim() ? file.title.trim() : "Slack Huddle";
  // who started the huddle: the first candidate that is an active person (never the bot)
  const candidates = [notes.huddle_host_id, notes.huddle_started_by, notes.huddle_organizer_id, notes.huddle_creator_id, file.huddle_host_id, notes.user, file.user].filter((v): v is string => typeof v === "string");
  const people = candidates.length ? await db.select({ id: users.id }).from(users).where(and(inArray(users.id, candidates), eq(users.isBot, false), eq(users.deactivated, false))) : [];
  const organizerId = candidates.find((c) => people.some((p) => p.id === c)) ?? null;
  const permalink = typeof notes.permalink === "string" ? notes.permalink : typeof file.permalink === "string" ? file.permalink : null;
  const base = {
    channelId, title, transcript: parsed.text, participantIds: parsed.participantIds,
    startedAt: parsed.startedAt ?? null, endedAt: parsed.endedAt ?? new Date(), updatedAt: new Date(),
  };
  // a re-import keeps the earlier items (ids, approvals, tasks carry over) and never moves a meeting to another channel
  const [saved] = await db.insert(meetings).values({ id: newId("mt_"), sourceFileId, threadTs: null, ...base, organizerId, sourceUrl: permalink, status: "processing", tasks: [] })
    .onConflictDoUpdate({ target: meetings.sourceFileId, set: { ...base, channelId: sql`${meetings.channelId}`, organizerId: organizerId ?? sql`${meetings.organizerId}`, sourceUrl: permalink ?? sql`${meetings.sourceUrl}`, status: "processing", failedReason: null } })
    .returning({ id: meetings.id });
  await processMeeting(saved!.id, { notify: true });
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
  await retryFailedRecaps().catch((err) => log.warn("recap retry failed", { error: String(err) }));
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

const liveItem = z.object({
    kind: z.enum(["task", "decision", "question"]),
    label: z.enum(["confirmed", "tentative", "suggestion"]).default("tentative"),
    title: z.string().trim().min(1).max(300),
    reason: z.string().trim().max(300).default(""),
    quote: z.string().trim().max(600).default(""),
    evidence: z.array(z.number().int().min(1)).max(6).default([]),
    assignee: z.string().trim().min(1).max(120).nullable().default(null),
    due: z.string().trim().min(1).max(60).nullable().default(null),
});
/** One malformed item (a decision or question without a title ...) is repaired from its quote or dropped; it never fails the whole analysis. */
const liveAnalysisSchema = z.object({
  items: z.array(z.unknown()).max(40).transform((arr) => arr.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const o = { ...(raw as Record<string, unknown>) };
    if (typeof o.title !== "string" || !o.title.trim()) o.title = [o.text, o.quote, o.reason].find((v) => typeof v === "string" && v.trim()) ?? "";
    if (typeof o.title === "string") o.title = o.title.trim().slice(0, 300);
    const p = liveItem.safeParse(o);
    return p.success ? [p.data] : [];
  })),
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
  return row ? { id: row.id, title: row.title, status: row.status, summary: row.summary, decisions: asStrings(row.decisions), tasks: asItems(row.id, row.tasks).filter((i) => i.itemType === "task") } : null;
}
