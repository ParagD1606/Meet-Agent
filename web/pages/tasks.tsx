import { useQuery } from "@tanstack/react-query"
import { useId, useMemo, useState } from "react"
import { ExportMenu, PushMenu } from "@/ui/task-export"
import { api, errMsg, type NewTask, type Person, type Task, type TaskCounts, type TaskFlag, type TaskStatus } from "@/lib/api"
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

type View = "all" | "attention" | "mine" | "byme" | "overdue"
/** Chip filter: an exception flag, or tasks finished in the last 7 days. */
type Chip = TaskFlag | "done7d" | ""
type Group = "list" | "person"
const VIEWS: { id: View; label: string }[] = [{ id: "all", label: "All" }, { id: "attention", label: "Needs attention" }, { id: "mine", label: "Mine" }, { id: "byme", label: "Assigned by me" }, { id: "overdue", label: "Overdue" }]
const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: "active", label: "Active" }, { id: "open", label: "Open" }, { id: "in_progress", label: "In progress" }, { id: "overdue", label: "Overdue" },
  { id: "done", label: "Done" }, { id: "dropped", label: "Dropped" }, { id: "all", label: "All statuses" },
]
const TONE: Record<TaskStatus, Tone> = { open: "accent", in_progress: "warn", overdue: "danger", done: "ok", dropped: "neutral" }
const SETTABLE = [["open", "Open"], ["in_progress", "In progress"], ["done", "Done"], ["dropped", "Dropped"]] as const
const ACTIVE = new Set<TaskStatus>(["open", "in_progress", "overdue"])
const nameOf = (t: Task) => t.ownerName ?? (t.ownerId ? t.ownerId : "Unassigned")

const flagsOf = (t: Task): TaskFlag[] => t.flags ?? (t.overdue ? ["overdue"] : [])
const attention = (t: Task) => { const f = flagsOf(t); return f.includes("overdue") || f.includes("unassigned") || f.includes("noDue") }
const WEEK = 7 * 86_400_000
/** Fallback for a server that predates `counts`. */
const localCounts = (all: Task[]): TaskCounts => {
  const n = (f: TaskFlag) => all.filter((t) => flagsOf(t).includes(f)).length
  return { total: all.length, open: all.filter((t) => ACTIVE.has(t.status)).length, overdue: n("overdue"), unassigned: n("unassigned"), noDue: n("noDue"), dueSoon: n("dueSoon"), done7d: all.filter((t) => t.status === "done" && !!t.completedAt && Date.now() - new Date(t.completedAt).getTime() <= WEEK).length }
}

