import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api, errMsg, isAdmin, type MeetingFull, type MeetingItem, type MeetingItemPatch, type MeetingRow, type MeetingStatus } from "@/lib/api"
import { ago, dateTime } from "@/lib/format"
import { Badge, type Tone } from "@/ui/badge"
import { Button } from "@/ui/button"
import { EmptyState } from "@/ui/empty"
import { Switch } from "@/ui/fields"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Skeleton } from "@/ui/skeleton"
import { Tabs } from "@/ui/tabs"
import { ExportMenu, PushMenu } from "@/ui/task-export"
import { useToast } from "@/ui/toast"
import { blocker, fmtDay, ItemCard, Status, type ItemOps } from "./meetings/item-card"
import { NewMeeting } from "./meetings/new-meeting"
import { TranscriptDrawer } from "./meetings/transcript-drawer"

const tone: Record<MeetingStatus, Tone> = { processing: "warn", ready: "ok", failed: "danger" }
const statusLabel: Record<MeetingStatus, string> = { processing: "Analysing", ready: "Ready", failed: "Failed" }
const today = () => new Date().toISOString().slice(0, 10)

// Meeting summaries are model-generated Markdown. Render a deliberately small,
// safe subset instead of injecting HTML from the transcript/model into the page.
const inlineMarkdown = (value: string): ReactNode[] => value.replace(/<@([A-Z0-9]+)>/g, "@$1").split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
  if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>
  if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-hover px-1 py-0.5 text-[0.9em]">{part.slice(1, -1)}</code>
  return <span key={i}>{part}</span>
})

function MeetingMarkdown({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  let paragraph: string[] = []
  let bullets: string[] = []
  const flushParagraph = () => { if (paragraph.length) { nodes.push(<p key={`p-${nodes.length}`} className="leading-6">{inlineMarkdown(paragraph.join(" "))}</p>); paragraph = [] } }
  const flushBullets = () => { if (bullets.length) { nodes.push(<ul key={`ul-${nodes.length}`} className="list-disc space-y-1 pl-5">{bullets.map((line, i) => <li key={i}>{inlineMarkdown(line)}</li>)}</ul>); bullets = [] } }
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim()
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (heading) { flushParagraph(); flushBullets(); const Tag = (`h${heading[1].length}` as "h1" | "h2" | "h3"); nodes.push(<Tag key={`h-${nodes.length}`} className={heading[1].length === 1 ? "text-base font-semibold" : "text-sm font-semibold"}>{inlineMarkdown(heading[2]!)}</Tag>); continue }
    if (bullet) { flushParagraph(); bullets.push(bullet[1]!); continue }
    if (!line) { flushParagraph(); flushBullets(); continue }
    flushBullets(); paragraph.push(line)
  }
  flushParagraph(); flushBullets()
  return <div className="mt-1.5 space-y-3 rounded-lg border border-line bg-sunken p-3 text-sm leading-6">{nodes}</div>
}

