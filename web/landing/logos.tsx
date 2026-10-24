import type { ReactNode } from "react"
import { PATHS } from "./glyphs"

type P = { size?: number }

export const SlackLogo = ({ size = 40 }: P) => (
  <svg viewBox="0 0 122.8 122.8" width={size} height={size} aria-label="Slack" role="img">
    <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#E01E5A" />
    <path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
    <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0" />
    <path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
    <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2EB67D" />
    <path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
    <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ECB22E" />
    <path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
  </svg>
)

// Google Meet's camera mark, in its four brand colours.
export const MeetLogo = ({ size = 40 }: P) => (
  <svg viewBox="0 0 87.5 72" width={size} height={(size * 72) / 87.5} aria-label="Google Meet" role="img">
    <path fill="#00832d" d="M49.5 36l8.53 9.75 11.47 7.33 2-17.02-2-16.64-11.69 6.44z" />
    <path fill="#0066da" d="M0 51.5V66c0 3.315 2.685 6 6 6h14.5l3-10.96-3-9.54-9.95-3z" />
    <path fill="#e94235" d="M20.5 0L0 20.5l10.55 3 9.95-3 2.95-9.41z" />
    <path fill="#2684fc" d="M20.5 20.5H0v31h20.5z" />
    <path fill="#00ac47" d="M82.6 8.68L69.5 19.42v33.66l13.16 10.79c1.97 1.54 4.85.135 4.85-2.37V11c0-2.535-2.945-3.925-4.91-2.32zM49.5 36v15.5h-29V72h43c3.315 0 6-2.685 6-6V53.08z" />
    <path fill="#ffba00" d="M63.5 0h-43v20.5h29V36l20-16.57V6c0-3.315-2.685-6-6-6z" />
  </svg>
)

// Microsoft Teams: a person in front of a person, with the T tile.
export const TeamsLogo = ({ size = 40 }: P) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-label="Microsoft Teams" role="img">
    <circle cx="48" cy="15" r="7" fill="#5059C9" />
    <path d="M39 26h18a3 3 0 0 1 3 3v14a9 9 0 0 1-9 9h-2a9 9 0 0 1-9-9V29a3 3 0 0 1 3-3z" fill="#5059C9" />
    <circle cx="29" cy="13" r="9" fill="#7B83EB" />
    <path d="M10 25h33a3 3 0 0 1 3 3v21a9 9 0 0 1-9 9H16a9 9 0 0 1-9-9V28a3 3 0 0 1 3-3z" fill="#7B83EB" />
    <rect x="6" y="22" width="27" height="27" rx="4" fill="#4B53BC" />
    <path d="M13.2 29h12.6v3.2h-4.7V43h-3.2V32.2h-4.7z" fill="#fff" />
  </svg>
)

// Zoom: the blue tile with the white camera.
export const ZoomLogo = ({ size = 40 }: P) => (
  <svg viewBox="0 0 64 64" width={size} height={size} aria-label="Zoom" role="img">
    <rect width="64" height="64" rx="16" fill="#0B5CFF" />
    <rect x="11" y="22" width="26" height="20" rx="5" fill="#fff" />
    <path d="M40 29l12-7.5a1 1 0 0 1 1.5.85v19.3a1 1 0 0 1-1.5.85L40 35z" fill="#fff" />
  </svg>
)

const glyph = (d: string, color: string, label: string) => ({ size = 40 }: P) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-label={label} role="img"><path d={d} fill={color} /></svg>
)
export const NotionLogo = glyph(PATHS.notion, "#111", "Notion")
export const DriveLogo = glyph(PATHS.drive, "#4285F4", "Google Drive")
export const GitHubLogo = glyph(PATHS.github, "#181717", "GitHub")
export const JiraLogo = glyph(PATHS.jira, "#0052CC", "Jira")
export const TrelloLogo = glyph(PATHS.trello, "#0052CC", "Trello")

/** The rounded app-icon tile the logos sit on. */
export const Tile = ({ children, size = 84, plain = false, className = "" }: { children: ReactNode; size?: number; plain?: boolean; className?: string }) => (
  <span className={`tile${plain ? " plain" : ""} ${className}`} style={{ width: size, height: size }}>{children}</span>
)

export const APPS = [
  { id: "meet", name: "Google Meet", Logo: MeetLogo },
  { id: "slack", name: "Slack", Logo: SlackLogo },
  { id: "teams", name: "Microsoft Teams", Logo: TeamsLogo },
  { id: "zoom", name: "Zoom", Logo: ZoomLogo },
  { id: "notion", name: "Notion", Logo: NotionLogo },
  { id: "drive", name: "Google Drive", Logo: DriveLogo },
  { id: "github", name: "GitHub", Logo: GitHubLogo },
  { id: "jira", name: "Jira", Logo: JiraLogo },
  { id: "trello", name: "Trello", Logo: TrelloLogo },
]
