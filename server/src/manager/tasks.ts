import { log } from "../log";
import { readTags } from "../memory/scope";
import { button, section } from "../slack/cards";
import { sanitizeForSlack } from "../slack/sanitize";
import { ACTIVE, canRead, listCommitments, type Commitment } from "./commitments";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "no due date");
const MAX_ROWS = 8;

/** Open tasks for one person: what they own and what they assigned to others. Scope-filtered to what THEY can read. */
export async function openTasksFor(userId: string): Promise<{ mine: Commitment[]; assigned: Commitment[] }> {
  const tags = await readTags({ channelId: "", isPrivate: false, isIm: true, userId });
  const keep = async (rows: Commitment[]) => { const out: Commitment[] = []; for (const r of rows) if (await canRead(r, userId)) out.push(r); return out; };
  const mine = await keep(await listCommitments({ tags, status: [...ACTIVE], ownerId: userId, limit: 50 }));
  const assigned = (await keep(await listCommitments({ tags, status: [...ACTIVE], assignerId: userId, limit: 50 }))).filter((r) => r.ownerId !== userId);
  return { mine, assigned };
}

const line = (c: Commitment, who: "owner" | "assigner") =>
  sanitizeForSlack(`${c.status === "overdue" ? ":warning: " : ""}${c.text} (due ${day(c.dueAt)})${who === "owner" && c.ownerId ? ` - <@${c.ownerId}>` : ""}${c.permalink ? ` - <${c.permalink}|source>` : ""}`);

function rows(title: string, list: Commitment[], who: "owner" | "assigner", buttons: boolean): unknown[] {
  if (!list.length) return [];
  const shown = list.slice(0, MAX_ROWS);
  return [
    section(`*${title}* (${list.length})`),
    ...shown.flatMap((c) => [
      section(line(c, who)),
      ...(buttons ? [{ type: "actions", elements: [button("Done", "brain_task_done", { value: c.id, style: "primary" }), button("Drop", "brain_task_drop", { value: c.id })] }] : []),
    ]),
    ...(list.length > shown.length ? [section(`_...and ${list.length - shown.length} more._`)] : []),
  ];
}

/** Message body for /brain-tasks and the daily digest. `buttons` adds Done/Drop per task (brain_task_* actions, handled in chase.ts). */
export async function taskListMessage(userId: string, o: { buttons?: boolean; heading?: string } = {}): Promise<{ text: string; blocks: unknown[]; count: number }> {
  const { mine, assigned } = await openTasksFor(userId);
  const buttons = o.buttons ?? true;
  const blocks = [...rows("Assigned to you", mine, "assigner", buttons), ...rows("You assigned", assigned, "owner", buttons)];
  const count = mine.length + assigned.length;
  if (!count) return { text: "You have no open tasks.", blocks: [section(o.heading ? `${o.heading}\n_No open tasks._` : "_You have no open tasks._")], count };
  return { text: `${o.heading ?? "Your tasks"}: ${mine.length} assigned to you, ${assigned.length} you assigned.`, blocks: o.heading ? [section(o.heading), ...blocks] : blocks, count };
}

/** Replaces the message a task button was clicked in (response_url), with the refreshed list. */
export async function refreshTaskList(responseUrl: string | undefined, userId: string): Promise<void> {
  if (!responseUrl) return;
  const m = await taskListMessage(userId);
  try {
    await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace_original: true, text: m.text, blocks: m.blocks }) });
  } catch (e) { log.warn("task list refresh failed", { error: (e as Error).message }); }
}
