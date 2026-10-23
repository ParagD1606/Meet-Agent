import { useState } from "react"
const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h }
export function Avatar({ name, src, size = 24 }: { name: string; src?: string | null; size?: number }) {
  const [bad, setBad] = useState(false)
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"
  const dim = { width: size, height: size }
  if (src && !bad) return <img src={src} alt="" width={size} height={size} style={dim} className="shrink-0 rounded-full object-cover" onError={() => setBad(true)} />
  return (
    <span aria-hidden style={{ ...dim, fontSize: size * 0.42, background: `oklch(0.9 0.04 ${hue(name)})`, color: `oklch(0.35 0.07 ${hue(name)})` }} className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold">{initials}</span>
  )
}
