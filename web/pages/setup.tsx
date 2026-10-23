import { useMutation, useQuery } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { Link } from "wouter"
import { api, checkDetail, checkOk, count, errMsg, type SetupStatus } from "@/lib/api"
import { Icon, Logo } from "@/lib/icons"
import { Badge } from "@/ui/badge"
import { Button, LinkButton } from "@/ui/button"
import { cn } from "@/ui/cn"
import { FormField, Input } from "@/ui/fields"
import { CopyButton } from "@/ui/page"
import { Skeleton } from "@/ui/skeleton"

type StepId = "model" | "embedding" | "app" | "install" | "owner" | "integration" | "test"
const STEPS: { id: StepId; title: string; short: string }[] = [
  { id: "model", title: "Model provider", short: "Choose the language model" },
  { id: "embedding", title: "Embeddings", short: "Enable semantic memory search" },
  { id: "app", title: "Slack app", short: "Create the app from a manifest" },
  { id: "install", title: "Install to workspace", short: "Authorize the bot" },
  { id: "owner", title: "Owner sign-in", short: "Claim the owner account" },
  { id: "integration", title: "First integration", short: "Connect a tool" },
  { id: "test", title: "Test message", short: "Confirm it can post" },
]

const Env = ({ children }: { children: string }) => <pre className="mono overflow-x-auto rounded-md border border-line bg-sunken p-3 text-xs leading-5">{children}</pre>
const P = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted">{children}</p>

function Manifest() {
  const q = useQuery({ queryKey: ["manifest"], queryFn: api.setupManifest })
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between"><span className="eyebrow">slack-app-manifest.yaml</span>{q.data && <CopyButton text={q.data} label="Copy manifest" />}</div>
      {q.isPending ? <Skeleton className="h-40 w-full" /> : q.error ? <p className="text-sm text-danger" role="alert">{errMsg(q.error)}</p> : <pre className="mono max-h-60 overflow-auto rounded-md border border-line bg-sunken p-3 text-xs leading-5">{q.data}</pre>}
    </div>
  )
}

