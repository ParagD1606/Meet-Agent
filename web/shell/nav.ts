import type { IconName } from "@/lib/icons"

export interface NavItem { to: string; label: string; icon: IconName; group: string; admin?: boolean; keys?: string; kw?: string }
export const NAV: NavItem[] = [
  { to: "/", label: "Home", icon: "home", group: "Overview", keys: "h", kw: "overview dashboard" },
  { to: "/graph", label: "Graph", icon: "graph", group: "Knowledge", keys: "g", kw: "map network" },
  { to: "/memories", label: "Memories", icon: "memory", group: "Knowledge", keys: "m", kw: "facts documents search upload" },
  { to: "/core-memory", label: "Core memory", icon: "core", group: "Knowledge", keys: "c", kw: "blocks company channel user" },
  { to: "/tasks", label: "Tasks", icon: "check", group: "Knowledge", kw: "commitments assigned owner due overdue follow-up todo promises" },
  { to: "/review", label: "Review queue", icon: "review", group: "Knowledge", admin: true, keys: "r", kw: "approve reject pending" },
  { to: "/meetings", label: "Meetings", icon: "book", group: "Knowledge", keys: "n", kw: "meeting notes huddle transcript summary tasks action items decisions approve jira" },
  { to: "/memory-health", label: "Memory health", icon: "gauge", group: "Knowledge", admin: true, kw: "freshness learn now consolidation undo observe channels export backfill" },
  { to: "/skills", label: "Skills", icon: "skills", group: "Agent", keys: "s", kw: "skill.md" },
  { to: "/automations", label: "Automations", icon: "clock", group: "Agent", keys: "a", kw: "cron schedule digest reminder" },
  { to: "/models", label: "Models", icon: "models", group: "Agent", kw: "llm provider fallback" },
  { to: "/pixel", label: "Pixel", icon: "sparkle", group: "Agent", admin: true, kw: "persona name tone greeting approvals features standup risks digest nudge" },
  { to: "/proactivity", label: "Proactivity", icon: "radio", group: "Agent", admin: true, kw: "chime channels observe" },
  { to: "/prompt", label: "Workspace prompt", icon: "file", group: "Agent", kw: "instructions system" },
  { to: "/integrations", label: "Integrations", icon: "plug", group: "Connect", keys: "i", kw: "mcp connectors github linear notion" },
  { to: "/tokens", label: "API tokens", icon: "key", group: "Connect", admin: true, kw: "mcp bearer" },
  { to: "/turns", label: "Turns", icon: "turns", group: "Admin", admin: true, keys: "t", kw: "runs log history" },
  { to: "/usage", label: "Usage & limits", icon: "usage", group: "Admin", admin: true, keys: "u", kw: "cost tokens budget" },
]
export const GROUPS = ["Overview", "Knowledge", "Agent", "Connect", "Admin"]
export const navFor = (path: string) => NAV.find((n) => (n.to === "/" ? path === "/" : path === n.to || path.startsWith(n.to + "/")))
