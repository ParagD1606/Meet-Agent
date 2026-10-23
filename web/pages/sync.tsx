import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type SyncSource } from "@/lib/api"
import { useAction } from "@/lib/action"
import { ago } from "@/lib/format"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { Dialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { FormField, Select, Textarea } from "@/ui/fields"
import { Async, PageHeader, Panel, Section } from "@/ui/page"
import { Table } from "@/ui/table"

const NAMES: Record<SyncSource["provider"], string> = { gdrive: "Google Drive", onedrive: "OneDrive", notion: "Notion" }
type Sel = NonNullable<SyncSource["selection"]>

function SelectionDialog({ src, onClose }: { src: SyncSource | null; onClose: () => void }) {
  const [mode, setMode] = useState<"all" | "selected">("all")
  const [ids, setIds] = useState("")
  const [seen, setSeen] = useState<string | null>(null)
  if (src && seen !== src.id) { setSeen(src.id); setMode(src.selection?.mode ?? "all"); setIds((src.selection?.ids ?? []).join("\n")) }
  const save = useAction((s: Sel) => api.saveSyncSource(src!.id, s), { invalidate: [["sync"]], ok: "Selection saved", onSuccess: onClose, inline: true })
  const list = ids.split(/[\s,]+/).filter(Boolean)
  return (
    <Dialog open={!!src} onClose={onClose} title={src ? `${NAMES[src.provider]} selection` : ""} description="Choose what gets pulled into shared memory. Changes apply on the next sync."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={mode === "selected" && list.length === 0} onClick={() => save.mutate({ mode, ids: mode === "selected" ? list : [] })}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        <FormField label="Scope">{(p) => <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as "all" | "selected")}><option value="all">Everything the account can see</option><option value="selected">Only selected folders or pages</option></Select>}</FormField>
        {mode === "selected" && <FormField label="Folder or page IDs" hint="One per line." error={save.error?.message}>{(p) => <Textarea {...p} rows={5} className="font-mono" value={ids} onChange={(e) => setIds(e.target.value)} />}</FormField>}
      </div>
    </Dialog>
  )
}

export default function SyncPage() {
  const q = useQuery({ queryKey: ["sync"], queryFn: api.syncSources, refetchInterval: 15_000 })
  const [provider, setProvider] = useState<SyncSource["provider"]>("gdrive")
  const [edit, setEdit] = useState<SyncSource | null>(null)
  const add = useAction(api.createSyncSource, { invalidate: [["sync"]], onSuccess: (r) => { if (r.authUrl) window.location.href = r.authUrl } })
  const run = useAction(api.runSync, { invalidate: [["sync"]], ok: "Sync started" })
  return (
    <>
      <PageHeader title="Sync" desc="Pull documents from external sources into shared memory every hour. Unchanged files are skipped, so repeat syncs are cheap." />
      <Section title="Connect a source">
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(provider) }}>
          <Select aria-label="Source" className="w-48" value={provider} onChange={(e) => setProvider(e.target.value as SyncSource["provider"])}>{Object.entries(NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          <Button type="submit" variant="primary" loading={add.isPending}>Connect</Button>
        </form>
      </Section>
      <Section title="Sources">
        <Async q={q} rows={3}>{(rows) => rows.length === 0 ? <Panel><EmptyState icon="sync" title="No sources connected">Connect one above. You will sign in with the provider and pick what to import.</EmptyState></Panel> : (
          <Panel><Table caption="Sync sources" rows={rows} rowKey={(s) => s.id} columns={[
            { key: "p", header: "Source", primary: true, cell: (s: SyncSource) => <span className="font-medium">{NAMES[s.provider] ?? s.provider}</span> },
            { key: "sel", header: "Importing", hideSm: true, cell: (s) => <span className="text-muted">{s.selection?.mode === "selected" ? `${s.selection.ids?.length ?? 0} selected` : "Everything"}</span> },
            { key: "st", header: "Status", cell: (s) => <Badge tone={s.status === "error" ? "danger" : s.status === "running" ? "accent" : "neutral"} dot>{s.status ?? "idle"}</Badge> },
            { key: "last", header: "Last sync", hideSm: true, cell: (s) => <span className="text-muted" title={s.error ?? undefined}>{s.error ? s.error : ago(s.lastSyncAt)}</span> },
            { key: "a", header: <span className="sr-only">Actions</span>, end: true, cell: (s) => <span className="flex justify-end gap-2"><Button size="sm" onClick={() => setEdit(s)}>Selection</Button><Button size="sm" loading={run.isPending && run.variables === s.id} onClick={() => run.mutate(s.id)}>Sync now</Button></span> },
          ]} /></Panel>
        )}</Async>
      </Section>
      <SelectionDialog src={edit} onClose={() => setEdit(null)} />
    </>
  )
}