export function Setup({ signedIn = false }: { signedIn?: boolean }) {
  const status = useQuery({ queryKey: ["setup-status", "poll"], queryFn: api.setupStatus, refetchInterval: 4000, retry: false })
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, enabled: signedIn, refetchInterval: 6000 })
  const s: Partial<SetupStatus> = status.data ?? {}
  const ws = !!s.workspace
  const done: Record<StepId, boolean> = {
    model: checkOk(s.checks?.model) ?? !!s.model,
    embedding: checkOk(s.checks?.embedding) ?? !!s.embedding,
    app: !!s.slack,
    install: ws,
    owner: signedIn,
    integration: count(overview.data?.connections) > 0,
    test: false,
  }
  const [picked, setPicked] = useState<StepId | null>(null)
  const [testOk, setTestOk] = useState(false)
  done.test = testOk
  const firstOpen = STEPS.find((x) => !done[x.id])?.id ?? "test"
  const active = picked ?? firstOpen
  const [token, setToken] = useState("")
  const test = useMutation({ mutationFn: api.testMessage, onSuccess: (r) => setTestOk(r.ok) })

  const body: Record<StepId, ReactNode> = {
    model: <><P>The brain needs a language model to answer questions. Set an API key (Anthropic, OpenAI, Google or xAI) or an OpenAI-compatible base URL in the server environment, then restart.</P><div className="mt-3"><Env>{`MODEL_API_KEY=sk-...\n# or, for a self-hosted endpoint\nMODEL_BASE_URL=http://localhost:11434/v1\nMODEL_NAME=llama3.2`}</Env></div></>,
    embedding: <><P>Embeddings power memory search. They use the same key by default; set a dedicated one to use a different provider.</P><div className="mt-3"><Env>{`EMBEDDING_API_KEY=sk-...   # optional, falls back to MODEL_API_KEY\nEMBEDDING_MODEL=text-embedding-3-small`}</Env></div></>,
    app: <><P>Create a Slack app from this manifest at <a className="text-accent-text underline underline-offset-2" href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer noopener">api.slack.com/apps</a> (From a manifest). Then copy its credentials into the server environment and restart.</P><Manifest /><div className="mt-3"><Env>{`SLACK_CLIENT_ID=...\nSLACK_CLIENT_SECRET=...\nSLACK_SIGNING_SECRET=...   # HTTP mode\nSLACK_APP_TOKEN=xapp-...   # Socket mode`}</Env></div></>,
    install: <><P>Authorize the app in your Slack workspace. This stores the bot token (encrypted) and creates the #company-brain channel.</P><div className="mt-4 flex items-center gap-3"><LinkButton href="/slack/install" variant="primary" icon="external">Add to Slack</LinkButton>{ws && <Badge tone="ok" dot>Workspace connected</Badge>}</div></>,
    owner: <>
      <P>The first person to sign in becomes the owner. While the deployment is unclaimed, paste the setup token printed in the server log to prove you control it.</P>
      {s.ownerLocked && <p className="mt-2 text-sm text-ok">An owner has already claimed this deployment.</p>}
      <form className="mt-4 max-w-md" onSubmit={(e) => { e.preventDefault(); location.href = `/auth/slack?setup_token=${encodeURIComponent(token.trim())}` }}>
        <FormField label="Setup token" hint="Look for “Setup token” in the server's startup output.">{(p) => <Input {...p} className="mono" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste token" />}</FormField>
        <Button variant="primary" type="submit" className="mt-3" disabled={!token.trim() && !s.ownerLocked}>Sign in with Slack</Button>
      </form>
    </>,
    integration: <><P>Connect a tool so the agent can act on your behalf, such as GitHub, Linear or Notion. You can skip this and add one later.</P><div className="mt-4 flex gap-2"><LinkButton href="/integrations" variant="primary">Open integrations</LinkButton>{done.integration && <Badge tone="ok" dot>Connected</Badge>}</div></>,
    test: <><P>Send a test message to #company-brain to confirm the bot can post.</P><div className="mt-4 flex items-center gap-3"><Button variant="primary" loading={test.isPending} onClick={() => test.mutate()}>Send test message</Button>
      {test.data?.ok && <Badge tone="ok" dot>Posted{test.data.channel ? ` to ${test.data.channel}` : ""}</Badge>}
      {(test.error || (test.data && !test.data.ok)) && <span role="alert" className="text-sm text-danger">{test.error ? errMsg(test.error) : test.data?.error ?? "The message could not be posted."}</span>}</div>
      {testOk && <p className="mt-4 text-sm">Setup is complete. <Link href="/" className="text-accent-text underline underline-offset-2">Go to home</Link></p>}</>,
  }
  const needsAuth = (id: StepId) => (id === "integration" || id === "test") && !signedIn
  const checks = (["db", "boss", "model", "embedding", "slack"] as const).filter((k) => s.checks?.[k] !== undefined)

  return (
    <div className="min-h-dvh bg-bg">
      <header className="flex h-12 items-center gap-2 border-b border-line px-4 md:px-8"><Logo size={20} /><span className="text-base font-semibold tracking-tight">Company Brain</span><span className="text-sm text-subtle">/ Setup</span>
        <span className="ml-auto text-xs text-subtle" role="status">{status.isFetching ? "Checking…" : "Live"}</span></header>
      <div className="mx-auto grid max-w-5xl gap-8 px-4 py-8 md:grid-cols-[260px_1fr] md:px-8">
        <nav aria-label="Setup steps">
          <ol className="flex gap-1 overflow-x-auto md:flex-col">
            {STEPS.map((st, i) => {
              const d = done[st.id], on = active === st.id
              return (
                <li key={st.id}>
                  <button onClick={() => setPicked(st.id)} aria-current={on ? "step" : undefined} className={cn("flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-hover max-md:whitespace-nowrap", on && "bg-surface shadow-[var(--shadow-sm)] ring-1 ring-line")}>
                    <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium", d ? "border-accent bg-accent text-[var(--accent-fg)]" : "border-line-strong text-muted")}>{d ? <Icon name="check" size={12} /> : i + 1}</span>
                    <span className="min-w-0"><span className="block text-sm font-medium">{st.title}</span><span className="block truncate text-xs text-subtle max-md:hidden">{st.short}</span></span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>
        <div>
          <section aria-live="polite" className="surface p-6">
            <div className="mb-1 flex items-center gap-2"><h1 className="text-lg">{STEPS.find((x) => x.id === active)!.title}</h1>{done[active] && <Badge tone="ok" dot>Done</Badge>}</div>
            {status.isPending ? <Skeleton className="mt-4 h-24 w-full" /> : needsAuth(active) ? <P>Sign in as the owner first (step 5), then come back to this step.</P> : body[active]}
            <div className="mt-6 flex justify-between border-t border-line pt-4">
              <Button size="sm" variant="ghost" disabled={active === STEPS[0]!.id} onClick={() => setPicked(STEPS[Math.max(0, STEPS.findIndex((x) => x.id === active) - 1)]!.id)}>Back</Button>
              <Button size="sm" disabled={active === "test"} onClick={() => setPicked(STEPS[Math.min(STEPS.length - 1, STEPS.findIndex((x) => x.id === active) + 1)]!.id)}>Next</Button>
            </div>
          </section>
          {checks.length > 0 && (
            <section className="mt-4 surface" aria-label="System checks">
              <ul className="grid grid-cols-2 divide-line sm:grid-cols-5 sm:divide-x">
                {checks.map((k) => { const ok = checkOk(s.checks![k]); const d = checkDetail(s.checks![k]); return (
                  <li key={k} className="px-3 py-2.5"><div className="flex items-center gap-1.5 text-xs text-muted"><span className={cn("dot", ok ? "text-ok" : "text-danger")} />{k === "boss" ? "Job queue" : k === "db" ? "Database" : k[0]!.toUpperCase() + k.slice(1)}</div><div className="mt-0.5 truncate text-xs" title={d ?? undefined}>{ok ? "Healthy" : d ?? "Not ready"}</div></li>) })}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
