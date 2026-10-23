import { tool, type ToolSet } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { mcpConnections } from "../db/schema";
import { log } from "../log";
import { buildMcpTools } from "../mcp/tools";
import { PRESETS } from "../mcp/catalog";
import type { AgentContext } from "../memory/core-blocks";
import type { SlackScope } from "../memory/scope";
import { automationTools } from "../automations";
import { researchTools } from "../research";
import { loadSkill } from "../skills/skills";
import { searchPeople } from "../slack/people";
import { slackSearchTools } from "../slack/search";
import { extractUrl } from "../tools/web/extract";
import { webSearch } from "../tools/web/search";
import { allowedUrls } from "../tools/web";
import { grantedLeases, leaseCandidates, requestLease } from "./lease";
import { memoryTools } from "./memory-tools";
import { readToolResultTool } from "./spill";
import { allowedFamilies, likelyFamilies, type Depth, type ToolFamily } from "./depth";
import { createProgressTools } from "./progress";
import type { Trigger } from "./prompt";

export type ToolContext = {
  turnId: string;
  userId: string | null;
  channelId: string;
  threadTs?: string;
  scope: SlackScope;
  readOnly: boolean;
  orgConnectionsOnly: boolean;
  agentContext?: AgentContext;
  trigger?: Trigger;
  depth?: Depth;
  /** Set when personal/leased data entered this turn: shared memory capture and web_extract are then off. */
  touchedPrivateData?: boolean;
};

const MAX_EXTRACT_URLS = 3;
const FAMILY_NAMES = ["web", "slack_search", "automations", "research"] as const;

export type Assembled = {
  tools: ToolSet;
  notes: string[];
  /** Tool names the model may see right now. Grows when the model calls enable_tool_family. */
  active: () => string[];
  families: Record<ToolFamily, string[]>;
};

/**
 * All tools this turn could use, grouped so the model only SEES what the depth/trigger needs:
 *   direct/memory -> none; tools -> core + families the text suggests + enable_tool_family; deep -> core + every allowed family.
 * Unattended triggers (chime/automation/research) get a minimal read-only set; readOnly never includes a write tool.
 */
