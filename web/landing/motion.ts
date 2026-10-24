import gsap from "gsap"

export const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
const fine = () => matchMedia("(hover: hover) and (pointer: fine)").matches

type Cleanup = () => void
const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window | Document, ev: string, fn: (e: any) => void, o?: AddEventListenerOptions): Cleanup => {
  el.addEventListener(ev, fn, o)
  return () => el.removeEventListener(ev, fn, o)
}

/** Buttons lean toward the pointer, then spring back. */
export function magnetic(root: HTMLElement): Cleanup {
  if (!fine()) return () => {}
  const offs: Cleanup[] = []
  root.querySelectorAll<HTMLElement>("[data-magnetic]").forEach((el) => {
    const inner = el.querySelector<HTMLElement>(".in") ?? el
    const strength = Number(el.dataset.magnetic) || 0.35
    offs.push(on(el, "pointermove", (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2)
      gsap.to(el, { x: dx * strength, y: dy * strength, duration: 0.4, ease: "power3.out" })
      gsap.to(inner, { x: dx * strength * 0.45, y: dy * strength * 0.45, duration: 0.4, ease: "power3.out" })
    }))
    offs.push(on(el, "pointerleave", () => {
      gsap.to([el, inner], { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.4)" })
    }))
  })
  return () => offs.forEach((f) => f())
}

/** Cards get a pointer-following spotlight and a gentle 3D tilt. */
export function spotlightTilt(root: HTMLElement): Cleanup {
  const offs: Cleanup[] = []
  root.querySelectorAll<HTMLElement>("[data-spot]").forEach((el) => {
    const tilt = fine() && el.hasAttribute("data-tilt")
    offs.push(on(el, "pointermove", (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
      el.style.setProperty("--mx", `${x * 100}%`); el.style.setProperty("--my", `${y * 100}%`)
      if (tilt) gsap.to(el, { rotateY: (x - 0.5) * 9, rotateX: (0.5 - y) * 9, transformPerspective: 900, duration: 0.5, ease: "power2.out" })
    }))
    offs.push(on(el, "pointerleave", () => { if (tilt) gsap.to(el, { rotateX: 0, rotateY: 0, duration: 0.8, ease: "elastic.out(1, 0.5)" }) }))
  })
  return () => offs.forEach((f) => f())
}

/** A dot and a ring that trail the pointer; the ring swells over anything clickable. */
export function cursor(root: HTMLElement): Cleanup {
  const dot = root.querySelector<HTMLElement>(".cur-dot"), ring = root.querySelector<HTMLElement>(".cur-ring")
  if (!dot || !ring || !fine()) return () => {}
  const dx = gsap.quickTo(dot, "x", { duration: 0.08, ease: "power3" }), dy = gsap.quickTo(dot, "y", { duration: 0.08, ease: "power3" })
  const rx = gsap.quickTo(ring, "x", { duration: 0.45, ease: "power3" }), ry = gsap.quickTo(ring, "y", { duration: 0.45, ease: "power3" })
  const offs: Cleanup[] = []
  offs.push(on(window, "pointermove", (e: PointerEvent) => {
    gsap.to([dot, ring], { opacity: 1, duration: 0.3, overwrite: "auto" })
    dx(e.clientX); dy(e.clientY); rx(e.clientX); ry(e.clientY)
    ring.classList.toggle("hot", !!(e.target as HTMLElement | null)?.closest?.("a, button, [data-hot]"))
  }))
  offs.push(on(document, "pointerleave", () => gsap.to([dot, ring], { opacity: 0, duration: 0.3 })))
  return () => offs.forEach((f) => f())
}

/** A small burst of coloured dots from an element: used on the big call to action. */
export function burst(origin: HTMLElement, root: HTMLElement) {
  if (reduced()) return
  const r = origin.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2
  const colors = ["#2dd4bf", "#22d3ee", "#8b5cf6", "#f472b6", "#fbbf24"]
  for (let i = 0; i < 26; i++) {
    const p = document.createElement("i")
    p.className = "particle"; p.style.background = colors[i % colors.length]!; p.style.left = `${cx}px`; p.style.top = `${cy}px`
    root.appendChild(p)
    const a = Math.random() * Math.PI * 2, d = 70 + Math.random() * 150
    gsap.to(p, { x: Math.cos(a) * d, y: Math.sin(a) * d + 30, scale: Math.random() * 1.4 + 0.3, opacity: 0, duration: 0.9 + Math.random() * 0.6, ease: "power3.out", onComplete: () => p.remove() })
  }
}
