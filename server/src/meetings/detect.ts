import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { commitments, meetings } from "../db/schema";
import { log } from "../log";
import { ACTIVE, titleKey } from "../manager/commitments";
import { embed } from "../memory/embed";
import { completeJson } from "../memory/llm";
import { jaccard, type Conflict, type DupRef, type MeetingItem, asItems } from "./items";
import { suggestAssignees } from "./suggest";

/**
 * Extraction-time duplicate / conflict / ambiguity checks for items that still need a human decision. Compares each item with
 * (a) the other items of the same meeting, (b) existing OPEN tasks in the same scope and (c) tasks and decisions of other meetings of the
 * last 30 days that the same people may read. Heuristics first (title key, token Jaccard >= 0.6, embedding cosine); a model is asked
 * only when it is unsure, with a small budget. Pure flags: nothing is changed or merged here.
 */
const DAY = 86_400_000;
const yesNo = z.object({ same: z.boolean().optional(), contradicts: z.boolean().optional() });
const SAME_SYSTEM = `Two task titles from one team. Say whether they describe the SAME piece of work (not merely a related one). Reply JSON only: {"same":true|false}.`;
const CONTRA_SYSTEM = `Two decisions from one team. Say whether they CONTRADICT each other (they cannot both hold). Reply JSON only: {"contradicts":true|false}.`;

type Other = { id: string; title: string; ownerId: string | null; ownerName: string | null; dueDate: string | null; source: "task" | "meeting"; meetingId?: string };
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const cosine = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / (Math.sqrt(x * y) || 1); };

