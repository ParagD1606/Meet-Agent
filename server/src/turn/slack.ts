import type { WebClient } from "@slack/web-api";
import { slackClient } from "../slack/client";

let override: (() => Promise<WebClient>) | undefined;
/** Test seam: inject a fake Slack client. Pass undefined to restore. */
export function setSlackClient(f?: () => Promise<WebClient>) { override = f; }
export const getSlack = (): Promise<WebClient> => (override ? override() : slackClient());

export type BlockActionsPayload = {
  user: { id: string };
  actions?: { action_id: string; value?: string }[];
  channel?: { id: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts?: string };
};

/** Escape user/tool-controlled text for Slack mrkdwn. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
