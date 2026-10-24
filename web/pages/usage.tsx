import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Link } from "wouter"
import { api, fieldErr, type CostReport, type Limits, type Usage, type UsageRange } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useUserNames } from "@/lib/auth"
import { ago, compact, num, pct, usd } from "@/lib/format"
import { useDirtyGuard } from "@/lib/hooks"
import { BarChart, HBars, Legend, SERIES, StackedBar } from "@/ui/charts"
import { Button } from "@/ui/button"
import { EmptyState } from "@/ui/empty"
import { FormField, Input } from "@/ui/fields"
import { Async, Meter, PageHeader, Panel, Section, Stat } from "@/ui/page"
import { Segmented } from "@/ui/tabs"
import { Table } from "@/ui/table"
import { breakdownParts } from "./turns"

const RANGES: { id: UsageRange; label: string }[] = [{ id: "1d", label: "24 hours" }, { id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }, { id: "90d", label: "90 days" }]
const tok = (r: { inputTokens: number; outputTokens: number }) => r.inputTokens + r.outputTokens

function LimitsForm() {
  const q = useQuery({ queryKey: ["limits"], queryFn: api.limits })
  const [d, setD] = useState<Limits | null>(null)
  useEffect(() => { if (q.data) setD(q.data) }, [q.data])
  const dirty = !!d && JSON.stringify(d) !== JSON.stringify(q.data)
  useDirtyGuard(dirty)
  const save = useAction(api.saveLimits, { invalidate: [["limits"]], ok: "Limits saved", inline: true })
  const field = (label: string, key: keyof Omit<Limits, "maxStepsByDepth">, hint: string) => d && (
    <FormField label={label} hint={hint} error={fieldErr(save.error, key)}>{(p) => <Input {...p} type="number" min={0} inputMode="numeric" value={d[key]} onChange={(e) => setD({ ...d, [key]: Number(e.target.value) })} className="tabular-nums" />}</FormField>
  )
  return (
    <Async q={q} rows={3}>{() => d && (
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(d) }}>
        <Panel className="p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {field("Per-turn ceiling", "perTurnTokenCeiling", "Tokens. A turn is stopped with a friendly message at this point.")}
            {field("Per-user daily", "perUserDailyTokens", "Tokens per person per day.")}
            {field("Workspace daily", "orgDailyTokens", "Tokens across everyone per day.")}
            {field("Concurrent turns", "concurrentTurns", "Turns running at the same time.")}
          </div>
          <fieldset className="mt-4 border-t border-line pt-4">
            <legend className="eyebrow mb-2 float-left w-full">Maximum steps by depth</legend>
            <div className="grid clear-both grid-cols-2 gap-4 sm:grid-cols-4">
              {(["direct", "memory", "tools", "deep"] as const).map((k) => (
                <FormField key={k} label={k[0]!.toUpperCase() + k.slice(1)} error={fieldErr(save.error, k)}>{(p) => <Input {...p} type="number" min={1} value={d.maxStepsByDepth[k]} onChange={(e) => setD({ ...d, maxStepsByDepth: { ...d.maxStepsByDepth, [k]: Number(e.target.value) } })} className="tabular-nums" />}</FormField>
              ))}
            </div>
          </fieldset>
        </Panel>
        {save.error && <p role="alert" className="mt-2 text-sm text-danger">{save.error.message}</p>}
        <div className="mt-3"><Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>Save limits</Button></div>
      </form>
    )}</Async>
  )
}

