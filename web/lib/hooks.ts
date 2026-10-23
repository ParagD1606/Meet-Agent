import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { confirmDialog } from "@/ui/dialog"

export const TITLE = "Company Brain"
export function useTitle(t?: string | null) {
  useEffect(() => { document.title = t ? `${t} · ${TITLE}` : TITLE }, [t])
}

export function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v)
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h) }, [v, ms])
  return d
}

// ---- theme: system | light | dark
export type ThemePref = "system" | "light" | "dark"
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null
const readPref = (): ThemePref => { try { const v = localStorage.getItem("theme-pref"); return v === "light" || v === "dark" ? v : "system" } catch { return "system" } }
let pref = readPref()
const themeSubs = new Set<() => void>()
function applyTheme() {
  const dark = pref === "dark" || (pref === "system" && !!mq?.matches)
  document.documentElement.dataset.theme = dark ? "dark" : "light"
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#16181b" : "#f6f7f9")
  themeSubs.forEach((f) => f())
}
mq?.addEventListener("change", applyTheme)
export const setThemePref = (p: ThemePref) => { pref = p; try { localStorage.setItem("theme-pref", p) } catch {} applyTheme() }
export function useTheme() {
  const p = useSyncExternalStore((f) => { themeSubs.add(f); return () => themeSubs.delete(f) }, () => pref)
  const resolved = useSyncExternalStore((f) => { themeSubs.add(f); return () => themeSubs.delete(f) }, () => document.documentElement.dataset.theme as string)
  return { pref: p, resolved, set: setThemePref }
}

// ---- dirty-state guard: blocks in-app navigation (async confirm) and tab close
const dirty = new Set<symbol>()
export function useDirtyGuard(isDirty: boolean) {
  const id = useRef(Symbol("dirty"))
  useEffect(() => {
    if (!isDirty) { dirty.delete(id.current); return }
    dirty.add(id.current)
    const h = (e: BeforeUnloadEvent) => { e.preventDefault() }
    addEventListener("beforeunload", h)
    return () => { dirty.delete(id.current); removeEventListener("beforeunload", h) }
  }, [isDirty])
}
export async function allowNavigation(): Promise<boolean> {
  if (!dirty.size) return true
  const ok = await confirmDialog({ title: "Discard unsaved changes?", body: "You have changes on this page that haven't been saved.", confirmLabel: "Discard", danger: true })
  if (ok) dirty.clear()
  return ok
}

// ---- keyboard shortcuts
export const isTyping = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)) }

export function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches)
  useEffect(() => { const l = matchMedia(q); const f = () => setM(l.matches); f(); l.addEventListener("change", f); return () => l.removeEventListener("change", f) }, [q])
  return m
}
