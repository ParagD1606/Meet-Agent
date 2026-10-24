import { useEffect, useMemo, useRef, useState } from "react"
import { Dialog } from "@/ui/dialog"
import { Input } from "@/ui/fields"

type Line = { n: number; speaker: string; text: string }
const COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"]

/** Bottom-sheet transcript with search; evidence lines are highlighted and the focus line is scrolled into view. */
export function TranscriptDrawer({ open, onClose, lines: rawLines, highlight, focus }: { open: boolean; onClose: () => void; lines: Line[] | null; highlight: Set<number>; focus: number | null }) {
  const [q, setQ] = useState("")
  const lines = Array.isArray(rawLines) ? rawLines : null
  const speakers = useMemo(() => [...new Set((lines ?? []).map((l) => l.speaker))], [lines])
  const shown = useMemo(() => { const s = q.trim().toLowerCase(); return (lines ?? []).filter((l) => !s || `${l.speaker} ${l.text}`.toLowerCase().includes(s)) }, [lines, q])
  return <Dialog open={open} onClose={onClose} title="Transcript" sheet width={900} height={560} description={focus ? `Showing line ${focus}. Highlighted lines are evidence for the selected item.` : "Highlighted lines are evidence for items."}>
    <div className="mb-3"><Input type="search" aria-label="Search transcript" placeholder="Search transcript" value={q} onChange={(e) => setQ(e.target.value)} /></div>
    {!lines ? <p className="text-sm text-muted">No transcript was stored for this meeting.</p> : shown.length === 0 ? <p className="text-sm text-muted">No lines match.</p> : (
      <ol className="space-y-0.5 text-sm" aria-label="Transcript lines">{shown.map((l) => <Row key={l.n} l={l} color={COLORS[speakers.indexOf(l.speaker) % COLORS.length]!} hl={highlight.has(l.n)} scroll={l.n === focus} />)}</ol>
    )}
  </Dialog>
}

function Row({ l, color, hl, scroll }: { l: Line; color: string; hl: boolean; scroll: boolean }) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => { if (scroll) ref.current?.scrollIntoView({ block: "center" }) }, [scroll])
  return <li ref={ref} id={`line-${l.n}`} aria-current={scroll || undefined} className={`flex gap-3 rounded-md px-2 py-1 ${hl ? "bg-warn-soft" : ""} ${scroll ? "ring-1 ring-[var(--accent)]" : ""}`}>
    <span className="w-7 shrink-0 text-right text-xs tabular-nums text-subtle">{l.n}</span>
    <span className="min-w-0"><b style={{ color }} className="mr-1.5 font-semibold">{l.speaker}</b>{l.text}</span>
  </li>
}
