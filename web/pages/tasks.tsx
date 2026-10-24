import { useQuery } from "@tanstack/react-query"
import { useId, useMemo, useState } from "react"
import { api, errMsg, type NewTask, type Person, type Task, type TaskStatus } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { dateShort } from "@/lib/format"
import { Avatar } from "@/ui/avatar"
import { Badge, type Tone } from "@/ui/badge"
import { Button } from "@/ui/button"
import { useChannels } from "@/ui/channel-picker"
import { Dialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { FormField, Input, Select } from "@/ui/fields"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Table, type Column } from "@/ui/table"
import { Segmented, Tabs } from "@/ui/tabs"
import { cn } from "@/ui/cn"

type View = "all" | "mine" | "byme" | "overdue"
type Group = "list" | "person"
const VIEWS: { id: View; label: string }[] = [{ id: "all", label: "All" }, { id: "mine", label: "Mine" }, { id: "byme", label: "Assigned by me" }, { id: "overdue", label: "Overdue" }]
const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: "active", label: "Active" }, { id: "open", label: "Open" }, { id: "in_progress", label: "In progress" }, { id: "overdue", label: "Overdue" },
  { id: "done", label: "Done" }, { id: "dropped", label: "Dropped" }, { id: "all", label: "All statuses" },
]
const TONE: Record<TaskStatus, Tone> = { open: "accent", in_progress: "warn", overdue: "danger", done: "ok", dropped: "neutral" }
const SETTABLE = [["open", "Open"], ["in_progress", "In progress"], ["done", "Done"], ["dropped", "Dropped"]] as const
const ACTIVE = new Set<TaskStatus>(["open", "in_progress", "overdue"])
const nameOf = (t: Task) => t.ownerName ?? (t.ownerId ? t.ownerId : "Unassigned")

function Who({ name, src }: { name: string | null; src?: string | null }) {
  return name ? <span className="flex min-w-0 items-center gap-1.5"><Avatar name={name} src={src} size={20} /><span className="truncate">{name}</span></span> : <span className="text-subtle">Unknown</span>
}

