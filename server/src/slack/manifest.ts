/** Single source of truth for what the Slack app needs (used by OAuth install and any manifest generator). */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read", "assistant:write", "channels:history", "channels:join", "channels:manage", "channels:read",
  "chat:write", "chat:write.public", "canvases:read", "files:read", "groups:history", "groups:read", "im:history", "im:read", "im:write",
  "mpim:history", "mpim:read", "reactions:read", "reactions:write", "users:read", "users:read.email", "team:read",
] as const;

export const SLACK_USER_SCOPES_SIGNIN = ["openid", "profile", "email"] as const;

export const SLACK_BOT_EVENTS = [
  "app_mention", "app_home_opened", "message.channels", "message.groups", "message.im", "message.mpim",
  "member_joined_channel", "member_left_channel", "channel_left", "group_left", "channel_rename", "channel_archive",
  "channel_unarchive", "channel_deleted", "team_join", "user_change", "reaction_added",
  "file_created", "file_shared", "file_change",
  "assistant_thread_started", "assistant_thread_context_changed", "tokens_revoked", "app_uninstalled",
] as const;
