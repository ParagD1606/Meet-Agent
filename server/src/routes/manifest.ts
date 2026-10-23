import { config } from "../config";
import { SLACK_BOT_EVENTS, SLACK_SLASH_COMMANDS, SLACK_BOT_SCOPES, SLACK_USER_SCOPES_SIGNIN } from "../slack/manifest";

export const SLACK_APP_NAME = "Company Brain";

/** Slack app manifest for this deployment. Socket mode needs no public request URLs; HTTP mode points at PUBLIC_URL. */
export function slackAppManifest(origin: string, mode: "socket" | "http" = config.SLACK_MODE, appName = SLACK_APP_NAME) {
  const base = origin.replace(/\/$/, "");
  const socket = mode === "socket";
  return {
    display_information: {
      name: appName,
      description: "A teammate with shared memory that lives in your Slack.",
      background_color: "#000b36",
    },
    features: {
      app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: appName, always_online: true },
      slash_commands: SLACK_SLASH_COMMANDS.map((c) => ({ ...c, ...(socket ? {} : { url: `${base}/slack/commands` }), should_escape: true })),
    },
    oauth_config: {
      redirect_urls: [`${base}/slack/oauth/callback`, `${base}/auth/slack/callback`],
      scopes: { user: [...SLACK_USER_SCOPES_SIGNIN], bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { ...(socket ? {} : { request_url: `${base}/slack/events` }), bot_events: [...SLACK_BOT_EVENTS] },
      interactivity: { is_enabled: true, ...(socket ? {} : { request_url: `${base}/slack/interactions` }) },
      org_deploy_enabled: false,
      socket_mode_enabled: socket,
      token_rotation_enabled: false,
    },
  };
}

const q = (s: string) => JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars

/** Minimal YAML emitter for plain JSON-like data (objects, arrays, scalars). */
export function toYaml(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    return v.map((x) => (x !== null && typeof x === "object" ? `${pad}-\n${toYaml(x, indent + 1)}` : `${pad}- ${scalar(x)}`)).join("\n");
  }
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) =>
      x !== null && typeof x === "object"
        ? Array.isArray(x) && x.length === 0 ? `${pad}${k}: []` : `${pad}${k}:\n${toYaml(x, indent + 1)}`
        : `${pad}${k}: ${scalar(x)}`)
    .join("\n");
}
const scalar = (x: unknown) => (typeof x === "string" ? q(x) : String(x));

export const slackManifestYaml = (origin: string, mode?: "socket" | "http") =>
  `# Slack app manifest for Company Brain. Slack -> Create New App -> From a manifest -> paste this.\n${toYaml(slackAppManifest(origin, mode))}\n`;
