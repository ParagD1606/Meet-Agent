// One icon family: 24px grid, 1.5px stroke, round caps/joins, currentColor.
import type { SVGProps } from "react"

const P = {
  home: "M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z",
  graph: "M12 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM5.5 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM18.5 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10.8 9.2 6.9 14.3M13.2 9.2l3.9 5.1M8 17h8",
  memory: "M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2ZM4 6v6c0 1.1 3.6 2 8 2s8-.9 8-2V6M4 12v6c0 1.1 3.6 2 8 2s8-.9 8-2v-6",
  core: "M6 4h11a1 1 0 0 1 1 1v14.5H7.5A1.5 1.5 0 0 1 6 18zM6 18a1.5 1.5 0 0 1 1.5-1.5H18M10 8h4",
  review: "M4 13l2.6-7.2A1 1 0 0 1 7.5 5h9a1 1 0 0 1 .9.8L20 13M4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5M4 13h4.5l1 2h5l1-2H20M9.5 9.5l1.7 1.7 3.3-3.4",
  skills: "M13 3 5 13.5h6L10 21l8-10.5h-6z",
  clock: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 7.5V12l3 2",
  models: "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3",
  radio: "M12 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.7 18.3a9 9 0 0 1 0-12.6M18.3 5.7a9 9 0 0 1 0 12.6",
  file: "M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1ZM13 3.5V8h5M9 12.5h6M9 16h6",
  plug: "M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4",
  sync: "M19.5 12a7.5 7.5 0 0 0-13-5L4.5 9M4.5 4.5V9H9M4.5 12a7.5 7.5 0 0 0 13 5l2-2M19.5 19.5V15H15",
  key: "M14.5 9.5a4.5 4.5 0 1 1-1.8 3.6L4 21v-3l2-.5.5-2L9 14.5l1.8-1.8M16.5 8.5h.01",
  turns: "M4 6h16M4 12h10M4 18h13",
  usage: "M5 20V10M12 20V4M19 20v-7",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6 6 18",
  check: "M5 12.5 10 17.5 19 7",
  down: "m7 10 5 5 5-5",
  up: "m7 14 5-5 5 5",
  right: "m10 7 5 5-5 5",
  left: "m14 7-5 5 5 5",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  copy: "M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM5 15V5a1 1 0 0 1 1-1h9",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  trash: "M5 7h14M10 7V4.5h4V7M7 7l.8 12a1 1 0 0 0 1 .9h6.4a1 1 0 0 0 1-.9L17 7M10 11v5M14 11v5",
  upload: "M12 16V4M7.5 8.5 12 4l4.5 4.5M4 15v3.5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V15",
  download: "M12 4v12M7.5 11.5 12 16l4.5-4.5M4 15v3.5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V15",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1 1M17.4 17.4l1 1M5.6 18.4l1-1M17.4 6.6l1-1",
  moon: "M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z",
  monitor: "M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM9 20h6M12 16v4",
  logout: "M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9",
  alert: "M12 4 3 19.5h18zM12 10v4.5M12 17.2h.01",
  info: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 11v5M12 8.2h.01",
  error: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 8v4.5M12 15.7h.01",
  success: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.5 12.3l2.5 2.5 4.5-5",
  loader: "M12 4a8 8 0 1 0 8 8",
  filter: "M4 6h16M7 12h10M10 18h4",
  message: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  globe: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM4 12h16M12 4c2.2 2.2 3.2 4.9 3.2 8s-1 5.8-3.2 8c-2.2-2.2-3.2-4.9-3.2-8S9.8 6.2 12 4Z",
  user: "M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM5 20a7 7 0 0 1 14 0",
  users: "M9.5 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 19a6 6 0 0 1 12 0M16 5.8a3 3 0 0 1 0 5.4M17.5 14a6 6 0 0 1 3 5",
  hash: "M9.5 4 8 20M16 4l-1.5 16M5 9h15M4 15h15",
  lock: "M6.5 11h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  play: "M8 5.5v13l10.5-6.5z",
  command: "M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9Zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15Zm0 0v6m0 0h-6m6 0v2.5a2.5 2.5 0 1 0 2.5-2.5H15Zm-6 0v2.5A2.5 2.5 0 1 1 6.5 15H9Z",
  menu: "M4 7h16M4 12h16M4 17h16",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  sortUp: "M12 18V6M7 11l5-5 5 5",
  sortDown: "M12 6v12M7 13l5 5 5-5",
  shield: "M12 3.5 5 6v5.5c0 4 2.8 7.2 7 9 4.2-1.8 7-5 7-9V6z",
  layers: "m12 4 8.5 4.5L12 13 3.5 8.5zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5",
  zoomIn: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4M11 8v6M8 11h6",
  zoomOut: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4M8 11h6",
  fit: "M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  edit: "M5 19h3.5L19 8.5 15.5 5 5 15.5zM13.5 7l3.5 3.5",
  history: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9M4.5 4.5V9H9M12 8v4l2.5 1.5",
  link: "M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.8.8M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.8-.8",
  gauge: "M4.5 17a8 8 0 1 1 15 0M12 13l3.5-4.5",
  book: "M5 5.5A1.5 1.5 0 0 1 6.5 4H19v13H6.5A1.5 1.5 0 0 0 5 18.5zm0 13A1.5 1.5 0 0 0 6.5 20H19v-3",
  sparkle: "M12 4v4M12 16v4M4 12h4M16 12h4M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12a7 7 0 0 0-.1-1.2l1.9-1.5-1.8-3.1-2.3.8a7 7 0 0 0-2-1.2L14.3 3h-3.6l-.4 2.8a7 7 0 0 0-2 1.2l-2.3-.8-1.8 3.1 1.9 1.5a7 7 0 0 0 0 2.4l-1.9 1.5 1.8 3.1 2.3-.8a7 7 0 0 0 2 1.2l.4 2.8h3.6l.4-2.8a7 7 0 0 0 2-1.2l2.3.8 1.8-3.1-1.9-1.5c.1-.4.1-.8.1-1.2Z",
  inbox: "M4 13l2.6-7.2A1 1 0 0 1 7.5 5h9a1 1 0 0 1 .9.8L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z",
  git: "M7 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 21.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 13.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 6.5v11M17 13.5c0 3-4 3-10 4",
} as const

export type IconName = keyof typeof P

export function Icon({ name, size = 16, className, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} {...rest}>
      <path d={P[name]} />
    </svg>
  )
}

/** Product mark (also the favicon). */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <g fill="none" stroke="var(--accent-fg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="12" r="2.5" /><circle cx="21" cy="11" r="2.5" /><circle cx="16" cy="22" r="2.5" />
        <path d="M13 13.3l2 6.4M19 13l-2 6.8M13.5 11.7h5" />
      </g>
    </svg>
  )
}
