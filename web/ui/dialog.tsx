import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"
import { Button } from "./button"
import { cn } from "./cn"

/** Native <dialog>: focus trap, Esc, inert background and top layer come from the platform. */
export function Dialog({ open, onClose, title, description, children, footer, width = 480, height, sheet, bare }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; width?: number; height?: number; sheet?: boolean; bare?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const d = ref.current!
    if (open && !d.open) { d.showModal(); requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 })) }
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={cn("dlg", Boolean(height) && "dlg-fixed", sheet && "sheet")}
      style={{ ["--w" as string]: `${width}px`, ...(height ? { ["--h" as string]: `${height}px` } : {}) }}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
    >
      {open && bare && children}
      {open && !bare && (
        <>
          <div className="shrink-0 flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div><h2 className="text-lg">{title}</h2>{description && <p className="mt-0.5 text-sm text-muted">{description}</p>}</div>
            <Button variant="ghost" size="sm" icon="x" aria-label="Close" onClick={onClose} />
          </div>
          <div ref={bodyRef} className={cn("overflow-y-auto px-5 py-4", Boolean(height) && "min-h-0 flex-1")}>{children}</div>
          {footer && <div className="shrink-0 flex justify-end gap-2 border-t border-line bg-sunken px-5 py-3">{footer}</div>}
        </>
      )}
    </dialog>
  )
}
// ---- imperative confirm(), rendered once by <ConfirmHost/> ----
interface Ask { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (ok: boolean) => void }
let ask: Ask | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
export function confirmDialog(o: Omit<Ask, "resolve">): Promise<boolean> {
  return new Promise((resolve) => { ask?.resolve(false); ask = { ...o, resolve }; emit() })
}
export function ConfirmHost() {
  const cur = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => ask)
  const done = (ok: boolean) => { cur?.resolve(ok); ask = null; emit() }
  return (
    <Dialog open={!!cur} onClose={() => done(false)} title={cur?.title ?? ""} width={420}
      footer={<><Button onClick={() => done(false)}>Cancel</Button><Button variant={cur?.danger ? "danger-solid" : "primary"} onClick={() => done(true)}>{cur?.confirmLabel ?? "Confirm"}</Button></>}>
      {cur?.body && <div className="text-sm text-muted">{cur.body}</div>}
    </Dialog>
  )
}
