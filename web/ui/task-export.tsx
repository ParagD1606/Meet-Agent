import { useQuery } from "@tanstack/react-query"
import { api, type BoardTarget, type ExternalRef, type PushSummary } from "@/lib/api"
import { useAction } from "@/lib/action"
import { Button } from "./button"
import { Menu, MenuItem, MenuLabel } from "./menu"
import { useToast } from "./toast"

type Filters = Record<string, string | number | boolean | null | undefined>
const FORMATS = [["csv", "Download CSV"], ["json", "Download JSON"], ["md", "Download Markdown"], ["ics", "Download Calendar (.ics)"]] as const

/** Plain GET links: the browser sends the session cookie and the Content-Disposition header makes it a download. */
export function exportUrl(scope: "tasks" | "meeting", format: string, id?: string, filters: Filters = {}): string {
  const q = new URLSearchParams({ format })
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== null && v !== "" && v !== false) q.set(k, v === true ? "1" : String(v))
  return scope === "meeting" ? `/api/meetings/${encodeURIComponent(id ?? "")}/export?${q}` : `/api/tasks/export?${q}`
}

/** `scope='tasks'` exports what the Tasks page shows (pass its current `filters`); `scope='meeting'` exports one meeting's items. */
export function ExportMenu({ scope, id, filters, size = "md" }: { scope: "tasks" | "meeting"; id?: string; filters?: Filters; size?: "md" | "sm" }) {
  return (
    <Menu align="end" trigger={(p) => <Button {...p} size={size} icon="download" aria-label="Export">Export</Button>}>
      {() => <>
        <MenuLabel>{scope === "meeting" ? "This meeting" : "Tasks in this view"}</MenuLabel>
        {FORMATS.map(([f, label]) => <MenuItem key={f} icon="download" href={exportUrl(scope, f, id, filters)}>{label}</MenuItem>)}
      </>}
    </Menu>
  )
}

const NAME: Record<BoardTarget, string> = { trello: "Trello", github: "GitHub" }

export function summarize(s: PushSummary, target: BoardTarget): { kind: "success" | "error" | "info"; title: string; body: string } {
  const parts = [s.created && `${s.created} created`, s.existing && `${s.existing} already sent`, s.skipped && `${s.skipped} skipped`, s.failed && `${s.failed} failed`].filter(Boolean)
  const lines = s.results.map((r) => (r.url ? `${r.title}: ${r.url}${r.warning ? ` (${r.warning})` : ""}` : `${r.title}: ${r.status === "skipped" ? "skipped" : "failed"} (${r.reason === "not_found" ? "not found" : r.reason ?? "unknown"})`))
  return { kind: s.failed ? "error" : s.results.some((r) => r.warning) ? "info" : s.created || s.existing ? "success" : "info", title: `${NAME[target]}: ${parts.join(", ") || "nothing to send"}`, body: lines.slice(0, 8).join(" | ") + (lines.length > 8 ? ` | ...and ${lines.length - 8} more` : "") }
}

/** Small links to the cards / issues a task was sent to (`externalRefs` from GET /api/tasks). Renders nothing without refs. */
export function ExternalLinks({ refs, className }: { refs?: ExternalRef[] | null; className?: string }) {
  if (!refs?.length) return null
  return (
    <span className={className ?? "inline-flex flex-wrap items-center gap-1.5"}>
      {refs.map((r) => (
        <a key={`${r.provider}:${r.id}`} href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:bg-hover" title={`Open on ${r.provider === "github" ? "GitHub" : r.provider === "trello" ? "Trello" : r.provider}`} onClick={(e) => e.stopPropagation()}>
          {r.provider === "github" ? `GitHub #${r.id}` : r.provider === "trello" ? "Trello card" : r.provider}
        </a>
      ))}
    </span>
  )
}

/**
 * Send to GitHub (or Trello when it is set up). `scope='tasks'`: `ids` are task ids. `scope='meeting'`: `id` is the meeting and `ids` are item ids
 * (omit to send every approved task). Only configured boards are listed; nothing renders when none is set up.
 */
export function PushMenu({ scope, id, ids, size = "md", label = "Send to" }: { scope: "tasks" | "meeting"; id?: string; ids?: string[]; size?: "md" | "sm"; label?: string }) {
  const toast = useToast()
  const targets = useQuery({ queryKey: ["board-targets"], queryFn: api.boardTargets, staleTime: 60_000 })
  const send = useAction(
    (target: BoardTarget) => scope === "meeting" ? api.pushMeeting(id ?? "", target, ids?.length ? { itemIds: ids } : { all: "approved" }) : api.pushTasks(target, ids ?? []),
    { onSuccess: (r, target) => { const s = summarize(r, target); toast.push({ ...s, ms: 12_000 }) } },
  )
  const on = (["github", "trello"] as const).filter((t) => targets.data?.[t])
  if (!on.length) return null
  const none = scope === "tasks" && !ids?.length
  return (
    <Menu align="end" trigger={(p) => <Button {...p} size={size} icon="upload" loading={send.isPending} disabled={none} title={none ? "Select tasks first" : undefined}>{label}</Button>}>
      {() => <>
        <MenuLabel>{scope === "meeting" && !ids?.length ? "All approved tasks" : `${ids?.length ?? 0} selected`}</MenuLabel>
        {on.map((t) => <MenuItem key={t} icon="external" onSelect={() => send.mutate(t)}>{NAME[t]}</MenuItem>)}
      </>}
    </Menu>
  )
}
