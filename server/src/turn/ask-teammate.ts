import { tool } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { users } from "../db/schema";
import { readTags } from "../memory/scope";
import { searchMemory } from "../memory/search";
import { searchPeople } from "../slack/people";
import { proposeAsk } from "../slack/teammate";
import type { ToolContext } from "./tools";

/**
 * Likely owner of a topic: the human who authored the most relevant facts the asker may read (fact `created_by`),
 * weighted by hit score. ponytail: authorship only; add entities.owner edges when the graph carries them.
 */
export async function findOwner(a: { ctx: Pick<ToolContext, "scope" | "userId">; question: string }): Promise<string | null> {
  const hits = await searchMemory({ tags: await readTags(a.ctx.scope), query: a.question, limit: 10 });
  const score = new Map<string, number>();
  for (const h of hits) if (h.createdBy && /^[UW][A-Z0-9]{6,}$/.test(h.createdBy) && h.createdBy !== a.ctx.userId) score.set(h.createdBy, (score.get(h.createdBy) ?? 0) + h.score);
  const ids = [...score.keys()];
  if (!ids.length) return null;
  const live = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.isBot, false), eq(users.deactivated, false)));
  return live.map((u) => u.id).sort((x, y) => score.get(y)! - score.get(x)!)[0] ?? null;
}

/** Near-miss argument names the model tends to emit; the first present alias fills the canonical field. */
export const withAliases = <T extends z.ZodType>(schema: T, aliases: Record<string, string[]>) =>
  z.preprocess((v) => {
    if (!v || typeof v !== "object") return v;
    const o = { ...(v as Record<string, unknown>) };
    for (const [k, alts] of Object.entries(aliases)) if (o[k] === undefined) { const a = alts.find((x) => o[x] !== undefined); if (a) o[k] = o[a]; }
    return o;
  }, schema);
export const askTeammateAliases = <T extends z.ZodType>(schema: T) => withAliases(schema, { person: ["recipient", "to", "user"], question: ["message", "text"] });

export function askTeammateTool(ctx: ToolContext) {
  return tool({
    description: "Use when memory and tools cannot answer: ask a teammate the question. This only shows the asker a consent card; nothing is sent until they confirm. Give `person` (a Slack id from people_search/entity_lookup) when you know the owner, otherwise the likely owner is inferred from who wrote the related facts. The question must stand alone and contain no private details.",
    inputSchema: askTeammateAliases(z.object({ question: z.string().min(8).max(500), person: z.string().max(100).optional().describe("Slack user id or a name") })),
    execute: async ({ question, person }) => {
      if (!ctx.userId) return "ERROR: no asker to get consent from.";
      let owner: string | null = null;
      if (person) {
        const found = await searchPeople(person.replace(/^@/, ""), 5);
        if (found.length > 1) return `Several people match "${person}": ${found.map((p) => `${p.name} <@${p.id}>`).join(", ")}. Ask the asker which one, or retry with an id.`;
        owner = found[0]?.id ?? null;
      } else owner = await findOwner({ ctx, question });
      if (!owner) return "I could not tell who would know. Tell the asker, and suggest a channel or person to try.";
      if (owner === ctx.userId) return "ERROR: the asker is the person you picked; answer or look elsewhere.";
      await proposeAsk({ asker: ctx.userId, owner, question, origin: { channelId: ctx.channelId, threadTs: ctx.threadTs, isPrivate: ctx.scope.isPrivate, isIm: ctx.scope.isIm } });
      return `Posted a consent card asking the asker whether to ask <@${owner}>. Tell them briefly you are waiting for their OK; the answer will come back in this thread.`;
    },
  });
}
