import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { commitments, memories, users } from "../db/schema";
import { readTags } from "../memory/scope";
import { personScope, recallForMeeting, type MemorySource } from "./index";

/**
 * Who could take a task, from what the signed-in person is allowed to see. Deliberately a transparent score rather than a model
 * guess: every suggestion carries the evidence behind it. Availability here means workload (open, overdue, urgent and due-soon
 * tasks), who is on this call, and time off mentioned in memory; Slack presence and calendars are not connected.
 */
export type SuggestTask = { id: string; title: string };
export type Candidate = {
  userId: string; name: string; title: string | null; score: number;
  skill: number; availability: "light" | "busy" | "overloaded"; onCall: boolean; possibleTimeOff: boolean;
  load: { open: number; overdue: number; dueSoon: number; urgent: number };
  reasons: string[];
};
export type Suggestions = {
  tasks: { id: string; candidates: Candidate[]; noSkillSignal: boolean }[];
  basis: { people: number; tasksSeen: number; usedMemory: boolean; note: string };
};

const STOP = new Set("the and for with from that this will have has had are was were our your you their them they what when where who how why not but can could should would into onto about over under then than also just very more most some any all each per via get got let make made need needs done set sent send handle handles handling handled task tasks work working help take part item items thing things stuff manage prepare follow".split(" "));
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
/** How much of `task` is covered by `other` (0..1). */
function coverage(task: Set<string>, other: Set<string>): number {
  if (!task.size || !other.size) return 0;
  let n = 0; for (const w of task) if (other.has(w)) n++;
  return n / task.size;
}
const DAY = 24 * 3600 * 1000;
const mentions = (text: string, name: string) => {
  const lower = text.toLowerCase(), n = name.toLowerCase().trim();
  if (!n) return false;
  if (lower.includes(n)) return true;
  const first = n.split(/\s+/)[0]!;
  return first.length >= 3 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
};
const ago = (d: Date, now: number) => { const days = Math.round((now - d.getTime()) / DAY); return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`; };
const cite = (s: MemorySource) => `“${s.text.length > 110 ? `${s.text.slice(0, 110)}…` : s.text}” (${s.source}, ${s.date})`;

export async function suggestAssignees(userId: string, tasks: SuggestTask[], opts: { roster?: string[]; context?: string; limit?: number } = {}): Promise<Suggestions> {
  const now = Date.now();
  const people = await db.select({ id: users.id, name: users.name, title: users.title }).from(users).where(and(eq(users.isBot, false), eq(users.deactivated, false)));
  const named = people.filter((p) => p.name?.trim());

  // Workload and track record, only from tasks this person may read.
  const tags = await readTags(personScope(userId));
  const since = new Date(now - 90 * DAY);
  const rows = tags.length ? await db.select({ ownerId: commitments.ownerId, text: commitments.text, status: commitments.status, dueAt: commitments.dueAt, priority: commitments.priority, completedAt: commitments.completedAt })
    .from(commitments).where(and(isNotNull(commitments.ownerId), inArray(commitments.scopeTag, tags),
      or(inArray(commitments.status, ["open", "in_progress", "overdue"]), and(eq(commitments.status, "done"), gt(commitments.completedAt, since))))).limit(5_000) : [];
  const byOwner = new Map<string, typeof rows>();
  for (const r of rows) byOwner.set(r.ownerId!, [...(byOwner.get(r.ownerId!) ?? []), r]);

  const load = (id: string) => {
    const mine = (byOwner.get(id) ?? []).filter((r) => r.status !== "done");
    return {
      open: mine.length,
      overdue: mine.filter((r) => r.status === "overdue" || (r.dueAt && r.dueAt.getTime() < now)).length,
      dueSoon: mine.filter((r) => r.dueAt && r.dueAt.getTime() >= now && r.dueAt.getTime() < now + 7 * DAY).length,
      urgent: mine.filter((r) => r.priority === "urgent").length,
    };
  };

  // Time off mentioned in what this person can read, from the last 30 days (older notes are stale). A pattern search, not a model guess.
  const awaySources: MemorySource[] = tags.length ? (await db.select({ text: memories.text, source: memories.source, createdAt: memories.createdAt }).from(memories)
    .where(and(inArray(memories.scopeTag, tags), eq(memories.reviewState, "ok"), eq(memories.status, "active"), isNull(memories.invalidAt),
      or(isNull(memories.validUntil), sql`${memories.validUntil} > now()`), gt(memories.createdAt, new Date(now - 30 * DAY)),
      sql`${memories.text} ~* ${"\\m(vacation|on leave|out of office|ooo|day off|days off|sick|holiday|unavailable|away next|out next)\\M"}`))
    .orderBy(desc(memories.createdAt)).limit(40)).map((r) => ({ text: r.text.slice(0, 240), source: r.source, date: r.createdAt.toISOString().slice(0, 10) })) : [];
  const awayNotes = (name: string) => awaySources.filter((x) => mentions(x.text, name));

  const roster = new Set((opts.roster ?? []).map((n) => n.toLowerCase()));
  let usedMemory = awaySources.length > 0;
  const out: Suggestions["tasks"] = [];
  for (const task of tasks.slice(0, 12)) {
    const want = tokens(task.title);
    const mem = await recallForMeeting(userId, `${task.title}${opts.context ? `\n${opts.context}` : ""}`, { budgetTokens: 1_500 });
    usedMemory ||= mem.sources.length > 0;
    const ranked: Candidate[] = named.map((p) => {
      const name = p.name!.trim();
      const history = byOwner.get(p.id) ?? [];
      const similar = history.map((h) => ({ h, s: coverage(want, tokens(h.text)) })).filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s);
      const best = similar[0];
      const role = p.title ? coverage(want, tokens(p.title)) > 0 : false;
      const said = mem.sources.filter((s) => mentions(s.text, name)).slice(0, 2);
      const skill = Math.min(1, 0.6 * (best?.s ?? 0) + 0.25 * (said.length ? 1 : 0) + 0.25 * (role ? 1 : 0) + 0.15 * (similar.some((x) => x.h.status === "done") ? 1 : 0));
      const l = load(p.id);
      const heavy = l.open + 2 * l.overdue + l.urgent + l.dueSoon;
      const off = awayNotes(name);
      const free = Math.max(0, 1 - heavy / 12) * (off.length ? 0.4 : 1);
      const onCall = roster.has(name.toLowerCase()) || roster.has(name.toLowerCase().split(/\s+/)[0]!);
      const reasons: string[] = [];
      if (best) reasons.push(`${best.h.status === "done" ? "Did" : "Working on"} something similar: “${best.h.text.slice(0, 90)}”${best.h.status === "done" && best.h.completedAt ? ` (${ago(best.h.completedAt, now)})` : ""}`);
      if (role) reasons.push(`Role: ${p.title}`);
      for (const s of said) reasons.push(`In memory: ${cite(s)}`);
      reasons.push(`${l.open} open · ${l.overdue} overdue · ${l.dueSoon} due within a week${l.urgent ? ` · ${l.urgent} urgent` : ""}`);
      for (const s of off.slice(0, 1)) reasons.push(`Possible time off: ${cite(s)}`);
      if (onCall) reasons.push("On this call now");
      return {
        userId: p.id, name, title: p.title ?? null, skill: Math.round(skill * 100) / 100, onCall, possibleTimeOff: off.length > 0, load: l,
        availability: heavy <= 2 ? "light" as const : heavy <= 6 ? "busy" as const : "overloaded" as const,
        score: Math.round((0.6 * skill + 0.4 * free + (onCall ? 0.03 : 0)) * 100) / 100, reasons,
      };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    out.push({ id: task.id, candidates: ranked.slice(0, opts.limit ?? 3), noSkillSignal: !ranked.some((c) => c.skill > 0) });
  }
  return {
    tasks: out,
    basis: {
      people: named.length, tasksSeen: rows.length, usedMemory,
      note: "Availability is estimated from open, overdue and due-soon tasks you can see, who is on this call, and time off mentioned in memory. Slack presence and calendars are not connected.",
    },
  };
}
