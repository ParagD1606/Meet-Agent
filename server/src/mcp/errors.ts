export type ToolErrorKind = "reauth" | "rate_limited" | "timeout" | "server_error" | "not_found" | "invalid_input" | "transient" | "tool_error";

/** Structured, model-readable tool failure. `status:"error"` is what loops/UI key on. */
export type McpToolError = {
  status: "error"; kind: ToolErrorKind; tool: string; message: string; suggestion: string; retryable: boolean;
};

const SUGGEST: Record<ToolErrorKind, [string, boolean]> = {
  reauth: ["Tell the user to reconnect this app in Integrations (or ask for the Connect button). Do not retry.", false],
  rate_limited: ["The app is rate limiting us. Wait and tell the user; do not loop retries.", true],
  timeout: ["The app was too slow. Retry once with a narrower request (smaller limit, tighter filter).", true],
  server_error: ["The app's server failed. Retry once; if it persists, tell the user it is down.", true],
  not_found: ["The item or tool does not exist. Check the id/name via a search or list call.", false],
  invalid_input: ["Fix the arguments (see the message) and retry once.", false],
  transient: ["Connection dropped. Retry once.", true],
  tool_error: ["The app rejected the request. Read the message, adjust, or explain it to the user.", false],
};

const text = (e: unknown) => (e instanceof Error ? `${e.name} ${e.message}` : String(e));

/** Transport-level blips worth exactly one silent retry (reads only). */
export const isTransientError = (e: unknown): boolean =>
  /ECONNRESET|EPIPE|socket hang up|fetch failed|terminated|connection (closed|reset)|network|\b50[234]\b|bad gateway|service unavailable|gateway time-?out/i.test(
    typeof e === "string" ? e : text(e),
  );

export function classifyError(e: unknown): ToolErrorKind {
  const t = typeof e === "string" ? e : text(e);
  if (/McpReauthRequired|Unauthorized|\b401\b|\b403\b|invalid_token|reconnect/i.test(t)) return "reauth";
  if (/\b429\b|rate.?limit|too many requests/i.test(t)) return "rate_limited";
  if (/timed? ?out|timeout|AbortError|ETIMEDOUT/i.test(t)) return "timeout";
  if (/\b5\d\d\b|internal server error|bad gateway|unavailable/i.test(t)) return "server_error";
  if (isTransientError(t)) return "transient";
  if (/\b404\b|not found|unknown tool|no such/i.test(t)) return "not_found";
  if (/\b400\b|\b422\b|invalid|required|validation/i.test(t)) return "invalid_input";
  return "tool_error";
}

export function toolError(tool: string, e: unknown, kind: ToolErrorKind = classifyError(e)): McpToolError {
  const [suggestion, retryable] = SUGGEST[kind];
  const raw = e instanceof Error ? e.message : String(e);
  return { status: "error", kind, tool, message: raw.replace(/^ERROR:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 500), suggestion, retryable };
}

export const isToolError = (v: unknown): v is McpToolError =>
  !!v && typeof v === "object" && (v as McpToolError).status === "error" && typeof (v as McpToolError).kind === "string";
