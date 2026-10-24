/** Read retries: `retries` extra attempts, waiting backoffMs * attempt between them. Mutable so tests can zero the wait. */
export const retryPolicy = { retries: 2, backoffMs: 300 };

/**
 * Runs `fn`; on a transient error retries (default: once, immediately). ONLY for idempotent calls (MCP reads and tool listing):
 * writes go through the approval card path and are never auto-retried.
 */
export async function withResetRetry<T>(
  fn: () => Promise<T>, isTransient: (e: unknown) => boolean, onRetry?: () => void, o: { retries?: number; backoffMs?: number } = {},
): Promise<T> {
  const retries = o.retries ?? 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt > retries || !isTransient(e)) throw e;
      onRetry?.();
      if (o.backoffMs) await new Promise((r) => setTimeout(r, o.backoffMs! * attempt));
    }
  }
}
