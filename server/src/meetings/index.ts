import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channelMembers, channels, meetings } from "../db/schema";
import { log } from "../log";
import { completeJson } from "../memory/llm";
import { htmlToText } from "../memory/ingest";
import { recordEpisode } from "../memory/episodes";
import { captureTurn } from "../memory/writeback";
import { slackClient } from "../slack/client";

export type MeetingTask = {
  title: string;
  description: string;
  assigneeName: string | null;
  assigneeId: string | null;
  dueDate: string | null;
  jiraKey?: string | null;
  jiraUrl?: string | null;
};

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

const SUMMARY_SYSTEM = `You turn a completed Slack Huddle transcript into useful meeting notes.
Use only the supplied transcript. Write a concise Markdown summary with headings for Decisions, Discussion, and Open questions when applicable.
Extract only explicit commitments as tasks. Never invent an owner or due date. If a speaker's Slack user id is shown, preserve it as assigneeId. Return JSON only: {"summary":"...","tasks":[{"title":"...","description":"...","assigneeName":null,"assigneeId":null,"dueDate":null}]}.`;

const admin = (a: Actor) => a.role === "owner" || a.role === "admin";
const asTasks = (value: unknown): MeetingTask[] => Array.isArray(value) ? value as MeetingTask[] : [];
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Public channels are visible to every member; private-channel records require membership. */
const readable = (actor: Actor) => admin(actor)
  ? undefined
  : or(eq(channels.isPrivate, false), eq(channelMembers.userId, actor.userId));

async function rowsFor(actor: Actor) {
  const q = db.select({ meeting: meetings })
    .from(meetings)
    .leftJoin(channels, eq(meetings.channelId, channels.id))
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, meetings.channelId), eq(channelMembers.userId, actor.userId)));
  const where = readable(actor);
  return where ? q.where(where).orderBy(desc(meetings.endedAt), desc(meetings.createdAt)) : q.orderBy(desc(meetings.endedAt), desc(meetings.createdAt));
}

/** Meeting list intentionally omits the raw transcript. */
export async function listMeetings(actor: Actor) {
  const rows = await rowsFor(actor);
  return rows.map(({ meeting: { transcript: _transcript, ...meeting } }) => ({ ...meeting, tasks: asTasks(meeting.tasks), participantIds: asStrings(meeting.participantIds) }));
}

export async function getMeeting(id: string, actor: Actor) {
  const rows = await rowsFor(actor);
  const row = rows.find((r) => r.meeting.id === id)?.meeting;
  return row ? { ...row, tasks: asTasks(row.tasks), participantIds: asStrings(row.participantIds) } : null;
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
  const date = (n: unknown) => typeof n === "number" ? new Date(n * 1000) : undefined;
  return {
    text,
    participantIds: asStrings(t?.participant_ids ?? file.huddle_participant_ids),
    channelId: typeof t?.channel_id === "string" ? t.channel_id : undefined,
    startedAt: date(t?.date_start ?? file.huddle_date_start),
    endedAt: date(t?.date_end ?? file.huddle_date_end),
  };
}

/**
 * Feeds a finished meeting into memory via the public captureTurn (facts) + recordEpisode in the channel's write scope: public -> shared,
 * private -> channel_X. An unknown channel is treated as private (never widens). Best effort: memory failure never fails the meeting.
 */
export async function rememberMeeting(a: { channelId: string; fileId: string; title: string; summary: string; tasks: { title: string; assigneeName?: string | null; dueDate?: string | null }[] }): Promise<void> {
  try {
    const [ch] = await db.select({ isPrivate: channels.isPrivate, isIm: channels.isIm }).from(channels).where(eq(channels.id, a.channelId));
    const scope = { channelId: a.channelId, isPrivate: ch ? ch.isPrivate : true, isIm: ch?.isIm ?? false, userId: null };
    const tasks = a.tasks.map((t) => `- ${t.title}${t.assigneeName ? ` (owner: ${t.assigneeName})` : ""}${t.dueDate ? ` (due ${t.dueDate})` : ""}`).join("\n");
    // tasks are commitments made in the meeting; their live status is not stored here
    const transcript = `Slack Huddle "${a.title}"\n\n${a.summary}${tasks ? `\n\nAction items agreed:\n${tasks}` : ""}`;
    await captureTurn({ scope, transcript, sourceRef: `meeting:${a.fileId}`, createdBy: "bot" });
    await recordEpisode({ scope, channelId: a.channelId, threadTs: `huddle_${a.fileId}`, transcript });
  } catch (err) {
    log.warn("meeting memory write failed", { fileId: a.fileId, error: err instanceof Error ? err.message : String(err) });
  }
}

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
    const body = await res.text();
    const text = (/html|xml/i.test(res.headers.get("content-type") ?? "") || /^\s*</.test(body) ? htmlToText(body) : body).replace(/\n{3,}/g, "\n\n").trim();
    return text ? { text } : null;
  }
  throw new Error("too many redirects fetching canvas");
}

/** Ingests a Huddle transcript exposed by Slack's files API (inline lines, or the canvas download). Other files are ignored. */
export async function ingestHuddleFile(fileId: string, hintedChannelId?: string): Promise<boolean> {
  const client = await slackClient();
  let file = await fileInfo(client, fileId);
  if (!file) return false;
  const notes = file;
  let parsed: ReturnType<typeof transcriptText> = transcriptText(file);
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
  const channelId = parsed.channelId ?? hintedChannelId ?? (Array.isArray(file.channels) ? file.channels[0] : undefined) ?? (Array.isArray(notes.channels) ? notes.channels[0] : undefined);
  if (!channelId) return false;
  const sourceFileId = String(file.id ?? fileId);
  const title = typeof file.title === "string" && file.title.trim() ? file.title.trim() : "Slack Huddle";
  const base = {
    channelId, title, transcript: parsed.text, participantIds: parsed.participantIds,
    startedAt: parsed.startedAt ?? null, endedAt: parsed.endedAt ?? new Date(), updatedAt: new Date(),
  };
  await db.insert(meetings).values({ id: newId("mt_"), sourceFileId, threadTs: null, ...base, status: "processing", tasks: [] })
    .onConflictDoUpdate({ target: meetings.sourceFileId, set: { ...base, status: "processing", summary: null, tasks: [] } });
  try {
    const analysis = await completeJson({ system: SUMMARY_SYSTEM, prompt: parsed.text.slice(-50_000), role: "summarize", maxOutputTokens: 1_400 }, analysisSchema);
    await db.update(meetings).set({ summary: analysis.summary, tasks: analysis.tasks, status: "ready", updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
    await rememberMeeting({ channelId, fileId: sourceFileId, title, summary: analysis.summary, tasks: analysis.tasks });
  } catch (err) {
    await db.update(meetings).set({ status: "failed", updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
    log.warn("meeting summary failed", { fileId: sourceFileId, error: err instanceof Error ? err.message : String(err) });
  }
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
