import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Link } from "wouter"
import { api, type MeetingItem, type MeetingItemPatch } from "@/lib/api"
import { Icon } from "@/lib/icons"
import { dateTime } from "@/lib/format"
import { Badge, type Tone } from "@/ui/badge"
import { Button } from "@/ui/button"
import { Checkbox, FormField, Input, Select, Textarea } from "@/ui/fields"
import { Tooltip } from "@/ui/tooltip"

export const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
const labelTone: Record<MeetingItem["label"], Tone> = { confirmed: "ok", tentative: "warn", suggestion: "accent", question: "neutral" }
const notifTone: Record<string, Tone> = { sent: "accent", acknowledged: "ok", ack: "ok", acked: "ok", failed: "danger", declined: "danger", pending: "warn", skipped: "neutral" }

/** Why an item cannot be approved yet (null = ready). */
export function blocker(i: MeetingItem): string | null {
  if (i.unverified) return "No supporting quote in the transcript, so it can't be approved."
  if (i.itemType === "question") return "Questions are answered, not approved."
  if (i.itemType === "task" && (i.ambiguity.ownerMissing || i.ambiguity.ownerAmbiguous)) return i.ambiguity.ownerAmbiguous ? "Confirm which person owns this first." : "Pick an owner first."
  return null
}

export interface ItemOps {
  patch: (item: MeetingItem, p: MeetingItemPatch, assigneeName?: string | null) => void
  approve: (ids: string[]) => void
  merge: (item: MeetingItem, intoId: string) => void
  keepBoth: (item: MeetingItem) => void
  openLine: (n: number, item: MeetingItem) => void
  busy: boolean
}

export function OwnerPicker({ meetingId, onPick, placeholder = "Search people" }: { meetingId: string; onPick: (u: { id: string; name: string }) => void; placeholder?: string }) {
  const [q, setQ] = useState("")
  const res = useQuery({ queryKey: ["meeting-assignees", meetingId, q], queryFn: () => api.meetingAssignees(meetingId, q) })
  return <div className="min-w-[200px]">
    <Input aria-label="Search people to assign" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} className="!h-7 text-xs" />
    <div className="mt-1 max-h-32 overflow-auto rounded-md border border-line bg-surface" role="listbox" aria-label="People">
      {(res.data ?? []).slice(0, 8).map((u) => <button key={u.id} type="button" role="option" aria-selected={false} className="block w-full px-2 py-1 text-left text-sm hover:bg-hover" onClick={() => onPick({ id: u.id, name: u.name ?? u.id })}>{u.name ?? u.id}</button>)}
      {res.data?.length === 0 && <p className="px-2 py-1 text-xs text-muted">No matches</p>}
    </div>
  </div>
}

function Editor({ meetingId, item, ops, close }: { meetingId: string; item: MeetingItem; ops: ItemOps; close: () => void }) {
  const [f, setF] = useState({ title: item.title, description: item.description, dueDate: item.dueDate ?? "", priority: item.priority, kind: item.kind })
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null)
  const [pick, setPick] = useState(false)
  const save = () => {
    const p: MeetingItemPatch = {}
    if (f.title.trim() && f.title !== item.title) p.title = f.title.trim()
    if (f.description !== item.description) p.description = f.description
    if ((f.dueDate || null) !== item.dueDate) p.dueDate = f.dueDate || null
    if (f.priority !== item.priority) p.priority = f.priority
    if (f.kind !== item.kind) p.kind = f.kind
    if (owner) p.assigneeId = owner.id
    if (Object.keys(p).length) ops.patch(item, p, owner?.name)
    close()
  }
  return <form className="mt-3 grid gap-3 rounded-lg border border-line bg-sunken p-3 sm:grid-cols-2" aria-label={`Edit ${item.title}`} onSubmit={(e) => { e.preventDefault(); save() }}>
    <FormField label="Title" className="sm:col-span-2">{(p) => <Input {...p} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />}</FormField>
    <FormField label="Description" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</FormField>
    <FormField label="Owner" hint={owner ? `Will assign ${owner.name}` : item.assigneeName ? `Currently ${item.assigneeName}` : "Nobody yet"}>
      {() => pick ? <OwnerPicker meetingId={meetingId} onPick={(u) => { setOwner(u); setPick(false) }} /> : <Button size="sm" onClick={() => setPick(true)}>{owner ? "Change" : item.assigneeName ? "Change owner" : "Pick owner"}</Button>}
    </FormField>
    <FormField label="Due date">{(p) => <Input {...p} type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />}</FormField>
    <FormField label="Priority">{(p) => <Select {...p} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as "normal" | "urgent" })}><option value="normal">Normal</option><option value="urgent">Urgent</option></Select>}</FormField>
    <FormField label="Kind">{(p) => <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as MeetingItem["kind"] })}><option value="commitment">Commitment</option><option value="suggestion">Suggestion</option><option value="question">Question</option></Select>}</FormField>
    <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" size="sm">Save changes</Button><Button size="sm" onClick={close}>Cancel</Button></div>
  </form>
}

