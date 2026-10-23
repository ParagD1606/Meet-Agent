import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation } from "wouter"
import { api, type Me } from "@/lib/api"
import { isTyping, useTheme, type ThemePref } from "@/lib/hooks"
import { Icon, Logo } from "@/lib/icons"
import { Avatar } from "@/ui/avatar"
import { Button } from "@/ui/button"
import { Dialog } from "@/ui/dialog"
import { Menu, MenuItem, MenuLabel, MenuSep } from "@/ui/menu"
import { Tooltip } from "@/ui/tooltip"
import { GROUPS, NAV, navFor } from "./nav"
import { Palette, ShortcutsSheet } from "./palette"

const THEMES: { id: ThemePref; label: string; icon: "monitor" | "sun" | "moon" }[] = [
  { id: "system", label: "System", icon: "monitor" }, { id: "light", label: "Light", icon: "sun" }, { id: "dark", label: "Dark", icon: "moon" },
]

export function Shell({ me, admin, children }: { me: Me; admin: boolean; children: ReactNode }) {
  const [loc, nav] = useLocation()
  const qc = useQueryClient()
  const theme = useTheme()
  const [palette, setPalette] = useState(false)
  const [keys, setKeys] = useState(false)
  const [more, setMore] = useState(false)
  const items = NAV.filter((n) => admin || !n.admin)
  const cur = navFor(loc)

  const pending = useQuery({ queryKey: ["reviews", "pending"], queryFn: () => api.reviews("pending"), enabled: admin, refetchInterval: 60_000, retry: false })
  const pendingN = pending.data?.length ?? 0

  const signOut = useCallback(async () => {
    try { await fetch("/auth/logout", { method: "POST", headers: { "x-requested-with": "fetch" } }) } catch {}
    qc.clear(); qc.setQueryData(["me"], null)
  }, [qc])

  // Global shortcuts: ⌘K, ?, /, g <key>
  const gPending = useRef(0)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector("dialog[open]")) return
      if (e.key === "?") { e.preventDefault(); setKeys(true); return }
      if (e.key === "/") { const el = document.querySelector<HTMLElement>("[data-search]"); if (el) { e.preventDefault(); el.focus() } return }
      if (e.key === "g") { gPending.current = Date.now(); return }
      if (Date.now() - gPending.current < 1200) {
        const t = items.find((n) => n.keys === e.key)
        gPending.current = 0
        if (t) { e.preventDefault(); nav(t.to) }
      }
    }
    addEventListener("keydown", h)
    return () => removeEventListener("keydown", h)
  }, [items, nav])

  useEffect(() => { setMore(false) }, [loc])

  const navLinks = (big?: boolean) => (
    <>
      {GROUPS.map((g) => {
        const gi = items.filter((n) => n.group === g)
        if (!gi.length) return null
        return (
          <div key={g}>
            <div className="nav-group" id={`ng-${g}`}>{g}</div>
            <ul aria-labelledby={`ng-${g}`} className="flex flex-col gap-px">
              {gi.map((n) => (
                <li key={n.to}>
                  <Link href={n.to} className="nav-link" style={big ? { height: 44 } : undefined} aria-current={cur?.to === n.to ? "page" : undefined}>
                    <Icon name={n.icon} /><span className="flex-1 truncate">{n.label}</span>
                    {n.to === "/review" && pendingN > 0 && <span className="badge badge-accent tnum" aria-label={`${pendingN} pending`}>{pendingN}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )

  const userMenu = (up?: boolean) => (
    <Menu up={up} align="start" trigger={(p) => (
      <button {...p} className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-hover" aria-label="Account menu">
        <Avatar name={me.name} src={me.avatarUrl} size={24} />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium leading-4">{me.name}</span><span className="block text-xs capitalize leading-4 text-subtle">{me.role}</span></span>
        <Icon name="down" className="text-subtle" size={14} />
      </button>
    )}>
      {() => (
        <>
          <MenuLabel>Theme</MenuLabel>
          {THEMES.map((t) => <MenuItem key={t.id} icon={t.icon} checked={theme.pref === t.id} onSelect={() => theme.set(t.id)}>{t.label}</MenuItem>)}
          <MenuSep />
          <MenuItem icon="command" onSelect={() => setKeys(true)} trailing={<span className="kbd">?</span>}>Keyboard shortcuts</MenuItem>
          <MenuItem icon="logout" onSelect={signOut}>Sign out</MenuItem>
        </>
      )}
    </Menu>
  )

  return (
    <div className="shell">
      <a href="#main" className="sr-only-focusable btn btn-primary left-2 top-2" style={{ zIndex: "var(--z-toast)" }}>Skip to content</a>
      <aside className="sidebar" aria-label="Primary">
        <div className="mb-3 flex items-center gap-2 px-2 pt-0.5"><Logo size={20} /><span className="text-base font-semibold tracking-tight">Company Brain</span></div>
        <button onClick={() => setPalette(true)} className="mb-1 flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface px-2 text-sm text-subtle shadow-[var(--shadow-sm)] hover:text-fg">
          <Icon name="search" size={14} /><span className="flex-1 text-left">Search</span><span className="kbd">⌘K</span>
        </button>
        <nav className="flex-1">{navLinks()}</nav>
        <div className="mt-3 border-t border-line pt-2">{userMenu(true)}</div>
      </aside>

      <div className="min-w-0">
        <div className="sticky top-0 flex h-11 items-center justify-between gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur-sm md:px-6" style={{ zIndex: "var(--z-sticky)" }}>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <ol className="flex min-w-0 items-center gap-1.5">
              <li className="hidden text-muted md:block">{cur?.group ?? "Company Brain"}</li>
              {cur && cur.group !== "Overview" && <li aria-hidden className="hidden text-subtle md:block">/</li>}
              <li className="truncate font-medium" aria-current="page">{cur?.group === "Overview" ? "Home" : cur?.label ?? "Not found"}</li>
            </ol>
          </nav>
          <div className="md:hidden"><Tooltip text="Theme"><Button variant="ghost" size="sm" icon={theme.resolved === "dark" ? "moon" : "sun"} aria-label="Toggle theme" onClick={() => theme.set(theme.resolved === "dark" ? "light" : "dark")} /></Tooltip></div>
        </div>
        {children}
      </div>

      <nav className="bottombar" aria-label="Primary mobile">
        <Link href="/" aria-current={loc === "/" ? "page" : undefined}><Icon name="home" size={20} />Home</Link>
        <Link href="/graph" aria-current={loc === "/graph" ? "page" : undefined}><Icon name="graph" size={20} />Graph</Link>
        <Link href="/memories" aria-current={loc === "/memories" ? "page" : undefined}><Icon name="memory" size={20} />Memories</Link>
        <button onClick={() => setPalette(true)}><Icon name="search" size={20} />Search</button>
        <button onClick={() => setMore(true)} aria-haspopup="dialog"><Icon name="menu" size={20} />More</button>
      </nav>

      <Dialog open={more} onClose={() => setMore(false)} title="Menu" sheet>
        <nav aria-label="All pages">{navLinks(true)}</nav>
        <div className="mt-4 border-t border-line pt-3">{userMenu(true)}</div>
      </Dialog>
      <Palette open={palette} onClose={() => setPalette(false)} admin={admin} onShortcuts={() => setKeys(true)} onSignOut={signOut} />
      <ShortcutsSheet open={keys} onClose={() => setKeys(false)} />
    </div>
  )
}
