import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { channelMembers, channels, meetings } from "../db/schema";
import { log } from "../log";
import { completeJson, completeText } from "../memory/llm";
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

const SUMMARY_SYSTEM = `You turn completed meeting source material (a transcript, or Slack AI Huddle notes) into useful meeting notes.
Use only the supplied text. Write a concise Markdown summary with headings for Decisions, Discussion, and Open questions when applicable.
Extract only explicit commitments as tasks. Never invent an owner or due date. If a speaker's Slack user id is shown, preserve it as assigneeId. Return JSON only: {"summary":"...","tasks":[{"title":"...","description":"...","assigneeName":null,"assigneeId":null,"dueDate":null}]}.`;

const admin = (a: Actor) => a.role === "owner" || a.role === "admin";
const asTasks = (value: unknown): MeetingTask[] => Array.isArray(value) ? value as MeetingTask[] : [];
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Public channels are visible to every member; private-channel records require membership. */
const readable = (actor: Actor) => admin(actor)
  ? undefined
  : or(eq(meetings.ownerId, actor.userId), eq(channels.isPrivate, false), eq(channelMembers.userId, actor.userId));

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

async function analyze(sourceFileId: string, text: string): Promise<void> {
  try {
    const analysis = await completeJson({ system: SUMMARY_SYSTEM, prompt: text.slice(-50_000), role: "summarize", maxOutputTokens: 1_400 }, analysisSchema);
    await db.update(meetings).set({ summary: analysis.summary, tasks: analysis.tasks, status: "ready", updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
  } catch (err) {
    await db.update(meetings).set({ status: "failed", updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
    log.warn("meeting summary failed", { fileId: sourceFileId, error: err instanceof Error ? err.message : String(err) });
  }
}

export type ExtensionTranscript = {
  /** Stable per-call id from the extension; re-sending the same id replaces the earlier upload. */
  externalId: string;
  platform: string;
  title: string;
  lines: { speaker: string; text: string }[];
  startedAt?: Date;
  endedAt?: Date;
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

const LIVE_ASK_SYSTEM = `You are a meeting assistant sitting in on a live call. Answer the user's question using only the transcript so far.
Be brief and concrete, name speakers when relevant, and say plainly when the transcript does not cover the question. Never invent facts, owners or dates.`;

const LIVE_ANALYZE_SYSTEM = `You track a live meeting. From the transcript so far, list the decisions that were actually made and the tasks someone explicitly took on or was asked to take.
For each task set "assignee" to one of the provided speaker names only when the transcript makes the owner clear, otherwise null. Never invent an owner or due date; "due" is only what was said, as text.
Return JSON only: {"decisions":["..."],"tasks":[{"title":"...","assignee":null,"due":null}]}.`;

const liveAnalysisSchema = z.object({
  decisions: z.array(z.string().trim().min(1).max(500)).max(30),
  tasks: z.array(z.object({
    title: z.string().trim().min(1).max(240),
    assignee: z.string().trim().min(1).max(120).nullable().default(null),
    due: z.string().trim().min(1).max(60).nullable().default(null),
  })).max(40),
});

const tail = (text: string) => text.slice(-50_000);

/** Answers a question about an in-progress call. Nothing is stored. */
export async function askLiveMeeting(transcript: string, question: string, history: { role: "user" | "assistant"; text: string }[] = []): Promise<string> {
  const convo = history.slice(-6).map((h) => `${h.role === "user" ? "Q" : "A"}: ${h.text}`).join("\n");
  const prompt = `Transcript so far:\n${tail(transcript)}\n\n${convo ? `Earlier in this chat:\n${convo}\n\n` : ""}Question: ${question}`;
  return (await completeText({ system: LIVE_ASK_SYSTEM, prompt, role: "main", maxOutputTokens: 700 })).trim();
}

/** Extracts decisions and tasks from an in-progress call. Nothing is stored. */
export async function analyzeLiveMeeting(transcript: string, speakers: string[]) {
  const prompt = `Speakers: ${speakers.join(", ") || "unknown"}\n\nTranscript so far:\n${tail(transcript)}`;
  return completeJson({ system: LIVE_ANALYZE_SYSTEM, prompt, role: "summarize", maxOutputTokens: 1_200 }, liveAnalysisSchema);
}
