// Plain-SVG/CSS charts. Colours come from the categorical tokens --c1..--c4; every series is also named in a legend.
import { useState } from "react"
import { cn } from "./cn"

export const SERIES = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"]
const color = (i: number) => SERIES[i % SERIES.length]!

export function Legend({ items }: { items: { label: string; value?: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => <li key={i.label} className="flex items-center gap-1.5"><span className="size-2 rounded-[2px]" style={{ background: i.color }} />{i.label}{i.value && <span className="tnum text-fg">{i.value}</span>}</li>)}
    </ul>
  )
}

/** One horizontal bar split into named segments (e.g. prompt breakdown). */
export function StackedBar({ parts, fmt = (n: number) => n.toLocaleString(), label }: { parts: { label: string; value: number }[]; fmt?: (n: number) => string; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0)
  const shown = parts.filter((p) => p.value > 0)
  if (!total) return <p className="text-sm text-muted">No data.</p>
  return (
    <div>
      <div role="img" aria-label={`${label}: ${shown.map((p) => `${p.label} ${fmt(p.value)}`).join(", ")}`} className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-sunken">
        {shown.map((p, i) => <div key={p.label} title={`${p.label}: ${fmt(p.value)}`} style={{ width: `${(p.value / total) * 100}%`, background: color(i), opacity: i >= 4 ? 0.55 : 1 }} />)}
      </div>
      <div className="mt-2"><Legend items={shown.map((p, i) => ({ label: p.label, value: fmt(p.value), color: color(i) }))} /></div>
    </div>
  )
}

interface Bar { key: string; label: string; segs: number[] }
/** Vertical bars by category (days). `segs` stack bottom-up; hover/focus shows the readout. */
export function BarChart({ bars, series, fmt, height = 170, label }: { bars: Bar[]; series: string[]; fmt: (n: number) => string; height?: number; label: string }) {
  const [hot, setHot] = useState<number | null>(null)
  const W = 720, padL = 44, padB = 22, padT = 8
  const max = Math.max(1, ...bars.map((b) => b.segs.reduce((a, c) => a + c, 0)))
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); const m = max / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p })()
  const innerH = height - padB - padT, innerW = W - padL
  const bw = innerW / Math.max(bars.length, 1)
  const ticks = [0, 0.5, 1].map((r) => nice * r)
  const h = hot != null ? bars[hot] : null
  return (
    <div>
      <div className="mb-1 flex h-5 items-center justify-between text-xs">
        <Legend items={series.map((s, i) => ({ label: s, color: color(i) }))} />
        <span className="tnum text-muted" aria-live="polite">{h ? `${h.label}: ${h.segs.map((v, i) => `${series[i]} ${fmt(v)}`).join(" · ")}` : ""}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="group" aria-label={label} className="block">
        {ticks.map((t) => { const y = padT + innerH - (t / nice) * innerH; return (
          <g key={t}><line x1={padL} x2={W} y1={y} y2={y} stroke="var(--line)" strokeDasharray={t ? "2 3" : undefined} /><text x={padL - 8} y={y + 3.5} textAnchor="end" fontSize="10.5" fill="var(--fg-subtle)" className="tnum">{fmt(t)}</text></g>) })}
        {bars.map((b, i) => {
          let acc = 0
          const x = padL + i * bw + bw * 0.18, w = bw * 0.64
          return (
            <g key={b.key} tabIndex={0} role="img" aria-label={`${b.label}: ${b.segs.map((v, k) => `${series[k]} ${fmt(v)}`).join(", ")}`} onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(i)} onBlur={() => setHot(null)} style={{ outline: "none" }}>
              <rect x={padL + i * bw} y={padT} width={bw} height={innerH} fill="transparent" />
              {b.segs.map((v, k) => { const hgt = (v / nice) * innerH; acc += hgt; return <rect key={k} x={x} y={padT + innerH - acc} width={w} height={Math.max(hgt, 0)} rx={k === b.segs.length - 1 ? 2 : 0} fill={color(k)} opacity={hot == null || hot === i ? 1 : 0.45} /> })}
              {(bars.length <= 14 || i % Math.ceil(bars.length / 10) === 0) && <text x={x + w / 2} y={height - 6} textAnchor="middle" fontSize="10.5" fill="var(--fg-subtle)">{b.label}</text>}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** Ranked horizontal bars with a value column: the "by user / by model" lists. */
export function HBars({ rows, fmt, className }: { rows: { key: string; label: string; value: number; sub?: string }[]; fmt: (n: number) => string; className?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (!rows.length) return <p className="py-4 text-sm text-muted">No data in this range.</p>
  return (
    <ul className={cn("flex flex-col gap-2.5", className)}>
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm"><span className="truncate">{r.label}</span><span className="tnum shrink-0 text-muted">{fmt(r.value)}{r.sub && <span className="ml-2 text-xs text-subtle">{r.sub}</span>}</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-sunken"><div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: "var(--c1)" }} /></div>
        </li>
      ))}
    </ul>
  )
}
