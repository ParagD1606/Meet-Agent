export function ago(iso?: string | null, now = Date.now()): string {
  if (!iso) return "never"
  const s = Math.round((now - new Date(iso).getTime()) / 1000)
  if (s < 0) return inFuture(-s)
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}
function inFuture(s: number) { const m = Math.round(s / 60); return m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d` }
export const dateShort = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "")
export const dateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "")
export const num = (n?: number | null) => (n == null ? "-" : n.toLocaleString())
export const compact = (n?: number | null) => (n == null ? "-" : Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n))
/** costMicros = millionths of a dollar. */
export const usd = (micros?: number | null) => {
  if (micros == null) return "-"
  const d = micros / 1e6
  return d >= 100 ? `$${d.toFixed(0)}` : d >= 1 ? `$${d.toFixed(2)}` : d === 0 ? "$0.00" : `$${d.toFixed(d < 0.01 ? 4 : 3)}`
}
export const dur = (ms?: number | null) => (ms == null ? "-" : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`)
export const pct = (r?: number | null, digits = 0) => (r == null ? "-" : `${(r * 100).toFixed(digits)}%`)
export const plural = (n: number, w: string, p = w + "s") => `${n.toLocaleString()} ${n === 1 ? w : p}`
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`)
