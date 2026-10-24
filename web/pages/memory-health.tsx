import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, api, type ConsolidationEntry, type Freshness, type MemoryJob, type ObserveChannel } from "@/lib/api"
import { useAction } from "@/lib/action"
import { dateTime, dur } from "@/lib/format"
import { Badge } from "@/ui/badge"
import { Button, LinkButton } from "@/ui/button"
import { confirmDialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { Switch } from "@/ui/fields"
import { Async, PageHeader, Panel, Section } from "@/ui/page"
import { Segmented } from "@/ui/tabs"
import { Table } from "@/ui/table"
import { useToast } from "@/ui/toast"

const TUNE_LABEL: Record<string, string> = { captureEvery: "Learn every N messages", idleMs: "Idle wait", ambientMax: "Ambient batch", recallTtlMs: "Recall cache", snapshotTtlMs: "Snapshot cache", reflectCron: "Reflect schedule", observeCron: "Observe schedule" }
const tuneVal = (k: string, v: number | string) => (typeof v === "number" && k.endsWith("Ms") ? dur(v) : String(v))

function FreshnessCard() {
  const q = useQuery({ queryKey: ["freshness"], queryFn: api.freshness })
  const qc = useQueryClient()
  const save = useAction(api.saveFreshness, { ok: "Freshness updated", onSuccess: (d) => qc.setQueryData<Freshness>(["freshness"], d) })
  return (
    <Async q={q} rows={3}>{(f) => (
      <Panel className="p-4">
        <Segmented label="Memory freshness" value={f.mode} onChange={(m) => !save.isPending && m !== f.mode && save.mutate(m)} items={[{ id: "normal", label: "Normal" }, { id: "fast", label: "Fast" }]} />
        <p className="mt-3 max-w-2xl text-sm text-muted">
          {f.mode === "fast"
            ? "Fast is for demos: the bot learns from conversations within seconds and checks for new knowledge every minute or two. It makes many more model calls, so cost goes up. Switch back to Normal when you are done."
            : "Normal is the cheap default: conversations are learned in batches after a few messages or a few idle minutes. Choose Fast to learn within seconds, at a higher cost."}
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 md:grid-cols-3">
          {Object.entries(f.tuning).map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="text-muted">{TUNE_LABEL[k] ?? k}</dt><dd className="font-mono tabular-nums">{tuneVal(k, v)}</dd></div>)}
        </dl>
      </Panel>
    )}</Async>
  )
}

const JOBS: { job: MemoryJob; title: string; desc: string }[] = [
  { job: "capture-flush", title: "Flush captured chats", desc: "Turn buffered conversations into facts now." },
  { job: "observe", title: "Observe channels", desc: "Read new channel messages and learn from them." },
  { job: "consolidate", title: "Consolidate", desc: "Merge duplicates, archive stale facts, propose core-memory changes." },
  { job: "sync", title: "Sync sources", desc: "Pull meeting huddles and every connected source." },
  { job: "backfill-prefix", title: "Backfill context", desc: "Add context prefixes to older chunks." },
  { job: "backfill-history", title: "Backfill history", desc: "Learn from past channel history (a batch per run)." },
  { job: "sync-tasks", title: "Sync tasks", desc: "Extract tasks from memory and meetings." },
]
const countText = (c: Record<string, unknown>) => {
  const parts = Object.entries(c).flatMap(([k, v]) => typeof v === "number" ? [`${v} ${k}`] : v && typeof v === "object" ? Object.entries(v).filter(([, n]) => typeof n === "number").map(([k2, n]) => `${n} ${k2}`) : [])
  return parts.length ? parts.join(", ") : "nothing new"
}

function LearnNow() {
  const toast = useToast()
  const [res, setRes] = useState<Partial<Record<MemoryJob, string>>>({})
  const run = useAction(api.runMemoryJob, { inline: true, invalidate: [["consolidation-log"], ["memories"]] })
  const go = (job: MemoryJob, title: string) => run.mutate(job, {
    onSuccess: (r) => { const t = `${countText(r.counts)} in ${dur(r.ms)}`; setRes((s) => ({ ...s, [job]: t })); toast.push({ kind: "success", title: `${title} finished`, body: t }) },
    onError: (e) => {
      const d = e instanceof ApiError ? (e.data as { retryAfterSec?: number; message?: string } | null) : null
      if (e instanceof ApiError && e.status === 409) toast.push({ kind: "info", title: "Already running", body: `${title} is in progress. Try again in a moment.` })
      else if (e instanceof ApiError && e.status === 429) toast.push({ kind: "info", title: "Slow down a little", body: `That job was started too often. Try again in ${d?.retryAfterSec ?? "a few"} seconds.` })
      else toast.push({ kind: "error", title: `${title} failed`, body: d?.message ?? e.message })
    },
  })
  return (
    <Panel className="divide px-4">
      {JOBS.map((j) => (
        <div key={j.job} className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0"><div className="text-sm font-medium">{j.title}</div><div className="mt-0.5 text-xs text-muted">{j.desc}</div>{res[j.job] && <div className="mt-1 text-xs text-ok" aria-live="polite">Last run: {res[j.job]}</div>}</div>
          <Button size="sm" loading={run.isPending && run.variables === j.job} disabled={run.isPending} aria-label={`Learn now: ${j.title}`} onClick={() => go(j.job, j.title)}>Run now</Button>
        </div>
      ))}
    </Panel>
  )
}

