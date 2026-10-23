const emit = (level: string) => (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

export const log = { info: emit("info"), warn: emit("warn"), error: emit("error") };

/**
 * Error text that is safe to log: first line only, no URL query strings / credentials, no embedding-sized
 * number arrays (pg errors echo query parameters), capped length.
 */
export function redactError(e: unknown, max = 300): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw
    .split("\n")[0]!
    .replace(/(https?:\/\/[^\s?#"')]+)\?[^\s"')]*/gi, "$1?[redacted]")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@")
    .replace(/\[\s*-?\d+(?:\.\d+)?(?:e-?\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?(?:e-?\d+)?){7,}\s*\]?/gi, "[vector redacted]")
    .replace(/(Bearer|token|secret|api[_-]?key)(["']?\s*[:=]?\s*["']?)[A-Za-z0-9._\-]{12,}/gi, "$1$2[redacted]")
    .slice(0, max);
}
