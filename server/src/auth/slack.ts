import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { users, workspace } from "../db/schema";
import { log } from "../log";
import { cookieOpts, csrf, createSession, destroySession } from "./session";

const STATE_COOKIE = "brain_oauth_state";
const callbackUrl = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/auth/slack/callback`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const refuse = (message: string, status: 400 | 403 | 503 = 403) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Sign in</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.3rem">Can't sign you in</h1><p>${esc(message)}</p><p><a href="/">Back</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

type Identity = {
  ok: boolean; email?: string; name?: string; picture?: string;
  "https://slack.com/user_id"?: string; "https://slack.com/team_id"?: string;
};

/** First-ever sign-in (no owner yet) becomes owner, everyone after is a member. Serialised with an advisory lock. */
export async function upsertSignedInUser(u: { id: string; name: string | null; email: string | null; avatarUrl: string | null }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7301)`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.role, "owner"));
    const [row] = await tx
      .insert(users)
      .values({ ...u, role: n === 0 ? "owner" : "member" })
      .onConflictDoUpdate({
        target: users.id,
        set: { name: u.name, email: u.email, avatarUrl: u.avatarUrl, ...(n === 0 ? { role: "owner" as const } : {}) },
      })
      .returning();
    return row!;
  });
}

export function mountAuth(app: Hono<any>): void {
  app.get("/auth/slack", (c) => {
    if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
      return refuse("Slack sign-in is not configured on this server (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET).", 503);
    }
    const state = randomBytes(16).toString("base64url");
    setCookie(c, STATE_COOKIE, state, cookieOpts(600));
    const url = new URL("https://slack.com/openid/connect/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("client_id", config.SLACK_CLIENT_ID);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", callbackUrl());
    return c.redirect(url.toString());
  });

  app.get("/auth/slack/callback", async (c) => {
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    if (c.req.query("error")) return c.redirect("/");
    const code = c.req.query("code");
    if (!code || !expected || c.req.query("state") !== expected) {
      return refuse("That sign-in link is invalid or expired. Try again.", 400);
    }
    if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) return refuse("Slack sign-in is not configured.", 503);

    try {
      const tok = (await fetch("https://slack.com/api/openid.connect.token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.SLACK_CLIENT_ID, client_secret: config.SLACK_CLIENT_SECRET, code, redirect_uri: callbackUrl(),
        }),
      }).then((r) => r.json())) as { ok: boolean; error?: string; access_token?: string };
      if (!tok.ok || !tok.access_token) return refuse(`Slack refused the sign-in (${tok.error ?? "unknown error"}).`);

      const me = (await fetch("https://slack.com/api/openid.connect.userInfo", {
        headers: { authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json())) as Identity;
      const userId = me["https://slack.com/user_id"];
      const teamId = me["https://slack.com/team_id"];
      if (!me.ok || !userId || !teamId) return refuse("Slack didn't share your identity.");

      const [ws] = await db.select({ id: workspace.id }).from(workspace).limit(1);
      if (ws && ws.id !== teamId) return refuse("This Company Brain belongs to another Slack workspace.");

      const [existing] = await db.select({ deactivated: users.deactivated }).from(users).where(eq(users.id, userId));
      if (existing?.deactivated) return refuse("Your account is deactivated.");

      const user = await upsertSignedInUser({
        id: userId, name: me.name ?? null, email: me.email?.toLowerCase() ?? null, avatarUrl: me.picture ?? null,
      });
      await createSession(c, user.id);
      return c.redirect(ws ? "/" : "/setup");
    } catch (e) {
      log.error("slack sign-in failed", { err: String(e) });
      return refuse("Sign-in failed. Try again.", 400);
    }
  });

  app.post("/auth/logout", csrf, async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });
}