// ---- derived views -------------------------------------------------------
const live = (items: MeetingItem[]) => items.filter((i) => i.approval !== "rejected")
function sections(items: MeetingItem[]) {
  const t = (i: MeetingItem) => i.itemType === "task"
  return [
    { id: "confirmed", title: "Confirmed commitments", hint: "Someone clearly took this on.", items: items.filter((i) => t(i) && i.label === "confirmed") },
    { id: "tentative", title: "Tentative", hint: "Hedged or partly specified. Check before approving.", items: items.filter((i) => t(i) && i.label === "tentative") },
    { id: "suggestions", title: "Suggestions", hint: "Ideas floated, not commitments.", items: items.filter((i) => t(i) && i.label !== "confirmed" && i.label !== "tentative") },
    { id: "questions", title: "Open questions", hint: "Unresolved. Someone needs to answer these.", items: items.filter((i) => i.itemType === "question") },
    { id: "decisions", title: "Decisions", hint: "What the group agreed.", items: items.filter((i) => i.itemType === "decision") },
  ]
}
function tracking(items: MeetingItem[], status: (i: MeetingItem) => string | undefined) {
  const tasks = live(items).filter((i) => i.itemType === "task")
  const approved = tasks.filter((i) => i.approval === "approved")
  const done = (i: MeetingItem) => ["done", "dropped"].includes(status(i) ?? "")
  const open = approved.filter((i) => !done(i))
  return {
    open, unassigned: tasks.filter((i) => !i.assigneeId && !i.assigneeName).length, noDue: tasks.filter((i) => !i.dueDate).length,
    overdue: open.filter((i) => i.dueDate && i.dueDate < today()).length,
    dupes: tasks.filter((i) => i.ambiguity.duplicateOf.length).length, conflicts: tasks.filter((i) => i.ambiguity.conflicts.length).length,
  }
}
const applyPatch = (i: MeetingItem, p: MeetingItemPatch, name?: string | null): MeetingItem => ({
  ...i, ...p, kind: p.kind ?? i.kind, ...(p.kind === "commitment" && i.label === "suggestion" ? { label: "tentative" as const } : {}),
  ...(p.assigneeId !== undefined ? { assigneeName: p.assigneeId ? name ?? i.ambiguity.ownerCandidates.find((c) => c.id === p.assigneeId)?.name ?? p.assigneeId : null, ambiguity: { ...i.ambiguity, ownerMissing: !p.assigneeId, ownerAmbiguous: false } } : {}),
  ...(p.dueDate !== undefined ? { ambiguity: { ...i.ambiguity, dueMissing: !p.dueDate } } : {}),
} as MeetingItem)

// ---- approval-mode setting (admin) --------------------------------------
function ModeSetting() {
  const client = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey: ["meeting-settings"], queryFn: api.meetingSettings })
  const [pct, setPct] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const set = useMutation({
    mutationFn: (b: { mode?: "auto" | "approve"; autoConfidence?: number }) => api.setMeetingSettings(b),
    onMutate: (b) => { const prev = q.data; client.setQueryData(["meeting-settings"], { ...prev, ...b }); return { prev } },
    onError: (e, _b, ctx) => { client.setQueryData(["meeting-settings"], ctx?.prev); setPct(null); toast.push({ kind: "error", title: "Couldn't change the setting", body: errMsg(e) }) },
    onSettled: () => { client.invalidateQueries({ queryKey: ["meeting-settings"] }); client.invalidateQueries({ queryKey: ["meeting"] }) },
  })
  if (!q.data) return null
  const auto = q.data.mode === "auto"
  const shown = pct ?? Math.round((q.data.autoConfidence ?? 0.6) * 100)
  return <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-3">
    <label className="flex items-center justify-between gap-4">
      <span><span className="block text-sm font-medium">Require approval before creating tasks and sending DMs</span><span className="block text-xs text-muted">Admin setting for everyone. Off (default): confident items are assigned automatically and owners are notified; only low-confidence ones wait for review.</span></span>
      <Switch checked={!auto} label="Require approval before creating tasks and sending DMs" onChange={(v) => set.mutate({ mode: v ? "approve" : "auto" })} disabled={set.isPending} />
    </label>
    {auto && <label className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <span className="font-medium">Auto-assign when confidence is at least</span>
      <input type="range" min={30} max={95} step={5} value={shown} aria-label="Auto-assign confidence threshold" className="w-48" onChange={(e) => { const v = Number(e.target.value); setPct(v); clearTimeout(timer.current); timer.current = setTimeout(() => set.mutate({ autoConfidence: v / 100 }, { onSettled: () => setPct(null) }), 400) }} />
      <span className="tabular-nums">{shown}%</span>
    </label>}
  </div>
}

