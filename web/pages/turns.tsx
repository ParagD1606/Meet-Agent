import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useSearch } from "wouter"
import { api, type Turn, type TurnStatus as TS } from "@/lib/api"
import { useUserNames } from "@/lib/auth"
import { ago, compact, dateTime, dur, num, usd } from "@/lib/format"
import { useMedia } from "@/lib/hooks"
import { Icon } from "@/lib/icons"
import { Badge, type Tone } from "@/ui/badge"
import { Button, LinkButton } from "@/ui/button"
import { StackedBar } from "@/ui/charts"
import { cn } from "@/ui/cn"
import { Dialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { Select } from "@/ui/fields"
import { Async, ErrorState, PageHeader, Panel } from "@/ui/page"
import { Skeleton } from "@/ui/skeleton"
import { Table } from "@/ui/table"

const STATUS: Record<TS, { label: string; tone: Tone }> = {
  done: { label: "Completed", tone: "ok" }, error: { label: "Failed", tone: "danger" },
  running: { label: "Running", tone: "accent" }, waiting_approval: { label: "Awaiting approval", tone: "warn" },
}
export const TurnStatus = ({ s }: { s: TS }) => <Badge tone={STATUS[s]?.tone ?? "neutral"} dot>{STATUS[s]?.label ?? s}</Badge>

const BREAKDOWN_LABEL: Record<string, string> = { system: "System", coreBlocks: "Core memory", skills: "Skills", toolSchemas: "Tool schemas", history: "History", recall: "Recall", toolResults: "Tool results", user: "User message" }
export const breakdownParts = (b?: Partial<Record<string, number>> | null) => Object.entries(b ?? {}).map(([k, v]) => ({ label: BREAKDOWN_LABEL[k] ?? k, value: v ?? 0 }))
const turnMs = (t: Turn) => (t.finishedAt ? new Date(t.finishedAt).getTime() - new Date(t.startedAt).getTime() : null)

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="px-3 py-2"><dt className="eyebrow">{k}</dt><dd className="mt-0.5 text-sm tabular-nums">{v}</dd></div>
}

