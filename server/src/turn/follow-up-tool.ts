import { tool } from "ai";
import { z } from "zod";
import { createFollowUp, FollowUpError, proposeFollowUp } from "../manager/followups";
import { searchPeople } from "../slack/people";
import type { ToolContext } from "./tools";

/**
 * "Remind me Friday to check with Dana" / "follow up with @Bob on the invoice in 3 days". No approval card: a reminder only DMs
 * the requester. A follow-up to someone else shows the requester a consent card first (manager/followups.ts), so nobody is
 * messaged without the requester's explicit yes.
 */
export function scheduleFollowUpTool(ctx: ToolContext) {
  return tool({
    description: "Schedule a DM follow-up. `text` is only the message content: no greeting or sign-off (the DM adds its own). Without `person`, DMs the asker at the time (a reminder). With `person`, posts a consent card and DMs that person only after the asker confirms. `at` is an ISO 8601 datetime WITH timezone offset (resolve 'Friday', 'in 3 days' from the current time); DMs are only delivered. `repeatEveryDays` makes it recurring (1-90). Tell the asker what you scheduled; for a person, say you are waiting for their OK on the card.",
    inputSchema: z.object({
      text: z.string().min(3).max(500).describe("What to remind or follow up about. Plain words; it is DMed verbatim."),
      at: z.string().describe("ISO 8601 datetime with offset, e.g. 2026-06-12T09:00:00+05:30"),
      person: z.string().max(100).optional().describe("Slack id or name of who to follow up with; omit to remind the asker"),
      repeatEveryDays: z.number().int().min(1).max(90).optional(),
    }),
    execute: async ({ text, at, person, repeatEveryDays }) => {
      if (!ctx.userId) return "ERROR: no asker to schedule for.";
      let targetId: string | null = null;
      if (person) {
        const found = await searchPeople(person, 5);
        if (found.length > 1) return `Several people match "${person}": ${found.map((p) => `${p.name} <@${p.id}>`).join(", ")}. Ask the asker which one, or retry with an id.`;
        targetId = found[0]?.id ?? null;
        if (!targetId) return `I couldn't find anyone called "${person}".`;
        if (targetId === ctx.userId) targetId = null; // following up with yourself is a reminder
      }
      try {
        const f = await createFollowUp({ ownerId: ctx.userId, targetId, text, at, repeatDays: repeatEveryDays, origin: { channelId: ctx.channelId, threadTs: ctx.threadTs } });
        if (f.status === "proposed") {
          await proposeFollowUp(f);
          return `Posted a consent card asking the asker whether to follow up with <@${f.targetId}> on ${f.dueAt.toISOString()}. Nothing is sent until they click yes; tell them briefly you are waiting for their OK.`;
        }
        return `Scheduled ${f.id}: DM to the asker at ${f.dueAt.toISOString()}${f.repeatDays ? `, repeating every ${f.repeatDays} day(s)` : ""}. They can list or cancel it with /brain-followups.`;
      } catch (e) {
        if (e instanceof FollowUpError) return `Could not schedule: ${e.message}`;
        throw e;
      }
    },
  });
}