// ---- browser extension token (kept from the old page) ---------------------
function ConnectExtension() {
  const [copied, setCopied] = useState(false)
  const make = useMutation({ mutationFn: api.extensionToken, onSuccess: () => setCopied(false) })
  return <details className="mb-4 rounded-lg border border-line bg-surface px-4 py-3">
    <summary className="cursor-pointer text-sm font-medium">Capture calls with the browser extension</summary>
    <p className="mt-2 text-sm text-muted">Capture Google Meet, Teams and Zoom calls into your own meetings. Generate a token for yourself and paste it into the extension's Settings.</p>
    <Button size="sm" className="mt-2" onClick={() => make.mutate()} loading={make.isPending}>{make.data ? "New token" : "Get my token"}</Button>
    {make.data && <div className="mt-3 rounded-lg border border-line bg-sunken p-3">
      <p className="text-xs text-muted">Shown once. A new token replaces this one.</p>
      <div className="mt-2 flex gap-2"><input readOnly aria-label="Extension token" className="input min-w-0 flex-1 font-mono text-xs" value={make.data.token} onFocus={(e) => e.currentTarget.select()} />
        <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(make.data!.token).then(() => setCopied(true)) }}>{copied ? "Copied" : "Copy"}</Button></div>
    </div>}
    {make.isError && <p role="alert" className="mt-2 text-xs text-danger">{errMsg(make.error)}</p>}
  </details>
}

