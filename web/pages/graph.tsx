import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { quadtree, type Quadtree } from "d3-quadtree"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "wouter"
import { api, type GraphData, type GraphNode } from "@/lib/api"
import { dateShort, num } from "@/lib/format"
import { useDebounced, useTheme } from "@/lib/hooks"
import { Button, LinkButton } from "@/ui/button"
import { EmptyState } from "@/ui/empty"
import { Input, Select } from "@/ui/fields"
import { ErrorState, Spinner } from "@/ui/page"
import { Icon } from "@/lib/icons"
import { Badge } from "@/ui/badge"

// Layout runs in graph-worker.ts; this component only draws what is on screen and hit-tests with a quadtree.
const scopeGroup = (s: string) => (s === "shared" || s === "company" ? 0 : s.startsWith("channel") ? 1 : 2)
const GROUPS = ["Shared", "Channel", "Personal"]
const LIMITS = [500, 1000, 2500, 5000]

interface Pt { x: number; y: number; i: number }
interface View { x: number; y: number; k: number }
interface Filters { scope: string; q: string }

function GraphCanvas({ data, filters, selected, onSelect, focus }: { data: GraphData; filters: Filters; selected: number | null; onSelect: (n: GraphNode | null) => void; focus: { id: number; t: number } | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { resolved } = useTheme()
  const st = useRef({ pos: new Float32Array(0), view: { x: 0, y: 0, k: 1 } as View, w: 0, h: 0, hover: -1, settled: false, touched: false })
  const live = useRef({ filters, selected, data, resolved })
  live.current = { filters, selected, data, resolved }
  const api2 = useRef<{ draw: () => void; fit: () => void; zoom: (f: number) => void; center: (i: number) => void }>({ draw() {}, fit() {}, zoom() {}, center() {} })

  // derived per-node arrays (cheap; shared by draw and picking)
  const model = useMemo(() => {
    const idx = new Map<number, number>()
    data.nodes.forEach((n, i) => idx.set(n.id, i))
    const edges: number[] = []
    const deg = new Uint16Array(data.nodes.length)
    for (const e of data.edges) {
      const a = idx.get(e.source), b = idx.get(e.target)
      if (a === undefined || b === undefined || a === b) continue
      edges.push(a, b); deg[a]!++; deg[b]!++
    }
    const radius = Float32Array.from(data.nodes, (n, i) => (n.kind === "chunk" ? 2.5 : 3.5) + Math.min(4, Math.sqrt(deg[i]!) * 0.9))
    const group = Uint8Array.from(data.nodes, (n) => scopeGroup(n.scope))
    return { idx, edges: Int32Array.from(edges), radius, group }
  }, [data])

  useEffect(() => { api2.current.draw() }, [filters, selected, resolved])

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext("2d")!
    const s = st.current
    const n = data.nodes.length
    s.pos = new Float32Array(2 * n); s.settled = false; s.touched = false
    let raf = 0, tree: Quadtree<Pt> | null = null
    const pts: Pt[] = Array.from({ length: n }, (_, i) => ({ x: 0, y: 0, i }))
    let colors: string[] = [], line = "", fg = "", muted = "", bg = "", themeKey = ""

    const readTheme = () => {
      const key = document.documentElement.dataset.theme ?? ""
      if (key === themeKey) return
      themeKey = key
      const c = getComputedStyle(document.documentElement)
      const g = (v: string) => c.getPropertyValue(v).trim()
      colors = [g("--c1"), g("--c2"), g("--c3")]; line = g("--line-strong"); fg = g("--fg"); muted = g("--fg-muted"); bg = g("--bg")
    }

    const visible = (i: number) => {
      const f = live.current.filters
      if (f.scope !== "all" && String(model.group[i]) !== f.scope) return false
      return true
    }
    const matches = (i: number, q: string) => data.nodes[i]!.label.toLowerCase().includes(q)

    const draw = () => {
      raf = 0
      readTheme()
      const { w, h, view, pos } = s
      if (!w) return
      const dpr = devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const q = live.current.filters.q.trim().toLowerCase()
      const sel = live.current.selected
      const selIdx = sel == null ? -1 : model.idx.get(sel) ?? -1
      const sx = (x: number) => w / 2 + view.x + x * view.k
      const sy = (y: number) => h / 2 + view.y + y * view.k
      const pad = 12
      const inView = (x: number, y: number) => x > -pad && x < w + pad && y > -pad && y < h + pad
      const E = model.edges
      const dim = q.length > 0

      // edges: culled by bounding box, one path
      ctx.lineWidth = 1
      ctx.strokeStyle = line
      ctx.globalAlpha = dim ? 0.25 : 0.55
      ctx.beginPath()
      for (let e = 0; e < E.length; e += 2) {
        const a = E[e]!, b = E[e + 1]!
        if (!visible(a) || !visible(b)) continue
        const x1 = sx(pos[2 * a]!), y1 = sy(pos[2 * a + 1]!), x2 = sx(pos[2 * b]!), y2 = sy(pos[2 * b + 1]!)
        if ((x1 < 0 && x2 < 0) || (x1 > w && x2 > w) || (y1 < 0 && y2 < 0) || (y1 > h && y2 > h)) continue
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2)
      }
      ctx.stroke()

      // nodes: batched per colour, culled
      const hits: number[] = []
      const labelled: number[] = []
      for (let g = 0; g < 3; g++) {
        for (const pass of dim ? [0, 1] : [1]) { // pass 0 = non-matching (faded), 1 = normal/matching
          ctx.fillStyle = colors[g]!
          ctx.globalAlpha = pass === 0 ? 0.18 : 1
          ctx.beginPath()
          for (let i = 0; i < n; i++) {
            if (model.group[i] !== g || !visible(i)) continue
            const m = !dim || matches(i, q)
            if ((pass === 1) !== m) continue
            const x = sx(pos[2 * i]!), y = sy(pos[2 * i + 1]!)
            if (!inView(x, y)) continue
            const r = Math.max(1.6, model.radius[i]! * Math.min(1.6, Math.max(0.55, Math.sqrt(view.k))))
            ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832)
            if (pass === 1) { hits.push(i); if (dim) labelled.push(i) }
          }
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1

      // rings for hover / selection, plus labels where there is room
      const ring = (i: number, color: string) => {
        if (i < 0) return
        const x = sx(pos[2 * i]!), y = sy(pos[2 * i + 1]!)
        ctx.strokeStyle = color; ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(x, y, Math.max(4, model.radius[i]! * Math.sqrt(view.k)) + 3, 0, 6.2832); ctx.stroke()
      }
      ring(selIdx, fg); if (s.hover !== selIdx) ring(s.hover, muted)

      ctx.font = "12px Inter, system-ui, sans-serif"
      ctx.textBaseline = "middle"
      const label = (i: number) => {
        const x = sx(pos[2 * i]!), y = sy(pos[2 * i + 1]!)
        const t = data.nodes[i]!.label.slice(0, 44)
        ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.strokeText(t, x + 9, y)
        ctx.fillStyle = fg; ctx.fillText(t, x + 9, y)
      }
      if (view.k > 1.8 && hits.length <= 120) hits.forEach(label)
      else if (dim) labelled.slice(0, 40).forEach(label)
      if (selIdx >= 0) label(selIdx)
      if (s.hover >= 0 && s.hover !== selIdx) label(s.hover)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }

    const rebuildTree = () => {
      for (let i = 0; i < n; i++) { pts[i]!.x = s.pos[2 * i]!; pts[i]!.y = s.pos[2 * i + 1]! }
      tree = quadtree<Pt>().x((p) => p.x).y((p) => p.y).addAll(pts.filter((p) => visible(p.i)))
    }
    const bounds = () => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (let i = 0; i < n; i++) { if (!visible(i)) continue; const x = s.pos[2 * i]!, y = s.pos[2 * i + 1]!; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
      return n && x0 < Infinity ? { x0, x1, y0, y1 } : null
    }
    const fit = () => {
      const b = bounds()
      if (!b || !s.w) return
      const k = Math.min(3, (s.w - 80) / Math.max(40, b.x1 - b.x0), (s.h - 80) / Math.max(40, b.y1 - b.y0))
      s.view = { k, x: -((b.x0 + b.x1) / 2) * k, y: -((b.y0 + b.y1) / 2) * k }
      schedule()
    }
    const zoomAt = (f: number, cx = s.w / 2, cy = s.h / 2) => {
      const k = Math.min(12, Math.max(0.05, s.view.k * f)), r = k / s.view.k
      s.view = { k, x: cx - s.w / 2 - (cx - s.w / 2 - s.view.x) * r, y: cy - s.h / 2 - (cy - s.h / 2 - s.view.y) * r }
      s.touched = true; schedule()
    }
    api2.current = {
      draw: schedule, fit, zoom: (f) => zoomAt(f),
      center: (i) => { s.touched = true; const k = Math.max(s.view.k, 2); s.view = { k, x: -s.pos[2 * i]! * k, y: -s.pos[2 * i + 1]! * k }; schedule() },
    }

    // ---- worker layout
    const worker = new Worker("/graph-worker.js", { type: "module" }) // emitted as a separate entry by build.ts
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type !== "pos") return
      s.pos = e.data.pos as Float32Array<ArrayBuffer>
      rebuildTree()
      if (!s.touched && (!s.settled || e.data.done)) { fit() }
      if (e.data.done) s.settled = true
      schedule()
    }
    const seed = new Float32Array(2 * n).fill(NaN)
    worker.postMessage({ type: "init", n, edges: model.edges, radius: model.radius, pos: seed })

    const resize = () => {
      const r = canvas.getBoundingClientRect()
      s.w = r.width; s.h = r.height
      const dpr = devicePixelRatio || 1
      canvas.width = Math.round(s.w * dpr); canvas.height = Math.round(s.h * dpr)
      if (!s.touched) fit()
      schedule()
    }
    const ro = new ResizeObserver(resize); ro.observe(canvas); resize()

    // ---- interaction
    const pick = (e: PointerEvent): number => {
      if (!tree) return -1
      const r = canvas.getBoundingClientRect()
      const wx = (e.clientX - r.left - s.w / 2 - s.view.x) / s.view.k, wy = (e.clientY - r.top - s.h / 2 - s.view.y) / s.view.k
      const hit = tree.find(wx, wy, 10 / s.view.k + 4)
      return hit ? hit.i : -1
    }
    let pan = false, moved = 0, last = { x: 0, y: 0 }
    const down = (e: PointerEvent) => { canvas.setPointerCapture(e.pointerId); pan = true; moved = 0; last = { x: e.clientX, y: e.clientY } }
    const move = (e: PointerEvent) => {
      if (pan) {
        const dx = e.clientX - last.x, dy = e.clientY - last.y
        moved += Math.abs(dx) + Math.abs(dy)
        if (moved > 3) { s.touched = true; s.view = { ...s.view, x: s.view.x + dx, y: s.view.y + dy }; schedule() }
        last = { x: e.clientX, y: e.clientY }
      } else {
        const i = pick(e)
        if (i !== s.hover) { s.hover = i; canvas.style.cursor = i >= 0 ? "pointer" : "grab"; schedule() }
      }
    }
    const up = (e: PointerEvent) => {
      if (pan && moved <= 3) { const i = pick(e); onSelect(i >= 0 ? data.nodes[i]! : null) }
      pan = false
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top)
    }
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move)
    canvas.addEventListener("pointerup", up); canvas.addEventListener("wheel", wheel, { passive: false })
    canvas.addEventListener("pointerleave", () => { if (s.hover !== -1) { s.hover = -1; schedule() } })
    return () => {
      worker.terminate(); ro.disconnect(); cancelAnimationFrame(raf)
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move)
      canvas.removeEventListener("pointerup", up); canvas.removeEventListener("wheel", wheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, model])

  useEffect(() => {
    if (!focus) return
    const i = model.idx.get(focus.id)
    if (i !== undefined) api2.current.center(i)
  }, [focus, model])

  return (
    <>
      <canvas ref={ref} role="img" aria-label={`Memory graph with ${data.nodes.length} nodes. Drag to pan, scroll to zoom, click a node for details. The same memories are listed on the Memories page.`} className="absolute inset-0 block h-full w-full cursor-grab touch-none" />
      <div className="absolute bottom-3 left-3 flex flex-col gap-1 max-md:bottom-3">
        <Button size="sm" icon="zoomIn" aria-label="Zoom in" onClick={() => api2.current.zoom(1.4)} />
        <Button size="sm" icon="zoomOut" aria-label="Zoom out" onClick={() => api2.current.zoom(1 / 1.4)} />
        <Button size="sm" icon="fit" aria-label="Fit to screen" onClick={() => { st.current.touched = false; api2.current.fit() }} />
      </div>
    </>
  )
}