export async function assembleTools(ctx: ToolContext, o: { depth?: Depth; text?: string; narrate?: (text: string) => Promise<boolean> } = {}): Promise<Assembled> {
  const depth = o.depth ?? ctx.depth ?? "deep";
  const trigger = ctx.trigger ?? "mention";
  const unattended = trigger === "chime" || trigger === "automation" || trigger === "research";
  const writable = !ctx.readOnly && !unattended;
  const core: ToolSet = {};
  const fam: Record<ToolFamily, ToolSet> = { web: {}, slack_search: {}, automations: {}, research: {} };

  // memory: reads always; writes (core_memory, memory_remember, forget_memories) never on readOnly
  const mem = memoryTools(ctx as never);
  for (const [k, t] of Object.entries(mem)) if (writable || k === "memory_search" || k === "search_threads") core[k] = t;
  Object.assign(core, readToolResultTool(ctx));

  core.people_search = tool({
    description: "Find teammates by name, title or email. Returns Slack user ids.",
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    execute: async ({ query }) => {
      const r = await searchPeople(query);
      return r.length ? r.map((p) => `- ${p.name ?? "?"} <@${p.id}>${p.title ? `, ${p.title}` : ""}`).join("\n") : "No matches.";
    },
  });
  core.load_skill = tool({
    description: "Load a skill's full instructions by name.",
    inputSchema: z.object({ name: z.string().min(1) }),
    execute: async ({ name }) => (await loadSkill(name)) ?? `No skill named "${name}".`,
  });

  if (writable && !ctx.orgConnectionsOnly) {
    core.request_connection = tool({
      description: "Ask the user to connect an app (github, linear, notion...).",
      inputSchema: z.object({ provider: z.string().describe(`One of: ${PRESETS.map((p) => p.key).join(", ")}, or a custom MCP server`) }),
      execute: async ({ provider }) =>
        `Tell the user to connect ${provider} at ${config.PUBLIC_URL.replace(/\/$/, "")}/configure/integrations (or via the Home tab), then ask again.`,
    });
    core.request_teammate_access = tool({
      description: "Ask a teammate who has an app connected to allow ONE read-only request for the asker.",
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

  // ---- rare families ----
  fam.web.web_search = tool({
    description: "Search the public web.",
    inputSchema: z.object({ query: z.string().min(1).max(500) }),
    execute: async ({ query }) => {
      const r = await webSearch(query);
      if (!r.results.length) return r.message ?? "No results.";
      return r.results.map((x) => `- ${x.title}\n  ${x.url}\n  ${x.snippet}`).join("\n");
    },
  });
  fam.web.web_extract = tool({
    description: `Read public web pages by URL (up to ${MAX_EXTRACT_URLS}).`,
    inputSchema: z.object({ urls: z.array(z.string().url()).min(1).max(MAX_EXTRACT_URLS) }),
    execute: async ({ urls }) => {
      const verdict = allowedUrls(ctx as never, urls) as { ok: boolean; error?: string; urls?: string[] } | boolean;
      if (verdict === false || (typeof verdict === "object" && !verdict.ok)) {
        return `ERROR: ${typeof verdict === "object" && verdict.error ? verdict.error : "page reading is limited to links the user shared or search results, and is off once private data was used this turn."}`;
      }
      const list = typeof verdict === "object" && verdict.urls ? verdict.urls : urls;
      return (await Promise.all(list.map(async (u) => {
        try { const p = await extractUrl(u); return `## ${p.title || p.url}\n${p.url}\n\n${p.text}`; }
        catch (e) { return `## ${u}\nCould not read this page: ${e instanceof Error ? e.message : String(e)}`; }
      }))).join("\n\n---\n\n");
    },
  });
  Object.assign(fam.slack_search, slackSearchTools({ userId: ctx.userId }));
  if (writable) {
    Object.assign(fam.automations, await automationTools(ctx as never));
    Object.assign(fam.research, await researchTools(ctx as never));
  }

  // ---- MCP (D owns lazy tool-search for big servers) ----
  const mcp = await buildMcpTools(ctx).catch((e) => { log.warn("mcp tools failed", { error: String(e) }); return { tools: {} as ToolSet, notes: [] as string[] }; });
  if (!ctx.orgConnectionsOnly && ctx.userId && !ctx.touchedPrivateData && Object.keys(mcp.tools).length) {
    // Fail closed: if the asker has personal connections or leases, any app call may carry private data.
    const personal = await db.select({ id: mcpConnections.id }).from(mcpConnections)
      .where(and(eq(mcpConnections.status, "connected"), eq(mcpConnections.scope, "user"), eq(mcpConnections.ownerUserId, ctx.userId))).limit(1);
    const leased = personal.length ? [] : await grantedLeases(ctx.userId).catch(() => []);
    if (personal.length || leased.length) {
      for (const [k, t] of Object.entries(mcp.tools)) {
        const exec = (t as { execute?: (...a: unknown[]) => unknown }).execute;
        if (exec) mcp.tools[k] = { ...t, execute: (...a: unknown[]) => { ctx.touchedPrivateData = true; return exec(...a); } } as typeof t;
      }
    }
  }
  Object.assign(core, mcp.tools);

  const allowed = new Set(allowedFamilies(trigger, ctx.readOnly));
  const enabled = new Set<ToolFamily>(depth === "deep" || unattended ? [...allowed] : likelyFamilies(o.text ?? "").filter((f) => allowed.has(f)));
  const families = Object.fromEntries(FAMILY_NAMES.map((f) => [f, Object.keys(fam[f])])) as Record<ToolFamily, string[]>;

  const tools: ToolSet = { ...core };
  for (const f of FAMILY_NAMES) if (allowed.has(f)) Object.assign(tools, fam[f]);
  const extras = depth === "deep" || unattended ? {} : {
    enable_tool_family: tool({
      description: `Turn on a rare tool family for the next step: ${[...allowed].join(", ")}.`,
      inputSchema: z.object({ family: z.enum(FAMILY_NAMES) }),
      execute: async ({ family }) => {
        if (!allowed.has(family)) return `ERROR: ${family} is not available in this context.`;
        enabled.add(family);
        return `${family} enabled: ${families[family].join(", ") || "no tools"}. Use them now.`;
      },
    }),
  };
  const progress = createProgressTools(o.narrate);
  Object.assign(tools, extras, progress);

  const active = (): string[] => {
    if (depth === "direct" || depth === "memory") return [];
    const names = [...Object.keys(core), ...Object.keys(extras), ...Object.keys(progress)];
    for (const f of enabled) names.push(...families[f]);
    return names;
  };
  return { tools, notes: mcp.notes, active, families };
}

/** Every tool a turn of this shape could use, for callers that run their own loop (research sub-questions, tests). */
export async function buildTools(ctx: ToolContext): Promise<ToolSet> {
  return (await assembleTools(ctx, { depth: "deep" })).tools;
}
