import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type SyncSource } from "@/lib/api"
import { Async, Badge, Button, PageTitle, Select, ago, useAction } from "@/lib/ui"

const NAMES = { gdrive: "Google Drive", onedrive: "OneDrive", notion: "Notion" }

export function SyncPage() {
  const q = useQuery({ queryKey: ["sync"], queryFn: api.syncSources })
  const [provider, setProvider] = useState<SyncSource["provider"]>("gdrive")
  const add = useAction(api.createSyncSource, { invalidate: [["sync"]], onSuccess: (r) => { if (r.authUrl) window.location.href = r.authUrl } })
  const run = useAction(api.runSync, { invalidate: [["sync"]], ok: "Sync started" })
  return (
    <>
      <PageTitle title="Sync" sub="Pull documents from external sources into shared memory every hour." />
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(provider) }}>
        <Select aria-label="Source" value={provider} onChange={(e) => setProvider(e.target.value as SyncSource["provider"])} className="max-w-48">
          {Object.entries(NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Button type="submit" variant="primary" disabled={add.isPending}>Connect source</Button>
      </form>
      <Async q={q} empty="No sync sources connected.">
        {(rows) => (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {rows.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="font-medium">{NAMES[s.provider] ?? s.provider}</span>
                <Badge tone={s.status === "error" ? "danger" : "neutral"}>{s.status ?? "idle"}</Badge>
                <span className="text-xs text-muted">last sync {ago(s.lastSyncAt)}</span>
                <Button size="sm" className="ml-auto" disabled={run.isPending} onClick={() => run.mutate(s.id)}>Sync now</Button>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </>
  )
}