// ---- processing / failed ---------------------------------------------------
function Processing({ title }: { title: string }) {
  const t0 = useRef(Date.now())
  const [s, setS] = useState(0)
  useEffect(() => { const h = setInterval(() => setS(Math.round((Date.now() - t0.current) / 1000)), 1000); return () => clearInterval(h) }, [])
  return <div role="status" className="space-y-4 py-4">
    <div className="flex items-center gap-3"><span className="spin inline-block size-4 rounded-full border-2 border-line-strong border-t-[var(--accent)]" /><div><p className="text-sm font-medium">Analysing “{title}”</p><p className="text-xs text-muted">Reading the transcript and finding decisions, action items and owners. {s}s elapsed.</p></div></div>
    {s >= 30 && <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">Still working. Long meetings can take a minute or two. You can leave this page; results will be here when you return.</p>}
    <div className="space-y-2" aria-hidden><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
  </div>
}

// ---- export / push (owned by another component) ----------------------------
// TODO: replace with `import { ExportMenu, PushMenu } from "@/ui/task-export"` (props: scope="meeting" id) once that file lands.

// ---- detail ------------------------------------------------------------------
function Detail({ id, admin }: { id: string; admin: boolean }) {
  const client = useQueryClient()
  const toast = useToast()
  const key = ["meeting", id]
  const q = useQuery({ queryKey: key, queryFn: () => api.meetingDetail(id), refetchInterval: (s) => (s.state.data?.status === "processing" ? 2000 : false) })
  const m = q.data
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, enabled: m?.status === "ready" && m.items.some((i) => i.commitmentId) })
  const stat = useMemo(() => new Map((tasks.data?.tasks ?? []).map((t) => [t.id, t.status as string])), [tasks.data])
  const taskStatus = (i: MeetingItem) => (i.commitmentId ? stat.get(i.commitmentId) : undefined)

  const [tab, setTab] = useState<"review" | "open">("review")
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<{ focus: number | null; hl: Set<number> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState<{ item: MeetingItem; why: string }[]>([])
  useEffect(() => { setSel(new Set()); setSkipped([]); setError(null); setTab("review") }, [id])

  const setDetail = (fn: (d: MeetingFull) => MeetingFull) => client.setQueryData<MeetingFull>(key, (d) => (d ? fn(d) : d))
  const optimistic = <V,>(apply: (d: MeetingFull, v: V) => MeetingFull, fn: (v: V) => Promise<unknown>, what: string, okMsg?: (r: unknown) => string | undefined) => ({
    mutationFn: fn,
    onMutate: async (v: V) => { await client.cancelQueries({ queryKey: key }); const prev = client.getQueryData<MeetingFull>(key); setDetail((d) => apply(d, v)); setError(null); return { prev } },
    onError: (e: unknown, _v: V, ctx?: { prev?: MeetingFull }) => { if (ctx?.prev) client.setQueryData(key, ctx.prev); setError(`${what}: ${errMsg(e)}`); toast.push({ kind: "error", title: `${what} failed`, body: errMsg(e) }) },
    onSuccess: (r: unknown) => { const t = okMsg?.(r); if (t) toast.push({ kind: "success", title: t }) },
    onSettled: () => { client.invalidateQueries({ queryKey: key }); client.invalidateQueries({ queryKey: ["meetings"] }); client.invalidateQueries({ queryKey: ["tasks"] }) },
  })
  const patch = useMutation(optimistic<{ item: MeetingItem; p: MeetingItemPatch; name?: string | null }>(
    (d, v) => ({ ...d, items: d.items.map((i) => (i.id === v.item.id ? applyPatch(i, v.p, v.name) : i)) }), (v) => api.patchMeetingItem(id, v.item.id, v.p), "Update"))
  const approve = useMutation(optimistic<string[]>(
    (d, ids) => ({ ...d, items: d.items.map((i) => (ids.includes(i.id) ? { ...i, approval: "approved" as const } : i)) }), (ids) => api.approveMeetingItems(id, { itemIds: ids }), "Approve",
    () => (m?.mode === "approve" ? "Approved. Tasks are being created." : "Approved")))
  const merge = useMutation(optimistic<{ item: MeetingItem; intoId: string }>(
    (d, v) => ({ ...d, items: d.items.filter((i) => i.id !== v.item.id) }), (v) => api.mergeMeetingItem(id, v.item.id, v.intoId), "Merge", () => "Merged into the existing task"))
  const keep = useMutation(optimistic<MeetingItem>(
    (d, it) => ({ ...d, items: d.items.map((i) => (i.id === it.id ? { ...i, ambiguity: { ...i.ambiguity, duplicateOf: [] } } : i)) }), (it) => api.dismissMeetingDuplicate(id, it.id), "Keep both"))
  const recap = useMutation({
    mutationFn: (ids?: string[]) => api.meetingRecap(id, ids),
    onSuccess: (r) => { toast.push({ kind: "success", title: "Recap DMs", body: `${r?.sent ?? 0} sent, ${r?.skipped ?? 0} skipped, ${r?.failed ?? 0} failed.` }); client.invalidateQueries({ queryKey: key }) },
    onError: (e) => { setError(`Recap: ${errMsg(e)}`); toast.push({ kind: "error", title: "Couldn't send recap DMs", body: errMsg(e) }) },
  })
  const redo = useMutation({
    mutationFn: (kind: "reanalyze" | "retry") => (kind === "retry" ? api.retryMeeting(id) : api.reanalyzeMeeting(id)),
    onSuccess: () => { client.invalidateQueries({ queryKey: key }); client.invalidateQueries({ queryKey: ["meetings"] }) },
    onError: (e) => { setError(errMsg(e)); toast.push({ kind: "error", title: "Couldn't restart analysis", body: errMsg(e) }) },
  })

  if (q.isPending) return <div className="space-y-3"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-20 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>
  if (q.error || !m) return <EmptyState icon="alert" title="Couldn't load this meeting" action={<Button onClick={() => q.refetch()}>Retry</Button>}>{errMsg(q.error)}</EmptyState>

  const busy = patch.isPending || approve.isPending || merge.isPending || keep.isPending
  const approveIds = (ids: string[]) => {
    const picked = m.items.filter((i) => ids.includes(i.id) && i.approval === "proposed")
    const ok = picked.filter((i) => !blocker(i)), bad = picked.filter((i) => blocker(i))
    setSkipped(bad.map((item) => ({ item, why: blocker(item)! })))
    if (ok.length) approve.mutate(ok.map((i) => i.id))
    else if (bad.length) toast.push({ kind: "info", title: "Nothing could be approved", body: "Resolve the flagged items first." })
    setSel(new Set())
  }
  const ops: ItemOps = {
    patch: (item, p, name) => patch.mutate({ item, p, name }), approve: approveIds, merge: (item, intoId) => merge.mutate({ item, intoId }), keepBoth: (item) => keep.mutate(item),
    openLine: (n, item) => setDrawer({ focus: n, hl: new Set(item.evidence) }), busy,
  }
  const items = m.items
  const auto = m.mode === "auto"
  const threshold = m.autoConfidence ?? 0.6
  const autoItems = auto ? items.filter((i) => i.approvedBy === "auto" && i.approval === "approved") : []
  const isTask = (i: MeetingItem) => i.itemType === "task"
  const rest = items.filter((i) => !autoItems.includes(i))
  const secs = auto ? [
    { id: "review", title: "Needs review", hint: "Low confidence, no supporting quote, or nobody to assign it to.", items: rest.filter((i) => isTask(i) && i.approval === "proposed" && i.kind !== "suggestion") },
    { id: "approved", title: "Approved by you", hint: "", items: rest.filter((i) => isTask(i) && i.approval === "approved") },
    { id: "rejected", title: "Rejected", hint: "Not assigned. Restore to reconsider.", items: rest.filter((i) => isTask(i) && i.approval === "rejected") },
    { id: "suggestions", title: "Suggestions", hint: "Ideas, not tasks. Make one a task to review it.", items: rest.filter((i) => isTask(i) && i.approval === "proposed" && i.kind === "suggestion") },
    { id: "questions", title: "Open questions", hint: "Unresolved. For reference.", items: rest.filter((i) => i.itemType === "question") },
    { id: "decisions", title: "Decisions", hint: "What the group agreed.", items: rest.filter((i) => i.itemType === "decision") },
  ].filter((s) => s.id === "review" || s.items.length || ["suggestions", "questions", "decisions"].includes(s.id)) : sections(items)
  const renderSec = (s: (typeof secs)[number]) => <section key={s.id} aria-labelledby={`sec-${s.id}`}>
    <div className="mb-2 flex flex-wrap items-baseline gap-2"><h3 id={`sec-${s.id}`} className="text-sm font-semibold">{s.title}</h3><Badge tone={s.items.length ? "accent" : "neutral"}>{s.items.length}</Badge><span className="text-xs text-muted">{s.hint}</span></div>
    {s.items.length === 0 ? <p className="text-xs text-subtle">None found.</p> : <ul className="space-y-2">{s.items.map((i) => <ItemCard key={i.id} meetingId={id} item={i} mode={m.mode} canApprove={m.canApprove} selected={sel.has(i.id)} onSelect={(v) => setSel((p) => { const n = new Set(p); v ? n.add(i.id) : n.delete(i.id); return n })} ops={ops} taskStatus={taskStatus(i)} threshold={threshold} />)}</ul>}
  </section>
  const track = tracking(items, taskStatus)
  const bulkItems = auto ? items.filter((i) => i.itemType === "task" && i.approval === "proposed" && i.kind !== "suggestion") : items.filter((i) => i.itemType === "task" && i.label === "confirmed")
  const confirmedReady = bulkItems.filter((i) => i.approval === "proposed" && !blocker(i))
  const selReady = items.filter((i) => sel.has(i.id) && !blocker(i))
  const approvedTasks = items.filter((i) => i.itemType === "task" && i.approval === "approved")
  const chip = (n: number, label: string, t: Tone = "neutral") => <Badge tone={n ? t : "neutral"}>{n} {label}</Badge>

  return <div className="min-w-0">
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="text-lg font-semibold">{m.title}</h2><p className="mt-1 text-sm text-muted">{m.platform ? `${m.platform} · ` : ""}{m.startedAt ? dateTime(m.startedAt) : "No date"}</p></div>
      <Badge tone={tone[m.status]} dot>{statusLabel[m.status]}</Badge>
    </div>

    {m.status === "processing" && <Processing title={m.title} />}
    {m.status === "failed" && <div role="alert" className="rounded-lg border border-[var(--danger)] bg-danger-soft p-4">
      <p className="text-sm font-medium text-danger">Analysis failed</p>
      <p className="mt-1 text-sm text-danger">{m.failedReason || "The transcript could not be analysed."}</p>
      <Button size="sm" className="mt-3" loading={redo.isPending} onClick={() => redo.mutate("retry")}>Retry</Button>
      {m.lines && <Button size="sm" variant="ghost" className="ml-2 mt-3" onClick={() => setDrawer({ focus: null, hl: new Set() })}>Read transcript</Button>}
    </div>}

    {m.status === "ready" && <>
      <div role="note" className={`mb-4 rounded-lg border px-3 py-2 text-sm ${m.mode === "approve" ? "border-accent-line bg-accent-soft text-accent-text" : "border-line bg-sunken text-muted"}`}>
        {m.mode === "approve" ? <><b>Nothing is assigned or sent until you approve.</b> Review each item, fix owners and dates, then approve.</> : <><b>Anything the AI is confident about is assigned automatically and the owners are notified. Only low-confidence items are held for your review.</b><span className="block text-xs">Auto-assign threshold: {Math.round(threshold * 100)}% confidence, with an owner and a supporting quote.</span></>}
        {!m.canApprove && <span className="block text-xs">You can review and edit, but only admins or the meeting owner can approve.</span>}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5" aria-label="Tracking">
        {chip(track.open.length, "open actions", "accent")}{chip(track.unassigned, "unassigned", "warn")}{chip(track.noDue, "no due date", "warn")}{chip(track.overdue, "overdue", "danger")}
        {track.dupes > 0 && chip(track.dupes, "possible duplicates", "warn")}{track.conflicts > 0 && chip(track.conflicts, "conflicts", "danger")}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="sm" icon="file" onClick={() => setDrawer({ focus: null, hl: new Set() })}>Transcript</Button>
        <Button size="sm" loading={recap.isPending} disabled={!approvedTasks.length} onClick={() => recap.mutate(approvedTasks.map((i) => i.id))}>Send recap DMs</Button>
        <ExportMenu scope="meeting" id={m.id} size="sm" />
        <PushMenu scope="meeting" id={m.id} size="sm" />
        {admin && <Button size="sm" variant="ghost" loading={redo.isPending} onClick={() => redo.mutate("reanalyze")}>Re-analyse</Button>}
      </div>

      {error && <p role="alert" className="mb-3 flex items-center justify-between gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}<Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button></p>}
      {m.summary && <section className="mb-5"><h3 className="text-sm font-semibold">Summary</h3><MeetingMarkdown text={m.summary} /></section>}

      <Tabs label="Meeting views" value={tab} onChange={setTab} items={[{ id: "review", label: "Review" }, { id: "open", label: `Open actions (${track.open.length})` }]} />

      {tab === "open" ? (
        <div className="mt-4">{track.open.length === 0 ? <p className="text-sm text-muted">Nothing is open. Approve action items in the Review tab to start tracking them.</p> : <ul className="space-y-2">
          {track.open.map((i) => <li key={i.id} className="rounded-lg border border-line bg-surface p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{i.title}</span><span className="text-xs text-muted">{i.assigneeName ?? "No owner"} · {i.dueDate ? `due ${fmtDay(i.dueDate)}${i.dueDate < today() ? " (overdue)" : ""}` : "no due date"}</span></div><Status item={i} taskStatus={taskStatus(i)} mode={m.mode} /></li>)}
        </ul>}</div>
      ) : (
        <div className="mt-4 space-y-6">
          {(confirmedReady.length > 0 || sel.size > 0 || skipped.length > 0) && <div className="rounded-lg border border-line bg-sunken p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" disabled={!m.canApprove || busy || confirmedReady.length === 0} onClick={() => approveIds(bulkItems.map((i) => i.id))}>{auto ? "Approve all needing review that have owners" : "Approve all confirmed"} ({confirmedReady.length})</Button>
              <Button size="sm" disabled={!m.canApprove || busy || sel.size === 0} onClick={() => approveIds([...sel])}>Approve selected ({selReady.length}/{sel.size})</Button>
              {sel.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Clear selection</Button>}
            </div>
            <p className="mt-2 text-xs text-muted">Items that need an owner or lack a supporting quote are never approved in bulk.</p>
            {skipped.length > 0 && <div role="status" className="mt-2 text-xs text-warn"><b>Skipped {skipped.length}:</b><ul className="ml-4 list-disc">{skipped.map((s) => <li key={s.item.id}>{s.item.title} — {s.why}</li>)}</ul></div>}
          </div>}

          {auto && <section aria-labelledby="sec-auto">
            <div className="mb-2 flex flex-wrap items-baseline gap-2"><h3 id="sec-auto" className="text-sm font-semibold">Auto-assigned</h3><Badge tone={autoItems.length ? "ok" : "neutral"}>{autoItems.length}</Badge><span className="text-xs text-muted">Confident, with an owner and a quote. Created and sent without review; undo any you disagree with.</span></div>
            {autoItems.length === 0 ? <p className="text-xs text-subtle">Nothing was clear enough to assign automatically.</p> : <ul className="space-y-2">{autoItems.map((i) => <ItemCard key={i.id} meetingId={id} item={i} mode={m.mode} canApprove={m.canApprove} selected={false} onSelect={() => {}} ops={ops} taskStatus={taskStatus(i)} threshold={threshold} />)}</ul>}
          </section>}
          {secs.map(renderSec)}
        </div>
      )}
    </>}

    <TranscriptDrawer open={drawer !== null} onClose={() => setDrawer(null)} lines={m.lines ?? null} highlight={drawer?.hl ?? new Set()} focus={drawer?.focus ?? null} />
  </div>
}

function List({ rows, selected, onSelect }: { rows: MeetingRow[]; selected: string | null; onSelect: (id: string) => void }) {
  return <nav aria-label="Meetings" className="border-b border-line bg-sunken p-2 md:border-b-0 md:border-r">
    <p className="px-2 py-2 text-xs font-medium uppercase tracking-wide text-muted">Meetings</p>
    <ul className="max-h-56 space-y-1 overflow-auto md:max-h-none">{rows.map((r) => <li key={r.id}><button onClick={() => onSelect(r.id)} aria-current={r.id === selected || undefined} className={`block w-full rounded-md px-3 py-2.5 text-left transition ${r.id === selected ? "bg-hover" : "hover:bg-hover/70"}`}>
      <span className="block truncate text-sm font-medium">{r.title}</span>
      <span className="mt-1 flex items-center justify-between gap-2 text-xs text-muted"><span>{ago(r.startedAt)}</span>
        {r.status === "ready" ? <Badge tone={r.counts?.unassigned ? "warn" : "neutral"}>{(r.counts?.confirmed ?? 0) + (r.counts?.tentative ?? 0)} actions</Badge> : <Badge tone={tone[r.status]}>{statusLabel[r.status]}</Badge>}</span>
    </button></li>)}</ul>
  </nav>
}

export default function Meetings() {
  const list = useQuery({ queryKey: ["meetings"], queryFn: api.meetingRows, refetchInterval: (q) => (q.state.data?.some((m) => m.status === "processing") ? 2000 : false) })
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const admin = isAdmin(me.data?.role)
  const client = useQueryClient()
  const sync = useMutation({ mutationFn: api.syncMeetings, onSuccess: () => client.invalidateQueries({ queryKey: ["meetings"] }) })
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { if (!selected && list.data?.[0]) setSelected(list.data[0].id) }, [selected, list.data])
  return <>
    <PageHeader title="Meetings" desc="Turn a transcript into decisions, action items, owners and deadlines. Review and approve before anything is assigned or sent." actions={admin ? <Button size="sm" loading={sync.isPending} onClick={() => sync.mutate()}>Sync Slack Huddles</Button> : undefined} />
    {admin && <ModeSetting />}
    <NewMeeting onCreated={(id) => { setSelected(id); client.invalidateQueries({ queryKey: ["meetings"] }) }} />
    <ConnectExtension />
    <Async q={list} rows={4}>{(rows) => rows.length === 0 ? <Panel><EmptyState icon="book" title="No meetings yet">Paste a transcript or notes above, or connect Slack Huddles / the browser extension.</EmptyState></Panel> : (
      <Panel className="overflow-hidden p-0"><div className="grid min-h-[480px] md:grid-cols-[260px_minmax(0,1fr)]">
        <List rows={rows} selected={selected} onSelect={setSelected} />
        <section className="min-w-0 p-4 md:p-6">{selected ? <Detail id={selected} admin={admin} /> : null}</section>
      </div></Panel>
    )}</Async>
  </>
}
