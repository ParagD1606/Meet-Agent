import { eq } from "drizzle-orm";
import { z } from "zod";
import { id as newId } from "../crypto";
import { db } from "../db";
import { meetings, users } from "../db/schema";
import { log } from "../log";
import { titleKey } from "../manager/commitments";
import { completeJson, completeText } from "../memory/llm";
import { asItems, crossCheck, emptyAmbiguity, isUrgent, jaccard, normalizeDue, type Conflict, type Label, type MeetingItem } from "./items";
import { resolveOwner } from "./owner";
import { makeSource, quoteSupported, verifiedOwner, type Source } from "./verify";

/**
 * The final pass over a finished meeting: one classified item list (decisions, tasks, open questions) with quotes and evidence line numbers.
 * Nothing the model says is trusted blindly: an item without a supporting quote is KEPT but marked unverified (and never becomes a task by
 * itself); the model's confidence is cross-checked against the words actually said; owners must be real people; dates are resolved in code.
 */
export const CHUNK_CHARS = 45_000;
export const OVERLAP_CHARS = 4_000;
export const SINGLE_PASS_CHARS = 60_000;
const MAX_OUT = 8_000;

const evidence = z.array(z.coerce.number().int()).max(12).catch([]);
const conf = z.coerce.number().catch(0.7);
const prior = z.array(z.object({
  dueDate: z.string().trim().min(1).max(60).nullable().catch(null), assigneeName: z.string().trim().min(1).max(120).nullable().catch(null), quote: z.string().trim().max(600).catch(""),
})).max(4).catch([]);
const taskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).catch(""),
  assigneeName: z.string().trim().min(1).max(120).nullable().catch(null),
  assigneeId: z.string().trim().min(1).max(40).nullable().catch(null),
  dueDate: z.string().trim().min(1).max(60).nullable().catch(null),
  kind: z.enum(["commitment", "suggestion", "question"]).catch("commitment"),
  label: z.enum(["confirmed", "tentative", "suggestion", "question"]).nullable().catch(null),
  confidence: conf,
  priority: z.enum(["normal", "urgent"]).catch("normal"),
  followUp: z.boolean().catch(false),
  reason: z.string().trim().max(400).catch(""),
  quote: z.string().trim().max(600).catch(""),
  evidence,
  /** earlier values of the date / owner that were changed later in the same meeting */
  previously: prior,
});
const decisionSchema = z.object({ text: z.string().trim().min(1).max(500), quote: z.string().trim().max(600).catch(""), evidence, confidence: conf, reason: z.string().trim().max(400).catch("") });
const questionSchema = z.object({ text: z.string().trim().min(1).max(500), quote: z.string().trim().max(600).catch(""), evidence, reason: z.string().trim().max(400).catch("") });

/** One malformed item (a missing title, a wrong type) never fails the whole analysis: it is repaired from its quote or dropped. */
const tolerant = <S extends z.ZodType>(schema: S, textKeys: string[]) => z.array(z.unknown()).catch([]).transform((arr) => arr.flatMap((raw) => {
  if (!raw || typeof raw !== "object") return [];
  const o = { ...(raw as Record<string, unknown>) };
  for (const k of textKeys) if (typeof o[k] !== "string" || !String(o[k]).trim()) {
    const alt = ["title", "text", "decision", "question", "task", "name"].map((x) => o[x]).find((v) => typeof v === "string" && v.trim()) as string | undefined;
    o[k] = alt ?? (typeof o.quote === "string" && o.quote.trim() ? o.quote.trim().slice(0, 120) : typeof o.reason === "string" ? o.reason.trim().slice(0, 120) : "");
  }
  const p = schema.safeParse(o);
  return p.success ? [p.data as z.infer<S>] : [];
}));
export const analysisSchema = z.object({
  summary: z.string().trim().min(1).max(8_000),
  decisions: tolerant(decisionSchema, ["text"]),
  tasks: tolerant(taskSchema, ["title"]),
  questions: tolerant(questionSchema, ["text"]),
});
type Raw = z.infer<typeof analysisSchema>;

