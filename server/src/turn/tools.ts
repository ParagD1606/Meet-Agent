import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { config } from "../config";
import { log } from "../log";
import { buildMcpTools } from "../mcp/tools";
import { PRESETS } from "../mcp/catalog";
import { addFact } from "../memory/supersede";
import { readTags, writeTag, type SlackScope } from "../memory/scope";
import { searchMemory } from "../memory/search";
import { automationTools } from "../automations";
import { researchTools } from "../research";
import { loadSkill } from "../skills/skills";
import { searchPeople } from "../slack/people";
import { extractUrl } from "../tools/web/extract";
import { webSearch } from "../tools/web/search";
import { leaseCandidates, requestLease } from "./lease";

export type ToolContext = {
  turnId: string;
  userId: string | null;
  channelId: string;
  threadTs?: string;
  scope: SlackScope;
  readOnly: boolean;
  orgConnectionsOnly: boolean;
};

const MAX_EXTRACT_URLS = 3;

/** Core + MCP tools for one turn. `notes` are human-readable availability remarks for the system prompt. */
export async function assembleTools(ctx: ToolContext): Promise<{ tools: ToolSet; notes: string[] }> {
  const tools: ToolSet = {
    memory_search: tool({
      description: "Search the company's long-term memory (decisions, owners, deadlines, documents) visible in this conversation.",
      inputSchema: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).optional() }),
      execute: async ({ query, limit }) => {
        try {
          const hits = await searchMemory({ tags: await readTags(ctx.scope), query, limit: limit ?? 8 });
          return hits.length ? hits.map((h) => `- (${h.source}, ${h.createdAt.toISOString().slice(0, 10)}) ${h.text}`).join("\n") : "No matching memories.";
        } catch (e) { return `Memory search unavailable: ${e instanceof Error ? e.message : String(e)}`; }
      },
    }),
    web_search: tool({
      description: "Search the public web for external facts, news, docs.",
      inputSchema: z.object({ query: z.string().min(1).max(500) }),
      execute: async ({ query }) => {
        const r = await webSearch(query);
        if (!r.results.length) return r.message ?? "No results.";
        return r.results.map((x) => `- ${x.title}\n  ${x.url}\n  ${x.snippet}`).join("\n");
      },
    }),
    web_extract: tool({
      description: `Read the text of public web pages by URL (up to ${MAX_EXTRACT_URLS}). Private/internal addresses are blocked.`,
      inputSchema: z.object({ urls: z.array(z.string().url()).min(1).max(MAX_EXTRACT_URLS) }),
      execute: async ({ urls }) =>
        (await Promise.all(urls.map(async (u) => {
          try { const p = await extractUrl(u); return `## ${p.title || p.url}\n${p.url}\n\n${p.text}`; }
          catch (e) { return `## ${u}\nCould not read this page: ${e instanceof Error ? e.message : String(e)}`; }
        }))).join("\n\n---\n\n"),
    }),
    people_search: tool({
      description: "Find teammates by name, title or email. Returns Slack user ids.",
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
      execute: async ({ query }) => {
        const r = await searchPeople(query);
        return r.length ? r.map((p) => `- ${p.name ?? "?"} <@${p.id}>${p.title ? `, ${p.title}` : ""}`).join("\n") : "No matches.";
      },
    }),
    load_skill: tool({
      description: "Load the full instructions of one of the available skills by name.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => (await loadSkill(name)) ?? `No skill named "${name}".`,
    }),
  };

  if (!ctx.readOnly) {
    tools.memory_remember = tool({
      description: "Save one durable fact (decision, owner, deadline, preference) to memory. Only for things worth remembering later.",
      inputSchema: z.object({ text: z.string().min(3).max(1000) }),
      execute: async ({ text }) => {
        const tag = writeTag(ctx.scope);
        if (!tag) return "Cannot save memory in this context.";
        const r = await addFact({ tag, text, source: "slack" });
        return `Saved (id ${r.id}).`;
      },
    });
    if (!ctx.orgConnectionsOnly) {
      tools.request_connection = tool({
        description: "Ask the user to connect an app (e.g. github, linear, notion) so you can use it. Returns the page where they can do it.",
        inputSchema: z.object({ provider: z.string().describe(`One of: ${PRESETS.map((p) => p.key).join(", ")}, or a custom MCP server`) }),
        execute: async ({ provider }) =>
          `Tell the user to connect ${provider} at ${config.PUBLIC_URL.replace(/\/$/, "")}/configure/integrations (or via the Home tab), then ask again.`,
      });
      tools.request_teammate_access = tool({
        description: "When nobody in this context has the needed app connected but a teammate does, ask that teammate to allow ONE read-only request. Resumes automatically if they allow.",
        inputSchema: z.object({ provider: z.string(), reason: z.string().max(300), ownerUserId: z.string().optional() }),
        execute: async ({ provider, reason, ownerUserId }) => {
          if (!ctx.userId) return "ERROR: no requesting user.";
          const cands = await leaseCandidates(provider, ctx.userId);
          if (!cands.length) return `Nobody has ${provider} connected. Use request_connection instead.`;
          const pick = ownerUserId ? cands.find((c) => c.ownerUserId === ownerUserId) : cands.length === 1 ? cands[0] : undefined;
          if (!pick) return `Several teammates have it: ${cands.map((c) => `${c.name} (${c.ownerUserId})`).join(", ")}. Ask the user whom to ask, then call again with ownerUserId.`;
          try {
            await requestLease({ connectionId: pick.connectionId, requesterId: ctx.userId, turnId: ctx.turnId, reason });
            return `Asked ${pick.name ?? "the owner"} for one-time access. Tell the user you'll continue as soon as they allow it, then stop.`;
          } catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
        },
      });
    }
    Object.assign(tools, await automationTools(ctx), await researchTools(ctx));
  }

  const mcp = await buildMcpTools(ctx).catch((e) => { log.warn("mcp tools failed", { error: String(e) }); return { tools: {} as ToolSet, notes: [] as string[] }; });
  Object.assign(tools, mcp.tools);
  return { tools, notes: mcp.notes };
}

export async function buildTools(ctx: ToolContext): Promise<ToolSet> {
  return (await assembleTools(ctx)).tools;
}
