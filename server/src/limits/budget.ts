import { getLimits } from "./settings";

export const CEILING_MESSAGE = "This request used more than the per-request usage limit, so I stopped. Try a narrower question, or ask an admin to raise the limit under Usage & limits.";

/**
 * Per-turn token budget. Feed it each finished step's usage; once the running total reaches the ceiling `signal`
 * aborts (pass it as `abortSignal` to the model call) and `exceeded` stays true. ceiling 0 = unlimited.
 */
export class TurnBudget {
  readonly controller = new AbortController();
  used = 0;
  exceeded = false;
  constructor(readonly ceiling: number) {}
  get signal() { return this.controller.signal; }
  add(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): boolean {
    if (!usage) return this.exceeded;
    this.used += usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (this.ceiling > 0 && this.used >= this.ceiling && !this.exceeded) {
      this.exceeded = true;
      this.controller.abort(new Error("per-turn token ceiling reached"));
    }
    return this.exceeded;
  }
}

export async function createTurnBudget(): Promise<TurnBudget> {
  return new TurnBudget((await getLimits()).perTurnTokenCeiling);
}
