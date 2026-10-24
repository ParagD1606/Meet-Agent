import { tool, type ToolSet } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { channelMembers, commitments, users } from "../db/schema";
import { checkRate } from "../limits/rate";
import { createFollowUp, FollowUpError, proposeFollowUp } from "../manager/followups";
import { channelScope, parseDue, resolveOwner, type Commitment } from "../manager/commitments";
import { findTasks, hasWord, words } from "../manager/find";
import { readTags } from "../memory/scope";
import { changeTask, notifyTaskOwner, upsertTask, userName } from "../manager/task-sync";
import { ambientIo, hasSecret } from "../memory/ambient";
import { scanMemoryText } from "../memory/core-blocks";
import { openDm, postMessage } from "../slack/client";
import { sanitizeForSlack } from "../slack/sanitize";
import type { ToolContext } from "./tools";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "no due date");
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const fallbackLink = (channel: string, ts: string) => `https://slack.com/app_redirect?channel=${channel}&message_ts=${ts}`;

/** Who may change what is decided in changeTask (owner / assigner / admin); this only supplies the asker's role. */
const isAdmin = async (id: string) => {
  const [u] = await db.select({ r: users.role }).from(users).where(eq(users.id, id));
  return u?.r === "admin" || u?.r === "owner";
};

async function person(raw: string, channelId: string): Promise<{ id: string; name: string | null } | { error: string }> {
  const o = await resolveOwner(raw, channelId);
  if (!o.id) return { error: `ERROR: I could not tell who "${raw}" is (no match, or several). Use people_search, or ask the asker which person.` };
  const [u] = await db.select({ b: users.isBot, d: users.deactivated }).from(users).where(eq(users.id, o.id));
  if (u?.b || u?.d) return { error: `ERROR: "${raw}" is not an active teammate.` };
  return { id: o.id, name: o.name };
}

