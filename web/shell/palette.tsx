import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation } from "wouter"
import { Icon, type IconName } from "@/lib/icons"
import { setThemePref } from "@/lib/hooks"
import { Dialog } from "@/ui/dialog"
import { NAV } from "./nav"

interface Cmd { id: string; label: string; hint?: string; icon: IconName; run: () => void; kw?: string }

export function Palette({ open, onClose, admin, onShortcuts, onSignOut }: { open: boolean; onClose: () => void; admin: boolean; onShortcuts: () => void; onSignOut: () => void }) {
  const [, nav] = useLocation()
  const [q, setQ] = useState("")
  const [i, setI] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => { if (open) { setQ(""); setI(0) } }, [open])

  const cmds = useMemo<Cmd[]>(() => {
    const go = (to: string) => () => nav(to)
    const base: Cmd[] = NAV.filter((n) => admin || !n.admin).map((n) => ({ id: n.to, label: n.label, hint: n.keys ? `g ${n.keys}` : n.group, icon: n.icon, run: go(n.to), kw: `${n.group} ${n.kw ?? ""}` }))
    return [...base,
      { id: "t-system", label: "Theme: system", icon: "monitor", run: () => setThemePref("system"), kw: "appearance" },
      { id: "t-light", label: "Theme: light", icon: "sun", run: () => setThemePref("light"), kw: "appearance" },
      { id: "t-dark", label: "Theme: dark", icon: "moon", run: () => setThemePref("dark"), kw: "appearance" },
      { id: "keys", label: "Keyboard shortcuts", hint: "?", icon: "command", run: onShortcuts },
      { id: "out", label: "Sign out", icon: "logout", run: onSignOut },
    ]
  }, [admin, nav, onShortcuts, onSignOut])

  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    const m = s ? cmds.filter((c) => `${c.label} ${c.kw ?? ""}`.toLowerCase().includes(s)) : cmds
    return s ? [...m, { id: "search", label: `Search memories for “${q.trim()}”`, icon: "search" as IconName, run: () => nav(`/memories?q=${encodeURIComponent(q.trim())}`) }] : m
  }, [q, cmds, nav])
  useEffect(() => setI(0), [q])
  useEffect(() => { listRef.current?.children[i]?.scrollIntoView({ block: "nearest" }) }, [i])

  const exec = (c?: Cmd) => { if (!c) return; onClose(); setTimeout(c.run, 0) }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(results.length - 1, x + 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)) }
    else if (e.key === "Enter") { e.preventDefault(); exec(results[i]) }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Command palette" width={560} bare>
      <div className="flex items-center gap-2 border-b border-line px-4">
        <Icon name="search" className="text-subtle" />
        <input autoFocus role="combobox" aria-expanded aria-controls="pal-list" aria-activedescendant={results[i] ? `pal-${results[i]!.id}` : undefined} aria-label="Search commands and pages" placeholder="Jump to a page or run a command" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} className="h-12 flex-1 border-0 bg-transparent text-base outline-none placeholder:text-subtle" />
        <span className="kbd">esc</span>
      </div>
      <ul id="pal-list" role="listbox" ref={listRef} className="max-h-[50dvh] overflow-y-auto p-1.5">
        {results.map((c, k) => (
          <li key={c.id} id={`pal-${c.id}`} role="option" aria-selected={k === i} onMouseMove={() => setI(k)} onClick={() => exec(c)}
            className={`flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-3 text-sm ${k === i ? "bg-hover" : ""}`}>
            <Icon name={c.icon} className="text-muted" /><span className="flex-1 truncate">{c.label}</span>{c.hint && <span className="text-xs text-subtle">{c.hint}</span>}
          </li>
        ))}
        {!results.length && <li className="px-3 py-6 text-center text-sm text-muted">No matches</li>}
      </ul>
    </Dialog>
  )
}

const ROWS: [string, string[]][] = [
  ["Open command palette", ["⌘", "K"]], ["Show this sheet", ["?"]], ["Focus search on the page", ["/"]],
  ["Go to Home", ["g", "h"]], ["Go to Graph", ["g", "g"]], ["Go to Memories", ["g", "m"]], ["Go to Core memory", ["g", "c"]],
  ["Go to Review queue", ["g", "r"]], ["Go to Skills", ["g", "s"]], ["Go to Automations", ["g", "a"]], ["Go to Integrations", ["g", "i"]],
  ["Go to Turns", ["g", "t"]], ["Go to Usage & limits", ["g", "u"]], ["Close panel or dialog", ["esc"]],
]
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={460}>
      <ul className="divide">
        {ROWS.map(([l, k]) => (
          <li key={l} className="flex items-center justify-between py-2 text-sm"><span>{l}</span><span className="flex gap-1">{k.map((x, n) => <span key={n} className="kbd">{x}</span>)}</span></li>
        ))}
      </ul>
    </Dialog>
  )
}
