import { Link, Redirect, Route, Switch, useLocation } from "wouter"
import { useMe } from "@/lib/auth"
import { cn } from "@/lib/ui"
import { Automations } from "@/configure/automations"
import { Integrations } from "@/configure/integrations"
import { Models } from "@/configure/models"
import { Proactivity } from "@/configure/proactivity"
import { Skills } from "@/configure/skills"
import { SyncPage } from "@/configure/sync"
import { Tokens } from "@/configure/tokens"
import { WorkspacePrompt } from "@/configure/workspace-prompt"

const TABS = [
  { path: "integrations", label: "Integrations", el: <Integrations /> },
  { path: "models", label: "Models", el: <Models /> },
  { path: "skills", label: "Skills", el: <Skills /> },
  { path: "automations", label: "Automations", el: <Automations /> },
  { path: "proactivity", label: "Proactivity", el: <Proactivity /> },
  { path: "prompt", label: "Workspace prompt", el: <WorkspacePrompt /> },
  { path: "sync", label: "Sync", el: <SyncPage />, admin: true },
  { path: "tokens", label: "API tokens", el: <Tokens />, admin: true },
]

export function Configure() {
  const { admin } = useMe()
  const [loc] = useLocation()
  const tabs = TABS.filter((t) => admin || !t.admin)
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav aria-label="Configure" className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:w-48 md:shrink-0 md:flex-col md:px-0">
        {tabs.map((t) => {
          const on = loc === `/configure/${t.path}`
          return (
            <Link key={t.path} href={`/configure/${t.path}`} aria-current={on ? "page" : undefined}
              className={cn("whitespace-nowrap rounded-lg px-3 py-2 text-sm", on ? "bg-raised font-medium" : "text-muted hover:text-fg")}>{t.label}</Link>
          )
        })}
      </nav>
      <div className="min-w-0 flex-1">
        <Switch>
          {tabs.map((t) => <Route key={t.path} path={`/configure/${t.path}`}>{t.el}</Route>)}
          <Route><Redirect to="/configure/integrations" replace /></Route>
        </Switch>
      </div>
    </div>
  )
}