/** Searchable single-select list of people (same pattern as the channel picker). */
function PersonPicker({ label, value, onChange, people }: { label: string; value: string; onChange: (id: string) => void; people: Person[] }) {
  const [filter, setFilter] = useState("")
  const lid = useId()
  const f = filter.trim().toLowerCase()
  const shown = people.filter((p) => !f || (p.name ?? p.id).toLowerCase().includes(f))
  return (
    <div className="flex flex-col gap-2">
      <Input type="search" aria-label={`Search people: ${label}`} aria-controls={lid} placeholder="Search people" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul id={lid} aria-label={label} className="surface max-h-48 divide overflow-y-auto">
        {shown.map((p) => (
          <li key={p.id}>
            <button type="button" aria-pressed={value === p.id} onClick={() => onChange(p.id)} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-hover", value === p.id && "bg-hover")}>
              <Avatar name={p.name ?? p.id} src={p.avatarUrl} size={20} /><span className="truncate">{p.name ?? p.id}</span>
              {p.title && <span className="truncate text-xs text-subtle">{p.title}</span>}
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-2 text-sm text-muted">No one matches.</li>}
      </ul>
    </div>
  )
}

function AddTask({ open, onClose, people }: { open: boolean; onClose: () => void; people: Person[] }) {
  const { channels } = useChannels()
  const [title, setTitle] = useState("")
  const [ownerId, setOwnerId] = useState("")
  const [due, setDue] = useState("")
  const [priority, setPriority] = useState<"normal" | "urgent">("normal")
  const [channelId, setChannelId] = useState("")
  const create = useAction((t: NewTask) => api.createTask(t), {
    invalidate: [["tasks"]], ok: "Task created", inline: true,
    onSuccess: () => { setTitle(""); setOwnerId(""); setDue(""); setPriority("normal"); setChannelId(""); onClose() },
  })
  const submit = () => create.mutate({ title: title.trim(), ownerId, priority, ...(due ? { due: new Date(`${due}T23:59:00`).toISOString() } : {}), ...(channelId ? { channelId } : {}) })
  return (
    <Dialog open={open} onClose={onClose} title="Add task" description="The assignee gets a DM from Pixel with Done and Drop buttons." width={520}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={title.trim().length < 3 || !ownerId} onClick={submit}>Create task</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (title.trim().length >= 3 && ownerId) submit() }}>
        <FormField label="What needs doing">{(p) => <Input {...p} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="Tales launch" autoFocus />}</FormField>
        <div className="flex flex-col gap-1.5"><span id="task-owner-l" className="text-sm font-medium">Assign to</span><PersonPicker label="Assign to" value={ownerId} onChange={setOwnerId} people={people} /></div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Due" optional>{(p) => <Input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</FormField>
          <FormField label="Priority">{(p) => <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as "normal" | "urgent")}><option value="normal">Normal</option><option value="urgent">Urgent</option></Select>}</FormField>
        </div>
        <FormField label="Channel" optional hint="Only people who can read the channel can see the task. Without one it is visible to you and the assignee.">
          {(p) => <Select {...p} value={channelId} onChange={(e) => setChannelId(e.target.value)}><option value="">No channel</option>{channels.filter((c) => !c.isIm).map((c) => <option key={c.id} value={c.id}>#{c.name ?? c.id}</option>)}</Select>}
        </FormField>
        {create.error && <p role="alert" className="text-sm text-danger">{errMsg(create.error)}</p>}
      </form>
    </Dialog>
  )
}

export default function Tasks() {
  const { me, admin } = useMe()
  const q = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, placeholderData: (p) => p })
  const people = useQuery({ queryKey: ["people"], queryFn: api.people, staleTime: 5 * 60_000 })
  const [view, setView] = useState<View>("all")
  const [group, setGroup] = useState<Group>("list")
  const [status, setStatus] = useState("active")
  const [person, setPerson] = useState("")
  const [channel, setChannel] = useState("")
  const [search, setSearch] = useState("")
  const [adding, setAdding] = useState(false)
  const [reassign, setReassign] = useState<Task | null>(null)
  const [newOwner, setNewOwner] = useState("")
  const patch = useAction((v: { id: string; p: Parameters<typeof api.patchTask>[1] }) => api.patchTask(v.id, v.p), { invalidate: [["tasks"]] })
  const sync = useAction(() => api.syncTasks(), {
    invalidate: [["tasks"]],
    onSuccess: () => undefined, ok: "Synced tasks from memory",
  })

  const apply = (all: Task[]) => {
    const uid = me?.id
    const f = search.trim().toLowerCase()
    return all.filter((t) => {
      if (view === "mine" && t.ownerId !== uid) return false
      if (view === "byme" && t.assignerId !== uid) return false
      if (view === "overdue" && !t.overdue) return false
      if (status === "active" ? !ACTIVE.has(t.status) : status !== "all" && t.status !== status) return false
      if (person && t.ownerId !== person) return false
      if (channel && t.channelId !== channel) return false
      return !f || `${t.title} ${nameOf(t)} ${t.assignerName ?? ""}`.toLowerCase().includes(f)
    })
  }

  const columns = (): Column<Task>[] => [
    { key: "title", header: "Task", primary: true, sort: (t) => t.title.toLowerCase(), cell: (t) => <span className="flex min-w-0 flex-wrap items-center gap-1.5"><span className="line-clamp-2">{t.title}</span>{t.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}</span> },    { key: "owner", header: "Assigned to", sort: nameOf, cell: (t) => <Who name={t.ownerId || t.ownerName ? nameOf(t) : null} src={t.ownerAvatar} /> },
    { key: "by", header: "Assigned by", hideSm: true, sort: (t) => t.assignerName, cell: (t) => <Who name={t.assignerName} src={t.assignerAvatar} /> },
    { key: "due", header: "Due", sort: (t) => t.dueAt, cell: (t) => t.dueAt ? <span className={t.overdue ? "font-medium text-danger" : undefined}>{dateShort(t.dueAt)}{t.overdue && <span className="sr-only"> (overdue)</span>}</span> : <span className="text-subtle">No date</span> },
    { key: "status", header: "Status", end: true, sort: (t) => t.status, cell: (t) => t.canEdit
      ? <Select aria-label={`Status of ${t.title}`} className="h-8 w-32" value={t.status === "overdue" ? "open" : t.status} disabled={patch.isPending}
          onChange={(e) => patch.mutate({ id: t.id, p: { status: e.target.value as "open" } })}>
          {t.status === "overdue" && <option value="open">Overdue</option>}
          {SETTABLE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      : <Badge tone={TONE[t.status]} dot>{t.status.replace("_", " ")}</Badge> },
    { key: "src", header: "Source", hideSm: true, cell: (t) => t.permalink
      ? <a href={t.permalink} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">{t.channelName ? `#${t.channelName}` : "Slack"}<span className="sr-only"> (opens in a new tab)</span></a>
      : <span className="text-muted">{t.channelName ? `#${t.channelName}` : t.sourceType}</span> },
    { key: "act", header: <span className="sr-only">Actions</span>, cell: (t) => t.canEdit && ACTIVE.has(t.status) ? (
      <span className="flex gap-1">
        <Button size="sm" icon="check" aria-label={`Mark done: ${t.title}`} onClick={() => patch.mutate({ id: t.id, p: { status: "done" } })}>Done</Button>
        <Button size="sm" variant="ghost" icon="x" title="Drop" aria-label={`Drop: ${t.title}`} onClick={() => patch.mutate({ id: t.id, p: { status: "dropped" } })} />
        {t.canReassign && <Button size="sm" variant="ghost" icon="user" title="Reassign" aria-label={`Reassign: ${t.title}`} onClick={() => { setReassign(t); setNewOwner("") }} />}
      </span>) : null },
  ]

  const rowsView = useMemo(() => columns(), [patch.isPending]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Tasks" desc="Every task and who it is assigned to. Ask Pixel to assign work in Slack, or add it here; each task is also kept in memory and chased until it is done."
        actions={<>
          {admin && <Button icon="sync" loading={sync.isPending} onClick={() => sync.mutate()}>Sync from memory</Button>}
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add task</Button>
        </>} />
      <Async q={q} rows={6}>{({ tasks: all }) => {
        const rows = apply(all)
        const owners = [...new Map(all.filter((t) => t.ownerId).map((t) => [t.ownerId!, nameOf(t)])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
        const chans = [...new Map(all.filter((t) => t.channelId).map((t) => [t.channelId!, t.channelName ?? t.channelId!])).entries()]
        const grouped = group === "person" ? [...rows.reduce((m, t) => m.set(nameOf(t), [...(m.get(nameOf(t)) ?? []), t]), new Map<string, Task[]>()).entries()].sort((a, b) => a[0].localeCompare(b[0])) : []
        return (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <Tabs label="Task views" items={VIEWS} value={view} onChange={setView} />
              <Segmented label="Layout" value={group} onChange={setGroup} items={[{ id: "list", label: "List" }, { id: "person", label: "By person" }]} />
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Input type="search" aria-label="Search tasks" className="w-56" placeholder="Search tasks or people" value={search} onChange={(e) => setSearch(e.target.value)} />
              <Select aria-label="Status" className="w-36" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS_FILTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
              <Select aria-label="Person" className="w-44" value={person} onChange={(e) => setPerson(e.target.value)}><option value="">Everyone</option>{owners.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select>
              <Select aria-label="Channel" className="w-40" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">All channels</option>{chans.map(([id, n]) => <option key={id} value={id}>#{n}</option>)}</Select>
              <span className="ml-auto text-xs text-muted" aria-live="polite">{rows.length} shown</span>
            </div>
            {rows.length === 0 ? (
              <Panel><EmptyState icon="check" title={all.length ? "No tasks match" : "No tasks yet"} action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add task</Button>}>
                {all.length ? "Nothing matches these filters." : <>Try telling Pixel in Slack: <em>&ldquo;@Pixel assign the task of Tales launch to @Parag and tell him it is urgent&rdquo;</em>. It shows up here, and Parag gets a DM.</>}
              </EmptyState></Panel>
            ) : group === "list" ? (
              <Panel><Table caption="Tasks" rows={rows} rowKey={(t) => t.id} initialSort={{ key: "due", dir: 1 }} columns={rowsView} /></Panel>
            ) : (
              <div className="flex flex-col gap-4">
                {grouped.map(([who, ts]) => (
                  <section key={who} aria-label={who}>
                    <h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold"><Avatar name={who} src={ts[0]!.ownerAvatar} size={20} />{who}<span className="font-normal text-muted">{ts.length}</span></h2>
                    <Panel><Table caption={`Tasks for ${who}`} rows={ts} rowKey={(t) => t.id} initialSort={{ key: "due", dir: 1 }} columns={rowsView} /></Panel>
                  </section>
                ))}
              </div>
            )}
          </>
        )
      }}</Async>
      <AddTask open={adding} onClose={() => setAdding(false)} people={people.data ?? []} />
      <Dialog open={!!reassign} onClose={() => setReassign(null)} title="Reassign task" description={reassign?.title}
        footer={<><Button onClick={() => setReassign(null)}>Cancel</Button>
          <Button variant="primary" disabled={!newOwner} loading={patch.isPending} onClick={() => reassign && patch.mutate({ id: reassign.id, p: { ownerId: newOwner } }, { onSuccess: () => setReassign(null) })}>Reassign</Button></>}>
        <PersonPicker label="New assignee" value={newOwner} onChange={setNewOwner} people={people.data ?? []} />
      </Dialog>
    </>
  )
}
