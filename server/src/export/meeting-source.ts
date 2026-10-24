import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { meetings } from "../db/schema";
import { getMeeting } from "../meetings";

export type Actor = { userId: string; role: "owner" | "admin" | "member" };
export type ExternalRef = { provider: string; id: string; url: string };

/**
 * Flat meeting rows as `meetingItemsForExport` (server/src/meetings/export-data.ts, owned by the meetings agent) returns them.
 * itemId / assigneeId / description are extras the push needs; the fallback below fills them.
 */
export type MeetingItemRow = {
  meeting: { id: string; title: string; url?: string } | string; itemType: string; title: string; assignee: string | null; due: string | null; priority: string;
  kind: string; label: string; confidence: string | number | null; approval: "approved" | "proposed" | "rejected" | string; quote: string; status: string; externalUrl: string | null;
  itemId?: string; assigneeId?: string | null; description?: string;
};

type Real = {
  meetingItemsForExport?: (meetingId: string, actor: Actor) => Promise<MeetingItemRow[]>;
  setMeetingItemExternalRef?: (meetingId: string, itemId: string, ref: ExternalRef) => Promise<void>;
};
// resolved at run time so this file compiles and runs before / after the meetings agent's module lands
const realModule = async (): Promise<Real> => {
  const spec = "../meetings/" + "export-data";
  try { return (await import(spec)) as Real; } catch { return {}; }
};
let override: Real | null = null;
/** Tests only: substitute the meetings module. */
export const setMeetingSourceForTest = (r: Real | null) => { override = r; };
const source = async () => override ?? (await realModule());

export const meetingLink = (id: string) => `${config.PUBLIC_URL.replace(/\/$/, "")}/meetings#${id}`;

/** Null when the meeting does not exist or the actor may not read it (never distinguishes the two). */
export async function meetingItems(meetingId: string, actor: Actor): Promise<{ meeting: { id: string; title: string; url: string; ownerId: string | null }; rows: MeetingItemRow[] } | null> {
  const m = await getMeeting(meetingId, actor); // the readability check, whichever data source follows
  if (!m) return null;
  const [owner] = await db.select({ o: meetings.ownerId }).from(meetings).where(eq(meetings.id, meetingId));
  const meeting = { id: m.id, title: m.title, url: meetingLink(m.id), ownerId: owner?.o ?? null };
  const real = await source();
  if (real.meetingItemsForExport) return { meeting, rows: await real.meetingItemsForExport(meetingId, actor) };
  // ponytail: fallback until export-data lands. Legacy tasks have no approval state, so they are reported as "proposed" and never pushed.
  return {
    meeting,
    rows: m.tasks.map((t) => ({
      meeting: meeting, itemType: "task", title: t.title, assignee: t.assigneeName, due: t.dueDate, priority: "normal", kind: "commitment", label: "", confidence: null,
      approval: "proposed", quote: "", status: "open", externalUrl: t.jiraUrl ?? null, itemId: t.id, assigneeId: t.assigneeId, description: t.description,
    })),
  };
}

export async function setItemExternalRef(meetingId: string, itemId: string, ref: ExternalRef): Promise<void> {
  const real = await source();
  if (real.setMeetingItemExternalRef) return real.setMeetingItemExternalRef(meetingId, itemId, ref);
  // fallback: keep the ref on the legacy task json so a re-read shows it
  const [row] = await db.select({ tasks: meetings.tasks }).from(meetings).where(eq(meetings.id, meetingId));
  if (!Array.isArray(row?.tasks)) return;
  const tasks = (row.tasks as { id?: string; externalRefs?: ExternalRef[] }[]).map((t) => (t.id === itemId ? { ...t, externalRefs: [...(t.externalRefs ?? []).filter((r) => r.provider !== ref.provider), ref] } : t));
  await db.update(meetings).set({ tasks }).where(eq(meetings.id, meetingId));
}
