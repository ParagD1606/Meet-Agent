import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SocketModeClient } from "@slack/socket-mode";
import { config } from "../config";
import { log } from "../log";
import { slackConfigured } from "./client";
import { handleEventCallback, type EventCallback } from "./events";
import { handleInteraction } from "./interactions";
import { authorizeUrl, checkState, completeInstall, makeState, STATE_COOKIE } from "./install";
import { isSlackRetry, verifySlackSignature } from "./verify";

export { slackClient, botUserId } from "./client";
export { triage } from "./triage";
export { searchPeople } from "./people";
export { onUserJoined, onAppHome, journeyTick } from "./onboarding";
export { SLACK_BOT_SCOPES, SLACK_BOT_EVENTS } from "./manifest";

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p>`;

/** Routes: GET /slack/install, GET /slack/oauth/callback, POST /slack/events, POST /slack/interactions. */
export function mountSlack(app: Hono): void {
  app.get("/slack/install", (c) => {
    if (!slackConfigured().oauth) return c.html(page("Slack not configured", "Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET."), 503);
    const { state, nonce } = makeState();
    setCookie(c, STATE_COOKIE, nonce, { httpOnly: true, sameSite: "Lax", secure: config.PUBLIC_URL.startsWith("https"), maxAge: 600, path: "/slack" });
    return c.redirect(authorizeUrl(state));
  });

  app.get("/slack/oauth/callback", async (c) => {
    const nonce = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/slack" });
    if (c.req.query("error")) return c.html(page("Install cancelled", "Slack authorization was not granted."), 400);
    const code = c.req.query("code");
    if (!code || !checkState(c.req.query("state"), nonce)) return c.html(page("Invalid request", "The install link expired or is invalid. Start again from /slack/install."), 400);
    const r = await completeInstall(code);
    if (!r.ok) return c.html(page("Install failed", r.error), r.status as 400);
    return c.html(page("Company Brain installed", "You can close this tab and open Slack."));
  });

  app.post("/slack/events", async (c) => {
    const secret = config.SLACK_SIGNING_SECRET;
    if (!secret) return c.json({ error: "SLACK_SIGNING_SECRET not configured" }, 503);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!verifySlackSignature(raw, c.req.raw.headers, secret)) return c.json({ error: "invalid signature" }, 401);
    let body: EventCallback & { challenge?: string };
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "bad json" }, 400); }
    if (body.type === "url_verification") return c.json({ challenge: body.challenge });
    if (!isSlackRetry(c.req.raw.headers) && body.type === "event_callback") void handleEventCallback(body);
    return c.body(null, 200); // ack inside Slack's 3s window; work continues in the background
  });

  app.post("/slack/interactions", async (c) => {
    const secret = config.SLACK_SIGNING_SECRET;
    if (!secret) return c.json({ error: "SLACK_SIGNING_SECRET not configured" }, 503);
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!verifySlackSignature(raw, c.req.raw.headers, secret)) return c.json({ error: "invalid signature" }, 401);
    const payloadStr = new URLSearchParams(new TextDecoder().decode(raw)).get("payload");
    if (!payloadStr) return c.json({ error: "missing payload" }, 400);
    let payload;
    try { payload = JSON.parse(payloadStr); } catch { return c.json({ error: "bad payload" }, 400); }
    void handleInteraction(payload);
    return c.body(null, 200);
  });
}

let socket: SocketModeClient | null = null;

/** Socket Mode when SLACK_MODE=socket and SLACK_APP_TOKEN is present; otherwise a logged no-op. Never throws. */
export async function startSlack(): Promise<void> {
  if (config.SLACK_MODE !== "socket") { log.info("slack: http mode (events via POST /slack/events)"); return; }
  if (!config.SLACK_APP_TOKEN) { log.warn("slack: SLACK_APP_TOKEN missing; socket mode disabled"); return; }
  if (socket) return;
  try {
    const client = new SocketModeClient({ appToken: config.SLACK_APP_TOKEN });
    // Socket Mode emits the Events API envelope on `slack_event` with type `events_api`.
    // The per-event emitter is named after the inner Slack event (e.g. `app_mention`).
    client.on("slack_event", async ({ ack, type, body }: { ack: () => Promise<void>; type: string; body: EventCallback }) => {
      if (type !== "events_api") return;
      await ack();
      void handleEventCallback(body);
    });
    client.on("interactive", async ({ ack, body }: { ack: () => Promise<void>; body: Parameters<typeof handleInteraction>[0] }) => {
      await ack();
      void handleInteraction(body);
    });
    client.on("error", (err: Error) => log.warn("slack socket error", { error: err.message }));
    await client.start();
    socket = client;
    log.info("slack: socket mode connected");
  } catch (err) {
    log.error("slack: socket mode failed to start", { error: (err as Error).message });
  }
}

export async function stopSlack(): Promise<void> {
  const s = socket; socket = null;
  await s?.disconnect().catch(() => undefined);
}
