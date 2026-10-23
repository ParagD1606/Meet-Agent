import type { TurnInput } from "../turn";

/**
 * The only seam to the TURN module. Lazy so Slack boots (and tests run) even if the turn
 * module is unavailable; tests replace these fields.
 */
export const deps = {
  runTurn: async (input: TurnInput): Promise<void> => (await import("../turn")).runTurn(input),
  handleBlockAction: async (payload: unknown): Promise<boolean> =>
    (await import("../turn/approval")).handleBlockAction(payload as never),
};
export type { TurnInput };
