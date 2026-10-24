/** Single source of truth for what the Slack app needs (used by OAuth install and any manifest generator). */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read", "assistant:write", "channels:history", "channels:join", "channels:manage", "channels:read",
  "chat:write", "chat:write.public", "canvases:read", "commands", "files:read", "groups:history", "groups:read", "im:history", "im:read", "im:write",
  "mpim:history", "mpim:read", "reactions:read", "reactions:write", "users:read", "users:read.email", "team:read",
  // Real-time Search (assistant.search.context): user-scoped through the event action_token, read-only
  "search:read.public", "search:read.private", "search:read.mpim", "search:read.im",
] as const;

export const SLACK_USER_SCOPES_SIGNIN = ["openid", "profile", "email"] as const;

export const SLACK_BOT_EVENTS = [
  "app_mention", "app_home_opened", "message.channels", "message.groups", "message.im", "message.mpim",
  "member_joined_channel", "member_left_channel", "channel_left", "group_left", "channel_rename", "channel_archive",
  "channel_unarchive", "channel_deleted", "team_join", "user_change", "reaction_added",
  "file_created", "file_shared", "file_change",
  "assistant_thread_started", "assistant_thread_context_changed", "tokens_revoked", "app_uninstalled",
] as const;

/** Slash commands (the `commands` scope). In HTTP mode each also needs a request URL; routes/manifest.ts adds it. */
export const SLACK_SLASH_COMMANDS = [
  { command: "/remember", description: "Save a fact to memory", usage_hint: "[something worth remembering]" },
  { command: "/forget", description: "Find and delete memories", usage_hint: "[what to forget]" },
  { command: "/whatdoyouknow", description: "See what I remember", usage_hint: "[@person or topic]" },
  { command: "/brain-review", description: "Review pending memory changes (admins)" },
  { command: "/brain-tasks", description: "Your open tasks and the ones you assigned" },
  { command: "/brain-followups", description: "List, cancel and set up follow-up and digest DMs", usage_hint: "[list | cancel <id> | digest on 09:00 | weekly on]" },
  { command: "/brain-new", description: "Start a fresh chat (forget this conversation's history, keep memory)" },
  { command: "/brain-pause", description: "Stop learning from this channel (admins, channel creator)" },
  { command: "/brain-resume", description: "Resume learning from this channel (admins, channel creator)" },
  { command: "/repos", description: "List your connected GitHub repositories", usage_hint: "[page]" },
] as const;
