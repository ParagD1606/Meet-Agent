import { eq } from "drizzle-orm";
import { db } from "../db";
import { settings } from "../db/schema";

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

// ---- approval policy: which writes need a human-approval card ------------------------------------------------

/** Classes an admin may toggle. Anything not positively identified as one of these is "other" and ALWAYS needs a card. */
export const ACTION_CLASSES = ["ticket", "slack_post", "doc_edit", "email_calendar"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number] | "other";
/** Settings key `approval_cards`: { ticket: bool, ... }. Missing/false = NO card for that class (the default). */
export type ApprovalCards = Partial<Record<(typeof ACTION_CLASSES)[number], boolean>>;

// Destructive / irreversible-by-nature verbs: always a card, whatever the class setting says.
const DESTRUCTIVE = new Set(["delete", "remove", "revoke", "archive", "purge", "drop", "destroy", "cancel", "merge", "deploy", "release", "push", "exec", "execute", "run", "trigger", "restart", "transfer", "disable", "share", "invite", "grant", "permission", "permissions", "fork", "collaborator", "publish"]);
const EMAIL_CAL = new Set(["email", "mail", "gmail", "draft", "calendar", "event", "invite", "meeting", "attendee"]);
const SLACK = new Set(["slack", "channel", "message", "dm"]);
const DOC = new Set(["page", "doc", "docs", "document", "sheet", "slide", "file", "block", "database", "note", "drive", "folder"]);
const TICKET = new Set(["issue", "ticket", "task", "story", "bug", "comment", "label", "pull", "pr", "project", "cycle", "customer"]);
const PROVIDER_CLASS: Record<string, ActionClass> = { "gmail-personal-only": "email_calendar", notion: "doc_edit", linear: "ticket", plain: "ticket", sentry: "ticket", github: "ticket", slack: "slack_post" };

/** Pure and fail-closed: destructive => "other"; else name hints (email/calendar first: irreversible), then the app, else "other". */
export function actionClass(name: string, provider: string, annotations?: ToolAnnotations): ActionClass {
  const t = tokens(name);
  if (annotations?.destructiveHint === true || t.some((x) => DESTRUCTIVE.has(x)) || (t.includes("create") && t.includes("or") && t.includes("update"))) return "other";
  if (t.some((x) => EMAIL_CAL.has(x))) return "email_calendar";
  if ((!PROVIDER_CLASS[provider] || provider === "slack") && t.some((x) => SLACK.has(x))) return "slack_post";
  if (t.some((x) => DOC.has(x))) return PROVIDER_CLASS[provider] === "ticket" ? "ticket" : "doc_edit";
  if (t.some((x) => TICKET.has(x))) return "ticket";
  return "other"; // nothing identified the action: carded, whatever the app
}

/** `untrusted`: external-system text is in this turn, so even the classes an admin left card-free get a card. */
export const needsApproval = (cls: ActionClass, cards: ApprovalCards, untrusted = false): boolean => cls === "other" || untrusted || cards[cls] === true;
/** Fail-closed settings when the row cannot be read. */
export const ALL_CARDED: ApprovalCards = { ticket: true, slack_post: true, doc_edit: true, email_calendar: true };

export function parseApprovalCards(raw: unknown): ApprovalCards {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(ACTION_CLASSES.map((c) => [c, r[c] === true]));
}

let cachedCards: { at: number; v: ApprovalCards } | null = null;
export const invalidateApprovalCards = () => { cachedCards = null; };
export async function getApprovalCards(): Promise<ApprovalCards> {
  if (cachedCards && Date.now() - cachedCards.at < 10_000) return cachedCards.v;
  const [row] = await db.select().from(settings).where(eq(settings.key, "approval_cards"));
  cachedCards = { at: Date.now(), v: parseApprovalCards(row?.value) };
  return cachedCards.v;
}
export async function setApprovalCards(next: unknown): Promise<ApprovalCards> {
  const v = parseApprovalCards(next);
  await db.insert(settings).values({ key: "approval_cards", value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v } });
  cachedCards = { at: Date.now(), v };
  return v;
}
