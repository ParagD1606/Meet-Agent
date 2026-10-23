import { useQuery } from "@tanstack/react-query"
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force"
import { useEffect, useRef, useState } from "react"
import { api, type GraphData } from "@/lib/api"
import { Async, Badge, Empty, PageTitle } from "@/lib/ui"

type N = SimulationNodeDatum & { id: number; label: string; scope: string; kind: string }
type L = SimulationLinkDatum<N> & { weight: number }

const scopeKind = (s: string) => (s === "shared" ? "shared" : s.startsWith("channel_") ? "channel" : "user")
const COLORS = { shared: "#4d8df5", channel: "#fbbf24", user: "#4ade80" } as const

function Canvas({ data, onSelect }: { data: GraphData; onSelect: (n: N | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext("2d")!
    const nodes: N[] = data.nodes.map((n) => ({ ...n }))
    const ids = new Set(nodes.map((n) => n.id))
    const links: L[] = data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target, weight: e.weight }))
    const view = { x: 0, y: 0, k: 1 }
    let w = 0, h = 0, hover: N | null = null, raf = 0, selId: number | null = null

    const sim: Simulation<N, L> = forceSimulation(nodes)
      .force("link", forceLink<N, L>(links).id((d) => d.id).distance(50).strength(0.3))
      .force("charge", forceManyBody().strength(-60))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide(9))
    const radius = (n: N) => (n.kind === "chunk" ? 4 : 6)

    const css = getComputedStyle(document.documentElement)
    const draw = () => {
      raf = 0
      const dpr = devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.translate(w / 2 + view.x, h / 2 + view.y)
      ctx.scale(view.k, view.k)
      const line = css.getPropertyValue("--line").trim() || "#888"
      ctx.lineWidth = 1 / view.k
      for (const l of links) {
        const s = l.source as N, t = l.target as N
        ctx.globalAlpha = Math.min(1, 0.25 + l.weight * 0.5)
        ctx.strokeStyle = line
        ctx.beginPath(); ctx.moveTo(s.x!, s.y!); ctx.lineTo(t.x!, t.y!); ctx.stroke()
      }
      ctx.globalAlpha = 1
      for (const n of nodes) {
        ctx.fillStyle = COLORS[scopeKind(n.scope)]
        ctx.beginPath(); ctx.arc(n.x!, n.y!, radius(n), 0, 7); ctx.fill()
        if (n.id === selId || n === hover) { ctx.strokeStyle = css.getPropertyValue("--fg").trim() || "#fff"; ctx.lineWidth = 2 / view.k; ctx.stroke() }
      }
      if (view.k > 1.2 || nodes.length < 40) {
        ctx.fillStyle = css.getPropertyValue("--muted").trim() || "#999"
        ctx.font = `${11 / Math.max(view.k, 0.8)}px sans-serif`
        for (const n of nodes) ctx.fillText(n.label.slice(0, 28), n.x! + 8, n.y! + 3)
      }
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }
    let ticks = 0
    sim.on("tick", () => { if (++ticks === 60) fit(); schedule() })
    // Fit the settled layout to the viewport once (unless the user already moved the view).
    let touched = false
    function fit() {
      if (touched || !nodes.length || !w) return
      const xs = nodes.map((n) => n.x!), ys = nodes.map((n) => n.y!)
      const bw = Math.max(...xs) - Math.min(...xs) + 60, bh = Math.max(...ys) - Math.min(...ys) + 60
      view.k = Math.min(2, w / bw, h / bh)
      view.x = -((Math.max(...xs) + Math.min(...xs)) / 2) * view.k
      view.y = -((Math.max(...ys) + Math.min(...ys)) / 2) * view.k
      schedule()
    }
    sim.on("end", fit)

    const resize = () => {
      const r = canvas.getBoundingClientRect()
      w = r.width; h = r.height
      canvas.width = w * (devicePixelRatio || 1); canvas.height = h * (devicePixelRatio || 1)
      schedule()
    }
    const ro = new ResizeObserver(resize); ro.observe(canvas); resize()

    const world = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect()
      return { x: (e.clientX - r.left - w / 2 - view.x) / view.k, y: (e.clientY - r.top - h / 2 - view.y) / view.k }
    }
    const pick = (e: PointerEvent) => {
      const p = world(e)
      let best: N | null = null, bd = Infinity
      for (const n of nodes) { const d = (n.x! - p.x) ** 2 + (n.y! - p.y) ** 2; if (d < bd && d < (radius(n) + 5) ** 2) { best = n; bd = d } }
      return best
    }
    let drag: N | null = null, pan = false, moved = false, last = { x: 0, y: 0 }
    const down = (e: PointerEvent) => {
      touched = true
      canvas.setPointerCapture(e.pointerId)
      moved = false; last = { x: e.clientX, y: e.clientY }
      drag = pick(e); pan = !drag
      if (drag) { drag.fx = drag.x; drag.fy = drag.y; sim.alphaTarget(0.3).restart() }
    }
    const move = (e: PointerEvent) => {
      if (drag) {
        const p = world(e); drag.fx = p.x; drag.fy = p.y; moved = true
      } else if (pan) {
        view.x += e.clientX - last.x; view.y += e.clientY - last.y; moved = true; schedule()
      } else {
        const h2 = pick(e)
        if (h2 !== hover) { hover = h2; canvas.style.cursor = h2 ? "pointer" : "grab"; schedule() }
      }
      last = { x: e.clientX, y: e.clientY }
    }
    const up = () => {
      if (drag) { if (!moved) { selId = drag.id; onSelect(drag) } drag.fx = null; drag.fy = null; sim.alphaTarget(0) }
      else if (!moved) { selId = null; onSelect(null) }
      schedule()
      drag = null; pan = false
    }
    const wheel = (e: WheelEvent) => {
      touched = true
      e.preventDefault()
      const p = world(e), k = Math.min(6, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0015)))
      const r = canvas.getBoundingClientRect()
      view.k = k
      view.x = e.clientX - r.left - w / 2 - p.x * k
      view.y = e.clientY - r.top - h / 2 - p.y * k
      schedule()
    }
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move)
    canvas.addEventListener("pointerup", up); canvas.addEventListener("wheel", wheel, { passive: false })
    return () => {
      sim.stop(); ro.disconnect(); cancelAnimationFrame(raf)
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move)
      canvas.removeEventListener("pointerup", up); canvas.removeEventListener("wheel", wheel)
    }
  }, [data])

  return <canvas ref={ref} role="img" aria-label={`Memory graph with ${data.nodes.length} memories. Drag to pan, scroll to zoom, click a node for details.`} className="block h-full w-full cursor-grab touch-none" />
}