function Report({ u, range }: { u: Usage; range: UsageRange }) {
  const names = useUserNames()
  const turns = u.byDay.reduce((a, r) => a + (r.turns ?? 0), 0)
  const input = u.byDay.reduce((a, r) => a + r.inputTokens, 0)
  const output = u.byDay.reduce((a, r) => a + r.outputTokens, 0)
  const cost = u.byDay.reduce((a, r) => a + r.costMicros, 0)
  if (turns === 0) return <Panel><EmptyState icon="usage" title="No turns in this period">Usage appears here after the bot has answered something.</EmptyState></Panel>
  return (
    <>
      <Panel className="mb-8"><div className="grid grid-cols-2 md:grid-cols-4 md:divide-x md:divide-line">
        <Stat label="Turns" value={num(turns)} sub={`${(turns / Math.max(1, u.byDay.length)).toFixed(1)} per active day`} />
        <Stat label="Tokens" value={compact(input + output)} sub={`${compact(input)} in, ${compact(output)} out`} />
        <Stat label="Estimated cost" value={usd(cost)} sub={`${usd(cost / turns)} per turn`} />
        <Stat label="Cache hit rate" value={pct(u.cacheHitRate)} sub="Share of input served from cache" />
      </div></Panel>

      <Section title="Tokens per day" actions={<Legend items={[{ label: "Input", color: SERIES[0]! }, { label: "Output", color: SERIES[1]! }]} />}>
        <Panel className="p-4"><BarChart label={`Tokens per day, last ${range}`} series={["Input", "Output"]} fmt={compact} bars={u.byDay.map((r) => ({ key: r.day, label: r.day.slice(5), segs: [r.inputTokens, r.outputTokens] }))} /></Panel>
      </Section>

      <div className="grid gap-x-8 md:grid-cols-2">
        <Section title="By user"><Panel className="p-4"><HBars fmt={compact} rows={u.byUser.slice(0, 8).map((r) => ({ key: r.userId ?? "system", label: r.name ?? names.name(r.userId), value: tok(r), sub: usd(r.costMicros) }))} /></Panel></Section>
        <Section title="By model"><Panel className="p-4"><HBars fmt={compact} rows={u.byModel.map((r) => ({ key: r.model, label: r.model, value: tok(r), sub: usd(r.costMicros) }))} /></Panel></Section>
        <Section title="By trigger"><Panel className="p-4"><HBars fmt={compact} rows={u.byRole.map((r) => ({ key: r.role, label: r.role, value: tok(r), sub: usd(r.costMicros) }))} /></Panel></Section>
        <Section title="Average prompt" desc="Where the input tokens of a typical turn go.">
          <Panel className="p-4"><StackedBar label="Average prompt breakdown" fmt={compact} parts={breakdownParts(u.avgBreakdown)} /></Panel>
        </Section>
      </div>

      <Section title="Most expensive turns">
        <Panel><Table caption="Most expensive turns" rows={u.topTurns} rowKey={(t) => t.id} columns={[
          { key: "when", header: "When", primary: true, cell: (t) => <Link href={`/turns?id=${t.id}`} className="text-accent-text hover:underline">{ago(t.startedAt)}</Link> },
          { key: "user", header: "User", hideSm: true, cell: (t) => names.name(t.userId) },
          { key: "model", header: "Model", hideSm: true, cell: (t) => <span className="text-muted">{t.model ?? "-"}</span> },
          { key: "depth", header: "Depth", hideSm: true, cell: (t) => <span className="text-muted">{t.depth ?? "-"}</span> },
          { key: "tok", header: "Tokens", num: true, sort: tok, cell: (t) => compact(tok(t)) },
          { key: "cost", header: "Cost", num: true, end: true, sort: (t) => t.costMicros, cell: (t) => usd(t.costMicros) },
        ]} /></Panel>
      </Section>
    </>
  )
}

const DAYS: Record<UsageRange, number> = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 }
const dollars = (n: number) => usd(n * 1e6)

