import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { useSearch } from "wouter"
import { api, errMsg, type Memory } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { ago, bytes, dateTime, num } from "@/lib/format"
import { useDebounced } from "@/lib/hooks"
import { Icon } from "@/lib/icons"
import { Badge } from "@/ui/badge"
import { Button, LinkButton } from "@/ui/button"
import { cn } from "@/ui/cn"
import { Dialog, confirmDialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { Checkbox, Input, Select } from "@/ui/fields"
import { PageHeader, Panel, ErrorState } from "@/ui/page"
import { SkeletonRows } from "@/ui/skeleton"
import { useToast } from "@/ui/toast"

const PAGE = 40
const scopeLabel = (s: string) => (s === "shared" || s === "company" ? "Shared" : s.startsWith("channel") ? `Channel ${s.split("_").pop()}` : "Personal")
const MAX_UPLOAD = 20 * 1024 * 1024

function History({ m, onOpen }: { m: Memory; onOpen: (m: Memory) => void }) {
  const q = useQuery({ queryKey: ["memory-history", m.id], queryFn: () => api.memoryHistory(m.id) })
  if (q.isPending) return <SkeletonRows rows={2} />
  if (q.error) return <p className="text-sm text-danger">{errMsg(q.error)}</p>
  const chain = q.data
  if (chain.length <= 1) return <p className="text-sm text-muted">This memory has never been superseded.</p>
  return (
    <ol className="relative ml-2 border-l border-line-strong pl-4">
      {chain.map((h) => (
        <li key={h.id} className="relative pb-4 last:pb-0">
          <span className={cn("absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-bg", h.id === m.id ? "bg-accent" : h.status === "superseded" ? "bg-line-strong" : "bg-ok")} />
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>{dateTime(h.validAt ?? h.createdAt)}</span>
            {h.status === "superseded" ? <Badge>superseded</Badge> : <Badge tone="ok">current</Badge>}
            {h.id !== m.id && <button className="text-accent-text hover:underline" onClick={() => onOpen(h)}>Open</button>}
          </div>
          <p className={cn("mt-0.5 whitespace-pre-wrap break-words text-sm", h.status === "superseded" && "text-muted")}>{h.text}</p>
        </li>
      ))}
    </ol>
  )
}

function Detail({ m, onClose, admin, onDelete, onOpen }: { m: Memory | null; onClose: () => void; admin: boolean; onDelete: (m: Memory) => void; onOpen: (m: Memory) => void }) {
  return (
    <Dialog open={!!m} onClose={onClose} title="Memory" width={600} footer={m && admin ? <Button variant="danger" icon="trash" onClick={() => onDelete(m)}>Delete</Button> : undefined}>
      {m && (
        <div className="flex flex-col gap-4">
          <p className="whitespace-pre-wrap break-words text-sm">{m.text}</p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {([["Scope", scopeLabel(m.scopeTag)], ["Source", m.source], ["Reference", m.sourceRef ?? "None"], ["Created", dateTime(m.createdAt)], ["Status", m.status ?? "active"], ["Confidence", m.confidence != null ? `${Math.round(m.confidence * 100)}%` : "Not scored"]] as const).map(([k, v]) => (
              <div key={k} className="min-w-0"><dt className="eyebrow">{k}</dt><dd className="truncate">{v}</dd></div>
            ))}
          </dl>
          {m.permalink && <LinkButton href={m.permalink} external icon="external" size="sm" className="self-start">Open source</LinkButton>}
          <div><h3 className="mb-2 text-sm">History</h3><History m={m} onOpen={onOpen} /></div>
        </div>
      )}
    </Dialog>
  )
}

function DropZone({ onFiles, busy }: { onFiles: (f: File[]) => void; busy: boolean }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]) }}
      className={cn("mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-sm transition-colors", over ? "border-accent bg-accent-soft" : "border-line-strong")}>
      <Icon name="upload" className="text-muted" />
      <span className="flex-1 text-muted">Drop documents here to index them as shared memory. PDF, Markdown, text, CSV or HTML, up to 20 MB each.</span>
      <input ref={input} type="file" multiple hidden accept=".txt,.md,.pdf,.csv,.html,.htm,text/*,application/pdf" aria-label="Choose documents" onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = "" }} />
      <Button size="sm" loading={busy} onClick={() => input.current?.click()}>Choose files</Button>
    </div>
  )
}

