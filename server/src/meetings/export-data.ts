import { eq } from "drizzle-orm";
import { db } from "../db";
import { meetings } from "../db/schema";
import { getMeeting } from "./index";
import { asItems, type ExternalRef } from "./items";
import { saveItemsFor } from "./tasks";

type Actor = { userId: string; role: "owner" | "admin" | "member" };

export type ExportRow = {
  meeting: { id: string; title: string; date: string | null; url: string | null };
  itemId: string; itemType: "task" | "decision" | "question"; title: string; description: string;
  assigneeId: string | null; assignee: string | null; due: string | null; priority: "normal" | "urgent";
  kind: string; label: string; confidence: number; approval: string; quote: string;
  /** commitment status (open / done / ...) for approved tasks, else the approval state */
  status: string;
  externalUrl: string | null;
};

/** Flat rows of everything a meeting produced, for exports and pushes. Null when the meeting does not exist or the actor may not read it. */
export async function meetingItemsForExport(meetingId: string, actor: Actor): Promise<ExportRow[] | null> {
  const m = await getMeeting(meetingId, actor);
  if (!m) return null;
  const meeting = { id: m.id, title: m.title, date: (m.endedAt ?? m.startedAt ?? m.createdAt)?.toISOString().slice(0, 10) ?? null, url: `${(await import("./urls")).meetingUrl(m.id)}` };
  return m.items.map((i) => ({
    meeting, itemId: i.id, itemType: i.itemType, title: i.title, description: i.description, assigneeId: i.assigneeId, assignee: i.assigneeName,
    due: i.dueDate, priority: i.priority, kind: i.kind, label: i.label, confidence: i.confidence, approval: i.approval, quote: i.quote,
    status: i.commitmentStatus ?? i.approval, externalUrl: i.externalRefs[0]?.url ?? null,
  }));
}

/** Records where an item was pushed (Trello card, GitHub issue, Jira key). Idempotent per provider: a second push replaces the first ref. */
export async function setMeetingItemExternalRef(meetingId: string, itemId: string, ref: ExternalRef): Promise<boolean> {
  const [m] = await db.select({ tasks: meetings.tasks }).from(meetings).where(eq(meetings.id, meetingId)).limit(1);
  if (!m) return false;
  const items = asItems(meetingId, m.tasks);
  if (!items.some((i) => i.id === itemId)) return false;
  await saveItemsFor(meetingId, items.map((i) => (i.id === itemId ? { ...i, externalRefs: [...i.externalRefs.filter((r) => r.provider !== ref.provider), ref] } : i)));
  return true;
}
