import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { api, fieldErr, type Connection, type MarketItem } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { ago } from "@/lib/format"
import { useDebounced } from "@/lib/hooks"
import { Icon } from "@/lib/icons"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { cn } from "@/ui/cn"
import { ConnectorIcon } from "@/ui/connectors"
import { Dialog, confirmDialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { FormField, Input, Select, SettingRow, Switch } from "@/ui/fields"
import { useToast } from "@/ui/toast"
import { Async, ErrorState, PageHeader, Panel } from "@/ui/page"
import { SkeletonRows } from "@/ui/skeleton"
import { Tabs } from "@/ui/tabs"
import { Table } from "@/ui/table"

const TONE = { connected: "ok", pending: "warn", error: "danger", needs_reauth: "danger" } as const
const STATUS_LABEL = { connected: "connected", pending: "pending", error: "error", needs_reauth: "needs reconnect" } as const
const go = (r: { authUrl?: string }) => { if (r.authUrl) window.location.href = r.authUrl }
interface Target { item?: MarketItem; custom?: boolean }

function InstallDialog({ target, onClose, admin }: { target: Target | null; onClose: () => void; admin: boolean }) {
  const item = target?.item
  const [scope, setScope] = useState<"org" | "user">("user")
  const [token, setToken] = useState("")
  const [url, setUrl] = useState("")
  const [label, setLabel] = useState("")
  const [seen, setSeen] = useState<Target | null>(null)
  if (target && seen !== target) { setSeen(target); setScope(admin && !item?.personalOnly ? "org" : "user"); setToken(""); setUrl(""); setLabel("") }
  const apikey = item?.connectMode === "apikey"
  const install = useAction(() => api.installMarketplace(item?.key ?? "custom", { scope, token: token || undefined, label: label || undefined, url: target?.custom ? url.trim() : undefined }), {
    invalidate: [["connections"], ["marketplace"], ["overview"]], inline: true, onSuccess: (r) => { if (r.authUrl) go(r); else onClose() },
  })
  const title = target?.custom ? "Add a custom MCP server" : `Connect ${item?.name ?? ""}`
  return (
    <Dialog open={!!target} onClose={onClose} title={title} description={target?.custom ? "Any public HTTPS server that speaks MCP." : item?.url}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={install.isPending} disabled={(apikey && !token) || (!!target?.custom && !url)} onClick={() => install.mutate()}>{apikey || target?.custom ? "Connect" : "Continue to sign in"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); install.mutate() }}>
        {target?.custom && <>
          <FormField label="Server URL" error={fieldErr(install.error, "url")}>{(p) => <Input {...p} type="url" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />}</FormField>
          <FormField label="Name" optional>{(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} />}</FormField>
        </>}
        {apikey && <FormField label="API key" hint="Stored encrypted. Used only for this connection." error={fieldErr(install.error, "token")}>{(p) => <Input {...p} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />}</FormField>}
        {admin && !item?.personalOnly ? (
          <FormField label="Who can use it">{(p) => <Select {...p} value={scope} onChange={(e) => setScope(e.target.value as "org" | "user")}><option value="org">Everyone in the workspace</option><option value="user">Only me</option></Select>}</FormField>
        ) : <p className="text-sm text-muted">This connection will be personal: only you can use it.</p>}
        {install.error && <p role="alert" className="text-sm text-danger">{install.error.message}</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function Marketplace({ admin, onInstall }: { admin: boolean; onInstall: (t: Target) => void }) {
  const [input, setInput] = useState("")
  const q = useDebounced(input.trim(), 250)
  const [cat, setCat] = useState("all")
  const res = useQuery({ queryKey: ["marketplace", q], queryFn: () => api.marketplace(q), placeholderData: (p) => p })
  const cats = useMemo(() => { const c = new Map<string, number>(); for (const i of res.data?.items ?? []) for (const k of i.categories) c.set(k, (c.get(k) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k) }, [res.data])
  const items = (res.data?.items ?? []).filter((i) => cat === "all" || i.categories.includes(cat))
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-subtle" />
          <Input data-search type="search" aria-label="Search apps" placeholder="Search apps" className="w-64 pl-8" value={input} onChange={(e) => setInput(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
          {["all", ...cats].map((c) => <button key={c} aria-pressed={cat === c} onClick={() => setCat(c)} className={cn("rounded-full border px-2.5 py-0.5 text-xs capitalize", cat === c ? "border-accent-line bg-accent-soft text-accent-text" : "border-line text-muted hover:bg-hover")}>{c === "all" ? "All" : c}</button>)}
        </div>
        <Button className="ml-auto" size="sm" icon="plus" onClick={() => onInstall({ custom: true })}>Custom server</Button>
      </div>
      <Panel>
        {res.isPending ? <SkeletonRows rows={6} /> : res.error ? <ErrorState error={res.error} retry={() => res.refetch()} /> : items.length === 0 ? (
          <EmptyState icon="plug" title="No apps match" action={<Button onClick={() => onInstall({ custom: true })}>Add a custom server</Button>}>Try another search, or connect any MCP server by URL.</EmptyState>
        ) : (
          <ul className="divide">{items.map((i) => (
            <li key={i.key} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-sunken"><ConnectorIcon id={i.key} label={i.name} size={18} /></span>
              <div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-sm font-medium">{i.name}{i.personalOnly && <Badge>personal only</Badge>}</div><div className="truncate text-xs text-muted">{i.categories.slice(0, 3).join(", ") || i.url}</div></div>
              {i.connected ? <Badge tone="ok" dot>Connected</Badge> : <Button size="sm" onClick={() => onInstall({ item: i })}>Connect</Button>}
            </li>))}
          </ul>
        )}
      </Panel>
      {res.data && res.data.total > items.length && cat === "all" && <p className="mt-2 text-xs text-muted">Showing {items.length} of {res.data.total}. Search to narrow down.</p>}
      {!admin && <p className="mt-2 text-xs text-muted">Connections you add are personal. Admins can share one with the whole workspace.</p>}
    </>
  )
}

/** Workspace switch: may members trigger write tools through workspace connections (still subject to the approval cards in Pixel settings). */
function WriteSetting() {
  const q = useQuery({ queryKey: ["mcp-writes"], queryFn: api.mcpWrites })
  const save = useAction(api.saveMcpWrites, { invalidate: [["mcp-writes"], ["connections"]] })
  return (
    <Panel className="mb-4 px-4">
      <SettingRow title="Let the bot act through workspace connections" desc="When on, members can ask the bot to create or update things in workspace-wide apps. Approval cards still apply. A connection can override this.">
        <Switch label="Allow writes through workspace connections" checked={q.data?.enabled ?? true} disabled={q.isPending || save.isPending} onChange={(v) => save.mutate(v)} />
      </SettingRow>
    </Panel>
  )
}

export default function Integrations() {
  const { me, admin } = useMe()
  const [tab, setTab] = useState<"connected" | "browse">("connected")
  const [target, setTarget] = useState<Target | null>(null)
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.connections })
  const inv = { invalidate: [["connections"], ["marketplace"], ["overview"]] }
  const connect = useAction(api.connect, { ...inv, onSuccess: go })
  const remove = useAction(api.deleteConnection, { ...inv, ok: "Connection removed" })
  const toast = useToast()
  const can = (c: Connection) => admin || c.ownerUserId === me?.id
  const del = async (c: Connection) => { if (await confirmDialog({ title: `Remove ${c.label}?`, body: "The bot loses access to it right away.", confirmLabel: "Remove", danger: true })) remove.mutate(c.id) }
  const test = useAction(api.testConnection, {
    ...inv,
    onSuccess: (r, id) => {
      const label = conns.data?.find((c) => c.id === id)?.label ?? "Connection"
      if (r.ok) toast.push({ kind: "success", title: `${label} works`, body: `${r.toolCount} tools (${r.readCount} read, ${r.writeCount} write) in ${r.latencyMs} ms` })
      else toast.push({ kind: "error", title: r.needsReauth ? `${label} needs to be reconnected` : `${label} failed the test`, body: r.error })
    },
  })
  const share = useAction(api.makeWorkspaceWide, { ...inv, ok: "Now available to the whole workspace" })
  const allow = useAction((v: { id: string; allow: boolean }) => api.setAllowWrites(v.id, v.allow), { ...inv })
  const wide = async (c: Connection) => {
    if (await confirmDialog({ title: `Make ${c.label} workspace-wide?`, body: `Everyone in the workspace will be able to use ${c.ownerName ? `${c.ownerName}'s` : "this"} ${c.label} connection through the bot, with the same approval rules as other writes. Their account is used, so only do this if they agree.`, confirmLabel: "Make workspace-wide" })) share.mutate(c.id)
  }
  const n = conns.data?.length
  return (
    <>
      <PageHeader title="Integrations" desc="Connect tools over MCP so the bot can read from, and with your approval act in, your other apps." />
      <div className="mb-4"><Tabs label="Integrations view" value={tab} onChange={setTab} items={[{ id: "connected", label: n != null ? `Connected (${n})` : "Connected" }, { id: "browse", label: "Browse apps" }]} /></div>
      {tab === "connected" && admin && <WriteSetting />}
      {tab === "browse" ? <Marketplace admin={admin} onInstall={setTarget} /> : (
        <Async q={conns} rows={3}>{(rows) => rows.length === 0 ? (
          <Panel><EmptyState icon="plug" title="Nothing connected yet" action={<Button variant="primary" onClick={() => setTab("browse")}>Browse apps</Button>}>Connect GitHub, Linear, Notion or any MCP server to let the bot look things up.</EmptyState></Panel>
        ) : (
          <Panel><Table caption="Connections" rows={rows} rowKey={(c) => c.id} columns={[
            { key: "n", header: "App", primary: true, cell: (c: Connection) => <span className="flex items-center gap-2.5 py-1"><ConnectorIcon id={c.provider} label={c.label} size={18} /><span><span className="block font-medium">{c.label}</span><span className="block max-w-36 truncate text-xs text-muted" title={c.url}>{new URL(c.url).host}</span></span></span> },
            { key: "scope", header: "Scope", hideSm: true, cell: (c) => <span><Badge>{c.scope === "org" ? "Workspace" : "Personal"}</Badge>{c.scope === "user" && <span className="mt-0.5 block text-xs text-muted">{c.ownerUserId === me?.id ? "Yours" : `Owner: ${c.ownerName ?? c.ownerUserId ?? "unknown"}`}</span>}
              {admin && c.scope === "user" && c.status === "connected" && <button type="button" className="mt-0.5 block text-xs text-accent-text hover:underline" disabled={share.isPending} onClick={() => wide(c)}>Make workspace-wide</button>}
              {admin && c.scope === "org" && <button type="button" className="mt-0.5 block text-xs text-accent-text hover:underline" disabled={allow.isPending} onClick={() => allow.mutate({ id: c.id, allow: c.writesEnabled === false })}>{c.writesEnabled === false ? "Allow writes" : "Disable writes"}</button>}
            </span> },
            { key: "tools", header: "Tools", hideSm: true, cell: (c) => c.toolCount == null ? <span className="text-muted" title="Not checked yet. Use Test.">-</span> : <span><span className="block tabular-nums">{c.toolCount}</span><span className="block text-xs text-muted">{c.readCount ?? 0} read, {c.writeCount ?? 0} write{c.scope === "org" && c.writesEnabled === false ? " (writes off)" : ""}</span></span> },
            { key: "st", header: "Status", cell: (c) => <span><Badge tone={TONE[c.status] ?? "neutral"} dot>{STATUS_LABEL[c.status] ?? c.status}</Badge>{c.status !== "connected" && (c.error ?? c.lastError ?? c.reason) && <span className="mt-0.5 block w-56 whitespace-normal text-xs text-danger">{c.error ?? c.lastError ?? c.reason}</span>}{c.status === "connected" && c.lastError && <span className="mt-0.5 block w-56 whitespace-normal text-xs text-warn">Last check failed: {c.lastError}</span>}</span> },
            { key: "since", header: "Connected", hideSm: true, cell: (c) => <span className="text-muted"><span className="block">{c.lastVerifiedAt ? `Verified ${ago(c.lastVerifiedAt)}` : "Not verified yet"}</span><span className="block text-xs">{c.connectedAt ? `Connected ${ago(c.connectedAt)}` : ""}{c.scope === "user" && c.ownerName ? ` by ${c.ownerName}` : ""}</span></span> },
            { key: "a", header: <span className="sr-only">Actions</span>, end: true, cell: (c) => <span className="flex justify-end gap-1.5">
              <Button size="sm" loading={test.isPending && test.variables === c.id} disabled={c.status === "pending"} onClick={() => test.mutate(c.id)}>Test</Button>
              {can(c) && c.status !== "connected" && <Button size="sm" variant="primary" loading={connect.isPending && connect.variables === c.id} onClick={() => connect.mutate(c.id)}>{c.status === "pending" ? "Connect" : "Reconnect"}</Button>}
              {can(c) && <Button size="sm" variant="danger" aria-label={`Remove ${c.label}`} onClick={() => del(c)}>Remove</Button>}
            </span> },
          ]} /></Panel>
        )}</Async>
      )}
      <InstallDialog target={target} onClose={() => setTarget(null)} admin={admin} />
    </>
  )
}
