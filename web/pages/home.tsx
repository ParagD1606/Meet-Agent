import { useQuery } from "@tanstack/react-query"
import { Link } from "wouter"
import { api, count, type Turn } from "@/lib/api"
import { useMe, useUserNames } from "@/lib/auth"
import { ago, compact, num } from "@/lib/format"
import { Icon, type IconName } from "@/lib/icons"
import { cn } from "@/ui/cn"
import { Async, PageHeader, Panel, Section, Stat } from "@/ui/page"
import { Skeleton } from "@/ui/skeleton"
import { Table } from "@/ui/table"
import { TurnStatus } from "./turns"

interface Item { icon: IconName; tone: "danger" | "warn"; title: string; to: string; cta: string }

export default function Home() {
  const { admin } = useMe()
  const ov = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 30_000 })
  const reviews = useQuery({ queryKey: ["reviews", "pending"], queryFn: () => api.reviews("pending"), enabled: admin })
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.connections })
  const setup = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus, enabled: admin })
  const autos = useQuery({ queryKey: ["automations"], queryFn: api.automations })
  const names = useUserNames()

  const attention: Item[] = []
  const pend = reviews.data?.length ?? 0
  if (pend) attention.push({ icon: "review", tone: "warn", title: `${pend} ${pend === 1 ? "memory is" : "memories are"} waiting for review`, to: "/review", cta: "Review" })
  for (const c of conns.data?.filter((c) => c.status === "error") ?? []) attention.push({ icon: "plug", tone: "danger", title: `${c.label} lost its connection${c.error ?? c.lastError ?? c.reason ? `: ${c.error ?? c.lastError ?? c.reason}` : ""}`, to: "/integrations", cta: "Reconnect" })
  const failed = (ov.data?.recentTurns ?? []).filter((t) => t.status === "error")
  if (failed.length && admin) attention.push({ icon: "alert", tone: "danger", title: `${failed.length} of the last ${ov.data!.recentTurns.length} turns failed`, to: "/turns?status=error", cta: "Inspect" })
  for (const a of autos.data?.filter((a) => a.enabled && a.lastStatus && a.lastStatus !== "ok") ?? []) attention.push({ icon: "clock", tone: "warn", title: `Automation “${a.prompt.slice(0, 48)}” last run: ${a.lastStatus}`, to: "/automations", cta: "Open" })

  const s = setup.data
  const checklist = [
    { label: "Language model configured", done: s ? s.model : true, to: "/setup" },
    { label: "Slack workspace connected", done: s ? !!s.workspace : true, to: "/setup" },
    { label: "Connect a tool", done: count(ov.data?.connections) > 0, to: "/integrations" },
    { label: "Add knowledge: upload a document or sync a source", done: (ov.data?.memoryCount ?? 0) > 0, to: "/memories" },
    { label: "Schedule a digest or reminder", done: count(ov.data?.automations) > 0, to: "/automations" },
  ]
  const remaining = checklist.filter((c) => !c.done)

  return (
    <>
      <PageHeader title="Home" desc="Workspace activity, setup progress and anything that needs a decision." />

      <Section title="Needs attention">
        {ov.isPending ? <Panel><Skeleton className="m-4 h-4 w-1/2" /></Panel> : attention.length === 0 ? (
          <Panel><div className="flex items-center gap-3 px-4 py-3 text-sm"><Icon name="success" className="text-ok" size={18} /><span>Nothing needs attention. Reviews, connections and recent turns are healthy.</span></div></Panel>
        ) : (
          <Panel><ul className="divide">{attention.map((a, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-2.5">
              <Icon name={a.icon} className={a.tone === "danger" ? "text-danger" : "text-warn"} />
              <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
              <Link href={a.to} className="btn btn-sm">{a.cta}</Link>
            </li>))}</ul></Panel>
        )}
      </Section>

      <Section title="Overview">
        <Panel>
          <div className="grid grid-cols-2 divide-line md:grid-cols-4 md:divide-x [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-line md:[&>*:nth-child(n+3)]:border-t-0">
            {ov.isPending ? Array.from({ length: 4 }, (_, i) => <div key={i} className="p-4"><Skeleton className="h-8 w-16" /></div>) : <>
              <Link href="/memories" className="hover:bg-hover"><Stat label="Shared memories" value={compact(ov.data!.memoryCount)} /></Link>
              <Link href="/integrations" className="hover:bg-hover"><Stat label="Connections" value={num(count(ov.data!.connections))} sub={conns.data ? `${conns.data.filter((c) => c.status === "connected").length} connected` : undefined} /></Link>
              <Link href="/automations" className="hover:bg-hover"><Stat label="Active automations" value={num(count(ov.data!.automations))} /></Link>
              <Link href={admin ? "/turns" : "/"} className="hover:bg-hover"><Stat label="Recent turns" value={num(ov.data!.recentTurns.length)} sub={`${ov.data!.recentTurns.filter((t) => t.status === "done").length} completed`} /></Link>
            </>}
          </div>
        </Panel>
      </Section>

      {remaining.length > 0 && (
        <Section title="Finish setting up" desc={`${checklist.length - remaining.length} of ${checklist.length} steps done`}>
          <Panel>
            <ul className="divide">{checklist.map((c) => (
              <li key={c.label}>
                <Link href={c.to} className={cn("flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-hover", c.done && "text-muted")}>
                  <span className={cn("flex size-4 items-center justify-center rounded-full border", c.done ? "border-accent bg-accent text-[var(--accent-fg)]" : "border-line-strong")}>{c.done && <Icon name="check" size={10} />}</span>
                  <span className={cn("flex-1", c.done && "line-through decoration-line-strong")}>{c.label}</span>{!c.done && <Icon name="right" size={14} className="text-subtle" />}
                </Link>
              </li>))}</ul>
          </Panel>
        </Section>
      )}

      <Section title={admin ? "Recent turns" : "Your recent turns"} actions={admin ? <Link href="/turns" className="text-sm text-accent-text hover:underline">View all</Link> : undefined}>
        <Async q={ov} rows={4}>{(d) => d.recentTurns.length === 0 ? <Panel><p className="px-4 py-8 text-center text-sm text-muted">No turns yet. Mention the bot in Slack to get started.</p></Panel> : (
          <Panel><Table caption="Recent turns" rows={d.recentTurns} rowKey={(t) => t.id} columns={[
            { key: "when", header: "When", primary: true, cell: (t: Turn) => <span title={t.startedAt}>{ago(t.startedAt)}</span> },
            { key: "user", header: "User", cell: (t) => names.name(t.userId ?? null), hideSm: true },
            { key: "trigger", header: "Trigger", cell: (t) => <span className="capitalize text-muted">{t.trigger}</span> },
            { key: "tokens", header: "Tokens", num: true, hideSm: true, cell: (t) => compact((t.inputTokens ?? 0) + (t.outputTokens ?? 0)) },
            { key: "status", header: "Status", end: true, cell: (t) => <TurnStatus s={t.status} /> },
          ]} /></Panel>
        )}</Async>
      </Section>
    </>
  )
}
