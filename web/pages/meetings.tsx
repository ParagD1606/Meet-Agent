import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, isAdmin, type Meeting, type MeetingStatus, type MeetingTask } from "@/lib/api"
import { ago, dateTime } from "@/lib/format"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { EmptyState } from "@/ui/empty"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Tabs } from "@/ui/tabs"

const deliveryTone = { needs_assignee: "danger", pending: "warn", sent: "accent", acknowledged: "ok", declined: "danger", failed: "danger" } as const
const deliveryLabel = { needs_assignee: "Needs assignee", pending: "Ready to send", sent: "Sent", acknowledged: "Acknowledged", declined: "Declined", failed: "Delivery failed" } as const

const tone: Record<MeetingStatus, "neutral" | "ok" | "warn" | "danger"> = { processing: "warn", ready: "ok", failed: "danger" }
const statusLabel: Record<MeetingStatus, string> = { processing: "Processing", ready: "Ready", failed: "Summary failed" }

function Task({ meetingId, task }: { meetingId: string; task: MeetingTask }) {
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState("")
  const candidates = useQuery({ queryKey: ["meeting-assignees", meetingId, query], queryFn: () => api.meetingAssignees(meetingId, query), enabled: editing })
  const assign = useMutation({ mutationFn: (assigneeId: string | null) => api.updateMeetingTaskAssignee(meetingId, task.id, assigneeId), onSuccess: () => { setEditing(false); setQuery(""); client.invalidateQueries({ queryKey: ["meeting", meetingId] }); client.invalidateQueries({ queryKey: ["meetings"] }) } })
  const who = task.assigneeName ?? (task.assigneeId ? `Slack user ${task.assigneeId}` : "Unassigned")
  const status = task.notification?.status ?? "needs_assignee"
  return <li className="rounded-lg border border-line bg-sunken px-3 py-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><span className="font-medium">{task.title}</span><span className="flex gap-2"><Badge tone={deliveryTone[status]}>{deliveryLabel[status]}</Badge>{task.jiraUrl ? <a className="text-sm text-accent hover:underline" href={task.jiraUrl} target="_blank" rel="noreferrer">{task.jiraKey ?? "Open in Jira"}</a> : <Badge tone="neutral">Not created in Jira</Badge>}</span></div>
    {task.description && <p className="mt-1 whitespace-pre-line text-sm text-muted">{task.description}</p>}
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted"><span>Owner: {who}{task.dueDate ? ` · Due ${task.dueDate}` : ""}</span><Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>{editing ? "Cancel" : task.assigneeId ? "Change assignee" : "Assign"}</Button></div>
    {status === "failed" && task.notification?.error && <p className="mt-2 text-xs text-danger">{task.notification.error}</p>}
    {editing && <div className="mt-3 rounded-md border border-line bg-panel p-2">
      <input className="w-full rounded border border-line bg-sunken px-2 py-1.5 text-sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Slack members" autoFocus />
      <div className="mt-2 max-h-36 overflow-auto">{candidates.data?.map((user) => <button key={user.id} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-hover" disabled={assign.isPending} onClick={() => assign.mutate(user.id)}>{user.name ?? user.id}</button>)}</div>
      <Button size="sm" variant="ghost" className="mt-2" loading={assign.isPending} onClick={() => assign.mutate(null)}>Clear assignment</Button>
      {assign.error && <p className="mt-2 text-xs text-danger">Could not update the assignee.</p>}
    </div>}
  </li>
}

function Detail({ meeting }: { meeting: Meeting }) {
  const client = useQueryClient()
  const [tab, setTab] = useState<"transcript" | "summary">("summary")
  const send = useMutation({ mutationFn: () => api.sendMeetingTaskDms(meeting.id), onSuccess: () => { client.invalidateQueries({ queryKey: ["meeting", meeting.id] }); client.invalidateQueries({ queryKey: ["meetings"] }) } })
  const date = meeting.endedAt ?? meeting.createdAt
  return <div className="min-w-0">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{meeting.title}</h2><p className="mt-1 text-sm text-muted">Completed {dateTime(date)} · {meeting.participantIds.length} participant{meeting.participantIds.length === 1 ? "" : "s"}</p></div>
      <span className="flex items-center gap-2"><Button size="sm" loading={send.isPending} disabled={!meeting.tasks.length} onClick={() => send.mutate()}>Send task DMs</Button><Badge tone={tone[meeting.status]}>{statusLabel[meeting.status]}</Badge></span>
    </div>
    <Tabs label="Meeting content" value={tab} onChange={setTab} items={[{ id: "summary", label: `Summary, decisions & tasks (${meeting.tasks.length})` }, { id: "transcript", label: "Source notes" }]} />
    {tab === "transcript" ? (
      <div className="mt-4 rounded-lg border border-line bg-sunken p-4"><pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">{meeting.transcript || "The transcript is loading."}</pre></div>
    ) : (
      <div className="mt-4 space-y-6">
        {meeting.status === "processing" && <p className="rounded-lg bg-sunken p-4 text-sm text-muted">Company Brain is reading the saved Huddle transcript and preparing notes.</p>}
        {meeting.status === "failed" && <p className="rounded-lg bg-danger-soft p-4 text-sm text-danger">The source notes were saved, but the summary could not be generated. You can still read them in the Source notes tab.</p>}
        {meeting.summary && <section><h3 className="text-sm font-semibold">Meeting summary</h3><div className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-sunken p-4 text-sm leading-6">{meeting.summary}</div></section>}
        {(meeting.decisions?.length ?? 0) > 0 && <section><h3 className="text-sm font-semibold">Decisions ({meeting.decisions!.length})</h3><ul className="mt-2 space-y-2">{meeting.decisions!.map((d, i) => <li key={`${d}-${i}`} className="rounded-lg border border-line p-3 text-sm leading-6">{d}</li>)}</ul></section>}
        {send.isSuccess && <p className="rounded-lg bg-accent-soft p-3 text-sm text-accent-text">Task DMs: {send.data.sent} sent, {send.data.skipped} skipped, {send.data.failed} failed.</p>}
        {send.isError && <p className="rounded-lg bg-danger-soft p-3 text-sm text-danger">Could not send task DMs. Try again.</p>}
        <section><h3 className="text-sm font-semibold">Action items</h3>{meeting.tasks.length ? <ul className="mt-2 space-y-2">{meeting.tasks.map((task) => <Task key={task.id} meetingId={meeting.id} task={task} />)}</ul> : <p className="mt-2 text-sm text-muted">No explicit action items were found.</p>}</section>
      </div>
    )}
  </div>
}

export default function Meetings() {
  const list = useQuery({ queryKey: ["meetings"], queryFn: api.meetings, refetchInterval: (q) => (q.state.data?.some((m) => m.status === "processing") ? 4000 : false) })
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const queryClient = useQueryClient()
  const sync = useMutation({ mutationFn: api.syncMeetings, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["meetings"] }) })
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { if (!selected && list.data?.[0]) setSelected(list.data[0].id) }, [selected, list.data])
  const detail = useQuery({ queryKey: ["meeting", selected], queryFn: () => api.meeting(selected!), enabled: Boolean(selected) })
  return <>
    <PageHeader title="Meeting notes" desc="Saved meeting transcripts (Slack Huddles and the browser extension), AI summaries, and extracted action items. Jira links appear here after issues are created." actions={isAdmin(me.data?.role) ? <Button size="sm" loading={sync.isPending} onClick={() => sync.mutate()}>Sync Slack Huddles</Button> : undefined} />
    <Async q={list} rows={4}>{(meetings) => meetings.length === 0 ? <Panel><EmptyState icon="book" title="No meeting notes yet" action={isAdmin(me.data?.role) ? <Button loading={sync.isPending} onClick={() => sync.mutate()}>Sync Slack Huddles</Button> : undefined}>When Slack saves AI notes for a completed Huddle, Company Brain will add its transcript and summary here.</EmptyState></Panel> : (
      <Panel className="overflow-hidden p-0"><div className="grid min-h-[520px] md:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-line bg-sunken p-2 md:border-b-0 md:border-r">
          <p className="px-2 py-2 text-xs font-medium uppercase tracking-wide text-muted">Recent meetings</p>
          <div className="space-y-1">{meetings.map((m) => <button key={m.id} onClick={() => setSelected(m.id)} className={`block w-full rounded-md px-3 py-3 text-left transition ${m.id === selected ? "bg-hover" : "hover:bg-hover/70"}`}>
            <div className="truncate text-sm font-medium">{m.title}</div><div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted"><span>{ago(m.endedAt ?? m.createdAt)}</span><Badge tone={tone[m.status]}>{m.tasks.length} task{m.tasks.length === 1 ? "" : "s"}</Badge></div>
          </button>)}</div>
        </aside>
        <section className="p-5 md:p-6">{selected ? <Async q={detail} rows={6}>{(meeting) => <Detail meeting={meeting} />}</Async> : null}</section>
      </div></Panel>
    )}</Async>
  </>
}
