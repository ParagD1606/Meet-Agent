import { JOURNEY_RUNGS, type JourneyRung, type RungState } from "./rungs";

export const MIN_NUDGE_GAP_MS = 24 * 60 * 60 * 1000; // max one nudge per user per day
export const MAX_NUDGES_PER_RUNG = 2; // two unanswered asks for a rung = they said no by silence

export type JourneyData = {
  quiet?: boolean;
  exited?: "completed" | "ignored" | "quiet";
  lastNudgeAt?: string;
  nudges?: Partial<Record<JourneyRung, number>>;
  welcomedAt?: string;
};

export type Decision =
  | { action: "send"; rung: JourneyRung }
  | { action: "suppress"; reason: "quiet" | "exited" | "rate_limited" }
  | { action: "exit"; reason: "completed" | "ignored" };

/** Pure: decide whether (and what) to nudge a user right now. */
export function decideNudge(data: JourneyData, state: RungState, nowMs: number): Decision {
  if (data.exited) return { action: "suppress", reason: "exited" };
  if (data.quiet) return { action: "suppress", reason: "quiet" };
  const open = JOURNEY_RUNGS.filter((r) => !state[r]);
  if (!open.length) return { action: "exit", reason: "completed" };
  const askable = open.filter((r) => (data.nudges?.[r] ?? 0) < MAX_NUDGES_PER_RUNG);
  if (!askable.length) return { action: "exit", reason: "ignored" };
  const last = data.lastNudgeAt ? Date.parse(data.lastNudgeAt) : null;
  if (last !== null && nowMs - last < MIN_NUDGE_GAP_MS) return { action: "suppress", reason: "rate_limited" };
  return { action: "send", rung: askable[0]! };
}
