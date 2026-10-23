import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "../config";
import { db } from "../db";
import { users } from "../db/schema";
import { log } from "../log";

/**
 * Owner lock. Until an owner exists the first Slack sign-in would otherwise become owner, so whoever reaches the
 * server first could take it over. Claiming ownership requires the setup token (printed in the boot log or fixed
 * with SETUP_TOKEN) and, when SLACK_TEAM_ID is set, a sign-in from that team. Once an owner exists none of this applies.
 */
export const SETUP_COOKIE = "brain_setup";

let generated: string | undefined;

export const ownerExists = async (): Promise<boolean> => {
  const [o] = await db.select({ id: users.id }).from(users).where(eq(users.role, "owner")).limit(1);
  return Boolean(o);
};

/** The setup token for this process (env SETUP_TOKEN, else random per boot). Logged when no owner exists yet. */
export async function ensureSetupToken(): Promise<string> {
  const token = config.SETUP_TOKEN || (generated ??= randomBytes(18).toString("base64url"));
  if (!(await ownerExists())) {
    log.warn("no owner yet: claim this server by opening /auth/slack?setup_token=<token>", {
      setupToken: token, teamPinned: Boolean(config.SLACK_TEAM_ID),
    });
  }
  return token;
}

const eq32 = (a: string, b: string) => {
  const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

const currentToken = () => config.SETUP_TOKEN || (generated ??= randomBytes(18).toString("base64url"));
export const verifySetupToken = (t: string | undefined): boolean => Boolean(t) && eq32(t!, currentToken());

const proof = () => createHash("sha256").update(`setup-proof:${currentToken()}`).digest("base64url");

/** Remember a correct token in an httpOnly cookie so it survives the Slack redirect round trip. */
export function grantSetupProof(c: Context, maxAgeSec = 900): void {
  setCookie(c, SETUP_COOKIE, proof(), { path: "/", httpOnly: true, sameSite: "Lax", secure: config.PUBLIC_URL.startsWith("https://"), maxAge: maxAgeSec });
}
export const hasSetupProof = (c: Context): boolean => {
  const v = getCookie(c, SETUP_COOKIE);
  return Boolean(v) && eq32(v!, proof());
};

/** True when `teamId` is allowed by the SLACK_TEAM_ID pin (always true when unpinned). */
export const teamAllowed = (teamId: string | undefined): boolean => !config.SLACK_TEAM_ID || teamId === config.SLACK_TEAM_ID;
