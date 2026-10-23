export type ToolKind = "read" | "write";
export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown } | undefined;

const tokens = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const READ = new Set([
  "analyze", "check", "count", "describe", "export", "fetch", "find", "get", "history", "info", "inspect", "list",
  "lookup", "query", "read", "report", "resolve", "retrieve", "search", "show", "status", "view", "whoami",
]);
const WRITE = new Set([
  "add", "approve", "archive", "assign", "cancel", "close", "comment", "create", "delete", "deploy", "disable",
  "edit", "enable", "exec", "execute", "invite", "merge", "move", "post", "publish", "push", "release", "remove",
  "rename", "reopen", "reply", "restart", "revoke", "run", "save", "send", "set", "transfer", "trigger",
  "unarchive", "update", "upload", "upsert", "write",
]);

/**
 * Deterministic and fail-closed: anything we cannot positively identify as a read is a write.
 * Order: destructiveHint -> write; trusted readOnlyHint -> read; write verb -> write; read verb -> read; else write.
 * `description` is deliberately ignored (server-controlled text can't downgrade a tool's risk).
 */
export function classifyTool(
  name: string,
  _description: string | undefined,
  annotations?: ToolAnnotations,
  opts: { trustAnnotations?: boolean } = {},
): ToolKind {
  if (annotations?.destructiveHint === true) return "write";
  if (opts.trustAnnotations && annotations?.readOnlyHint === true) return "read";
  const t = tokens(name);
  if (t.some((x) => WRITE.has(x))) return "write";
  if (t.some((x) => READ.has(x))) return "read";
  return "write";
}
