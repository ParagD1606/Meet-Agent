import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, isAdmin, type Meeting, type MeetingStatus, type MeetingTask } from "@/lib/api"
import { ago, dateTime } from "@/lib/format"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { EmptyState } from "@/ui/empty"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Tabs } from "@/ui/tabs"

const tone: Record<MeetingStatus, "neutral" | "ok" | "warn" | "danger"> = { processing: "warn", ready: "ok", failed: "danger" }
const statusLabel: Record<MeetingStatus, string> = { processing: "Processing", ready: "Ready", failed: "Summary failed" }

function Task({ task }: { task: MeetingTask }) {
  const who = task.assigneeName ?? (task.assigneeId ? `Slack user ${task.assigneeId}` : "Unassigned")
  return <li className="rounded-lg border border-line bg-sunken px-3 py-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><span className="font-medium">{task.title}</span>{task.jiraUrl ? <a className="text-sm text-accent hover:underline" href={task.jiraUrl} target="_blank" rel="noreferrer">{task.jiraKey ?? "Open in Jira"}</a> : <Badge tone="neutral">Not created in Jira</Badge>}</div>
    {task.description && <p className="mt-1 text-sm text-muted">{task.description}</p>}
    <p className="mt-2 text-xs text-muted">Owner: {who}{task.dueDate ? ` · Due ${task.dueDate}` : ""}</p>
  </li>
}

function Detail({ meeting }: { meeting: Meeting }) {
  const [tab, setTab] = useState<"transcript" | "summary">("summary")
  const date = meeting.endedAt ?? meeting.createdAt
  return <div className="min-w-0">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">{meeting.title}</h2><p className="mt-1 text-sm text-muted">Completed {dateTime(date)} · {meeting.participantIds.length} participant{meeting.participantIds.length === 1 ? "" : "s"}</p></div>
      <Badge tone={tone[meeting.status]}>{statusLabel[meeting.status]}</Badge>
    </div>
    <Tabs label="Meeting content" value={tab} onChange={setTab} items={[{ id: "summary", label: `Summary & tasks (${meeting.tasks.length})` }, { id: "transcript", label: "Transcript" }]} />
    {tab === "transcript" ? (
      <div className="mt-4 rounded-lg border border-line bg-sunken p-4"><pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6">{meeting.transcript || "The transcript is loading."}</pre></div>
    ) : (
      <div className="mt-4 space-y-6">
        {meeting.status === "processing" && <p className="rounded-lg bg-sunken p-4 text-sm text-muted">Company Brain is reading the saved Huddle transcript and preparing notes.</p>}
        {meeting.status === "failed" && <p className="rounded-lg bg-danger-soft p-4 text-sm text-danger">The transcript was saved, but the summary could not be generated. You can still read it in the Transcript tab.</p>}
        {meeting.summary && <section><h3 className="text-sm font-semibold">Meeting summary</h3><div className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-sunken p-4 text-sm leading-6">{meeting.summary}</div></section>}
        <section><h3 className="text-sm font-semibold">Action items</h3>{meeting.tasks.length ? <ul className="mt-2 space-y-2">{meeting.tasks.map((task, i) => <Task key={`${task.title}-${i}`} task={task} />)}</ul> : <p className="mt-2 text-sm text-muted">No explicit action items were found.</p>}</section>
      </div>
    )}
  </div>
}

export default function Meetings() {
  const list = useQuery({ queryKey: ["meetings"], queryFn: api.meetings })
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const queryClient = useQueryClient()
  const sync = useMutation({ mutationFn: api.syncMeetings, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["meetings"] }) })
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { if (!selected && list.data?.[0]) setSelected(list.data[0].id) }, [selected, list.data])
  const detail = useQuery({ queryKey: ["meeting", selected], queryFn: () => api.meeting(selected!), enabled: Boolean(selected) })
  return <>
    <PageHeader title="Meeting notes" desc="Saved Slack Huddle transcripts, AI summaries, and extracted action items. Jira links appear here after issues are created." actions={isAdmin(me.data?.role) ? <Button size="sm" loading={sync.isPending} onClick={() => sync.mutate()}>Sync Slack Huddles</Button> : undefined} />
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
