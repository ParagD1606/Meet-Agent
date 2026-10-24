import { tool, type ToolSet } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { users } from "../db/schema";
import { coreMemoryEdit, type Actor, type AgentContext, type BlockLabel } from "../memory/core-blocks";
import { forgetMemories, rememberFact } from "../memory/facts";
import { entityLookup } from "../memory/entities";
import { searchThreads } from "../memory/episodes";
import { readTags, writeTag, type SlackScope } from "../memory/scope";
import { searchMemory } from "../memory/search";
import { findTasks, formatTasks } from "../manager/find";

type MemoryToolContext = {
  turnId: string;
  userId: string | null;
  channelId: string;
  threadTs?: string;
  scope: SlackScope;
  readOnly: boolean;
  orgConnectionsOnly: boolean;
  agentContext?: AgentContext;
};

async function actorFor(ctx: MemoryToolContext): Promise<Actor> {
  if (!ctx.userId) return { userId: null, role: "bot", agentContext: ctx.agentContext ?? "primary" };
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, ctx.userId));
  return { userId: ctx.userId, role: user?.role ?? "member", agentContext: ctx.agentContext ?? "primary" };
}

export function memoryTools(ctx: MemoryToolContext): ToolSet {
  return {
    core_memory: tool({
      description: "Edit always-on memory blocks (company, channel, user): add, replace or remove one line. Declarative facts only, no instructions or secrets; size-capped.",
      inputSchema: z.object({
        label: z.enum(["company", "channel", "user"]),
        op: z.enum(["add", "replace", "remove"]),
        text: z.string().max(1500).optional(),
        match: z.string().max(500).optional(),
      }),
      execute: async ({ label, op, text, match }) => {
        const result = await coreMemoryEdit({
          scope: ctx.scope, actor: await actorFor(ctx), label: label as BlockLabel, op, text, match,
        });
        if (!result.ok) return `Could not update core memory (${result.usage}): ${result.error}`;
        return result.queuedForReview
          ? `Change queued for admin review. Current block usage: ${result.usage}.`
          : `Core memory updated. Usage: ${result.usage}.`;
      },
    }),
    memory_search: tool({
      description: "Search company memory and past decisions. Results may be outdated. Pass asOf (YYYY-MM-DD) to see what was true on that date instead of now.",
      inputSchema: z.object({
        query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).optional(),
        asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "asOf must be YYYY-MM-DD").optional(),
      }),
      execute: async ({ query, limit, asOf }) => {
        const at = asOf ? new Date(`${asOf.slice(0, 10)}T23:59:59.999Z`) : undefined;
        if (at && Number.isNaN(at.getTime())) return "asOf is not a valid date; use YYYY-MM-DD.";
        const hits = await searchMemory({ tags: await readTags(ctx.scope), query, limit: limit ?? 8, asOf: at });
        return hits.length
          ? hits.map((h) => `- [${h.source}; ${h.createdAt.toISOString().slice(0, 10)}; ${h.scopeTag}${h.factType !== "fact" ? `; ${h.factType}` : ""}${h.validUntil ? `; until ${h.validUntil.toISOString().slice(0, 10)}` : ""}] ${h.text}`).join("\n")
          : "No matching company memory found.";
      },
    }),
    entity_lookup: tool({
      description: "Everything company memory knows about one person, customer, project, product or channel (name or alias, e.g. 'Dana', 'Zephyr Corp'): a summary, current facts and related entities. Use for 'what do we know about X'.",
      inputSchema: z.object({ name: z.string().min(1).max(200), limit: z.number().int().min(1).max(30).optional() }),
      execute: async ({ name, limit }) => {
        const info = await entityLookup({ tags: await readTags(ctx.scope), name, limit });
        if (!info.entities.length && !info.facts.length) return `No accessible memory about "${name}".`;
        const head = info.entities.map((e) => `${e.name} (${e.type})${e.summary ? `: ${e.summary}` : ""}`).join("\n");
        const facts = info.facts.map((f) => `- [${f.source}; ${f.validAt.toISOString().slice(0, 10)}; ${f.scopeTag}${f.factType !== "fact" ? `; ${f.factType}` : ""}] ${f.text}`).join("\n");
        return [head, facts && `Facts:\n${facts}`, info.related.length ? `Related: ${info.related.join(", ")}` : ""].filter(Boolean).join("\n\n");
      },
    }),
    search_threads: tool({
      description: "Search summaries of past threads this conversation may read.",
      inputSchema: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(10).optional() }),
      execute: async ({ query, limit }) => {
        const rows = await searchThreads({ scope: ctx.scope, query, limit, excludeThreadTs: ctx.threadTs });
        return rows.length
          ? rows.map((r) => `- ${r.endedAt.toISOString().slice(0, 10)} in <#${r.channelId}>${r.permalink ? ` (${r.permalink})` : ""}: ${r.summary}`).join("\n")
          : "No matching past threads found.";
      },
    }),
    find_tasks: tool({
      description: "Look up tracked tasks and commitments: who was given a task, who owns X, what is due or overdue, what someone assigned. Filter by text, owner, assigner, channel, status or due range. Read-only; only returns tasks the asker may read. Each row has the owner, assigner, due date, status and a Source link to the original message.",
      inputSchema: z.object({
        query: z.string().max(300).optional().describe("What the task is about"),
        owner: z.string().max(100).optional().describe("Person doing it: Slack id, name, or 'me'"),
        assigner: z.string().max(100).optional().describe("Person who gave it: Slack id, name, or 'me'"),
        channel: z.string().max(100).optional().describe("Channel id"),
        status: z.enum(["open", "overdue", "done", "dropped", "all"]).optional().describe("Default open (open + overdue)"),
        dueAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(), dueBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async (i) => formatTasks(await findTasks({ ...i, scope: ctx.scope, asker: ctx.userId })),
    }),
    forget_memories: tool({
      description: "Find facts to forget. Use dryRun=true first; forget (soft-delete, history is kept) only when the user explicitly asks.",
      inputSchema: z.object({ query: z.string().min(1).max(500), dryRun: z.boolean().optional().default(true) }),
      execute: async ({ query, dryRun }) => {
        const hits = await forgetMemories({ tags: await readTags(ctx.scope), query, dryRun });
        if (!hits.length) return "No matching facts were found.";
        const listed = hits.map((h) => `- [${h.scopeTag}] ${h.text}`).join("\n");
        return dryRun ? `These facts match and can be forgotten if confirmed:\n${listed}` : `Forgot ${hits.length} matching fact(s):\n${listed}`;
      },
    }),
    memory_remember: tool({
      description: "Save one durable, self-contained fact (decision, owner, deadline, preference). Never secrets.",
      inputSchema: z.object({ text: z.string().min(8).max(1000), confidence: z.number().min(0).max(1).optional(), importance: z.number().min(0).max(1).optional() }),
      execute: async ({ text, confidence, importance }) => {
        const tag = writeTag(ctx.scope);
        if (!tag) return "This conversation has no user memory scope, so nothing was saved.";
        const result = await rememberFact({
          tag, text, source: "slack", sourceRef: ctx.threadTs ?? ctx.channelId, createdBy: ctx.userId,
          confidence, importance, agentContext: ctx.agentContext ?? "primary",
        });
        if (result.deduped) return "That fact is already in memory.";
        if (result.heldForReview) return "Saved as pending and sent to admins for review.";
        return `Saved to memory${result.superseded.length ? ` and superseded ${result.superseded.length} outdated fact(s)` : ""}.`;
      },
    }),
  };
}