export const SUMMARY_SYSTEM = `You turn completed meeting source material (a transcript, or Slack AI Huddle notes) into useful meeting notes. Work from the WHOLE text, start to end. Lines are numbered like [12].
Use only the supplied text. Never use outside knowledge or what a meeting like this "usually" covers. If it is not written, it does not exist.
The text is usually automatic speech recognition: words can be wrong, punctuation is unreliable, sentences are cut at random points, names may be lowercase or misspelled. Read for meaning across broken sentences and write names with normal capitalisation.
"Background" is earlier team knowledge: use it ONLY to understand people, projects and names. Never create an item from it; every quote must come from the meeting text.
Return JSON only: {"summary":"...","decisions":[...],"tasks":[...],"questions":[...]}.
- "summary": concise Markdown. Headings "Discussion" (bullets of key points) and "Open questions" when applicable. If something clearly relates to an earlier item in the Background, add one line under "Related earlier context".
- "decisions": a choice that was made, agreed or approved ("we decided", "let's go with", "go ahead with", "agreed", "the plan is"), a choice between options, a rejected option ("no, we won't do X"), or a changed process / policy / date for the team. Hopes, goals, ideas and intentions nobody agreed to are not decisions. {"text","quote","evidence":[line numbers],"confidence":0-1,"reason"}.
- "tasks": every commitment, assignment or proposal of work to be done AFTER the meeting, however small. NOT tasks: things already done ("I sent it yesterday"), status updates, hypotheticals ("if we ever ..."), opinions, general plans where nobody acts, and the same work repeated in other words (one task, not two). {"title","description","assigneeName","assigneeId","dueDate","kind","label","confidence","priority","followUp","reason","quote","evidence"}.
  kind "commitment": someone explicitly takes it or is told to take it ("I'll send it", "Parag, you take the ads", "the pricing page is on Manas"). kind "suggestion": a proposal nobody accepted ("we could", "we should maybe", "it would be nice if"). A hedge ("maybe", "might", "I'll try") lowers the confidence.
  label: "confirmed" (clear commitment, firm words), "tentative" (hedged or half-agreed), "suggestion" (proposed only).
  confidence is how sure you are that this is a real, owned commitment. Calibrate: a clear "I will ... / you take ..." with a named owner and a date is 0.85-0.95; clear but terse (no date) 0.7-0.8; hedged ("I'll try", "I think I can maybe") 0.5-0.6; "someone should ..." or "we could ..." with no owner 0.2-0.4.
  followUp true when it is a follow-up or check-back ("circle back on", "follow up with the vendor", "check in next week").
  assigneeName is the person named as responsible, spelled as in the participant list when they are in it; assigneeId is their Slack id only when the list shows one. "I'll ..." means the speaker. If nobody is clearly named, null. Never guess an owner.
  dueDate is an ISO date YYYY-MM-DD resolved against the Meeting date and weekday ("Friday" = the next Friday after the meeting; "next Friday" = the Friday of the following week). If a date was said but cannot be resolved, put the words said. Never invent a date. priority "urgent" only when urgency is said (urgent, asap, today, blocker).
  If a date or owner is said and then CHANGED later in the meeting ("Friday ... no, make it Monday", "Parag ... actually Eve"), put the FINAL value in dueDate / assigneeName and list every earlier value in "previously":[{"dueDate","assigneeName","quote"}]. Never silently drop the earlier value.
  A sentence saying who does something is a task owned by that person, even if they are not on the call. title is a short imperative; description is one short line; reason is under 12 words; quote is words copied exactly from the text; evidence is the line numbers of the quote.
- "questions": things asked or raised and NOT answered or decided in the meeting. {"text","quote","evidence","reason"}. A question that was answered is not listed. Questions are never tasks.
Examples (text -> items):
  "[4] Parag: I'll send the revised deck to Acme by Friday." -> task commitment, assignee Parag, due the next Friday, confidence 0.95, label confirmed.
  "[9] Dana: We could maybe redo the logo at some point." -> task suggestion, assignee null, no due date, confidence 0.3, label suggestion.
  "[12] Eve: Who is paying for the venue? [13] Dana: No idea yet." -> question "Who is paying for the venue?".
  "[15] Dana: Let's go with the annual plan for the pilot." -> decision. "[16] Manas: I'll try to loop in legal, no promises." -> task commitment but tentative, confidence 0.5.`;

type Roster = { id: string; name: string }[];
export type Extraction = { summary: string; items: MeetingItem[] };

/** One extra attempt with the validation error when the model's JSON is unusable. */
export async function jsonWithRetry<S extends z.ZodType>(a: { system: string; prompt: string; maxOutputTokens: number }, schema: S): Promise<z.infer<S>> {
  try {
    return await completeJson({ ...a, role: "main" }, schema);
  } catch (e) {
    log.warn("meeting analysis reply invalid, retrying once", { error: String(e).slice(0, 200) });
    return completeJson({ ...a, prompt: `${a.prompt}\n\nYour previous reply was not valid (${String(e).slice(0, 300)}). Return valid JSON only, exactly in the format described.`, role: "main" }, schema);
  }
}