export async function annotateItems(m: typeof meetings.$inferSelect, items: MeetingItem[], scopeTag: string, opts: { llm?: number } = {}): Promise<MeetingItem[]> {
  const budget = { llm: opts.llm ?? 6 };
  const mine = (i: MeetingItem) => i.approval !== "approved" && i.approval !== "rejected";
  if (!items.some(mine)) return items;
  const ext = m.channelId.startsWith("ext_");

  // (b) open tasks in the same scope, not made from this meeting
  const open: Other[] = (await db.select().from(commitments).where(and(eq(commitments.scopeTag, scopeTag), inArray(commitments.status, [...ACTIVE]), sql`${commitments.sourceRef} not like ${`meeting:${m.id}:%`}`)).limit(300))
    .map((c) => ({ id: c.id, title: c.text, ownerId: c.ownerId, ownerName: c.ownerName, dueDate: day(c.dueAt), source: "task" as const }));
  // (c) other recent meetings the same audience can read
  const recent = (await db.select({ id: meetings.id, tasks: meetings.tasks }).from(meetings)
    .where(and(ne(meetings.id, m.id), gt(meetings.createdAt, new Date(Date.now() - 30 * DAY)), ext ? eq(meetings.ownerId, m.ownerId ?? "") : eq(meetings.channelId, m.channelId))).limit(40))
    .flatMap((r) => asItems(r.id, r.tasks).filter((i) => i.approval !== "rejected").map((i) => ({ i, meetingId: r.id })));
  const others = (type: MeetingItem["itemType"]): Other[] => [
    ...(type === "task" ? open : []),
    ...recent.filter((r) => r.i.itemType === type).map((r) => ({ id: r.i.id, title: r.i.title, ownerId: r.i.assigneeId, ownerName: r.i.assigneeName, dueDate: r.i.dueDate, source: "meeting" as const, meetingId: r.meetingId })),
  ];

  // one batch of embeddings for every title involved (best effort: heuristics still work without)
  const titles = [...new Set([...items.filter(mine).map((i) => i.title), ...open.slice(0, 150).map((o) => o.title), ...recent.slice(0, 100).map((r) => r.i.title)])].slice(0, 300);
  const vec = new Map<string, number[]>();
  if (titles.length > 1 && open.length + recent.length > 0) {
    try { (await embed(titles)).forEach((v, k) => vec.set(titles[k]!, v)); } catch (e) { log.warn("meeting duplicate embeddings failed", { error: String(e).slice(0, 120) }); }
  }
  const same = async (a: string, b: string): Promise<boolean> => {
    if (titleKey(a) && titleKey(a) === titleKey(b)) return true;
    const j = jaccard(a, b);
    if (j >= 0.6) return true;
    const va = vec.get(a), vb = vec.get(b);
    const cos = va && vb ? cosine(va, vb) : 0;
    if (cos >= 0.88) return true;
    if ((j >= 0.4 || cos >= 0.78) && budget.llm > 0) {
      budget.llm--;
      return completeJson({ system: SAME_SYSTEM, prompt: `A: ${a}\nB: ${b}`, role: "extract", maxOutputTokens: 40 }, yesNo).then((v) => v.same === true).catch(() => false);
    }
    return false;
  };

  const out: MeetingItem[] = [];
  for (let n = 0; n < items.length; n++) {
    const item = items[n]!;
    if (!mine(item) || item.itemType === "question") { out.push(item); continue; }
    const dismissed = new Set(item.ambiguity.dismissed ?? []);
    const duplicateOf: DupRef[] = [], conflicts: Conflict[] = [];
    const consider = async (o: Other) => {
      if (dismissed.has(o.id) || duplicateOf.length + conflicts.length >= 4) return;
      if (item.itemType === "decision") {
        const j = jaccard(item.title, o.title);
        if (j >= 0.9 || j < 0.25 || budget.llm <= 0) return;
        budget.llm--;
        const bad = await completeJson({ system: CONTRA_SYSTEM, prompt: `A: ${item.title}\nB: ${o.title}`, role: "extract", maxOutputTokens: 40 }, yesNo).then((v) => v.contradicts === true).catch(() => false);
        if (bad) conflicts.push({ type: "decision", with: { id: o.id, title: o.title, ownerName: null, dueDate: null } });
        return;
      }
      if (!(await same(item.title, o.title))) return;
      const sameOwner = !item.assigneeId || !o.ownerId || item.assigneeId === o.ownerId;
      const sameDue = !item.dueDate || !o.dueDate || item.dueDate === o.dueDate;
      const w = { id: o.id, title: o.title, ownerName: o.ownerName, dueDate: o.dueDate };
      if (sameOwner && sameDue) duplicateOf.push({ source: o.source, ...(o.meetingId ? { meetingId: o.meetingId } : {}), ...w });
      else {
        if (!sameOwner) conflicts.push({ type: "owner", with: w });
        if (!sameDue) conflicts.push({ type: "due", with: w });
      }
    };
    for (const prev of items.slice(0, n)) if (prev.itemType === item.itemType && prev.approval !== "rejected") await consider({ id: prev.id, title: prev.title, ownerId: prev.assigneeId, ownerName: prev.assigneeName, dueDate: prev.dueDate, source: "meeting", meetingId: m.id });
    for (const o of others(item.itemType)) await consider(o);
    out.push({
      ...item,
      ambiguity: { ...item.ambiguity, ownerMissing: item.itemType === "task" && !item.assigneeId && !(item.assigneeName && item.ambiguity.ownerCandidates.length > 0), // nobody named, or a name that is nobody in the workspace
        ownerAmbiguous: item.itemType === "task" && !item.assigneeId && !!item.assigneeName && item.ambiguity.ownerCandidates.length > 0,
        dueMissing: item.itemType === "task" && !item.dueDate, duplicateOf, conflicts: [...item.ambiguity.conflicts.filter((c) => c.restated), ...conflicts] },
    });
  }

  // Missing owners: workload-based suggestions from what the organizer may read (best effort, top 3).
  const needOwner = out.filter((i) => i.itemType === "task" && i.kind === "commitment" && i.ambiguity.ownerMissing && i.ambiguity.ownerCandidates.length === 0).slice(0, 8);
  if (needOwner.length && m.organizerId) {
    try {
      const s = await suggestAssignees(m.organizerId, needOwner.map((i) => ({ id: i.id, title: i.title, ...(i.dueDate ? { due: i.dueDate } : {}) })), { limit: 3 });
      for (const r of s.tasks) {
        const it = out.find((i) => i.id === r.id);
        if (it) it.ambiguity = { ...it.ambiguity, ownerCandidates: r.candidates.slice(0, 3).map((c) => ({ id: c.userId, name: c.name, score: c.skill })) };
      }
    } catch (e) { log.warn("meeting owner suggestions failed", { error: String(e).slice(0, 120) }); }
  }
  return out;
}