export function ItemCard({ meetingId, item, canApprove, selected, onSelect, ops, taskStatus, mode, threshold }: { meetingId: string; item: MeetingItem; canApprove: boolean; selected: boolean; onSelect: (v: boolean) => void; ops: ItemOps; taskStatus?: string; mode: "auto" | "approve"; threshold: number }) {
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const [pickOwner, setPickOwner] = useState(false)
  const a = item.ambiguity
  const block = blocker(item)
  const rejected = item.approval === "rejected"
  const approved = item.approval === "approved"
  const isTask = item.itemType === "task"
  const canSelect = isTask && item.approval === "proposed"
  const needsOwner = isTask && (a.ownerMissing || a.ownerAmbiguous)
  const auto = mode === "auto"
  const autoMerged = approved && item.approvedBy === "auto"
  const low = auto && isTask && item.approval === "proposed" && item.kind !== "suggestion" && !item.unverified && item.confidence < threshold
  const approveOff = !canApprove || Boolean(block) || ops.busy

  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === "a" && !approveOff && item.approval === "proposed" && item.itemType !== "question") ops.approve([item.id])
    if (e.key === "r" && item.approval === "proposed") ops.patch(item, { approval: "rejected" })
  }

  return <li tabIndex={0} aria-keyshortcuts="a r" onKeyDown={onKey} aria-label={`${item.label}: ${item.title}`} className={`rounded-lg border bg-surface p-3 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${needsOwner && !approved ? "border-[var(--warn)]" : "border-line"} ${rejected ? "opacity-60" : ""}`}>
    <div className="flex items-start gap-2.5">
      {canSelect && <div className="pt-0.5"><Checkbox checked={selected} onChange={onSelect} label={`Select ${item.title}`} /></div>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className={`text-sm font-medium ${rejected ? "line-through" : ""}`}>{item.title}</h4>
          <Badge tone={labelTone[item.label]}>{item.label}</Badge>
          {item.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
          {item.followUp && <Badge tone="neutral">Follow-up</Badge>}
          {item.unverified && <Tooltip text="The model could not find a quote in the transcript to support this."><Badge tone="danger">No supporting quote</Badge></Tooltip>}
          {low && <Badge tone="warn">Low confidence</Badge>}
          {approved && <Badge tone="ok" dot>{item.approvedBy === "auto" ? "Auto-assigned" : "Approved"}</Badge>}
          {rejected && <Badge>Rejected</Badge>}
        </div>

        {isTask && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {item.assigneeName && !a.ownerAmbiguous ? <span className="badge"><Icon name="user" size={11} />{item.assigneeName}</span> : <Badge tone="warn">{a.ownerAmbiguous ? "Which person?" : "Needs an owner"}</Badge>}
          {needsOwner && !approved && <>
            {a.ownerCandidates.slice(0, 3).map((c) => <Button key={c.id} size="sm" disabled={ops.busy} onClick={() => ops.patch(item, { assigneeId: c.id }, c.name)} aria-label={`Assign to ${c.name}`}>{c.name} <span className="text-subtle">{Math.round(c.score * 100)}%</span></Button>)}
            <Button size="sm" variant="ghost" aria-expanded={pickOwner} onClick={() => setPickOwner((v) => !v)}>Search…</Button>
          </>}
          {item.dueDate ? <span className="badge"><Icon name="clock" size={11} />Due {fmtDay(item.dueDate)}</span> : (
            <label className="inline-flex items-center gap-1 text-muted">Set date <input type="date" className="input !h-7 !w-auto !px-1.5 text-xs" aria-label={`Set due date for ${item.title}`} onChange={(e) => e.target.value && ops.patch(item, { dueDate: e.target.value })} /></label>
          )}
        </div>}
        {pickOwner && needsOwner && <div className="mt-2"><OwnerPicker meetingId={meetingId} onPick={(u) => { ops.patch(item, { assigneeId: u.id }, u.name); setPickOwner(false) }} /></div>}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <Tooltip text={item.reason || "No reason recorded"}>
            <span className="inline-flex items-center gap-1.5" tabIndex={0}><span role="meter" aria-label="Confidence" aria-valuemin={0} aria-valuemax={1} aria-valuenow={item.confidence} className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-hover"><span className="block h-full rounded-full" style={{ width: `${Math.round(item.confidence * 100)}%`, background: item.confidence >= 0.75 ? "var(--ok)" : item.confidence >= 0.5 ? "var(--warn)" : "var(--danger)" }} /></span>{Math.round(item.confidence * 100)}% confident</span>
          </Tooltip>
          <button type="button" className="text-accent hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide details" : "Why / details"}</button>
        </div>
        {open && <div className="mt-2 space-y-1 rounded-md bg-sunken p-2 text-xs text-muted">{item.reason && <p><b className="text-fg">Why: </b>{item.reason}</p>}{item.description && <p className="whitespace-pre-line"><b className="text-fg">Detail: </b>{item.description}</p>}</div>}

        {item.quote ? <blockquote className="mt-2 border-l-2 border-line-strong pl-2.5 text-xs italic text-muted">“{item.quote}”
          {item.evidence.map((n) => <button key={n} type="button" className="ml-1.5 not-italic text-accent hover:underline" onClick={() => ops.openLine(n, item)}>line {n}</button>)}
        </blockquote> : null}

        {a.duplicateOf.map((d) => autoMerged
          ? <div key={d.id} role="note" className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>Merged with “{d.title}”{d.ownerName ? ` · ${d.ownerName}` : ""} <span className="opacity-80">({d.source === "task" ? "existing task" : "earlier meeting"})</span></span><Button size="sm" variant="ghost" disabled={ops.busy} onClick={() => ops.keepBoth(item)}>Undo merge</Button></div>
          : <div key={d.id} role="note" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--warn)] bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          <span><b>Looks like</b> “{d.title}”{d.ownerName ? ` · ${d.ownerName}` : ""}{d.dueDate ? ` · due ${fmtDay(d.dueDate)}` : ""} <span className="opacity-80">({d.source === "task" ? "existing task" : "earlier meeting"})</span></span>
          <span className="flex gap-1.5"><Button size="sm" disabled={ops.busy} onClick={() => ops.merge(item, d.id)}>Merge</Button><Button size="sm" disabled={ops.busy} onClick={() => ops.keepBoth(item)}>Keep both</Button></span>
        </div>)}
        {a.conflicts.map((c, k) => <div key={k} role="note" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--warn)] bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          <span><b>Heads-up: </b>conflicts with “{c.with.title}” ({c.type === "due" ? `due ${item.dueDate ? fmtDay(item.dueDate) : "?"} vs ${c.with.dueDate ? fmtDay(c.with.dueDate) : "?"}` : c.type === "owner" ? `owner ${item.assigneeName ?? "none"} vs ${c.with.ownerName ?? "none"}` : "contradicts an earlier decision"})</span>
          {c.type !== "decision" && <Button size="sm" onClick={() => setEditing(true)}>Resolve</Button>}
        </div>)}

        {editing && <Editor meetingId={meetingId} item={item} ops={ops} close={() => setEditing(false)} />}

        {approved && <Status item={item} taskStatus={taskStatus} mode={mode} onUndo={item.approvedBy === "auto" ? () => ops.patch(item, { approval: "rejected" }) : undefined} />}

        {!editing && <div className="mt-3 flex flex-wrap items-center gap-2">
          {auto && item.approval === "proposed" && item.kind === "suggestion" && <Button size="sm" variant="primary" disabled={ops.busy} onClick={() => ops.patch(item, { kind: "commitment" })}>Make it a task</Button>}
          {item.approval === "proposed" && item.itemType !== "question" && !(auto && item.kind === "suggestion") && (block || !canApprove
            ? <Tooltip text={!canApprove ? "Only admins or the meeting owner can approve." : block!}><Button size="sm" variant="primary" disabled>Approve</Button></Tooltip>
            : <Button size="sm" variant="primary" disabled={ops.busy} onClick={() => ops.approve([item.id])}>Approve</Button>)}
          {!rejected && <Button size="sm" onClick={() => setEditing(true)} icon="edit">Edit</Button>}
          {item.approval === "proposed" && <Button size="sm" variant="danger" disabled={ops.busy} onClick={() => ops.patch(item, { approval: "rejected" })}>Reject</Button>}
          {rejected && <Button size="sm" onClick={() => ops.patch(item, { approval: "proposed" })}>Restore</Button>}
          {block && item.approval === "proposed" && <span className="text-xs text-muted">{block}</span>}
        </div>}
      </div>
    </div>
  </li>
}