function Cost({ c }: { c: CostReport }) {
  const top = c.byModel.slice(0, 3).map((m) => m.model)
  const series = c.byModel.length > 3 ? [...top, "Other"] : top
  const m = c.month
  return (
    <>
      <Panel className="mb-4"><div className="grid grid-cols-2 md:grid-cols-3 md:divide-x md:divide-line">
        <Stat label={`Spend, last ${c.days} ${c.days === 1 ? "day" : "days"}`} value={dollars(c.totalUsd)} sub={`${num(c.byDay.reduce((a, d) => a + d.turns, 0))} turns`} />
        {m && <Stat label="This month (UTC)" value={dollars(m.spentUsd)} sub={m.alertUsd ? `Alert threshold ${dollars(m.alertUsd)}` : "No spend alert configured"} />}
        {m?.alertUsd ? <div className="col-span-2 px-4 py-3 md:col-span-1"><div className="eyebrow">Against alert</div><div className="mt-3"><Meter value={m.spentUsd} max={m.alertUsd} label="Month spend against alert threshold" /></div><div className="mt-1.5 text-xs text-muted">{pct(m.spentUsd / m.alertUsd)} used. Alert only, nothing is paused.</div></div> : null}
      </div></Panel>
      {c.byDay.length === 0 ? <Panel><EmptyState icon="usage" title="No spend in this period">Cost appears here after the bot has answered something.</EmptyState></Panel> : (
        <>
          <Panel className="mb-4 p-4"><BarChart label={`Spend per day by model, last ${c.days} days`} series={series} fmt={dollars}
            bars={c.byDay.map((d) => ({ key: d.day, label: d.day.slice(5), segs: series.map((s) => s === "Other" && c.byModel.length > 3 ? Object.entries(d.models).filter(([k]) => !top.includes(k)).reduce((a, [, v]) => a + v, 0) : d.models[s] ?? 0) }))} /></Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel><Table caption="Spend by model" rows={c.byModel} rowKey={(r) => r.model} initialSort={{ key: "usd", dir: -1 }} columns={[
              { key: "model", header: "Model", primary: true, cell: (r) => r.model },
              { key: "turns", header: "Turns", num: true, sort: (r) => r.turns, cell: (r) => num(r.turns) },
              { key: "tok", header: "Tokens", num: true, hideSm: true, sort: tok, cell: (r) => compact(tok(r)) },
              { key: "usd", header: "Cost", num: true, end: true, sort: (r) => r.usd, cell: (r) => dollars(r.usd) },
            ]} /></Panel>
            <Panel><Table caption="Spend by day" rows={c.byDay} rowKey={(r) => r.day} initialSort={{ key: "day", dir: -1 }} columns={[
              { key: "day", header: "Day", primary: true, sort: (r) => r.day, cell: (r) => r.day },
              { key: "turns", header: "Turns", num: true, hideSm: true, sort: (r) => r.turns, cell: (r) => num(r.turns) },
              { key: "usd", header: "Cost", num: true, end: true, sort: (r) => r.usd, cell: (r) => dollars(r.usd) },
            ]} /></Panel>
          </div>
        </>
      )}
    </>
  )
}

export default function UsagePage() {
  const [range, setRange] = useState<UsageRange>("7d")
  const q = useQuery({ queryKey: ["usage", range], queryFn: () => api.usage(range), placeholderData: (p) => p })
  const cost = useQuery({ queryKey: ["cost", DAYS[range]], queryFn: () => api.costReport(DAYS[range]), placeholderData: (p) => p })
  return (
    <>
      <PageHeader title="Usage & limits" desc="Token spend and caps across the workspace. Costs are estimates from the model's published prices."
        actions={<Segmented label="Period" value={range} onChange={setRange} items={RANGES} />} />
      <Async q={q} rows={6}>{(u) => <Report u={u} range={range} />}</Async>
      <Section title="Cost" desc="Estimated model spend by day and model, from the per-turn ledger." className="mt-8"><Async q={cost} rows={3}>{(c) => <Cost c={c} />}</Async></Section>
      <Section title="Limits" desc="Enforced before and during a turn. Zero means unlimited." className="mt-8"><LimitsForm /></Section>
    </>
  )
}