const ACTION: Record<string, string> = { merge: "Merged", archive: "Archived", archive_stale: "Archived stale", promote: "Proposed core line", demote: "Proposed removal", about_block: "Channel summary", procedure: "Proposed procedure" }
const actionLabel = (a: string) => ACTION[a] ?? a.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())

function ConsolidationLog() {
  const q = useQuery({ queryKey: ["consolidation-log"], queryFn: api.consolidationLog })
  const undo = useAction(api.undoConsolidation, { invalidate: [["consolidation-log"], ["memories"], ["reviews"]], ok: "Undone" })
  const ask = async (e: ConsolidationEntry) => { if (await confirmDialog({ title: "Undo this change?", body: `${actionLabel(e.action)} ${e.count} ${e.count === 1 ? "memory" : "memories"} will be restored, and any pending review for it rejected.`, confirmLabel: "Undo" })) undo.mutate(e.id) }
  return (
    <Async q={q} rows={4}>{(rows) => rows.length === 0 ? <Panel><EmptyState icon="history" title="No consolidation runs yet">Merges, archives and proposals show up here after the first run.</EmptyState></Panel> : (
      <Panel><Table caption="Consolidation log" rows={rows} rowKey={(r) => r.id} columns={[
        { key: "t", header: "When", primary: true, cell: (r: ConsolidationEntry) => <span className="whitespace-nowrap">{dateTime(r.createdAt)}</span> },
        { key: "a", header: "What", cell: (r) => <span className="font-medium">{actionLabel(r.action)}</span> },
        { key: "c", header: "Memories", num: true, cell: (r) => r.count },
        { key: "s", header: "Scope", hideSm: true, cell: (r) => <Badge>{r.scopeTag ?? "none"}</Badge> },
        { key: "u", header: <span className="sr-only">Actions</span>, end: true, cell: (r) => r.undoneAt ? <Badge tone="warn">Undone {dateTime(r.undoneAt)}</Badge> : <Button size="sm" loading={undo.isPending && undo.variables === r.id} aria-label={`Undo ${actionLabel(r.action)} from ${dateTime(r.createdAt)}`} onClick={() => ask(r)}>Undo</Button> },
      ]} /></Panel>
    )}</Async>
  )
}

function ObserveList() {
  const q = useQuery({ queryKey: ["observe-channels"], queryFn: api.observeChannels })
  const qc = useQueryClient()
  const set = useAction((v: { id: string; observe: boolean }) => api.setObserve(v.id, v.observe), {
    onSuccess: (_, v) => qc.setQueryData<ObserveChannel[]>(["observe-channels"], (c) => c?.map((x) => (x.id === v.id ? { ...x, observe: v.observe } : x))),
  })
  return (
    <Async q={q} rows={4}>{(rows) => rows.length === 0 ? <Panel><EmptyState icon="hash" title="The bot is not in any channels">Invite it to a channel and it will show up here.</EmptyState></Panel> : (
      <Panel className="divide px-4">
        {rows.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-medium">#{c.name ?? c.id}</span>{c.isPrivate && <Badge>Private</Badge>}{!c.observe && <Badge tone="warn">Paused</Badge>}</div>
            <Switch label={`Learn from #${c.name ?? c.id}`} checked={c.observe} disabled={set.isPending && set.variables?.id === c.id}
              onChange={async (v) => { if (v || await confirmDialog({ title: `Pause learning in #${c.name ?? c.id}?`, body: "Messages buffered but not yet learned from are dropped. Nothing already learned is removed.", confirmLabel: "Pause" })) set.mutate({ id: c.id, observe: v }) }} />
          </div>
        ))}
      </Panel>
    )}</Async>
  )
}

export default function MemoryHealth() {
  return (
    <>
      <PageHeader title="Memory health" desc="How fast the bot learns, what it did overnight, and where it is listening." actions={<LinkButton href={api.exportMemoriesUrl} icon="download">Download memories</LinkButton>} />
      <Section title="Freshness" desc="How quickly new conversations become memory."><FreshnessCard /></Section>
      <Section title="Learn now" desc="Run a memory job immediately instead of waiting for its schedule."><LearnNow /></Section>
      <Section title="Consolidation log" desc="What the nightly cleanup merged, archived or proposed. Undo a change that looks wrong."><ConsolidationLog /></Section>
      <Section title="Learning by channel" desc="Choose which channels the bot learns from.">
        <ObserveList />
        <p className="mt-2 max-w-2xl text-xs text-muted">Private channels only learn into their own scope: what is learned there is never shared workspace-wide. Pausing a channel drops its buffered messages that have not been learned yet.</p>
      </Section>
    </>
  )
}