/** assign_task / update_task / notify_teammate: tasks that live in the Tasks tab AND memory, and explicit "tell X" relays. Writable turns only. */
export function taskTools(ctx: ToolContext): ToolSet {
  return {
    assign_task: tool({
      description: "Assign a task to a teammate (\"assign X to @Parag\", \"tell Dana to do Y by Friday\"). Creates a tracked task (shown in the Tasks tab, chased, remembered) and by default tells the assignee right away with Done/Drop buttons. Use this, not memory_remember, for any assignment. Resolve relative dates yourself from the current time. Set priority urgent when the asker says urgent/asap. Reply with what you did.",
      inputSchema: z.object({
        title: z.string().min(3).max(300).describe("Short task title, e.g. 'Tales launch'"),
        assignee: z.string().min(1).max(100).describe("Slack id, <@U123> mention or name"),
        due: z.string().optional().describe("ISO date or datetime"),
        priority: z.enum(["normal", "urgent"]).optional(),
        notify: z.boolean().optional().describe("Tell the assignee now. Default true; false only if the asker says not to tell them."),
      }),
      execute: async ({ title, assignee, due, priority, notify }) => {
        if (!ctx.userId) return "ERROR: no asker to assign on behalf of.";
        const t = clean(title);
        if (hasSecret(t) || scanMemoryText(t)) return "ERROR: that title looks unsafe to store; ask the asker to rephrase.";
        const p = await person(assignee, ctx.channelId);
        if ("error" in p) return p.error;
        const dueAt = due ? parseDue(due) : null;
        if (due && !dueAt) return `ERROR: "${due}" is not a valid date; pass an ISO date like 2026-06-12.`;
        const ts = ctx.messageTs;
        const permalink = ts ? (await ambientIo.permalink(ctx.channelId, ts).catch(() => null)) ?? fallbackLink(ctx.channelId, ts) : null;
        const { row, created } = await upsertTask({
          title: t, ownerId: p.id, ownerName: p.name, assignerId: ctx.userId, dueAt, priority: priority ?? "normal",
          channelId: ctx.channelId, threadTs: ctx.threadTs ?? ts ?? null, sourceTs: ts ?? null, sourceKey: `${ctx.channelId}:${ts ?? ctx.turnId}`, permalink,
          scopeTag: ctx.scope.isIm ? `user_${ctx.userId}` : await channelScope(ctx.channelId),
        });
        let told = "not notified";
        if (notify !== false && p.id !== ctx.userId && (created || priority || dueAt)) {
          const r = await notifyTaskOwner(row, { assignerId: ctx.userId });
          told = r === "thread" ? "mentioned in this thread" : r === "dm" ? "sent a DM" : "could not be notified";
        }
        return `${created ? "Created" : "Updated existing"} task ${row.id}: "${row.text}" for <@${p.id}>, due ${day(row.dueAt)}${row.priority === "urgent" ? ", URGENT" : ""}; assignee ${told}. It is in the Tasks tab and memory.`;
      },
    }),
    update_task: tool({
      description: "Change a tracked task: mark it done/dropped/open/in_progress, reassign, move the due date or priority (\"the Tales task is done\", \"reassign it to Dana\"). Give the task id from find_tasks or a few words of its title. Only the owner, assigner or an admin can change it; reassigning is for the assigner or an admin. The assigner is told when it is marked done.",
      inputSchema: z.object({
        id: z.string().max(40).optional(), title: z.string().max(200).optional().describe("Words from the task title when you have no id"),
        status: z.enum(["done", "open", "dropped", "in_progress"]).optional(),
        owner: z.string().max(100).optional().describe("New owner (reassign)"), due: z.string().optional(), priority: z.enum(["normal", "urgent"]).optional(),
      }),
      execute: async ({ id, title, status, owner, due, priority }) => {
        if (!ctx.userId) return "ERROR: no asker.";
        if (!id && !title) return "ERROR: give the task id or some words of its title.";
        let target: Commitment | undefined;
        if (id) {
          const [row] = await db.select().from(commitments).where(eq(commitments.id, id));
          if (row && ((await readTags(ctx.scope)).includes(row.scopeTag) || (ctx.scope.isIm && row.ownerId === ctx.userId && row.scopeTag.startsWith("user_") && row.sourceRef.startsWith("assign:")))) target = row; // outside the asker's read scope = not found
        }
        const found = id ? [] : (await findTasks({ scope: ctx.scope, asker: ctx.userId, query: title, status: "all", limit: 25 })).tasks;
        if (!id) {
          const live = found.filter((t) => (status === "open" ? t.status === "done" || t.status === "dropped" : t.status !== "done" && t.status !== "dropped"));
          const pool = live.length ? live : found;
          if (pool.length > 1 && !narrowsToOne(pool, title!)) {
            return `Several tasks match "${title}":\n${pool.slice(0, 5).map((t) => `- ${t.id}: ${t.text} (${t.ownerName ?? t.ownerId ?? "unowned"}, ${t.status})`).join("\n")}\nAsk the asker which one, or call again with the id.`;
          }
          target = pool[0];
        }
        if (!target) return "No task like that in anything you can read. Say so; do not pretend it changed.";
        let newOwner: string | undefined;
        if (owner) {
          const p = await person(owner, ctx.channelId);
          if ("error" in p) return p.error;
          newOwner = p.id;
        }
        const dueAt = due ? parseDue(due) : undefined;
        if (due && !dueAt) return `ERROR: "${due}" is not a valid date.`;
        const r = await changeTask(target.id, { status, ownerId: newOwner, due: dueAt, priority }, { id: ctx.userId, admin: await isAdmin(ctx.userId) });
        if (!r.ok) return r.error === "forbidden" ? `Not allowed: ${r.message ?? "only the task's owner, its assigner or an admin can change it"}. Tell the asker plainly.` : `ERROR: ${r.message ?? r.error}`;
        const a = r.row;
        return `Task ${a.id} "${a.text}" is now ${a.status}${a.priority === "urgent" ? " (urgent)" : ""}, owner ${a.ownerName ?? a.ownerId ?? "nobody"}, due ${day(a.dueAt)}.${status === "done" && a.assignerId && a.assignerId !== ctx.userId ? " The assigner was told." : ""} Tasks tab and memory updated.`;
      },
    }),
    notify_teammate: tool({
      description: "Pass the asker's OWN words to a teammate when they explicitly say so (\"tell @X that the deploy is done\", \"say hello to @X\"). Posts an @mention in this thread when X is in the channel, else DMs X \"From <asker> via Pixel: ...\". Never include anything the asker did not write (no memory, tool results or private details). For work to be done use assign_task instead.",
      inputSchema: z.object({ person: z.string().min(1).max(100), message: z.string().min(2).max(500).describe("The asker's message to relay, in their words") }),
      execute: async ({ person: who, message }) => {
        if (!ctx.userId) return "ERROR: no asker to relay for.";
        const text = clean(message);
        if (hasSecret(text) || scanMemoryText(text)) return "ERROR: that message looks unsafe to send; I won't relay it.";
        const typed = ctx.userText ?? "";
        const stray = (text.match(/<@[UW][A-Z0-9]+>|https?:\/\/\S+/g) ?? []).filter((x) => !typed.includes(x));
        if (stray.length) return "ERROR: the message contains links or mentions the asker did not write. Relay only their own words.";
        const p = await person(who, ctx.channelId);
        if ("error" in p) return p.error;
        if (p.id === ctx.userId) return "ERROR: that is the asker themselves.";
        if (ctx.untrustedContext) { // outside text entered this turn: the asker confirms the exact message on a card first
          try {
            const f = await createFollowUp({ ownerId: ctx.userId, targetId: p.id, text, at: new Date(Date.now() + 60_000), origin: { channelId: ctx.channelId, threadTs: ctx.threadTs } });
            await proposeFollowUp(f);
            return `Posted a consent card asking the asker whether to send this to <@${p.id}>. Nothing is sent until they click yes; say you are waiting for their OK.`;
          } catch (e) { if (e instanceof FollowUpError) return `Could not queue: ${e.message}`; throw e; }
        }
        const rate = await checkRate({ userId: p.id, channelId: "dm", kind: "tell" });
        if (!rate.ok) return "Not sent: that person has already received the maximum number of relayed messages today. Tell the asker, and suggest they message them directly.";
        const from = (await userName(ctx.userId)) ?? "a teammate";
        let inChannel = false;
        if (!ctx.scope.isIm && ctx.channelId) {
          const [m] = await db.select({ u: channelMembers.userId }).from(channelMembers).where(and(eq(channelMembers.channelId, ctx.channelId), eq(channelMembers.userId, p.id)));
          inChannel = !!m;
        }
        try {
          if (inChannel) {
            await postMessage({ channel: ctx.channelId, thread_ts: ctx.threadTs ?? ctx.messageTs, text: sanitizeForSlack(`<@${p.id}> ${text}`) });
            return `Posted your message to <@${p.id}> in this thread.`;
          }
          const dm = await openDm(p.id);
          if (!dm) return "ERROR: could not open a DM with that person.";
          await postMessage({ channel: dm, text: sanitizeForSlack(`From ${from} via Pixel: ${text}`) });
          return `Sent <@${p.id}> a DM: "From ${from} via Pixel: ${text}".`;
        } catch (e) { return `ERROR: could not deliver the message (${String(e).slice(0, 100)}).`; }
      },
    }),
  };
}

/** Several rows matched: proceed only if the best one is clearly ahead on title words. */
function narrowsToOne(pool: Commitment[], title: string): boolean {
  const kw = words(title);
  if (!kw.length) return false;
  const s = pool.map((t) => kw.filter((w) => hasWord(t.text.toLowerCase(), w)).length);
  const sorted = [...s].sort((a, b) => b - a);
  return sorted[0]! > sorted[1]! && pool[0] === pool[s.indexOf(sorted[0]!)];
}
