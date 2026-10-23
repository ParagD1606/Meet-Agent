import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { Icon, type IconName } from "@/lib/icons"
import { Button } from "./button"

type Kind = "success" | "error" | "info"
interface Toast { id: number; kind: Kind; title: string; body?: string; ms: number }
const Ctx = createContext<{ push: (t: { kind?: Kind; title: string; body?: string; ms?: number }) => void }>({ push: () => {} })
export const useToast = () => useContext(Ctx)

const ICON: Record<Kind, IconName> = { success: "success", error: "error", info: "info" }
const TONE: Record<Kind, string> = { success: "text-ok", error: "text-danger", info: "text-accent" }

function Item({ t, close }: { t: Toast; close: () => void }) {
  const [paused, setPaused] = useState(false)
  const left = useRef(t.ms)
  useEffect(() => {
    if (paused || t.ms === 0) return
    const start = Date.now()
    const h = setTimeout(close, left.current)
    return () => { clearTimeout(h); left.current -= Date.now() - start }
  }, [paused, close, t.ms])
  return (
    <div role={t.kind === "error" ? "alert" : "status"} className="pointer-events-auto flex w-[min(360px,calc(100vw-32px))] items-start gap-3 rounded-lg border border-line bg-surface p-3 shadow-[var(--shadow-md)]" style={{ animation: "slide-in 150ms var(--ease)" }}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <Icon name={ICON[t.kind]} size={18} className={`mt-0.5 shrink-0 ${TONE[t.kind]}`} />
      <div className="min-w-0 flex-1"><div className="text-sm font-medium">{t.title}</div>{t.body && <div className="mt-0.5 break-words text-xs text-muted">{t.body}</div>}</div>
      <Button variant="ghost" size="sm" icon="x" aria-label="Dismiss" className="-mr-1 -mt-1" onClick={close} />
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback((t: { kind?: Kind; title: string; body?: string; ms?: number }) => {
    const kind = t.kind ?? "info"
    setItems((s) => [...s.slice(-3), { id: ++seq.current, kind, title: t.title, body: t.body, ms: t.ms ?? (kind === "error" ? 8000 : 4000) }])
  }, [])
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 flex flex-col items-end gap-2 max-md:bottom-[72px] max-md:right-4" style={{ zIndex: "var(--z-toast)" }} aria-live="polite">
        {items.map((t) => <Item key={t.id} t={t} close={() => setItems((s) => s.filter((x) => x.id !== t.id))} />)}
      </div>
    </Ctx.Provider>
  )
}