export default function Memories() {
  const { admin } = useMe()
  const toast = useToast()
  const qc = useQueryClient()
  const urlQ = new URLSearchParams(useSearch()).get("q") ?? ""
  const [input, setInput] = useState(urlQ)
  useEffect(() => { setInput(urlQ) }, [urlQ])
  const q = useDebounced(input.trim(), 300)
  const [status, setStatus] = useState("active")
  const [scope, setScope] = useState("all")
  const [source, setSource] = useState("all")
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<Memory | null>(null)
  const [uploading, setUploading] = useState(false)

  const query = useInfiniteQuery({
    queryKey: ["memories", q, status],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.memories({ q, limit: PAGE, offset: pageParam, status }),
    getNextPageParam: (last, all) => { const n = all.reduce((a, p) => a + p.items.length, 0); return last.items.length === PAGE && n < last.total ? n : undefined },
  })
  const all = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data])
  const total = query.data?.pages[0]?.total ?? 0
  const sources = useMemo(() => [...new Set(all.map((m) => m.source))], [all])
  const items = useMemo(() => all.filter((m) => (scope === "all" || scopeLabel(m.scopeTag).split(" ")[0]!.toLowerCase() === scope) && (source === "all" || m.source === source)), [all, scope, source])
  useEffect(() => { setPicked(new Set()) }, [q, status, scope, source])

  const inv = [["memories"], ["graph"], ["overview"]]
  const remove = useAction(async (ids: number[]) => { await Promise.all(ids.map((id) => api.deleteMemory(id))); return ids.length }, {
    invalidate: inv, onSuccess: (n) => { toast.push({ kind: "success", title: n === 1 ? "Memory deleted" : `${n} memories deleted` }); setPicked(new Set()); setOpen(null) },
  })
  const del = async (ids: number[]) => {
    if (await confirmDialog({ title: ids.length === 1 ? "Delete this memory?" : `Delete ${ids.length} memories?`, body: "They are removed permanently and the bot will no longer recall them. Superseded history stays linked.", confirmLabel: "Delete", danger: true })) remove.mutate(ids)
  }

  const upload = async (files: File[]) => {
    if (!files.length) return
    setUploading(true)
    let ok = 0
    for (const f of files) {
      if (f.size > MAX_UPLOAD) { toast.push({ kind: "error", title: `${f.name} is too large`, body: `${bytes(f.size)}. The limit is 20 MB.` }); continue }
      try { await api.uploadMemory(f); ok++ } catch (e) { toast.push({ kind: "error", title: `Couldn't index ${f.name}`, body: errMsg(e) }) }
    }
    setUploading(false)
    if (ok) { toast.push({ kind: "success", title: ok === 1 ? "Document indexed" : `${ok} documents indexed` }); inv.forEach((k) => void qc.invalidateQueries({ queryKey: k })) }
  }

  const allOn = items.length > 0 && items.every((m) => picked.has(m.id))
  const filtered = q || status !== "active" || scope !== "all" || source !== "all"
  return (
    <>
      <PageHeader title="Memories" desc="Everything the brain remembers that you are allowed to see."
        actions={admin ? <LinkButton href="/api/export/memories" icon="download">Export Markdown</LinkButton> : undefined} />
      {admin && <DropZone onFiles={upload} busy={uploading} />}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-subtle" />
          <Input data-search type="search" aria-label="Search memories" placeholder="Search memories" className="w-64 pl-8" value={input} onChange={(e) => setInput(e.target.value)} />
        </div>
        <Select aria-label="Status" className="w-36" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Current</option><option value="superseded">Superseded</option><option value="all">All versions</option>
        </Select>
        <Select aria-label="Scope" className="w-32" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">All scopes</option><option value="shared">Shared</option><option value="channel">Channel</option><option value="personal">Personal</option>
        </Select>
        {sources.length > 1 && <Select aria-label="Source" className="w-32" value={source} onChange={(e) => setSource(e.target.value)}><option value="all">All sources</option>{sources.map((s) => <option key={s}>{s}</option>)}</Select>}
        <span className="ml-auto text-xs text-muted tabular-nums">{query.data ? `${num(items.length)} shown of ${num(total)}` : ""}</span>
      </div>

      {admin && picked.size > 0 && (
        <div role="region" aria-label="Bulk actions" className="mb-3 flex items-center gap-3 rounded-lg border border-accent-line bg-accent-soft px-3 py-2 text-sm">
          <span className="font-medium">{picked.size} selected</span>
          <Button size="sm" variant="danger" icon="trash" loading={remove.isPending} onClick={() => del([...picked])}>Delete</Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
        </div>
      )}

      <Panel>
        {query.isPending ? <SkeletonRows rows={8} /> : query.error ? <ErrorState error={query.error} retry={() => query.refetch()} /> : items.length === 0 ? (
          <EmptyState icon="memory" title={filtered ? "No memories match" : "No memories yet"}
            action={filtered ? <Button onClick={() => { setInput(""); setStatus("active"); setScope("all"); setSource("all") }}>Clear filters</Button> : undefined}>
            {filtered ? "Try a different search or loosen the filters." : "Memories appear as the bot learns from conversations. You can also drop a document above."}
          </EmptyState>
        ) : (
          <ul className="divide">
            {admin && (
              <li className="flex items-center gap-3 bg-sunken px-4 py-1.5 text-xs text-muted">
                <Checkbox label="Select all shown" checked={allOn} indeterminate={!allOn && picked.size > 0} onChange={(v) => setPicked(v ? new Set(items.map((m) => m.id)) : new Set())} />
                Select all shown
              </li>
            )}
            {items.map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-4 py-3 hover:bg-hover">
                {admin && <div className="pt-0.5"><Checkbox label={`Select memory ${m.id}`} checked={picked.has(m.id)} onChange={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(m.id); else n.delete(m.id); return n })} /></div>}
                <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(m)}>
                  <p className={cn("line-clamp-3 break-words text-sm", m.status === "superseded" && "text-muted line-through decoration-line-strong")}>{m.text}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <Badge tone="accent">{scopeLabel(m.scopeTag)}</Badge><Badge>{m.source}</Badge>
                    {m.status === "superseded" && <Badge tone="warn">superseded</Badge>}
                    {m.sourceRef && <span className="max-w-56 truncate">{m.sourceRef}</span>}
                    <span title={m.createdAt}>{ago(m.createdAt)}</span>
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {query.hasNextPage && <div className="mt-4 text-center"><Button loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>Load more</Button></div>}
      <Detail m={open} onClose={() => setOpen(null)} admin={admin} onDelete={(m) => del([m.id])} onOpen={setOpen} />
    </>
  )
}
