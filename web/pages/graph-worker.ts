// Force layout off the main thread. Protocol:
//   in : { type: "init", n, edges: Int32Array (pairs of node indexes), radius: Float32Array, pos?: Float32Array (warm start; NaN = unknown) }
//   out: { type: "pos", pos: Float32Array (x0,y0,x1,y1...), alpha, done }
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationNodeDatum } from "d3-force"

type N = SimulationNodeDatum & { r: number }
let sim: Simulation<N, undefined> | null = null
let timer: ReturnType<typeof setTimeout> | null = null

self.onmessage = (e: MessageEvent) => {
  const m = e.data
  if (m.type !== "init") return
  if (timer) clearTimeout(timer)
  sim?.stop()
  const { n, edges, radius, pos } = m as { n: number; edges: Int32Array; radius: Float32Array; pos?: Float32Array }
  const nodes: N[] = Array.from({ length: n }, (_, i) => {
    const x = pos?.[2 * i], y = pos?.[2 * i + 1]
    return x !== undefined && !Number.isNaN(x) ? { x, y: y!, r: radius[i]! } : { r: radius[i]! }
  })
  const links = Array.from({ length: edges.length / 2 }, (_, i) => ({ source: edges[2 * i]!, target: edges[2 * i + 1]! }))
  const warm = !!pos && pos.some((v) => !Number.isNaN(v))
  sim = forceSimulation<N>(nodes)
    .force("link", forceLink<N, { source: number; target: number }>(links).distance(26).strength(0.35).iterations(1))
    .force("charge", forceManyBody<N>().strength(-24).theta(0.95).distanceMax(260))
    .force("center", forceCenter(0, 0).strength(0.04))
    .force("collide", forceCollide<N>((d) => d.r + 1.2).iterations(1))
    .alpha(warm ? 0.35 : 1).alphaDecay(0.04).stop()

  const out = new Float32Array(2 * n)
  let ticks = 0
  const step = () => {
    const t0 = performance.now()
    // run as many ticks as fit in ~24ms so the main thread gets frequent updates
    do { sim!.tick(); ticks++ } while (performance.now() - t0 < 24 && sim!.alpha() > sim!.alphaMin())
    const done = sim!.alpha() <= sim!.alphaMin() || ticks > 600
    for (let i = 0; i < n; i++) { out[2 * i] = nodes[i]!.x ?? 0; out[2 * i + 1] = nodes[i]!.y ?? 0 }
    ;(self as unknown as Worker).postMessage({ type: "pos", pos: out.slice(), alpha: sim!.alpha(), done })
    if (!done) timer = setTimeout(step, 0)
  }
  step()
}
