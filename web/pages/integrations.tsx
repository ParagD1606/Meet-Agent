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
import { GithubPanel } from "./github-board"
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

// ---------- Task boards: where approved tasks are sent (GitHub issues; Trello is optional and tucked away) ----------
const mapRows = (people: { id: string; name: string | null }[] | undefined, map: Record<string, string>, set: (m: Record<string, string>) => void, input: (id: string, v: string) => React.ReactNode) => (
  <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
    <table className="w-full text-sm"><tbody>{(people ?? []).map((p) => (
      <tr key={p.id} className="border-b border-line last:border-0"><td className="px-3 py-1.5">{p.name ?? p.id}</td><td className="w-1/2 px-3 py-1.5">{input(p.id, map[p.id] ?? "")}</td></tr>
    ))}</tbody></table>
    {!people?.length && <p className="p-3 text-xs text-muted">No people loaded.</p>}
  </div>
)
const withMapped = (m: Record<string, string>, id: string, v: string) => { const n = { ...m }; if (v) n[id] = v; else delete n[id]; return n }

function TrelloPanel() {
  const toast = useToast()
  const s = useQuery({ queryKey: ["trello-settings"], queryFn: api.trelloSettings })
  const people = useQuery({ queryKey: ["people"], queryFn: api.people })
  const [f, setF] = useState({ key: "", token: "", boardId: "", listId: "", map: {} as Record<string, string> })
  const [seeded, setSeeded] = useState(false)
  if (s.data && !seeded) { setSeeded(true); setF({ key: "", token: "", boardId: s.data.boardId, listId: s.data.listId, map: s.data.memberMap }) }
  const ready = !!s.data?.configured
  const boards = useQuery({ queryKey: ["trello-boards"], queryFn: api.trelloBoards, enabled: ready, retry: false })
  const lists = useQuery({ queryKey: ["trello-lists", f.boardId], queryFn: () => api.trelloLists(f.boardId), enabled: ready && !!f.boardId, retry: false })
  const members = useQuery({ queryKey: ["trello-members", f.boardId], queryFn: () => api.trelloMembers(f.boardId), enabled: ready && !!f.boardId, retry: false })
  const save = useAction(() => api.saveTrello({ key: f.key || undefined, token: f.token || undefined, boardId: f.boardId, listId: f.listId, memberMap: f.map }), {
    invalidate: [["trello-settings"], ["trello-boards"], ["board-targets"]], ok: "Trello settings saved", inline: true, onSuccess: () => setF((v) => ({ ...v, token: "" })),
  })
  const test = useAction(() => api.testTrello({ key: f.key || undefined, token: f.token || undefined }), {
    inline: true, onSuccess: (r) => toast.push(r.ok ? { kind: "success", title: `Trello works${r.username ? ` (signed in as ${r.username})` : ""}`, body: "Nothing was created." } : { kind: "error", title: "Trello rejected these credentials", body: r.message }),
  })
  return (
    <Panel className="mb-4 p-4">
      <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-semibold">Trello</h2><Badge tone={s.data?.listId ? "ok" : "neutral"} dot>{s.data?.listId ? "Ready" : ready ? "Pick a list" : "Not set up"}</Badge></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="API key" hint={ready ? `Saved (ends in ${s.data!.keyLast4}). Leave empty to keep it.` : "From trello.com/power-ups/admin"}>{(p) => <Input {...p} autoComplete="off" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />}</FormField>
        <FormField label="Token" hint={ready ? "Saved encrypted. Leave empty to keep it." : "Authorize the key to get a token (read and write)."}>{(p) => <Input {...p} type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />}</FormField>
        <FormField label="Board" hint={!ready ? "Save the key and token first." : boards.error ? "Could not load boards." : undefined}>{(p) => <Select {...p} disabled={!ready} value={f.boardId} onChange={(e) => setF({ ...f, boardId: e.target.value, listId: "", map: {} })}><option value="">Choose a board</option>{boards.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</FormField>
        <FormField label="List for new cards">{(p) => <Select {...p} disabled={!f.boardId} value={f.listId} onChange={(e) => setF({ ...f, listId: e.target.value })}><option value="">Choose a list</option>{lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</FormField>
      </div>
      {f.boardId && <div className="mt-4"><div className="text-sm font-medium">Member mapping</div><p className="text-xs text-muted">Cards are assigned to the mapped Trello member. Unmapped owners are named in the card description.</p>
        {mapRows(people.data, f.map, (m) => setF({ ...f, map: m }), (id, v) => <Select aria-label="Trello member" value={v} onChange={(e) => setF({ ...f, map: withMapped(f.map, id, e.target.value) })}><option value="">Not mapped</option>{members.data?.map((m) => <option key={m.id} value={m.id}>{m.name} (@{m.username})</option>)}</Select>)}</div>}
      {(save.error || test.error) && <p role="alert" className="mt-3 text-sm text-danger">{(save.error ?? test.error)!.message}</p>}
      <div className="mt-4 flex gap-2"><Button variant="primary" loading={save.isPending} disabled={!ready && !(f.key && f.token)} onClick={() => save.mutate()}>Save</Button><Button loading={test.isPending} disabled={!ready && !(f.key && f.token)} onClick={() => test.mutate()}>Test</Button></div>
    </Panel>
  )
}

function TaskBoards() {
  const trello = useQuery({ queryKey: ["trello-settings"], queryFn: api.trelloSettings })
  const [addTrello, setAddTrello] = useState(false)
  return (
    <>
      <p className="mb-3 text-sm text-muted">Approved tasks can be sent to GitHub from the Tasks and Meetings pages. Each task is sent once; sending it again returns the existing link. Test only checks the connection and creates nothing.</p>
      <GithubPanel />
      {trello.data?.configured ? (
        <details className="mb-4"><summary className="cursor-pointer text-sm text-muted">Other boards (Trello is set up)</summary><div className="mt-3"><TrelloPanel /></div></details>
      ) : addTrello ? <TrelloPanel /> : (
        <button type="button" className="text-xs text-accent-text hover:underline" onClick={() => setAddTrello(true)}>Add Trello (optional)</button>
      )}
    </>
  )
}

export default function Integrations() {
  const { me, admin } = useMe()
  const [tab, setTab] = useState<"connected" | "browse" | "boards">("connected")
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
      <div className="mb-4"><Tabs label="Integrations view" value={tab} onChange={setTab} items={[{ id: "connected", label: n != null ? `Connected (${n})` : "Connected" }, { id: "browse", label: "Browse apps" }, ...(admin ? [{ id: "boards" as const, label: "Task boards" }] : [])]} /></div>
      {tab === "connected" && admin && <WriteSetting />}
      {tab === "boards" && admin ? <TaskBoards /> : tab === "browse" ? <Marketplace admin={admin} onInstall={setTarget} /> : (
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