function TurnDetail({ id, who }: { id: string; who: (id?: string | null) => string }) {
  const q = useQuery({ queryKey: ["turn", id], queryFn: () => api.turn(id), refetchInterval: (c) => (c.state.data?.status === "running" ? 3000 : false) })
  if (q.isPending) return <div className="space-y-3 p-4"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-24 w-full" /><Skeleton className="h-32 w-full" /></div>
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const t = q.data
  const calls = t.toolCalls ?? []
  const maxD = Math.max(1, ...calls.map((c) => c.durationMs ?? 0))
  const total = turnMs(t)
  return (
    <div className="divide">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <TurnStatus s={t.status} /><Badge className="capitalize">{t.trigger}</Badge>{t.depth && <Badge>{t.depth}</Badge>}
        <span className="ml-auto text-xs text-muted">{dateTime(t.startedAt)}</span>
      </div>
      {t.error && <div role="alert" className="flex gap-2 bg-danger-soft px-4 py-3 text-sm text-danger"><Icon name="error" className="mt-0.5 shrink-0" /><span className="break-words">{t.error}</span></div>}
      <dl className="grid grid-cols-2 divide-line sm:grid-cols-3 [&>*]:border-b [&>*]:border-line">
        <Fact k="User" v={who(t.userId)} /><Fact k="Model" v={<span className="mono text-xs">{t.model ?? "-"}</span>} /><Fact k="Duration" v={dur(total)} />
        <Fact k="Input tokens" v={num(t.inputTokens)} /><Fact k="Output tokens" v={num(t.outputTokens)} /><Fact k="Cost" v={usd(t.costMicros)} />
        <Fact k="Cache read" v={num(t.cacheReadTokens)} /><Fact k="Cache write" v={num(t.cacheWriteTokens)} /><Fact k="Steps" v={num(t.steps)} />
      </dl>
      {t.promptBreakdown && <div className="px-4 py-3"><h3 className="mb-2 text-sm">Prompt breakdown</h3><StackedBar label="Prompt breakdown" parts={breakdownParts(t.promptBreakdown)} /></div>}
      <div className="px-4 py-3">
        <h3 className="mb-2 text-sm">Tool calls <span className="font-normal text-subtle">{calls.length}</span></h3>
        {calls.length === 0 ? <p className="text-sm text-muted">This turn answered without calling any tools.</p> : (
          <ol className="relative flex flex-col gap-2 border-l border-line pl-4">
            {calls.map((c, i) => {
              const bad = !!c.error || c.ok === false
              return (
                <li key={i} className="relative">
                  <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface", bad ? "bg-danger" : "bg-accent")} />
                  <div className="flex items-center justify-between gap-3 text-sm"><span className="mono truncate text-[12.5px]">{c.name}</span>{bad && <Badge tone="danger">Error</Badge>}<span className="tnum ml-auto shrink-0 text-xs text-muted">{dur(c.durationMs)}</span></div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken"><div className="h-full rounded-full" style={{ width: `${Math.max(3, ((c.durationMs ?? 0) / maxD) * 100)}%`, background: bad ? "var(--danger)" : "var(--c1)" }} /></div>
                  {c.error && <p className="mt-1 break-words text-xs text-danger">{c.error}</p>}
                  {c.args != null && <details className="mt-1"><summary className="cursor-pointer text-xs text-muted">Arguments</summary><pre className="mono mt-1 max-h-40 overflow-auto rounded bg-sunken p-2 text-[11.5px]">{JSON.stringify(c.args, null, 2)}</pre></details>}
                </li>
              )
            })}
          </ol>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {t.permalink ? <LinkButton href={t.permalink} external icon="external" size="sm">Open in Slack</LinkButton> : <span className="text-xs text-subtle">No Slack link recorded</span>}
        <span className="mono ml-auto text-[11px] text-subtle">{t.id}</span>
      </div>
    </div>
  )
}

export default function Turns() {
  const sp = new URLSearchParams(useSearch())
  const [f, setF] = useState({ status: sp.get("status") ?? "", trigger: "", channel: "", user: "" })
  const [limit, setLimit] = useState(50)
  const [sel, setSel] = useState<string | null>(sp.get("id"))
  const wide = useMedia("(min-width: 1100px)")
  const names = useUserNames()
  const q = useQuery({
    queryKey: ["turns", f, limit], queryFn: () => api.turns({ ...f, limit }),
    refetchInterval: (c) => (c.state.data?.some((t) => t.status === "running") ? 4000 : false),
  })
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("dialog[open]")) setSel(null) }; addEventListener("keydown", h); return () => removeEventListener("keydown", h) }, [])
  const rows = q.data ?? []
  const channels = [...new Set(rows.map((t) => t.channelId))]
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }))
  const live = rows.some((t) => t.status === "running")

  return (
    <>
      <PageHeader title="Turns" desc="Every agent run, with tool calls, token use and cost." actions={live ? <Badge tone="accent" dot>Live</Badge> : undefined} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Status" className="!w-auto" value={f.status} onChange={set("status")}><option value="">All statuses</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
        <Select aria-label="Trigger" className="!w-auto" value={f.trigger} onChange={set("trigger")}><option value="">All triggers</option>{["mention", "dm", "chime", "automation", "research"].map((t) => <option key={t} value={t} className="capitalize">{t}</option>)}</Select>
        <Select aria-label="Channel" className="!w-auto" value={f.channel} onChange={set("channel")}><option value="">All channels</option>{channels.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        <Select aria-label="User" className="!w-auto" value={f.user} onChange={set("user")}><option value="">All users</option>{names.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
      </div>
      <div className={cn("grid items-start gap-4", wide && sel && "grid-cols-[minmax(0,1fr)_440px]")}>
        <div className="min-w-0">
          <Async q={q} rows={8}>{() => rows.length === 0 ? <Panel><EmptyState icon="turns" title="No turns match">{Object.values(f).some(Boolean) ? "Try clearing a filter." : "Turns appear here after someone talks to the bot in Slack."}</EmptyState></Panel> : (
            <Panel>
              <Table caption="Turns" rows={rows} rowKey={(t) => t.id} selectedKey={sel} onRowClick={(t) => setSel(t.id)} columns={[
                { key: "when", header: "Started", primary: true, sort: (t) => t.startedAt, cell: (t) => <span title={t.startedAt}>{ago(t.startedAt)}</span> },
                { key: "user", header: "User", hideSm: true, sort: (t) => names.name(t.userId), cell: (t) => <span className="truncate">{names.name(t.userId)}</span> },
                { key: "channel", header: "Channel", hideSm: true, cell: (t) => <span className="mono text-xs text-muted">{t.channelId}</span> },
                { key: "trigger", header: "Trigger", sort: (t) => t.trigger, cell: (t) => <span className="capitalize text-muted">{t.trigger}</span> },
                { key: "tools", header: "Tools", num: true, hideSm: true, cell: (t) => t.toolCalls?.length ?? 0 },
                { key: "tokens", header: "Tokens", num: true, sort: (t) => (t.inputTokens ?? 0) + (t.outputTokens ?? 0), cell: (t) => compact((t.inputTokens ?? 0) + (t.outputTokens ?? 0)) },
                { key: "cost", header: "Cost", num: true, hideSm: true, sort: (t) => t.costMicros, cell: (t) => usd(t.costMicros) },
                { key: "status", header: "Status", end: true, sort: (t) => t.status, cell: (t) => <TurnStatus s={t.status} /> },
              ]} />
              {rows.length >= limit && <div className="border-t border-line p-2 text-center"><Button size="sm" variant="ghost" onClick={() => setLimit((l) => Math.min(200, l + 50))} disabled={limit >= 200}>{limit >= 200 ? "Showing the latest 200" : "Load more"}</Button></div>}
            </Panel>
          )}</Async>
        </div>
        {wide && sel && (
          <aside aria-label="Turn details" className="surface sticky top-14 max-h-[calc(100dvh-72px)] overflow-y-auto">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-4 py-2"><h2 className="text-sm">Turn details</h2><Button variant="ghost" size="sm" icon="x" aria-label="Close details" onClick={() => setSel(null)} /></div>
            <TurnDetail id={sel} who={names.name} />
          </aside>
        )}
      </div>
      {!wide && <Dialog sheet open={!!sel} onClose={() => setSel(null)} title="Turn details" width={720}>{sel && <div className="-mx-5 -my-4"><TurnDetail id={sel} who={names.name} /></div>}</Dialog>}
    </>
  )
}
