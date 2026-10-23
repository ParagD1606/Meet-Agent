import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Link, Redirect, Route, Switch, useLocation } from "wouter"
import { api } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Button, ErrorState, Spinner, cn } from "@/lib/ui"
import { Configure } from "@/pages/configure"
import { GraphPage } from "@/pages/graph"
import { Home } from "@/pages/home"
import { Memories } from "@/pages/memories"
import { Setup } from "@/pages/setup"
import { SignIn } from "@/pages/signin"
import { Turns } from "@/pages/turns"

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    try { localStorage.setItem("theme", dark ? "dark" : "light") } catch {}
  }, [dark])
  return [dark, () => setDark((d) => !d)] as const
}

export function App() {
  const { me, loading, error, refetch, admin } = useMe()
  const [loc] = useLocation()
  const [dark, toggle] = useTheme()
  // Public until a workspace exists; a 401 here just means "already configured".
  const setup = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus, retry: false, enabled: me === null })

  if (loading || (me === null && setup.isPending)) return <Spinner />
  if (error) return <div className="mx-auto max-w-md p-6"><ErrorState error={error} retry={() => refetch()} /></div>
  if (!me) {
    const s = setup.data
    const unconfigured = s && (!s.slack || s.workspace === false)
    return loc === "/setup" || unconfigured ? <Setup signedIn={false} /> : <SignIn />
  }

  const nav = [
    { to: "/", label: "Home" },
    { to: "/graph", label: "Graph" },
    { to: "/memories", label: "Memories" },
    { to: "/configure", label: "Configure" },
    ...(admin ? [{ to: "/turns", label: "Turns" }] : []),
  ]
  const active = (to: string) => (to === "/" ? loc === "/" : loc.startsWith(to))

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-1">Skip to content</a>
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <Link href="/" className="flex items-center gap-2 font-semibold"><span aria-hidden className="size-5 rounded-md bg-primary" />Company Brain</Link>
          <nav aria-label="Main" className="order-last -mx-1 flex w-full gap-1 overflow-x-auto px-1 sm:order-none sm:w-auto sm:flex-1">
            {nav.map((n) => (
              <Link key={n.to} href={n.to} aria-current={active(n.to) ? "page" : undefined}
                className={cn("rounded-lg px-3 py-1.5 text-sm", active(n.to) ? "bg-raised font-medium" : "text-muted hover:text-fg")}>{n.label}</Link>
            ))}
          </nav>
          <Button size="sm" variant="ghost" className="ml-auto sm:ml-0" onClick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? "Light" : "Dark"}</Button>
          <span className="hidden items-center gap-2 text-sm sm:flex">
            {me.avatarUrl && <img src={me.avatarUrl} alt="" className="size-6 rounded-full" />}
            <span className="max-w-32 truncate">{me.name}</span>
            <span className="rounded bg-raised px-1.5 py-0.5 text-xs text-muted">{me.role}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => fetch("/auth/logout", { method: "POST", headers: { "x-requested-with": "fetch" } }).finally(() => { window.location.href = "/" })}>Sign out</Button>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Switch>
          <Route path="/"><Home /></Route>
          <Route path="/graph"><GraphPage /></Route>
          <Route path="/memories"><Memories /></Route>
          <Route path="/setup"><Setup signedIn /></Route>
          <Route path="/turns">{admin ? <Turns /> : <Redirect to="/" />}</Route>
          <Route path="/configure/*?"><Configure /></Route>
          <Route><Redirect to="/" /></Route>
        </Switch>
      </main>
    </div>
  )
}