const dayLabel = (d: Date) => `${d.toISOString().slice(0, 10)} (${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })})`;

/** Splits numbered lines into chunks of about CHUNK_CHARS that overlap by about OVERLAP_CHARS (always on line boundaries). */
export function chunkLines(numbered: { n: number; text: string }[]): { n: number; text: string }[][] {
  const total = numbered.reduce((s, l) => s + l.text.length + 1, 0);
  if (total <= SINGLE_PASS_CHARS) return [numbered];
  const chunks: { n: number; text: string }[][] = [];
  let start = 0;
  while (start < numbered.length) {
    let size = 0, end = start;
    while (end < numbered.length && (size < CHUNK_CHARS || end === start)) size += numbered[end++]!.text.length + 1;
    chunks.push(numbered.slice(start, end));
    if (end >= numbered.length) break;
    let back = end, ov = 0;
    while (back > start + 1 && ov < OVERLAP_CHARS) ov += numbered[--back]!.text.length + 1;
    start = back;
  }
  return chunks;
}

/** Evidence lines: the model's numbers when valid, else the line that contains the start of the quote. */
function evidenceFor(lines: string[], quote: string, given: number[]): number[] {
  const ok = [...new Set(given.filter((n) => n >= 1 && n <= lines.length))].slice(0, 6);
  if (ok.length || !quote) return ok;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const q = norm(quote).split(" ").slice(0, 8).join(" ");
  if (!q) return [];
  const i = lines.findIndex((l) => norm(l).includes(q));
  return i >= 0 ? [i + 1] : [];
}

export async function extractMeeting(text: string, o: { roster: Roster; names: string[]; ref: Date; background?: string }): Promise<Extraction> {
  const lines = text.split("\n");
  const numbered = lines.map((l, i) => ({ n: i + 1, text: l })).filter((l) => l.text.trim());
  const src = makeSource(text);
  const chunks = chunkLines(numbered);
  const people = [...o.roster.map((r) => `${r.name} (Slack id ${r.id})`), ...o.names.filter((n) => !o.roster.some((r) => r.name.toLowerCase() === n.toLowerCase()))];
  const header = `Meeting date: ${dayLabel(o.ref)}\n${people.length ? `Participants: ${people.join(", ")}\n` : ""}${o.background ? `Background (earlier team knowledge; see the rules above):\n${o.background}\n` : ""}`;
  // chunks are independent: up to 4 run at once (latency of a long meeting is one slow chunk, not the sum)
  const raws: Raw[] = new Array(chunks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
    for (let k = next++; k < chunks.length; k = next++) {
      const chunk = chunks[k]!;
      const part = chunks.length > 1 ? `\n(Part ${k + 1} of ${chunks.length}; parts overlap a little. Line numbers are global.)` : "";
      raws[k] = await jsonWithRetry({ system: SUMMARY_SYSTEM, prompt: `${header}${part}\nTranscript:\n${chunk.map((l) => `[${l.n}] ${l.text}`).join("\n")}`, maxOutputTokens: MAX_OUT }, analysisSchema);
    }
  }));
  let summary = raws[0]!.summary;
  if (raws.length > 1) {
    summary = (await completeText({ system: "Combine these partial notes of one long meeting (in order) into ONE concise Markdown set of notes with headings Discussion and Open questions. Merge repeats, drop nothing important, add nothing.", prompt: raws.map((r, i) => `Part ${i + 1}:\n${r.summary}`).join("\n\n"), role: "summarize", maxOutputTokens: 2_000 }).catch(() => raws.map((r) => r.summary).join("\n\n"))).trim() || raws[0]!.summary;
  }
  const items: MeetingItem[] = [];
  const base = (p: Partial<MeetingItem> & { title: string; itemType: MeetingItem["itemType"] }): MeetingItem => ({
    id: newId(p.itemType === "task" ? "mtask_" : p.itemType === "decision" ? "mdec_" : "mq_"), description: "", assigneeId: null, assigneeName: null, dueDate: null, priority: "normal",
    kind: "commitment", label: "confirmed", confidence: 0.7, reason: "", quote: "", evidence: [], unverified: false, followUp: false,
    ambiguity: emptyAmbiguity(), commitmentId: null, externalRefs: [], ...p,
  });
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  for (const raw of raws) {
    for (const d of raw.decisions) {
      const unverified = !quoteSupported(src, d.quote);
      items.push(base({ itemType: "decision", title: d.text, quote: d.quote, reason: d.reason, evidence: evidenceFor(lines, d.quote, d.evidence), unverified, confidence: unverified ? Math.min(clamp(d.confidence), 0.5) : clamp(d.confidence), label: unverified ? "tentative" : "confirmed" }));
    }
    for (const q of raw.questions) {
      items.push(base({ itemType: "question", title: q.text, kind: "question", label: "question", quote: q.quote, reason: q.reason, evidence: evidenceFor(lines, q.quote, q.evidence), unverified: !quoteSupported(src, q.quote), confidence: 0.8 }));
    }
    for (const t of raw.tasks) {
      const unverified = !quoteSupported(src, t.quote);
      if (t.kind === "question") { // a question the model filed as a task is an open question, never a task
        items.push(base({ itemType: "question", title: t.title, kind: "question", label: "question", quote: t.quote, reason: t.reason, evidence: evidenceFor(lines, t.quote, t.evidence), unverified, confidence: 0.7 }));
        continue;
      }
      items.push(await taskItem(t, { src, lines, o, unverified, base }));
    }
  }
  return { summary, items: dedupe(items) };
}

