export type Preset = {
  key: string;
  label: string;
  url: string;
  authType: "oauth" | "bearer";
  personalOnly?: boolean;
  /** Server annotations (readOnlyHint) can be believed for curated servers only. */
  trusted: boolean;
};

export const PRESETS: Preset[] = [
  { key: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", authType: "oauth", trusted: true },
  { key: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", authType: "oauth", trusted: true },
  { key: "notion", label: "Notion", url: "https://mcp.notion.com/mcp", authType: "oauth", trusted: true },
  { key: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp", authType: "oauth", trusted: true },
  { key: "plain", label: "Plain", url: "https://mcp.plain.com/mcp", authType: "oauth", trusted: true },
  { key: "posthog", label: "PostHog", url: "https://mcp.posthog.com/mcp", authType: "oauth", trusted: true },
  { key: "granola", label: "Granola", url: "https://mcp.granola.ai/mcp", authType: "oauth", trusted: true },
  // Mailboxes are personal: never org-scoped, never leased.
  { key: "gmail-personal-only", label: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", authType: "oauth", personalOnly: true, trusted: true },
  { key: "google", label: "Google Workspace", url: "https://drivemcp.googleapis.com/mcp/v1", authType: "oauth", trusted: true },
];

export const getPreset = (key: string) => PRESETS.find((p) => p.key === key);
