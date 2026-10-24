import { useQuery } from "@tanstack/react-query"
import { api, type BoardTarget, type PushSummary } from "@/lib/api"
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

const NAME: Record<BoardTarget, string> = { trello: "Trello", github: "GitHub Issues" }

export function summarize(s: PushSummary, target: BoardTarget): { kind: "success" | "error" | "info"; title: string; body: string } {
  const parts = [s.created && `${s.created} created`, s.existing && `${s.existing} already sent`, s.skipped && `${s.skipped} skipped`, s.failed && `${s.failed} failed`].filter(Boolean)
  const lines = s.results.map((r) => (r.url ? `${r.title}: ${r.url}` : `${r.title}: ${r.status === "skipped" ? "skipped" : "failed"} (${r.reason === "not_found" ? "not found" : r.reason ?? "unknown"})`))
  return { kind: s.failed ? "error" : s.created || s.existing ? "success" : "info", title: `${NAME[target]}: ${parts.join(", ") || "nothing to send"}`, body: lines.slice(0, 8).join(" | ") + (lines.length > 8 ? ` | ...and ${lines.length - 8} more` : "") }
}

/**
 * Send to Trello / GitHub. `scope='tasks'`: `ids` are task ids. `scope='meeting'`: `id` is the meeting and `ids` are item ids
 * (omit to send every approved task). Only configured boards are listed; nothing renders when none is set up.
 */
export function PushMenu({ scope, id, ids, size = "md", label = "Send to" }: { scope: "tasks" | "meeting"; id?: string; ids?: string[]; size?: "md" | "sm"; label?: string }) {
  const toast = useToast()
  const targets = useQuery({ queryKey: ["board-targets"], queryFn: api.boardTargets, staleTime: 60_000 })
  const send = useAction(
    (target: BoardTarget) => scope === "meeting" ? api.pushMeeting(id ?? "", target, ids?.length ? { itemIds: ids } : { all: "approved" }) : api.pushTasks(target, ids ?? []),
    { onSuccess: (r, target) => { const s = summarize(r, target); toast.push({ ...s, ms: 12_000 }) } },
  )
  const on = (["trello", "github"] as const).filter((t) => targets.data?.[t])
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
