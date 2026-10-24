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
  decisions: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  tasks: z.array(taskSchema).max(50),
});

const SUMMARY_SYSTEM = `You turn completed meeting source material (a transcript, or Slack AI Huddle notes) into useful meeting notes.
Use only the supplied text. Write a concise Markdown summary with headings for Decisions, Discussion, and Open questions when applicable.
List every decision that was actually made in "decisions" (short sentences). Extract only explicit commitments as tasks. Never invent an owner or due date. When a participant list is given, set assigneeName to the matching participant's name. If a speaker's Slack user id is shown, preserve it as assigneeId. Return JSON only: {"summary":"...","decisions":["..."],"tasks":[{"title":"...","description":"...","assigneeName":null,"assigneeId":null,"dueDate":null}]}.`;

const admin = (a: Actor) => a.role === "owner" || a.role === "admin";
const asTasks = (value: unknown): MeetingTask[] => Array.isArray(value) ? value as MeetingTask[] : [];
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
  return rows.map(({ meeting: { transcript: _transcript, ...meeting }, channelName }) => ({ ...meeting, title: cleanTitle(meeting.title, channelName, meeting.endedAt), decisions: asStrings(meeting.decisions), tasks: asTasks(meeting.tasks), participantIds: asStrings(meeting.participantIds) }));
}

export async function getMeeting(id: string, actor: Actor) {
  const rows = await rowsFor(actor);
  const found = rows.find((r) => r.meeting.id === id);
  const row = found?.meeting;
  return row ? { ...row, title: cleanTitle(row.title, found!.channelName, row.endedAt), decisions: asStrings(row.decisions), tasks: asTasks(row.tasks), participantIds: asStrings(row.participantIds) } : null;
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

async function analyze(sourceFileId: string, text: string, participants: string[] = []): Promise<void> {
  try {
    const header = participants.length ? `Participants: ${participants.join(", ")}\n\n` : "";
    const analysis = await completeJson({ system: SUMMARY_SYSTEM, prompt: header + text.slice(-50_000), role: "summarize", maxOutputTokens: 1_800 }, analysisSchema);
    await db.update(meetings).set({ summary: analysis.summary, decisions: analysis.decisions, tasks: analysis.tasks, status: "ready", updatedAt: new Date() }).where(eq(meetings.sourceFileId, sourceFileId));
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
  const [row] = await db.select({ summary: meetings.summary, tasks: meetings.tasks, decisions: meetings.decisions, status: meetings.status }).from(meetings).where(eq(meetings.sourceFileId, sourceFileId));
  if (!row) return;
  const mine: MeetingTask[] = (t.tasks ?? []).map((k) => ({
    title: k.title, description: k.done ? "Marked done during the call." : "",
    assigneeName: k.assignee?.trim() || null, assigneeId: null, dueDate: k.due?.trim() || null,
  }));
  const tasks = [...mine, ...asTasks(row.tasks).filter((k) => !mine.some((m) => similar(m.title, k.title)))];
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
  await analyze(sourceFileId, text, t.participants ?? []);
  if (t.decisions?.length || t.tasks?.length) await mergeUserNotes(sourceFileId, t);
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

const LIVE_NOTES_SYSTEM = `You keep running notes for a live meeting. You get the previous notes and the transcript lines added since (numbered like [12]).
Return the updated notes in Markdown, replacing the old ones: keep what is still true, fold in the new lines, drop nothing that matters.
Use these sections when they have content: "## Topics", "## Decisions", "## Action items" (with the owner when it was said), "## Open questions". Short bullets, plain words, no more than about 250 words.
Use only the transcript. Never invent owners, dates or decisions. Output the notes only, no preamble.`;

/** Rolls the previous live notes forward with the lines added since. `offset` is how many lines came before `lines`. */
export async function updateLiveNotes(lines: LiveLine[], offset: number, previous: string, ctx: LiveContext): Promise<string> {
  const fresh = lines.map((l, i) => `[${offset + i + 1}] ${l.speaker ? `${l.speaker}: ` : ""}${l.text}`).join("\n").slice(-40_000);
  const prompt = `${contextBlock(ctx)}\n\nPrevious notes:\n${previous.trim() || "(none yet)"}\n\nNew transcript lines:\n${fresh}`;
  return (await completeText({ system: LIVE_NOTES_SYSTEM, prompt, role: "summarize", maxOutputTokens: 900 })).trim();
}
