import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { sanitizeForSlack } from "../slack/sanitize";
import { requestAutomationApproval } from "../turn/approval";
import type { ToolContext } from "../turn/tools";
import { type Actor, type Automation, RESEARCH_PREFIX, getRole, listAutomations, validateCreate } from "./automations";

const fmt = (a: Automation) =>
  `${a.id} [${a.kind}${a.prompt.startsWith(RESEARCH_PREFIX) ? "/research" : ""}] ${a.cron ? `cron "${a.cron}" UTC` : `at ${a.runAt?.toISOString()}`}` +
  ` -> ${a.destChannelId ? `<#${a.destChannelId}>` : "DM"}${a.enabled ? "" : " (done/disabled)"}: ${a.prompt.slice(0, 80)}`;

/** ai tools for the turn module. Errors are returned as text so the model can relay them. */
export function automationTools(ctx: ToolContext): ToolSet {
  const actor = async (): Promise<Actor | null> =>
    ctx.userId ? { userId: ctx.userId, role: await getRole(ctx.userId), source: "slack", inChannelId: ctx.channelId } : null;
  const guard = async <T>(fn: (a: Actor) => Promise<T>): Promise<T | string> => {
    const a = await actor();
    if (!a) return "Can't do this: the asker's identity is unknown.";
    try {
      return await fn(a);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  return {
    schedule_automation: tool({
      description:
        "Schedule a reminder (posts the asker's text back) or a recurring digest (read-only recap from org-shared tools and memory). Give exactly one timing: cron (5-field, UTC, at least every 3 minutes) or runAt (ISO datetime, future). Set research=true on a digest to run a research pass each time (watchlist). destination: 'dm' (default, asker's DM), 'here' (this channel) or a channel id.",
      inputSchema: z.object({
        kind: z.enum(["reminder", "digest"]),
        prompt: z.string().describe("Reminder text, or the digest instruction / research question."),
        cron: z.string().optional(),
        runAt: z.string().optional(),
        destination: z.string().optional(),
        research: z.boolean().optional(),
      }),
      execute: async (i) =>
        guard(async (a) => {
          const dest = !i.destination || i.destination === "dm" ? null : i.destination === "here" ? ctx.channelId : i.destination;
          // broadcast mentions / hidden link markup in a stored prompt would fire on every run: neutralise now
          const input = {
            kind: i.kind,
            prompt: sanitizeForSlack(i.research && i.kind === "digest" ? RESEARCH_PREFIX + i.prompt : i.prompt),
            cron: i.cron,
            runAt: i.runAt,
            destChannelId: dest,
          };
          await validateCreate(input, a); // fail early with a useful error instead of asking a human to approve something invalid
          const { approvalId } = await requestAutomationApproval({
            turnId: ctx.turnId, requesterId: a.userId, channelId: ctx.channelId, threadTs: ctx.threadTs,
            op: "schedule", input: { ...input, cron: input.cron ?? null, runAt: input.runAt ?? null }, actorRole: a.role,
          });
          return { status: "awaiting_approval", approvalId, instruction: "An approval card was posted. Tell the user briefly that nothing is scheduled until they approve, then stop. Do not retry." };
        }),
    }),
    list_automations: tool({
      description: "List the asker's scheduled reminders and digests (admins see everyone's).",
      inputSchema: z.object({}),
      execute: async () =>
        guard(async (a) => {
          const rows = await listAutomations(a);
          return rows.length ? rows.map(fmt).join("\n") : "No automations.";
        }),
    }),
    cancel_automation: tool({
      description: "Cancel (delete) a reminder or digest by id. Call list_automations first to get the id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) =>
        guard(async (a) => {
          const own = (await listAutomations(a)).find((x) => x.id === id);
          if (!own) throw new Error("automation not found");
          const { approvalId } = await requestAutomationApproval({
            turnId: ctx.turnId, requesterId: a.userId, channelId: ctx.channelId, threadTs: ctx.threadTs,
            op: "cancel", input: { id, summary: fmt(own).slice(0, 400) }, actorRole: a.role,
          });
          return { status: "awaiting_approval", approvalId, instruction: "An approval card was posted. Tell the user briefly that nothing is cancelled until they approve, then stop. Do not retry." };
        }),
    }),
  };
}
