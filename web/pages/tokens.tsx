import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, fieldErr, type ApiToken } from "@/lib/api"
import { useAction } from "@/lib/action"
import { ago } from "@/lib/format"
import { Button } from "@/ui/button"
import { confirmDialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { FormField, Input } from "@/ui/fields"
import { Async, CopyButton, PageHeader, Panel, Section } from "@/ui/page"
import { Table } from "@/ui/table"

export default function Tokens() {
  const q = useQuery({ queryKey: ["tokens"], queryFn: api.tokens })
  const [name, setName] = useState("")
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null)
  const create = useAction(api.createToken, { invalidate: [["tokens"]], inline: true, onSuccess: (r, n) => { setFresh({ name: n, token: r.token }); setName("") } })
  const remove = useAction(api.deleteToken, { invalidate: [["tokens"]], ok: "Token revoked" })
  const revoke = async (t: ApiToken) => {
    if (await confirmDialog({ title: `Revoke "${t.name}"?`, body: "Anything using this token stops working immediately.", confirmLabel: "Revoke", danger: true })) remove.mutate(t.id)
  }
  return (
    <>
      <PageHeader title="API tokens" desc="Bearer tokens for the outward MCP endpoint, so tools like Cursor or Claude Desktop can search shared memory. Tokens are read-only." />
      <Section title="Create a token">
        <form className="flex max-w-lg items-start gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name.trim()) }}>
          <FormField label="Name" className="flex-1" error={fieldErr(create.error, "name") ?? create.error?.message}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Cursor on Ada's laptop" />}
          </FormField>
          <Button type="submit" variant="primary" className="mt-[26px]" loading={create.isPending} disabled={!name.trim()}>Create</Button>
        </form>
      </Section>
      {fresh && (
        <div role="alert" className="mb-8 rounded-lg border border-warn bg-warn-soft p-4">
          <p className="text-sm font-medium">Copy the token for "{fresh.name}" now. You won't be able to see it again.</p>
          <div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 break-all rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs">{fresh.token}</code><CopyButton text={fresh.token} /><Button size="sm" variant="ghost" onClick={() => setFresh(null)}>Done</Button></div>
        </div>
      )}
      <Section title="Active tokens">
        <Async q={q} rows={3}>{(rows) => rows.length === 0 ? <Panel><EmptyState icon="key" title="No tokens yet">Create one above to connect an MCP client.</EmptyState></Panel> : (
          <Panel><Table caption="API tokens" rows={rows} rowKey={(t) => t.id} columns={[
            { key: "name", header: "Name", primary: true, sort: (t) => t.name, cell: (t) => <span className="font-medium">{t.name}</span> },
            { key: "created", header: "Created", cell: (t) => <span className="text-muted">{ago(t.createdAt)}</span> },
            { key: "used", header: "Last used", hideSm: true, cell: (t) => <span className="text-muted">{t.lastUsedAt ? ago(t.lastUsedAt) : "Never"}</span> },
            { key: "x", header: <span className="sr-only">Actions</span>, end: true, width: "90px", cell: (t) => <Button size="sm" variant="danger" aria-label={`Revoke ${t.name}`} onClick={() => revoke(t)}>Revoke</Button> },
          ]} /></Panel>
        )}</Async>
      </Section>
    </>
  )
}