export function GraphPage() {
  const q = useQuery({ queryKey: ["graph"], queryFn: () => api.graph(300) })
  const [sel, setSel] = useState<N | null>(null)
  return (
    <>
      <PageTitle title="Memory graph" sub="Facts and document chunks the brain remembers, linked by similarity." />
      <Async q={q}>
        {(g) =>
          g.nodes.length === 0 ? <Empty>No memories yet. Chat with the bot in Slack or upload documents.</Empty> : (
            <div className="relative h-[calc(100dvh-14rem)] min-h-96 overflow-hidden rounded-xl border border-line bg-surface">
              <Canvas data={g} onSelect={setSel} />
              <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2 text-xs">
                <Badge className="bg-bg/80"><i className="mr-1.5 inline-block size-2 rounded-full" style={{ background: COLORS.shared }} />shared</Badge>
                <Badge className="bg-bg/80"><i className="mr-1.5 inline-block size-2 rounded-full" style={{ background: COLORS.channel }} />channel</Badge>
                <Badge className="bg-bg/80"><i className="mr-1.5 inline-block size-2 rounded-full" style={{ background: COLORS.user }} />user</Badge>
                <Badge className="bg-bg/80">{g.nodes.length} nodes, {g.edges.length} links</Badge>
              </div>
              {sel && (
                <aside className="absolute inset-x-3 bottom-3 rounded-lg border border-line bg-bg/95 p-3 text-sm shadow-lg sm:left-auto sm:w-80">
                  <div className="mb-1 flex items-center gap-2"><Badge tone="primary">{sel.scope}</Badge><Badge>{sel.kind}</Badge>
                    <button className="ml-auto text-muted hover:text-fg" aria-label="Close details" onClick={() => setSel(null)}>x</button></div>
                  <p>{sel.label}</p>
                </aside>
              )}
            </div>
          )}
      </Async>
    </>
  )
}