export default function GraphPage() {
  const [limit, setLimit] = useState(1000)
  const [kind, setKind] = useState("all")
  const [source, setSource] = useState("all")
  const [scope, setScope] = useState("all")
  const [search, setSearch] = useState("")
  const dq = useDebounced(search, 200)
  const [sel, setSel] = useState<GraphNode | null>(null)
  const [focus, setFocus] = useState<{ id: number; t: number } | null>(null)

  const q = useQuery({
    queryKey: ["graph", limit, kind, source],
    queryFn: () => api.graph({ limit, kind: kind === "all" ? undefined : kind, source: source === "all" ? undefined : source }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
  const data = q.data
  const filters = useMemo(() => ({ scope, q: dq }), [scope, dq])
  const total = data?.total ?? data?.nodes.length ?? 0
  const matches = useMemo(() => (dq.trim() && data ? data.nodes.filter((n) => n.label.toLowerCase().includes(dq.trim().toLowerCase())) : []), [data, dq])
  const sources = useMemo(() => ["all", ...new Set((data?.nodes ?? []).map((n) => n.source).filter((x): x is string => !!x))], [data])
  const neighbours = useMemo(() => {
    if (!sel || !data) return []
    const ids = new Set<number>()
    for (const e of data.edges) { if (e.source === sel.id) ids.add(e.target); else if (e.target === sel.id) ids.add(e.source) }
    return data.nodes.filter((n) => ids.has(n.id)).slice(0, 8)
  }, [sel, data])
  useEffect(() => { setSel(null) }, [data])
  const jump = useCallback((n: GraphNode) => { setSel(n); setFocus({ id: n.id, t: Date.now() }) }, [])

  return (
    <div className="flex h-[calc(100dvh-44px)] flex-col max-md:h-[calc(100dvh-44px-60px)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bg px-4 py-2 md:px-6">
        <h1 className="mr-2 text-lg">Graph</h1>
        <div className="relative">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-subtle" />
          <Input data-search type="search" aria-label="Find a node" placeholder="Find a node" className="w-48 pl-8" value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) jump(matches[0]) }} />
        </div>
        <Select aria-label="Kind" className="w-32" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">All kinds</option><option value="fact">Facts</option><option value="chunk">Document chunks</option>
        </Select>
        <Select aria-label="Scope" className="w-32" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">All scopes</option>{GROUPS.map((g, i) => <option key={g} value={i}>{g}</option>)}
        </Select>
        {sources.length > 2 && (
          <Select aria-label="Source" className="w-32" value={source} onChange={(e) => setSource(e.target.value)}>
            {sources.map((s) => <option key={s} value={s}>{s === "all" ? "All sources" : s}</option>)}
          </Select>
        )}
        <Select aria-label="Node limit" className="w-36" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {LIMITS.map((l) => <option key={l} value={l}>Up to {num(l)}</option>)}
        </Select>
        <span className="ml-auto text-xs text-muted tabular-nums" aria-live="polite">
          {data ? <>Showing {num(data.nodes.length)} of {num(total)}{dq.trim() ? ` · ${matches.length} match${matches.length === 1 ? "" : "es"}` : ""}</> : null}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 bg-sunken">
        {q.isPending ? <Spinner /> : q.error && !data ? <div className="p-6"><ErrorState error={q.error} retry={() => q.refetch()} /></div> : data && data.nodes.length === 0 ? (
          <EmptyState icon="graph" title="Nothing to show yet" action={<LinkButton href="/memories" variant="primary">Add memories</LinkButton>}>
            The graph fills in as the bot learns from Slack or you upload documents.
          </EmptyState>
        ) : data && (
          <>
            <GraphCanvas data={data} filters={filters} selected={sel?.id ?? null} onSelect={setSel} focus={focus} />
            {q.isFetching && <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted"><Icon name="loader" size={12} className="spin" />Updating</div>}
            <div className="pointer-events-none absolute left-3 top-3 flex gap-1.5 text-xs">
              {GROUPS.map((g, i) => <span key={g} className="rounded-md border border-line bg-surface/90 px-2 py-1"><i className="mr-1.5 inline-block size-2 rounded-full align-baseline" style={{ background: `var(--c${i + 1})` }} />{g}</span>)}
            </div>
            {data.truncated && <div className="absolute bottom-3 right-3 max-w-xs rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted max-md:hidden">Showing the {num(data.nodes.length)} best-connected nodes. Raise the limit or filter to see others.</div>}
            {sel && (
              <aside aria-label="Node details" className="absolute inset-x-3 bottom-3 rounded-lg border border-line bg-surface p-4 text-sm shadow-[var(--shadow-md)] md:inset-x-auto md:bottom-auto md:right-3 md:top-3 md:w-80">
                <div className="mb-2 flex items-center gap-1.5">
                  <Badge tone="accent">{GROUPS[scopeGroup(sel.scope)]}</Badge><Badge>{sel.kind}</Badge>{sel.source && <Badge>{sel.source}</Badge>}
                  <Button className="ml-auto -mr-1" variant="ghost" size="sm" icon="x" aria-label="Close details" onClick={() => setSel(null)} />
                </div>
                <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{sel.label}</p>
                <p className="mt-2 text-xs text-muted">{sel.scope}{sel.createdAt ? ` · ${dateShort(sel.createdAt)}` : ""}</p>
                {neighbours.length > 0 && (
                  <div className="mt-3 border-t border-line pt-2">
                    <div className="eyebrow mb-1">Linked to {neighbours.length === 8 ? "8+" : neighbours.length}</div>
                    <ul>{neighbours.map((n) => <li key={n.id}><button className="block w-full truncate rounded px-1 py-1 text-left text-xs hover:bg-hover" onClick={() => jump(n)}>{n.label}</button></li>)}</ul>
                  </div>
                )}
                <Link href={`/memories?q=${encodeURIComponent(sel.label.slice(0, 60))}`} className="mt-3 inline-flex items-center gap-1 text-xs text-accent-text hover:underline">Open in Memories<Icon name="arrowRight" size={12} /></Link>
              </aside>
            )}
          </>
        )}
      </div>
    </div>
  )
}
