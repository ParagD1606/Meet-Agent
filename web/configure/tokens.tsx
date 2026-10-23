import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/lib/api"
import { Async, Button, Card, Confirm, Input, PageTitle, ago, useAction, useToast } from "@/lib/ui"

export function Tokens() {
  const q = useQuery({ queryKey: ["tokens"], queryFn: api.tokens })
  const [name, setName] = useState("")
  const [fresh, setFresh] = useState<string | null>(null)
  const [del, setDel] = useState<string | null>(null)
  const toast = useToast()
  const create = useAction(api.createToken, { invalidate: [["tokens"]], onSuccess: (r) => { setFresh(r.token); setName("") } })
  const remove = useAction(api.deleteToken, { invalidate: [["tokens"]], ok: "Token revoked" })
  return (
    <>
      <PageTitle title="API tokens" sub="Bearer tokens for the MCP endpoint (POST /mcp). They can read shared memory only." />
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name.trim()) }}>
        <Input aria-label="Token name" placeholder="Token name, e.g. Cursor" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="max-w-xs" />
        <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>Create token</Button>
      </form>
      {fresh && (
        <Card className="mb-4 border-warn" role="alert">
          <p className="mb-2 text-sm font-medium">Copy your token now. It will not be shown again.</p>
          <div className="flex gap-2"><code className="min-w-0 flex-1 break-all rounded bg-raised p-2 text-xs">{fresh}</code>
            <Button size="sm" onClick={() => navigator.clipboard.writeText(fresh).then(() => toast("Copied"), () => toast("Copy failed", "error"))}>Copy</Button>
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>Done</Button></div>
        </Card>
      )}
      <Async q={q} empty="No tokens yet.">
        {(rows) => (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {rows.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className="font-medium">{t.name}</span><span className="text-xs text-muted">created {ago(t.createdAt)}</span>
                <Button size="sm" variant="danger" className="ml-auto" aria-label={`Revoke ${t.name}`} onClick={() => setDel(t.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </Async>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Revoke token?" body="Anything using this token will stop working immediately." action="Revoke" onYes={() => del && remove.mutate(del)} />
    </>
  )
}
