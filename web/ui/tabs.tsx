import { useRef, type ReactNode } from "react"
import { cn } from "./cn"

export interface TabItem<T extends string> { id: T; label: ReactNode }

function useRoving<T extends string>(items: TabItem<T>[], value: T, onChange: (v: T) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = items.findIndex((t) => t.id === value)
    const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1
    if (n < 0) return
    e.preventDefault()
    const next = items[(n + items.length) % items.length]!
    onChange(next.id)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus())
  }
  return { ref, onKeyDown }
}

/** Underlined tabs (view switching inside a page). Roving tabindex, arrow keys. */
export function Tabs<T extends string>({ items, value, onChange, label }: { items: TabItem<T>[]; value: T; onChange: (v: T) => void; label: string }) {
  const r = useRoving(items, value, onChange)
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={r.ref} onKeyDown={r.onKeyDown}>
      {items.map((t) => (
        <button key={t.id} data-id={t.id} role="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  )
}

/** Segmented control (filter-style radio group). */
export function Segmented<T extends string>({ items, value, onChange, label, className }: { items: TabItem<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string }) {
  const r = useRoving(items, value, onChange)
  return (
    <div className={cn("seg", className)} role="radiogroup" aria-label={label} ref={r.ref} onKeyDown={r.onKeyDown}>
      {items.map((t) => (
        <button key={t.id} data-id={t.id} role="radio" aria-checked={t.id === value} tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  )
}
