import { getLimits } from "./settings";

let active = 0;
const waiters: (() => void)[] = [];

/**
 * Global cap on turns running at once in this process (admin setting `concurrentTurns`).
 * Resolves true when a slot is held (caller MUST releaseTurnSlot in finally), false if none freed within waitMs.
 */
export async function acquireTurnSlot(waitMs = 30_000): Promise<boolean> {
  const cap = (await getLimits()).concurrentTurns;
  if (active < cap) { active++; return true; }
  return new Promise<boolean>((resolve) => {
    const wake = () => { clearTimeout(t); active++; resolve(true); };
    const t = setTimeout(() => {
      const i = waiters.indexOf(wake);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, waitMs);
    waiters.push(wake);
  });
}

export function releaseTurnSlot(): void {
  if (active > 0) active--;
  // a raised cap can also admit several waiters at once
  void getLimits().then((l) => { while (waiters.length && active < l.concurrentTurns) waiters.shift()!(); });
}

export const activeTurnSlots = () => active;
export const BUSY_MESSAGE = "I'm handling a lot of requests right now. Please try again in a minute.";
/** Test hook. */
export const resetTurnSlots = () => { active = 0; waiters.length = 0; };
