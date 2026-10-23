import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { encrypt } from "../crypto";
import { db } from "../db";
import { workspace } from "../db/schema";
import { log } from "../log";
import { getWorkspace, invalidateSlackClient, newWebClient, slackErrorCode } from "./client";
import { SLACK_BOT_SCOPES } from "./manifest";
import { sendInstallOnboarding } from "./onboarding";
import { syncWorkspace, upsertChannel } from "./sync";

export const HOME_CHANNEL = "company-brain";
const STATE_TTL_MS = 10 * 60_000;
export const STATE_COOKIE = "brain_slack_oauth";

const redirectUri = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/slack/oauth/callback`;
const stateKey = () => config.SLACK_CLIENT_SECRET ?? "";
const mac = (s: string) => createHmac("sha256", stateKey()).update(s).digest("base64url");

/** Signed, expiring OAuth state. The nonce is also set as an httpOnly cookie to bind the flow to the browser. */
export function makeState(nowMs = Date.now()): { state: string; nonce: string } {
  const nonce = randomBytes(12).toString("base64url");
  const body = `${nonce}.${nowMs + STATE_TTL_MS}`;
  return { state: `${body}.${mac(body)}`, nonce };
}

export function checkState(state: string | undefined, cookieNonce: string | undefined, nowMs = Date.now()): boolean {
  if (!state || !cookieNonce) return false;
  const [nonce, exp, sig] = state.split(".");
  if (!nonce || !exp || !sig || nonce !== cookieNonce || Number(exp) < nowMs) return false;
  const a = Buffer.from(sig), b = Buffer.from(mac(`${nonce}.${exp}`));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeUrl(state: string): string {
  const u = new URL("https://slack.com/oauth/v2/authorize");
  u.searchParams.set("client_id", config.SLACK_CLIENT_ID ?? "");
  u.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("state", state);
  return u.toString();
}

/** Find #company-brain (create if missing), join it, and remember it as the home channel. */
export async function ensureHomeChannel(token: string): Promise<string | null> {
  const c = newWebClient(token);
  let id: string | undefined;
  try {
    id = (await c.conversations.create({ name: HOME_CHANNEL })).channel?.id;
  } catch (err) {
    if (slackErrorCode(err) !== "name_taken") { log.warn("create home channel failed", { error: slackErrorCode(err) ?? (err as Error).message }); return null; }
    let cursor: string | undefined;
    do {
      const r = await c.conversations.list({ types: "public_channel", exclude_archived: true, limit: 200, cursor });
      id = r.channels?.find((x) => x.name === HOME_CHANNEL)?.id;
      cursor = id ? undefined : r.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }
  if (!id) return null;
  try { await c.conversations.join({ channel: id }); } catch (err) { if (slackErrorCode(err) !== "already_in_channel") log.warn("join home channel failed", { error: slackErrorCode(err) }); }
  await upsertChannel({ id, name: HOME_CHANNEL, isPrivate: false, isIm: false, botIsMember: true });
  return id;
}

export type InstallResult = { ok: true; teamId: string } | { ok: false; status: number; error: string };

/** OAuth callback body: exchange code, persist ENCRYPTED token, then adopt home channel + sync + onboard. */
export async function completeInstall(code: string): Promise<InstallResult> {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) return { ok: false, status: 503, error: "Slack OAuth is not configured" };
  let res;
  try {
    res = await newWebClient().oauth.v2.access({ client_id: config.SLACK_CLIENT_ID, client_secret: config.SLACK_CLIENT_SECRET, code, redirect_uri: redirectUri() });
  } catch (err) {
    log.warn("oauth exchange failed", { error: slackErrorCode(err) ?? (err as Error).message });
    return { ok: false, status: 400, error: "Slack rejected the authorization code" };
  }
  const token = res.access_token, teamId = res.team?.id, botUser = res.bot_user_id;
  if (!token || !teamId || !botUser) return { ok: false, status: 502, error: "Slack returned an incomplete install response" };

  const existing = await getWorkspace();
  if (existing && existing.id !== teamId) return { ok: false, status: 409, error: "This server is already linked to a different Slack workspace" };

  const values = { name: res.team?.name ?? null, botTokenEnc: encrypt(token), botUserId: botUser };
  await db.insert(workspace).values({ id: teamId, ...values }).onConflictDoUpdate({ target: workspace.id, set: values });
  invalidateSlackClient();

  // Post-install work must not fail the install itself.
  try {
    const home = await ensureHomeChannel(token);
    if (home) await db.update(workspace).set({ homeChannelId: home }).where(eq(workspace.id, teamId));
    await syncWorkspace();
    await sendInstallOnboarding(res.authed_user?.id);
  } catch (err) { log.error("post-install setup failed", { error: (err as Error).message }); }
  log.info("slack workspace installed", { teamId });
  return { ok: true, teamId };
}
