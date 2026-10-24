// A drifting network of "memories" that connects nearby nodes, leans toward the pointer and sends pulses along its links.
import { reduced } from "./motion"

type Node = { x: number; y: number; vx: number; vy: number; r: number; h: number }
type Pulse = { a: number; b: number; t: number; s: number }

export function mountNeural(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d")
  if (!ctx) return () => {}
  let w = 0, h = 0, dpr = 1, raf = 0, visible = true
  const mouse = { x: -9999, y: -9999, on: false }
  let nodes: Node[] = []
  const pulses: Pulse[] = []
  const LINK = 140

  const seed = () => {
    const n = Math.min(95, Math.max(28, Math.round((w * h) / 15000)))
    nodes = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.28, vy: (Math.random() - 0.5) * 0.28, r: Math.random() * 1.8 + 0.8, h: Math.random() }))
  }
  const resize = () => {
    const r = canvas.getBoundingClientRect()
    dpr = Math.min(2, window.devicePixelRatio || 1)
    w = r.width; h = r.height
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    seed()
  }
  const mix = (t: number) => `${Math.round(45 + (139 - 45) * t)}, ${Math.round(212 + (92 - 212) * t)}, ${Math.round(191 + (246 - 191) * t)}`

  const frame = () => {
    raf = requestAnimationFrame(frame)
    if (!visible || document.hidden) return
    ctx.clearRect(0, 0, w, h)
    for (const n of nodes) {
      if (mouse.on) {
        const dx = mouse.x - n.x, dy = mouse.y - n.y, d = Math.hypot(dx, dy)
        if (d < 190 && d > 1) { n.vx += (dx / d) * 0.012; n.vy += (dy / d) * 0.012 }
      }
      n.vx *= 0.995; n.vy *= 0.995
      n.x += n.vx; n.y += n.vy
      if (n.x < -20) n.x = w + 20; else if (n.x > w + 20) n.x = -20
      if (n.y < -20) n.y = h + 20; else if (n.y > h + 20) n.y = -20
    }
    ctx.lineWidth = 1
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!, d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d < LINK) { ctx.strokeStyle = `rgba(${mix((a.h + b.h) / 2)}, ${(1 - d / LINK) * 0.38})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke() }
      }
    }
    if (pulses.length < 7 && Math.random() < 0.05) {
      const a = Math.floor(Math.random() * nodes.length), A = nodes[a]!
      const b = nodes.findIndex((n, i) => i !== a && Math.hypot(A.x - n.x, A.y - n.y) < LINK)
      if (b >= 0) pulses.push({ a, b, t: 0, s: 0.012 + Math.random() * 0.012 })
    }
    for (let k = pulses.length - 1; k >= 0; k--) {
      const p = pulses[k]!, A = nodes[p.a]!, B = nodes[p.b]!
      p.t += p.s
      if (p.t >= 1) { pulses.splice(k, 1); continue }
      const x = A.x + (B.x - A.x) * p.t, y = A.y + (B.y - A.y) * p.t
      const g = ctx.createRadialGradient(x, y, 0, x, y, 12)
      g.addColorStop(0, "rgba(255,255,255,.95)"); g.addColorStop(0.3, `rgba(${mix(A.h)}, .6)`); g.addColorStop(1, "rgba(45,212,191,0)")
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 12, 0, 6.283); ctx.fill()
    }
    for (const n of nodes) {
      const near = mouse.on ? Math.max(0, 1 - Math.hypot(mouse.x - n.x, mouse.y - n.y) / 180) : 0
      ctx.fillStyle = `rgba(${mix(n.h)}, ${0.55 + near * 0.45})`
      ctx.shadowColor = `rgba(${mix(n.h)}, .9)`; ctx.shadowBlur = 8 + near * 16
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + near * 2.2, 0, 6.283); ctx.fill()
    }
    ctx.shadowBlur = 0
  }

  const move = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.on = true }
  const leave = () => { mouse.on = false }
  const ro = new ResizeObserver(resize); ro.observe(canvas)
  const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting }); io.observe(canvas)
  window.addEventListener("pointermove", move); document.addEventListener("pointerleave", leave)
  resize()
  if (reduced()) { frame(); cancelAnimationFrame(raf) } else raf = requestAnimationFrame(frame)
  return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); window.removeEventListener("pointermove", move); document.removeEventListener("pointerleave", leave) }
}
