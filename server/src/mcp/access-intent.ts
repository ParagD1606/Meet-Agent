import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { leaseCandidates, requestLease } from "../turn/lease";

const DENIAL = [
  /\b(?:i|we)\s+(?:do\s+not|don['’]?t|dont)\s+have(?:\s+[\p{L}\p{N}_-]+){0,5}\s+(?:access|permissions?|account)\b/iu,
  /\b(?:i|we)\s+have\s+no(?:\s+[\p{L}\p{N}_-]+){0,5}\s+(?:access|permissions?|account)\b/iu,
  /\b(?:i|we)\s+(?:can['’]?t|cant|cannot|can\s+not|couldn['’]?t|couldnt)\s+(?:access|authorize|authenticate|log\s*in|sign\s*in)\b/iu,
  /\b(?:access|permissions?)\s+(?:(?:is|was|got)\s+)?denied\b/iu,
  /\b(?:i(?:['’]?m|\s+am)|we(?:['’]?re|\s+are))\s+not\s+(?:authorized|permitted|a\s+member)\b/iu,
];

/**
 * True only when the requester says they cannot use their own account in the app. "I haven't connected it"
 * deliberately does NOT match: a missing connection is fixed by Connect, not by borrowing a teammate's access.
 */
export function requesterLacksPersonalAppAccess(text: string | undefined): boolean {
  const t = text?.normalize("NFKC").trim();
  return !!t && DENIAL.some((p) => p.test(t));
}

/**
 * `request_teammate_access`, offered only when the requester's message says they lack access to the app itself.
 * Pass the latest requester message as `requestText`; returns {} otherwise (so the schema costs no tokens).
 */
export function teammateAccessTools(
  ctx: { turnId: string; userId: string | null; readOnly: boolean; orgConnectionsOnly: boolean },
  requestText: string | undefined,
): ToolSet {
  if (ctx.readOnly || ctx.orgConnectionsOnly || !ctx.userId || !requesterLacksPersonalAppAccess(requestText)) return {};
  const userId = ctx.userId;
  return {
    request_teammate_access: tool({
      description: "Ask a teammate who has the app to allow ONE read-only request for the user, who lacks access themselves.",
      inputSchema: z.object({ provider: z.string(), reason: z.string().max(300), ownerUserId: z.string().optional() }),
      execute: async ({ provider, reason, ownerUserId }) => {
        const cands = await leaseCandidates(provider, userId);
        if (!cands.length) return `Nobody has ${provider} connected.`;
        const pick = ownerUserId ? cands.find((c) => c.ownerUserId === ownerUserId) : cands.length === 1 ? cands[0] : undefined;
        if (!pick) return `Several teammates have it: ${cands.map((c) => `${c.name} (${c.ownerUserId})`).join(", ")}. Ask the user whom, then call again with ownerUserId.`;
        try {
          await requestLease({ connectionId: pick.connectionId, requesterId: userId, turnId: ctx.turnId, reason });
          return `Asked ${pick.name ?? "the owner"} for one-time access. Tell the user you'll continue once they allow it, then stop.`;
        } catch (e) { return `ERROR: ${e instanceof Error ? e.message : String(e)}`; }
      },
    }),
  };
}