export function Status({ item, taskStatus, mode, onUndo }: { item: MeetingItem; taskStatus?: string; mode: "auto" | "approve"; onUndo?: () => void }) {
  const n = item.notification
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
    {item.commitmentId ? <Link href="/tasks" className="badge badge-accent">Task {taskStatus ? taskStatus.replace("_", " ") : "created"} <Icon name="right" size={11} /></Link> : <Badge tone="warn">Creating task…</Badge>}
    {n ? <Badge tone={notifTone[n.status] ?? "neutral"}>DM {n.status}{n.sentAt ? ` ${dateTime(n.sentAt)}` : ""}</Badge> : <Badge>{mode === "approve" ? "DM not sent yet" : "No DM"}</Badge>}
    {n?.error && <span className="text-danger">{n.error}</span>}
    {item.approvedBy === "auto" ? <span className="text-muted">assigned automatically{item.approvedAt ? ` · ${dateTime(item.approvedAt)}` : ""}</span> : item.approvedBy && <span className="text-muted">approved by {item.approvedBy}{item.approvedAt ? ` · ${dateTime(item.approvedAt)}` : ""}</span>}
    {onUndo && <Button size="sm" variant="ghost" aria-label={`Undo auto-assign of ${item.title}`} onClick={onUndo}>Undo</Button>}
    {item.externalRefs.map((r) => <a key={r.id} href={r.url} target="_blank" rel="noreferrer noopener" className="badge hover:underline">{r.provider} {r.id}<Icon name="external" size={11} /></a>)}
  </div>
}
