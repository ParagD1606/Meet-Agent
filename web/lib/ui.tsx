import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query"

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ")

// ---------- toasts ----------
type ToastFn = (msg: string, kind?: "ok" | "error") => void
const ToastCtx = createContext<ToastFn>(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: string }[]>([])
  const push: ToastFn = (msg, kind = "ok") => {
    const id = Date.now() + Math.random()
    setItems((s) => [...s, { id, msg, kind }])
    setTimeout(() => setItems((s) => s.filter((i) => i.id !== id)), 5000)
  }
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((i) => (
          <div key={i.id} className={cn("rounded-lg border bg-surface px-4 py-2 text-sm shadow-lg", i.kind === "error" ? "border-danger text-danger" : "border-line")}>{i.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/** Mutation that toasts errors/success and invalidates the given query keys. */
export function useAction<A, R = unknown>(fn: (a: A) => Promise<R>, opts: { invalidate?: QueryKey[]; ok?: string; onSuccess?: (r: R) => void } = {}) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k })
      if (opts.ok) toast(opts.ok)
      opts.onSuccess?.(r)
    },
    onError: (e: Error) => toast(e.message, "error"),
  })
}

// ---------- primitives ----------
const btn = {
  primary: "bg-primary text-primary-fg hover:opacity-90",
  secondary: "border border-line bg-surface hover:bg-raised",
  ghost: "hover:bg-raised",
  danger: "border border-danger/50 text-danger hover:bg-danger/10",
}
export function Button({ variant = "secondary", size = "md", className, type = "button", ...p }: ComponentProps<"button"> & { variant?: keyof typeof btn; size?: "sm" | "md" }) {
  return <button type={type} className={cn("inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition disabled:pointer-events-none disabled:opacity-50", size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-4 text-sm", btn[variant], className)} {...p} />
}
export const LinkButton = ({ className, ...p }: ComponentProps<"a">) => (
  <a className={cn("inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-fg hover:opacity-90", className)} {...p} />
)

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted disabled:opacity-60"
export const Input = ({ className, ...p }: ComponentProps<"input">) => <input className={cn(field, "h-9", className)} {...p} />
export const Textarea = ({ className, ...p }: ComponentProps<"textarea">) => <textarea className={cn(field, className)} {...p} />
export const Select = ({ className, ...p }: ComponentProps<"select">) => <select className={cn(field, "h-9", className)} {...p} />

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children(id)}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  )
}

export const Card = ({ className, ...p }: ComponentProps<"div">) => <div className={cn("rounded-xl border border-line bg-surface p-4", className)} {...p} />

const tone = { neutral: "bg-raised text-muted", ok: "bg-ok/15 text-ok", warn: "bg-warn/15 text-warn", danger: "bg-danger/15 text-danger", primary: "bg-primary/15 text-primary" }
export const Badge = ({ tone: t = "neutral", className, ...p }: ComponentProps<"span"> & { tone?: keyof typeof tone }) => (
  <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", tone[t], className)} {...p} />
)

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
      <span className="size-4 animate-spin rounded-full border-2 border-line border-t-primary" aria-hidden />
      {label}…
    </div>
  )
}
export const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-xl border border-dashed border-line py-10 text-center text-sm text-muted">{children}</p>
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-danger/40 py-8 text-center text-sm">
      <p className="text-danger">{error instanceof Error ? error.message : "Something went wrong"}</p>
      {retry && <Button size="sm" onClick={retry}>Try again</Button>}
    </div>
  )
}

/** Renders loading / error / empty / data for a react-query result. */
export function Async<T>({ q, empty, children }: { q: { data?: T; isPending: boolean; error: unknown; refetch: () => unknown }; empty?: ReactNode; children: (d: T) => ReactNode }) {
  if (q.isPending) return <Spinner />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const d = q.data as T
  if (empty && Array.isArray(d) && d.length === 0) return <Empty>{empty}</Empty>
  return <>{children(d)}</>
}

export function PageTitle({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-sm text-muted">{sub}</p>}
      </div>
      {action}
    </div>
  )
}

/** Native <dialog> modal: focus trap, Esc and a11y for free. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label={title}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-fg backdrop:bg-black/60">
      {open && (
        <div className="p-5">
          <h2 className="mb-4 text-base font-semibold">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  )
}

export function Confirm({ open, title, body, action, onYes, onClose }: { open: boolean; title: string; body: string; action: string; onYes: () => void; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="mb-5 text-sm text-muted">{body}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={() => { onYes(); onClose() }}>{action}</Button>
      </div>
    </Modal>
  )
}

export const ago = (d?: string | null) => {
  if (!d) return "never"
  const s = (Date.now() - new Date(d).getTime()) / 1000
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
