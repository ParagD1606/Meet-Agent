import { queryTasks } from "../manager/routes";
import type { ExportRow } from "./format";
import { meetingItems, type Actor, type MeetingItemRow } from "./meeting-source";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Tasks the requester can read (the exact Tasks-tab query), as export rows. */
export async function taskExportRows(me: { id: string }, q: Record<string, string | undefined>): Promise<ExportRow[]> {
  const rows = await queryTasks(me, { ...q, limit: "1000" });
  return rows.map((r) => ({
    id: `commitment:${r.id}`, source: r.channelName ? `#${r.channelName}` : r.sourceType, itemType: "task", title: r.title, assignee: r.ownerName, due: iso(r.dueAt),
    priority: r.priority, status: r.status, kind: "commitment", label: "", confidence: "", approval: "approved", quote: "", link: r.permalink ?? "", externalUrl: r.externalRefs[0]?.url ?? "",
  }));
}

export const meetingTitle = (r: MeetingItemRow) => (typeof r.meeting === "string" ? r.meeting : r.meeting.title);

export function toExportRow(r: MeetingItemRow, i: number, fallbackUrl: string): ExportRow {
  const m = typeof r.meeting === "string" ? { id: "", title: r.meeting, url: fallbackUrl } : { url: fallbackUrl, ...r.meeting };
  return {
    id: `meeting:${m.id}:${r.itemId ?? i}`, source: m.title, itemType: r.itemType, title: r.title, assignee: r.assignee, due: r.due, priority: r.priority, status: r.status,
    kind: r.kind, label: r.label, confidence: r.confidence == null ? "" : String(r.confidence), approval: r.approval, quote: r.quote, link: m.url ?? fallbackUrl, externalUrl: r.externalUrl ?? "",
  };
}

/** null = meeting missing or unreadable by the actor. */
export async function meetingExportRows(meetingId: string, actor: Actor): Promise<{ title: string; rows: ExportRow[] } | null> {
  const m = await meetingItems(meetingId, actor);
  return m && { title: m.meeting.title, rows: m.rows.map((r, i) => toExportRow(r, i, m.meeting.url)) };
}