/** Summary strip: each chip is a toggle button that filters the list below. */
function Stats({ counts, chip, onChip }: { counts: TaskCounts; chip: Chip; onChip: (c: Chip) => void }) {
  const items: { id: Chip; label: string; n: number; tone: string }[] = [
    { id: "overdue", label: "Overdue", n: counts.overdue, tone: "text-danger" },
    { id: "unassigned", label: "Unassigned", n: counts.unassigned, tone: "text-warn" },
    { id: "noDue", label: "No due date", n: counts.noDue, tone: "text-muted" },
    { id: "dueSoon", label: "Due soon", n: counts.dueSoon, tone: "text-accent-text" },
    { id: "done7d", label: "Done this week", n: counts.done7d, tone: "text-ok" },
  ]
  return (
    <div role="group" aria-label="Task summary" className="mb-3 flex flex-wrap gap-2">
      {items.map((i) => (
        <button key={i.id} type="button" aria-pressed={chip === i.id} onClick={() => onChip(chip === i.id ? "" : i.id)}
          className={cn("surface flex min-w-[7.5rem] flex-col items-start px-3 py-2 text-left hover:bg-hover focus-visible:outline-2", chip === i.id && "bg-hover ring-2 ring-accent")}>
          <span className={cn("text-xl font-semibold leading-none", i.n > 0 ? i.tone : "text-subtle")}>{i.n}</span>
          <span className="mt-1 text-xs text-muted">{i.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Inline quick-edit shown under a task title: pick an owner or a due date; Enter/change commits, Escape cancels. */
function QuickEdit({ kind, task, people, onDone, busy, save }: { kind: "owner" | "due"; task: Task; people: Person[]; onDone: () => void; busy: boolean; save: (p: Parameters<typeof api.patchTask>[1]) => void }) {
  const stop = (e: React.KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onDone() } }
  return (
    <span className="mt-1 flex items-center gap-1.5" onKeyDown={stop}>
      {kind === "owner"
        ? <Select aria-label={`Assign: ${task.title}`} className="h-8 w-44" autoFocus disabled={busy} defaultValue="" onChange={(e) => { if (e.target.value) { save({ ownerId: e.target.value }); onDone() } }}>
            <option value="" disabled>Choose a person</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name ?? p.id}</option>)}
          </Select>
        : <>
            <Input type="date" aria-label={`Due date: ${task.title}`} className="h-8 w-40" autoFocus disabled={busy} defaultValue={task.dueAt ? task.dueAt.slice(0, 10) : ""}
              onChange={(e) => { if (e.target.value) { save({ due: new Date(`${e.target.value}T23:59:00`).toISOString() }); onDone() } }} />
            {task.dueAt && <Button size="sm" variant="ghost" onClick={() => { save({ due: null }); onDone() }}>Clear</Button>}
          </>}
      <Button size="sm" variant="ghost" icon="x" aria-label="Cancel edit" onClick={onDone} />
    </span>
  )
}

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
  const [chip, setChip] = useState<Chip>("")
  const [editing, setEditing] = useState<{ id: string; kind: "owner" | "due" } | null>(null)
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
      if (view === "attention" && !attention(t)) return false
      if (chip === "done7d") { if (t.status !== "done" || !t.completedAt || Date.now() - new Date(t.completedAt).getTime() > WEEK) return false }
      else if (chip && !flagsOf(t).includes(chip)) return false
      if (chip !== "done7d" && (status === "active" ? !ACTIVE.has(t.status) : status !== "all" && t.status !== status)) return false
      if (person && t.ownerId !== person) return false
      if (channel && t.channelId !== channel) return false
      return !f || `${t.title} ${nameOf(t)} ${t.assignerName ?? ""}`.toLowerCase().includes(f)
    })
  }

  const columns = (): Column<Task>[] => [
    { key: "title", header: "Task", primary: true, sort: (t) => t.title.toLowerCase(), cell: (t) => {
      const f = flagsOf(t)
      const act = (k: "owner" | "due") => setEditing({ id: t.id, kind: k })
      return (
        <span className="flex min-w-[220px] max-w-[440px] flex-col items-start whitespace-normal">
          <span className="line-clamp-2 break-words">{t.title}</span>
          {f.length > 0 && (
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              {f.includes("overdue") && <Badge tone="danger">Overdue</Badge>}
              {f.includes("urgent") && <Badge tone="danger">Urgent</Badge>}
              {f.includes("unassigned") && <Badge tone="warn">Unassigned</Badge>}
              {f.includes("unassigned") && t.canEdit && <Button size="sm" variant="ghost" aria-label={`Assign: ${t.title}`} onClick={() => act("owner")}>Assign</Button>}
              {f.includes("noDue") && <Badge>No date</Badge>}
              {f.includes("noDue") && t.canEdit && <Button size="sm" variant="ghost" aria-label={`Set date: ${t.title}`} onClick={() => act("due")}>Set date</Button>}
              {f.includes("dueSoon") && <Badge tone="accent">Due soon</Badge>}
              {f.includes("stale") && <Badge>Stale</Badge>}
            </span>
          )}
          {editing?.id === t.id && <QuickEdit kind={editing.kind} task={t} people={people.data ?? []} busy={patch.isPending} save={(p) => patch.mutate({ id: t.id, p })} onDone={() => setEditing(null)} />}
        </span>
      )
    } },
    { key: "owner", header: "Assigned to", sort: nameOf, cell: (t) => (
      <span className="flex items-center gap-1">
        {t.ownerId || t.ownerName ? <Who name={nameOf(t)} src={t.ownerAvatar} /> : <span className="font-medium text-warn">Unassigned</span>}
        {t.canReassign && ACTIVE.has(t.status) && <Button size="sm" variant="ghost" icon="edit" title="Change owner" aria-label={`Change owner: ${t.title}`} onClick={() => setEditing({ id: t.id, kind: "owner" })} />}
      </span>) },
    { key: "by", header: "Assigned by", hideSm: true, sort: (t) => t.assignerName, cell: (t) => <Who name={t.assignerName} src={t.assignerAvatar} /> },
    { key: "due", header: "Due", sort: (t) => t.dueAt, cell: (t) => (
      <span className="flex items-center gap-1">
        {t.dueAt ? <span className={t.overdue ? "font-medium text-danger" : undefined}>{dateShort(t.dueAt)}{t.overdue && <span className="sr-only"> (overdue)</span>}</span> : <span className="text-subtle">No date</span>}
        {t.canEdit && ACTIVE.has(t.status) && <Button size="sm" variant="ghost" icon="edit" title="Change due date" aria-label={`Change due date: ${t.title}`} onClick={() => setEditing({ id: t.id, kind: "due" })} />}
      </span>) },
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
        <PushMenu scope="tasks" ids={[t.id]} size="sm" label="Send" />
        {t.canReassign && <Button size="sm" variant="ghost" icon="user" title="Reassign" aria-label={`Reassign: ${t.title}`} onClick={() => { setReassign(t); setNewOwner("") }} />}
      </span>) : null },
  ]

  const rowsView = useMemo(() => columns(), [patch.isPending, editing, people.data]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PageHeader title="Tasks" desc="Every task and who it is assigned to. Ask Pixel to assign work in Slack, or add it here; each task is also kept in memory and chased until it is done."
        actions={<>
          <ExportMenu scope="tasks" filters={{
            status: status === "active" ? "open,in_progress,overdue" : status === "all" ? undefined : status,
            owner: person || undefined, channel: channel || undefined, q: search || undefined,
            mine: view === "mine", assignedByMe: view === "byme", overdue: view === "overdue" || chip === "overdue",
            unassigned: chip === "unassigned", noDue: chip === "noDue", dueSoon: chip === "dueSoon", stale: chip === "stale",
          }} />
          {admin && <Button icon="sync" loading={sync.isPending} onClick={() => sync.mutate()}>Sync from memory</Button>}
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add task</Button>
        </>} />
      <Async q={q} rows={6}>{({ tasks: all, counts }) => {
        const rows = apply(all)
        const owners = [...new Map(all.filter((t) => t.ownerId).map((t) => [t.ownerId!, nameOf(t)])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
        const chans = [...new Map(all.filter((t) => t.channelId).map((t) => [t.channelId!, t.channelName ?? t.channelId!])).entries()]
        const grouped = group === "person" ? [...rows.reduce((m, t) => m.set(nameOf(t), [...(m.get(nameOf(t)) ?? []), t]), new Map<string, Task[]>()).entries()].sort((a, b) => a[0].localeCompare(b[0])) : []
        return (
          <>
            <Stats counts={counts ?? localCounts(all)} chip={chip} onChip={(c) => { setChip(c); if (c && c !== "done7d") setStatus("active") }} />
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
              <Panel><Table caption="Tasks" rows={rows} rowKey={(t) => t.id} columns={rowsView} /></Panel>
            ) : (
              <div className="flex flex-col gap-4">
                {grouped.map(([who, ts]) => (
                  <section key={who} aria-label={who}>
                    <h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold"><Avatar name={who} src={ts[0]!.ownerAvatar} size={20} />{who}<span className="font-normal text-muted">{ts.length}</span></h2>
                    <Panel><Table caption={`Tasks for ${who}`} rows={ts} rowKey={(t) => t.id} columns={rowsView} /></Panel>
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
