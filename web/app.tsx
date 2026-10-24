import { useQuery } from "@tanstack/react-query"
import { lazy, Suspense, type ComponentType } from "react"
import { Redirect, Router, useLocation } from "wouter"
import { useBrowserLocation } from "wouter/use-browser-location"
import { api } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { allowNavigation, useTitle } from "@/lib/hooks"
import { Shell } from "@/shell/shell"
import { navFor } from "@/shell/nav"
import { ConfirmHost } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { ErrorBoundary } from "@/ui/error-boundary"
import { ErrorState, Spinner } from "@/ui/page"
import { LinkButton } from "@/ui/button"
import { SignIn } from "@/pages/signin"
import { Setup } from "@/pages/setup"

// After a deploy an open tab still points at old chunk hashes: reload once to pick up the new build, then give up (no loop).
const RELOADED = "chunk-reloaded"
const page = <T extends ComponentType>(f: () => Promise<{ default: T }>) =>
  lazy(() => f().then(
    (m) => { sessionStorage.removeItem(RELOADED); return m },
    (e) => {
      if (sessionStorage.getItem(RELOADED)) throw e
      sessionStorage.setItem(RELOADED, "1")
      location.reload()
      return new Promise<never>(() => {})
    },
  ))
const Home = page(() => import("@/pages/home"))
const Graph = page(() => import("@/pages/graph"))
const Memories = page(() => import("@/pages/memories"))
const CoreMemory = page(() => import("@/pages/core-memory"))
const Review = page(() => import("@/pages/review"))
const Skills = page(() => import("@/pages/skills"))
const Automations = page(() => import("@/pages/automations"))
const Models = page(() => import("@/pages/models"))
const Proactivity = page(() => import("@/pages/proactivity"))
const Prompt = page(() => import("@/pages/prompt"))
const Integrations = page(() => import("@/pages/integrations"))
const Sync = page(() => import("@/pages/sync"))
const Tokens = page(() => import("@/pages/tokens"))
const Turns = page(() => import("@/pages/turns"))
const Usage = page(() => import("@/pages/usage"))
const Pixel = page(() => import("@/pages/pixel"))
const Tasks = page(() => import("@/pages/tasks"))
const Meetings = page(() => import("@/pages/meetings"))

const ROUTES: Record<string, ComponentType> = {
  "/": Home, "/graph": Graph, "/memories": Memories, "/core-memory": CoreMemory, "/review": Review, "/skills": Skills,
  "/automations": Automations, "/models": Models, "/proactivity": Proactivity, "/prompt": Prompt, "/integrations": Integrations,
  "/sync": Sync, "/tokens": Tokens, "/turns": Turns, "/usage": Usage, "/meetings": Meetings, "/pixel": Pixel, "/tasks": Tasks,
}
// Old /configure/* deep links keep working.
const LEGACY: Record<string, string> = { "/commitments": "/tasks", "/configure": "/integrations", "/configure/integrations": "/integrations", "/configure/models": "/models", "/configure/skills": "/skills", "/configure/automations": "/automations", "/configure/proactivity": "/proactivity", "/configure/prompt": "/prompt", "/configure/sync": "/sync", "/configure/tokens": "/tokens" }

function NotFound() {
  useTitle("Page not found")
  return <div className="mx-auto max-w-md pt-16"><EmptyState icon="search" title="Page not found" action={<LinkButton href="/" variant="primary">Go to home</LinkButton>}>That address doesn't match anything here. It may have moved.</EmptyState></div>
}

function Routed({ admin }: { admin: boolean }) {
  const [loc] = useLocation()
  const item = navFor(loc)
  useTitle(item ? item.label : LEGACY[loc] ? null : "Page not found")
  if (LEGACY[loc]) return <Redirect to={LEGACY[loc]!} replace />
  const C = ROUTES[item?.to ?? ""]
  const bleed = item?.to === "/graph"
  return (
    <main id="main" className={bleed ? "page" : "page mx-auto w-full max-w-[1120px] px-4 py-6 md:px-8 md:py-8"}>
      <ErrorBoundary resetKey={loc}>
        <Suspense fallback={<Spinner />}>
          {item?.admin && !admin ? <EmptyState icon="lock" title="Admins only">Ask a workspace admin if you need this page.</EmptyState> : !C ? <NotFound /> : <C />}
        </Suspense>
      </ErrorBoundary>
    </main>
  )
}

function Authed() {
  const { me, loading, error, refetch, admin } = useMe()
  const [loc] = useLocation()
  // Public until a workspace exists; a 401 here just means "already configured".
  const setup = useQuery({ queryKey: ["setup-status"], queryFn: api.setupStatus, retry: false, enabled: me === null })
  useTitle(!me ? (loc === "/setup" ? "Set up" : "Sign in") : undefined)

  if (loading || (me === null && setup.isPending)) return <Spinner />
  if (error) return <div className="mx-auto max-w-md p-6"><ErrorState error={error} retry={() => refetch()} /></div>
  if (!me) {
    const s = setup.data
    const unconfigured = s && (!s.slack || !s.workspace)
    return loc === "/setup" || unconfigured ? <Setup /> : <SignIn />
  }
  if (loc === "/setup") return <Setup signedIn />
  return <Shell me={me} admin={admin}><Routed admin={admin} /></Shell>
}

// Navigation goes through the dirty-state guard.
const useGuardedLocation = (): ReturnType<typeof useBrowserLocation> => {
  const [l, nav] = useBrowserLocation()
  return [l, (to, o) => { void allowNavigation().then((ok) => ok && nav(to, o)) }]
}

export function App() {
  return (
    <Router hook={useGuardedLocation}>
      <Authed />
      <ConfirmHost />
    </Router>
  )
}
