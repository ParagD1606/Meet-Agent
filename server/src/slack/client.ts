import { LogLevel, WebClient } from "@slack/web-api";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { decrypt } from "../crypto";
import { db } from "../db";
import { workspace } from "../db/schema";
import { log } from "../log";

export type WorkspaceRow = typeof workspace.$inferSelect;

export class SlackNotInstalledError extends Error {
  constructor() { super("Slack is not installed: no workspace row (visit /slack/install)"); }
}

let cached: { token: string; client: WebClient } | null = null;
let override: WebClient | null = null;

/** Test hook: route every Slack call to a fake client. Pass null to restore. */
export function setSlackClientForTest(c: unknown | null) { override = c as WebClient | null; }
export function invalidateSlackClient() { cached = null; }

export const slackConfigured = () => ({
  oauth: Boolean(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET),
  signing: Boolean(config.SLACK_SIGNING_SECRET),
  socket: Boolean(config.SLACK_APP_TOKEN),
});

export async function getWorkspace(): Promise<WorkspaceRow | null> {
  const [row] = await db.select().from(workspace).limit(1);
  return row ?? null;
}

export function newWebClient(token?: string): WebClient {
  return new WebClient(token, {
    logLevel: LogLevel.ERROR,
    timeout: 30_000, // every Slack call is bounded; the SDK default is unbounded
    retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 5_000, randomize: true },
    ...(config.SLACK_API_URL ? { slackApiUrl: config.SLACK_API_URL } : {}),
  });
}

/** WebClient bound to the installed workspace's decrypted bot token. Throws SlackNotInstalledError if absent. */
export async function slackClient(): Promise<WebClient> {
  if (override) return override;
  const ws = await getWorkspace();
  if (!ws) throw new SlackNotInstalledError();
  const token = decrypt(ws.botTokenEnc);
  if (cached?.token !== token) cached = { token, client: newWebClient(token) };
  return cached.client;
}

export async function botUserId(): Promise<string> {
  const ws = await getWorkspace();
  if (!ws) throw new SlackNotInstalledError();
  return ws.botUserId;
}

/** Slack errors that mean "already in the desired state"; never worth surfacing. */
const BENIGN = new Set(["already_reacted", "no_reaction", "message_not_found", "not_in_channel", "channel_not_found"]);

export function slackErrorCode(err: unknown): string | undefined {
  const e = err as { data?: { error?: string } };
  return e?.data?.error;
}

async function safe<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (err) {
    const code = slackErrorCode(err);
    if (!code || !BENIGN.has(code)) log.warn(`slack ${what} failed`, { error: code ?? (err as Error).message });
    return undefined;
  }
}

export const addReaction = (channel: string, ts: string, name: string) =>
  safe("reactions.add", async () => (await slackClient()).reactions.add({ channel, timestamp: ts, name }));
export const removeReaction = (channel: string, ts: string, name: string) =>
  safe("reactions.remove", async () => (await slackClient()).reactions.remove({ channel, timestamp: ts, name }));

export async function openDm(userId: string): Promise<string | null> {
  const r = await safe("conversations.open", async () => (await slackClient()).conversations.open({ users: userId }));
  return r?.channel?.id ?? null;
}

export async function postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }) {
  const c = await slackClient();
  return c.chat.postMessage({ channel: args.channel, text: args.text, thread_ts: args.thread_ts, blocks: args.blocks as never, unfurl_links: false });
}

export async function postDm(userId: string, text: string, blocks?: unknown[]): Promise<string | null> {
  const channel = await openDm(userId);
  if (!channel) return null;
  const r = await safe("chat.postMessage", () => postMessage({ channel, text, blocks }));
  return r?.ts ?? null;
}