async function taskItem(t: z.infer<typeof taskSchema>, c: { src: Source; lines: string[]; o: { roster: Roster; names: string[]; ref: Date }; unverified: boolean; base: (p: any) => MeetingItem }): Promise<MeetingItem> {
  const rosterHit = t.assigneeId ? c.o.roster.find((r) => r.id === t.assigneeId) : undefined;
  const nameSaid = rosterHit?.name ?? verifiedOwner(c.src, c.o.names.length ? c.o.names : c.o.roster.map((r) => r.name), t.assigneeName);
  const owner = await resolveOwner({ assigneeId: rosterHit?.id ?? null, assigneeName: nameSaid });
  const iso = normalizeDue(t.dueDate, c.o.ref);
  const base = c.base({
    itemType: "task", title: t.title, description: t.description, assigneeId: owner.user?.id ?? null, assigneeName: owner.user?.name ?? nameSaid,
    dueDate: iso, dueText: !iso && t.dueDate ? t.dueDate : null, priority: t.priority, kind: t.kind,
    label: (t.label ?? (t.kind === "commitment" ? "confirmed" : "suggestion")) as Label, confidence: Math.min(1, Math.max(0, t.confidence)), reason: t.reason, quote: t.quote,
    evidence: evidenceFor(c.lines, t.quote, t.evidence), unverified: c.unverified, followUp: t.followUp,
    ambiguity: { ...emptyAmbiguity(), ownerAmbiguous: owner.ambiguous, ownerCandidates: owner.candidates },
  }) as MeetingItem;
  // a date / owner that was said and then changed in the same meeting: the latest wins, the earlier one is a visible conflict
  const conflicts: Conflict[] = [];
  for (const p of t.previously) {
    const was = normalizeDue(p.dueDate, c.o.ref);
    if (was && iso && was !== iso) conflicts.push({ type: "due", restated: true, with: { id: `restated:due:${was}`, title: t.title, ownerName: base.assigneeName, dueDate: was } });
    if (p.assigneeName && base.assigneeName && p.assigneeName.trim().toLowerCase() !== base.assigneeName.trim().toLowerCase() && !base.assigneeName.toLowerCase().startsWith(p.assigneeName.trim().toLowerCase()))
      conflicts.push({ type: "owner", restated: true, with: { id: `restated:owner:${p.assigneeName.trim().toLowerCase()}`, title: t.title, ownerName: p.assigneeName.trim(), dueDate: was ?? null } });
  }
  base.ambiguity = { ...base.ambiguity, conflicts };
  const checked = crossCheck(base);
  const out = { ...checked, priority: isUrgent(checked) ? "urgent" as const : "normal" as const };
  return c.unverified ? { ...out, confidence: Math.min(out.confidence, 0.5), label: out.label === "confirmed" ? "tentative" : out.label } : out;
}

