import { useQuery } from "@tanstack/react-query"
import { useId, useMemo, useState } from "react"
import { api, type Channel } from "@/lib/api"
import { Icon } from "@/lib/icons"
import { Input } from "./fields"
import { cn } from "./cn"

/** Shared channel list (names for ids). Cached; pickers and pages use the same query. */
export function useChannels() {
  const q = useQuery({ queryKey: ["channels"], queryFn: api.channels, staleTime: 60_000 })
  const byId = useMemo(() => new Map((q.data ?? []).map((c) => [c.id, c])), [q.data])
  return { ...q, channels: q.data ?? [], label: (id: string) => (byId.get(id)?.name ? `#${byId.get(id)!.name}` : id) }
}

const ID_RE = /^[CGD][A-Z0-9]{6,}$/i
const ChannelName = ({ c }: { c: Channel }) => (
  <span className="flex min-w-0 items-center gap-1.5 text-sm">
    <Icon name={c.isPrivate ? "lock" : "hash"} size={14} className="shrink-0 text-subtle" />
    <span className="truncate">{c.name ?? c.id}</span>
    {!c.botIsMember && <span className="shrink-0 text-xs text-subtle">bot not in channel</span>}
  </span>
)

interface Common { label: string; disabled?: boolean; className?: string }

/** Searchable list. `value` is a channel id (single) or ids (multi). A pasted Slack ID is accepted as a fallback. */
export function ChannelPicker(p: Common & ({ multiple?: false; value: string; onChange: (id: string) => void } | { multiple: true; value: string[]; onChange: (ids: string[]) => void })) {
  const { channels, isPending, error } = useChannels()
  const [filter, setFilter] = useState("")
  const lid = useId()
  const selected = p.multiple ? p.value : p.value ? [p.value] : []
  const f = filter.trim().replace(/^#/, "").toLowerCase()
  const shown = channels.filter((c) => !f || (c.name ?? c.id).toLowerCase().includes(f) || c.id.toLowerCase() === f)
  const known = new Set(channels.map((c) => c.id))
  const pasted = ID_RE.test(f) && !known.has(f.toUpperCase()) ? f.toUpperCase() : null
  const unknown = selected.filter((id) => !known.has(id))
  const toggle = (id: string) => {
    if (!p.multiple) return p.onChange(id)
    p.onChange(p.value.includes(id) ? p.value.filter((x) => x !== id) : [...p.value, id])
  }
  return (
    <div className={cn("flex flex-col gap-2", p.className)}>
      <div className="relative">
        <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-subtle" />
        <Input type="search" aria-label={`Search channels: ${p.label}`} aria-controls={lid} placeholder="Search channels, or paste a channel ID" className="pl-8" disabled={p.disabled}
          value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <ul id={lid} aria-label={p.label} className="surface max-h-56 divide overflow-y-auto">
        {pasted && (
          <li>
            <button type="button" aria-pressed={selected.includes(pasted)} disabled={p.disabled} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover" onClick={() => { toggle(pasted); setFilter("") }}>
              Use ID <code className="font-mono">{pasted}</code>
            </button>
          </li>
        )}
        {shown.map((c) => {
          const on = selected.includes(c.id)
          return (
            <li key={c.id}>
              <button type="button" aria-pressed={on} disabled={p.disabled} className={cn("flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-hover", on && "bg-hover")} onClick={() => toggle(c.id)}>
                <ChannelName c={c} />
                {on && <Icon name="check" size={14} className="shrink-0 text-accent-text" />}
              </button>
            </li>
          )
        })}
        {isPending && <li className="px-3 py-2 text-sm text-muted">Loading channels</li>}
        {!isPending && !shown.length && !pasted && <li className="px-3 py-2 text-sm text-muted">{error ? "Couldn't load channels. Paste a channel ID instead." : channels.length ? "No channels match." : "No channels yet. Invite the bot to one in Slack, or paste a channel ID."}</li>}
      </ul>
      {p.multiple && unknown.length > 0 && (
        <p className="text-xs text-muted">Not in the list: {unknown.map((id) => (
          <button key={id} type="button" className="mr-1 rounded border border-line px-1.5 font-mono hover:bg-hover" disabled={p.disabled} onClick={() => toggle(id)} aria-label={`Remove ${id}`}>{id} &times;</button>
        ))}</p>
      )}
    </div>
  )
}
