import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Connection, type Preset } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Async, Badge, Button, Card, Confirm, Field, Input, PageTitle, Select, useAction } from "@/lib/ui"

const statusTone = { connected: "ok", pending: "warn", error: "danger" } as const

export function Integrations() {
  const { me, admin } = useMe()
  const presets = useQuery({ queryKey: ["mcp-presets"], queryFn: api.presets })
  const conns = useQuery({ queryKey: ["mcp-connections"], queryFn: api.connections })
  const [del, setDel] = useState<Connection | null>(null)
  const [custom, setCustom] = useState({ label: "", url: "", scope: admin ? "org" : "user" })
  const inv = { invalidate: [["mcp-connections"], ["overview"]] }

  const redirect = (r: { authUrl: string }) => { window.location.href = r.authUrl }
  const connect = useAction(api.connect, { ...inv, onSuccess: redirect })
  const create = useAction(
    async (c: Parameters<typeof api.createConnection>[0]) => { const conn = await api.createConnection(c); return api.connect(conn.id) },
    { ...inv, onSuccess: redirect },
  )
  const remove = useAction(api.deleteConnection, { ...inv, ok: "Connection removed" })
  const canDelete = (c: Connection) => admin || c.ownerUserId === me?.id

  const scopeFor = (p: Preset): "org" | "user" => (p.personalOnly || !admin ? "user" : "org")
  return (
    <>
      <PageTitle title="Integrations" sub="Connect tools over MCP so the bot can read from, and with your approval act in, your other apps." />
      <h2 className="mb-2 font-semibold">Your connections</h2>
      <Async q={conns} empty="Nothing connected yet. Pick an app below.">
        {(rows) => (
          <ul className="mb-8 divide-y divide-line rounded-xl border border-line bg-surface">
            {rows.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">{c.label}<Badge tone={statusTone[c.status]}>{c.status}</Badge><Badge>{c.scope === "org" ? "workspace" : "personal"}</Badge></p>
                  <p className="truncate text-xs text-muted">{c.url}</p>
                </div>
                {c.status !== "connected" && canDelete(c) && <Button size="sm" variant="primary" disabled={connect.isPending} onClick={() => connect.mutate(c.id)}>{c.status === "error" ? "Reconnect" : "Connect"}</Button>}
                {canDelete(c) && <Button size="sm" variant="danger" aria-label={`Remove ${c.label}`} onClick={() => setDel(c)}>Remove</Button>}
              </li>
            ))}
          </ul>
        )}
      </Async>

      <h2 className="mb-2 font-semibold">Apps</h2>
      <Async q={presets} empty="No presets available.">
        {(rows) => (
          <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((p) => (
              <Card key={p.key} className="flex flex-col gap-3">
                <div><p className="font-medium">{p.label}</p><p className="truncate text-xs text-muted">{p.url}</p></div>
                <div className="mt-auto flex items-center gap-2">
                  <Button size="sm" variant="primary" disabled={create.isPending} onClick={() => create.mutate({ provider: p.key, label: p.label, scope: scopeFor(p) })}>Connect</Button>
                  {(p.personalOnly || !admin) && <Badge>personal</Badge>}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>

      <h2 className="mb-2 font-semibold">Custom MCP server</h2>
      <Card>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); create.mutate({ url: custom.url.trim(), label: custom.label.trim(), scope: custom.scope as "org" | "user" }) }}>
          <Field label="Name">{(id) => <Input id={id} required value={custom.label} onChange={(e) => setCustom({ ...custom, label: e.target.value })} placeholder="My tool" />}</Field>
          <Field label="Server URL">{(id) => <Input id={id} required type="url" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} placeholder="https://example.com/mcp" />}</Field>
          {admin && <Field label="Who can use it?">{(id) => (
            <Select id={id} value={custom.scope} onChange={(e) => setCustom({ ...custom, scope: e.target.value })}>
              <option value="org">Whole workspace</option><option value="user">Only me</option>
            </Select>)}</Field>}
          <div className="flex items-end sm:col-start-1"><Button type="submit" variant="primary" disabled={create.isPending}>Add and connect</Button></div>
        </form>
      </Card>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Remove connection?" body={`The bot will lose access to ${del?.label}.`} action="Remove" onYes={() => del && remove.mutate(del.id)} />
    </>
  )
}