/** Same type, same title key (and compatible owner) or near-identical wording: one item. The first occurrence (most complete) wins. */
export function dedupe(items: MeetingItem[]): MeetingItem[] {
  const out: MeetingItem[] = [];
  for (const it of items) {
    const key = titleKey(it.title);
    const dup = out.find((o) => o.itemType === it.itemType && (o.title.toLowerCase() === it.title.toLowerCase() || (!!key && titleKey(o.title) === key && (!o.assigneeId || !it.assigneeId || o.assigneeId === it.assigneeId)) || (jaccard(o.title, it.title) >= 0.8 && (!o.assigneeId || !it.assigneeId || o.assigneeId === it.assigneeId))));
    if (!dup) { out.push(it); continue; }
    if (!dup.assigneeId && it.assigneeId) Object.assign(dup, { assigneeId: it.assigneeId, assigneeName: it.assigneeName, ambiguity: { ...dup.ambiguity, ownerAmbiguous: false, ownerCandidates: [] } });
    if (!dup.dueDate && it.dueDate) dup.dueDate = it.dueDate;
    if (dup.unverified && !it.unverified) Object.assign(dup, { unverified: false, quote: it.quote, evidence: it.evidence });
  }
  return out;
}

/** Fresh items take over ids and human decisions (approval, owner, links, dismissals) from the items they match in the previous analysis. */
export function carryOver(fresh: MeetingItem[], previous: MeetingItem[]): MeetingItem[] {
  const left = [...previous];
  return fresh.map((f) => {
    const i = left.findIndex((p) => p.itemType === f.itemType && (titleKey(p.title) === titleKey(f.title) || jaccard(p.title, f.title) >= 0.6));
    if (i < 0) return f;
    const [p] = left.splice(i, 1);
    const decided = p!.approval === "approved" || p!.approval === "rejected";
    return {
      ...f, id: p!.id,
      ...(p!.approval ? { approval: p!.approval, approvedBy: p!.approvedBy, approvedAt: p!.approvedAt, rejectedBy: p!.rejectedBy, rejectedAt: p!.rejectedAt } : {}),
      title: decided ? p!.title : f.title,
      // owner decisions stick: an approved item keeps its owner (or the "Not mine" that cleared it) when the notes are analysed again
      assigneeId: decided ? p!.assigneeId : p!.assigneeId ?? f.assigneeId, assigneeName: decided || p!.assigneeId ? p!.assigneeName : f.assigneeName,
      dueDate: decided && p!.dueDate ? p!.dueDate : f.dueDate,
      commitmentId: p!.commitmentId, externalRefs: p!.externalRefs,
      ambiguity: { ...f.ambiguity, conflicts: f.ambiguity.conflicts.filter((c) => !p!.ambiguity.dismissed?.includes(c.with.id)), ...(p!.ambiguity.dismissed ? { dismissed: p!.ambiguity.dismissed } : {}) },
    };
  });
}

/** Names and ids of the meeting's people for the prompt: huddle participant ids that are real users, plus plain names (extension uploads). */
export async function rosterFor(participantIds: unknown): Promise<{ roster: Roster; names: string[] }> {
  const list = Array.isArray(participantIds) ? participantIds.filter((x): x is string => typeof x === "string") : [];
  const all = await db.select({ id: users.id, name: users.name }).from(users);
  const byId = new Map(all.map((u) => [u.id, u.name]));
  const roster: Roster = []; const names: string[] = [];
  for (const p of list) {
    const n = byId.get(p);
    if (n) roster.push({ id: p, name: n }); else if (!/^[UW][A-Z0-9]{5,}$/.test(p)) names.push(p);
  }
  return { roster, names: [...roster.map((r) => r.name), ...names] };
}

/** Runs the final pass on a stored meeting and saves the result. A failure keeps the previous items and records why. Returns true when ready. */
export async function analyzeMeeting(meetingId: string, o: { background?: string } = {}): Promise<boolean> {
  const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!m) return false;
  try {
    const { roster, names } = await rosterFor(m.participantIds);
    const ref = m.endedAt ?? m.startedAt ?? m.createdAt;
    const ex = await extractMeeting(m.transcript, { roster, names, ref, background: o.background });
    const previous = asItems(m.id, m.tasks);
    const items = carryOver(ex.items, previous);
    const unresolved = items.filter((i) => i.unverified).length;
    if (unresolved) log.warn("meeting items kept as unverified (no supporting quote)", { meetingId: m.id, unresolved });
    await db.update(meetings).set({
      summary: ex.summary, tasks: items, decisions: items.filter((i) => i.itemType === "decision" && i.approval !== "rejected" && !i.unverified).map((i) => i.title),
      status: "ready", failedReason: null, updatedAt: new Date(),
    }).where(eq(meetings.id, m.id));
    return true;
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await db.update(meetings).set({ status: "failed", failedReason: reason, updatedAt: new Date() }).where(eq(meetings.id, m.id));
    log.warn("meeting summary failed", { meetingId: m.id, error: reason });
    return false;
  }
}
