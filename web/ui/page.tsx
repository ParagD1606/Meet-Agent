import type { UseQueryResult } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { errMsg } from "@/lib/api"
import { Icon } from "@/lib/icons"
import { Button } from "./button"
import { EmptyState } from "./empty"
import { SkeletonRows } from "./skeleton"
import { useToast } from "./toast"
import { cn } from "./cn"

export function PageHeader({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0"><h1 className="text-xl">{title}</h1>{desc && <p className="mt-1 max-w-2xl text-sm text-muted">{desc}</p>}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Section({ title, desc, actions, children, className }: { title?: string; desc?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-8", className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>{title && <h2 className="text-base">{title}</h2>}{desc && <p className="mt-0.5 text-sm text-muted">{desc}</p>}</div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

/** Bordered list/table container: the one flat "surface" used for data. */
export const Panel = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cn("surface overflow-hidden", className)}>{children}</div>

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <EmptyState icon="alert" title="Couldn't load this" action={retry && <Button onClick={retry}>Retry</Button>}>{errMsg(error)}</EmptyState>
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <div role="status" aria-label={label} className="flex min-h-[40vh] items-center justify-center text-subtle"><Icon name="loader" size={20} className="spin" /></div>
}

/** Query wrapper: skeleton while loading, inline error with retry, else children(data). */
export function Async<T>({ q, children, rows = 6, skeleton }: { q: Pick<UseQueryResult<T>, "data" | "isPending" | "error" | "refetch">; children: (d: T) => ReactNode; rows?: number; skeleton?: ReactNode }) {
  if (q.isPending) return <>{skeleton ?? <Panel><SkeletonRows rows={rows} /></Panel>}</>
  if (q.error) return <Panel><ErrorState error={q.error} retry={() => q.refetch()} /></Panel>
  return <>{children(q.data as T)}</>
}

export function CopyButton({ text, label = "Copy", size = "sm" }: { text: string; label?: string; size?: "sm" | "md" }) {
  const [done, setDone] = useState(false)
  const toast = useToast()
  return (
    <Button size={size} icon={done ? "check" : "copy"} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) } catch { toast.push({ kind: "error", title: "Couldn't copy", body: "Select the text and copy it manually." }) }
    }}>{done ? "Copied" : label}</Button>
  )
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  )
}

export function Meter({ value, max, warnAt = 0.9, label }: { value: number; max: number; warnAt?: number; label?: string }) {
  const r = Math.min(1, value / max)
  return (
    <div role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label} className="h-1.5 w-full overflow-hidden rounded-full bg-sunken ring-1 ring-inset ring-line">
      <div className="h-full rounded-full transition-[width]" style={{ width: `${r * 100}%`, background: value > max ? "var(--danger)" : r >= warnAt ? "var(--c2)" : "var(--accent)", transitionDuration: "150ms" }} />
    </div>
  )
}
