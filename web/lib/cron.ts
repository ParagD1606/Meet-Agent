// Minimal 5-field cron: validation, plain-English summary and next-run computation (local time).
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

export interface Parsed { sets: Set<number>[]; star: boolean[]; raw: string[] }

function field(src: string, [lo, hi]: [number, number], dow: boolean): Set<number> {
  const out = new Set<number>()
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/")
    const step = stepS === undefined ? 1 : Number(stepS)
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step "${part}"`)
    let a = lo, b = hi
    if (range !== "*") {
      const [x, y] = range!.split("-")
      a = Number(x); b = y === undefined ? (stepS === undefined ? a : hi) : Number(y)
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`Bad value "${part}"`)
    }
    if (dow) { if (a === 7) a = 0; if (b === 7 && a !== 0) b = 6 }
    if (a < lo || b > hi || a > b) throw new Error(`"${part}" is outside ${lo}-${hi}`)
    for (let i = a; i <= b; i += step) out.add(i)
  }
  return out
}

export function parseCron(expr: string): Parsed {
  const p = expr.trim().split(/\s+/)
  if (p.length !== 5) throw new Error("Use 5 fields: minute hour day month weekday")
  return { sets: p.map((s, i) => field(s, RANGES[i]!, i === 4)), star: p.map((s) => s === "*"), raw: p }
}

export function nextRuns(expr: string, n = 3, from = new Date()): Date[] {
  const c = parseCron(expr)
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1)
  const out: Date[] = []
  const end = from.getTime() + 400 * 864e5
  while (out.length < n && d.getTime() < end) {
    const domOk = c.sets[2]!.has(d.getDate()), dowOk = c.sets[4]!.has(d.getDay())
    const dayOk = c.star[2] || c.star[4] ? domOk && dowOk : domOk || dowOk // standard cron OR semantics
    if (!c.sets[3]!.has(d.getMonth() + 1) || !dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue }
    if (!c.sets[1]!.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue }
    if (!c.sets[0]!.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue }
    out.push(new Date(d)); d.setMinutes(d.getMinutes() + 1)
  }
  return out
}

const two = (n: number) => String(n).padStart(2, "0")
const time = (h: number, m: number) => { const hh = h % 12 || 12; return `${hh}:${two(m)} ${h < 12 ? "AM" : "PM"}` }
const isNum = (s: string) => /^\d+$/.test(s)

export function describeCron(expr: string): string {
  let c: Parsed
  try { c = parseCron(expr) } catch (e) { return e instanceof Error ? e.message : "Invalid schedule" }
  const [mi, h, dom, mon, dow] = c.raw as [string, string, string, string, string]
  let when: string
  if (mi.startsWith("*/") && h === "*") when = `Every ${mi.slice(2)} minutes`
  else if (mi === "*" && h === "*") when = "Every minute"
  else if (isNum(mi) && h === "*") when = mi === "0" ? "Every hour" : `Every hour at minute ${Number(mi)}`
  else if (isNum(mi) && h.startsWith("*/")) when = `Every ${h.slice(2)} hours at minute ${Number(mi)}`
  else if (isNum(mi) && isNum(h)) when = `At ${time(Number(h), Number(mi))}`
  else when = `At minute ${mi}, hour ${h}`
  const parts: string[] = []
  if (dow !== "*") {
    const s = [...c.sets[4]!].sort()
    parts.push(s.join() === "1,2,3,4,5" ? "on weekdays" : s.join() === "0,6" ? "on weekends" : `on ${s.map((d) => DOW[d]).join(", ")}`)
  }
  if (dom !== "*") parts.push(`on day ${[...c.sets[2]!].join(", ")} of the month`)
  if (mon !== "*") parts.push(`in ${[...c.sets[3]!].map((m) => MON[m - 1]).join(", ")}`)
  if (!parts.length && (isNum(mi) && isNum(h))) return `${when}, every day`
  return [when, ...parts].join(" ")
}
