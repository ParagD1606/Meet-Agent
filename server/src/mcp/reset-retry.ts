/**
 * Runs `fn`; on a transient error retries exactly once. ONLY for idempotent calls (MCP reads):
 * writes go through the approval card path and are never auto-retried.
 */
export async function withResetRetry<T>(fn: () => Promise<T>, isTransient: (e: unknown) => boolean, onRetry?: () => void): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isTransient(e)) throw e;
    onRetry?.();
    return await fn();
  }
}
