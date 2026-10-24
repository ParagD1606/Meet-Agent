import { readTags, type SlackScope } from "../memory/scope";
import { searchMemory } from "../memory/search";
import { listCommitments, resolveOwner, type Commitment } from "./commitments";

const STOP = new Set(["who", "was", "were", "given", "gave", "the", "task", "tasks", "assigned", "assign", "owns", "owner", "what", "about", "for", "this", "that", "has", "have", "responsible", "with", "and", "when", "due", "which", "got", "from", "are", "its", "is", "to", "of", "on", "in", "a", "an", "me", "my", "done", "finished", "complete", "completed", "status", "feature"]);
export const words = (q: string) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP.has(w));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "no due date");
/** Prefix match so "launched" finds "launch" (and the reverse). */
export const hasWord = (hay: string, w: string) => hay.includes(w.length > 5 ? w.slice(0, w.length - 2) : w);

export type FindTasksArgs = {
  scope: SlackScope; asker: string | null; query?: string; owner?: string; assigner?: string; channel?: string;
  status?: "open" | "overdue" | "in_progress" | "done" | "dropped" | "all"; dueAfter?: string; dueBefore?: string; limit?: number;
};

const who = async (raw: string | undefined, asker: string | null, channel?: string) => {
  if (!raw) return undefined;
  if (/^(me|my|myself|i)$/i.test(raw.trim())) return asker ?? "none";
  return (await resolveOwner(raw, channel)).id ?? "none";
};
const date = (s?: string) => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d : undefined; };

/**
 * Tasks the ASKER can read (their readTags, so a private channel's task never reaches a non-member), best text match first.
 * With a text query and no status the search covers every status (done and dropped too) so "is X done?" is answered from the task itself.
 */
export async function findTasks(a: FindTasksArgs): Promise<{ tasks: Commitment[]; related: { text: string; permalink: string | null }[] }> {
  const tags = await readTags(a.scope);
  const kw = words(a.query ?? "");
  const status = a.status === "all" || (!a.status && kw.length) ? undefined
    : a.status === "done" || a.status === "dropped" || a.status === "in_progress" ? [a.status]
    : a.status === "overdue" ? (["overdue"] as const) : (["open", "overdue", "in_progress"] as const);
  const rows = await listCommitments({
    tags, alsoOwnedBy: a.scope.isIm ? a.asker : null, status: status && [...status], ownerId: await who(a.owner, a.asker, a.scope.channelId), assignerId: await who(a.assigner, a.asker, a.scope.channelId),
    channelId: a.channel?.replace(/^<#([A-Z0-9]+).*>$/, "$1"), dueAfter: date(a.dueAfter), dueBefore: date(a.dueBefore), limit: 500,
  });
  const active = (r: Commitment) => (r.status === "done" || r.status === "dropped" ? 0 : 0.5); // equal text match: live tasks first
  const scored = rows.map((r) => ({ r, s: kw.filter((w) => hasWord(`${r.text} ${r.ownerName ?? ""}`.toLowerCase(), w)).length }));
  const tasks = scored.filter((x) => !kw.length || x.s > 0).sort((x, y) => y.s + active(y.r) - (x.s + active(x.r))).slice(0, Math.min(a.limit ?? 8, 25)).map((x) => x.r);
  // task facts from the same scopes (status changes, owner notes) with their message links
  const related = a.query && kw.length
    ? (await searchMemory({ tags, query: a.query, limit: 4 })).filter((h) => h.permalink && h.score >= 0.3).map((h) => ({ text: h.text, permalink: h.permalink }))
    : [];
  return { tasks, related };
}

export function formatTasks(r: Awaited<ReturnType<typeof findTasks>>): string {
  if (!r.tasks.length && !r.related.length) return "No matching task found in anything you can read. Say you don't know; do not guess an owner.";
  const lines = r.tasks.map((t) =>
    `- [${t.status}${t.priority === "urgent" ? ", URGENT" : ""}] ${t.text} | id: ${t.id} | owner: ${t.ownerId ? `<@${t.ownerId}>` : t.ownerName ?? "unknown"} | assigned by: ${t.assignerId ? `<@${t.assignerId}>` : "unknown"} | due: ${day(t.dueAt)}${t.completedAt ? ` | closed: ${day(t.completedAt)}` : ""}${t.channelId ? ` | in <#${t.channelId}>` : ""} | Source: ${t.permalink ?? "no link"}`);
  const rel = r.related.map((x) => `- ${x.text} (Source: ${x.permalink})`);
  return [lines.join("\n"), rel.length ? `Related memory:\n${rel.join("\n")}` : ""].filter(Boolean).join("\n\n");
}
