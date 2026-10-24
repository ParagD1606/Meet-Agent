import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Commitment, type CommitmentStatus } from "@/lib/api"
import { useUserNames } from "@/lib/auth"
import { dateShort } from "@/lib/format"
import { Badge, type Tone } from "@/ui/badge"
import { useChannels } from "@/ui/channel-picker"
import { EmptyState } from "@/ui/empty"
import { Select } from "@/ui/fields"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Table } from "@/ui/table"
import { Segmented } from "@/ui/tabs"

type Filter = "open,overdue" | "" | CommitmentStatus
const FILTERS: { id: Filter; label: string }[] = [
  { id: "open,overdue", label: "Active" }, { id: "overdue", label: "Overdue" }, { id: "done", label: "Done" }, { id: "dropped", label: "Dropped" }, { id: "", label: "All" },
]
const TONE: Record<CommitmentStatus, Tone> = { open: "accent", overdue: "danger", done: "ok", dropped: "neutral" }

export default function Commitments() {
  const [status, setStatus] = useState<Filter>("open,overdue")
  const [owner, setOwner] = useState("")
  const q = useQuery({ queryKey: ["commitments", status], queryFn: () => api.commitments(status), placeholderData: (p) => p })
  const { label } = useChannels()
  const names = useUserNames()
  const ownerOf = (c: Commitment) => c.ownerName ?? (c.ownerId ? names.name(c.ownerId) : "Unassigned")
  return (
    <>
      <PageHeader title="Commitments" desc="Who promised what, by when. The bot picks these up from conversations, meetings and tickets, and nudges owners. Read-only for now."
        actions={<Segmented label="Status" value={status} onChange={setStatus} items={FILTERS} />} />
      <Async q={q} rows={6}>{(all) => {
        const owners = [...new Set(all.map(ownerOf))].sort()
        const rows = owner ? all.filter((c) => ownerOf(c) === owner) : all
        return (
          <>
            <div className="mb-3 flex items-center gap-2">
              <label htmlFor="owner" className="text-sm text-muted">Owner</label>
              <Select id="owner" className="w-48" value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="">Everyone</option>
                {owners.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
              <span className="ml-auto text-xs text-muted">{rows.length} shown</span>
            </div>
            <Panel>
              {rows.length === 0 ? <EmptyState icon="check" title="No commitments here">Nothing matches this filter. Commitments appear after people agree on something with a clear owner in a conversation the bot is in.</EmptyState> : (
                <Table caption="Commitments" rows={rows} rowKey={(c) => c.id} initialSort={{ key: "due", dir: 1 }} columns={[
                  { key: "text", header: "Commitment", primary: true, cell: (c) => <span className="line-clamp-2">{c.text}</span> },
                  { key: "owner", header: "Owner", sort: ownerOf, cell: ownerOf },
                  { key: "due", header: "Due", sort: (c) => c.dueAt, cell: (c) => c.dueAt ? <span className={c.status === "overdue" ? "text-danger" : undefined}>{dateShort(c.dueAt)}</span> : <span className="text-subtle">No date</span> },
                  { key: "status", header: "Status", end: true, sort: (c) => c.status, cell: (c) => <Badge tone={TONE[c.status]} dot>{c.status}</Badge> },
                  { key: "src", header: "Source", hideSm: true, cell: (c) => c.permalink
                    ? <a href={c.permalink} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">{c.channelId ? label(c.channelId) : c.sourceType}<span className="sr-only"> (opens in a new tab)</span></a>
                    : <span className="text-muted">{c.channelId ? label(c.channelId) : c.sourceType}</span> },
                ]} />
              )}
            </Panel>
          </>
        )
      }}</Async>
    </>
  )
}
