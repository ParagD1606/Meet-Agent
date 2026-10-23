import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Badge, Button, Card, Confirm, Empty, ErrorState, Input, PageTitle, Spinner, ago, useAction } from "@/lib/ui"

const PAGE = 30

export function Memories() {
  const { admin } = useMe()
  const [input, setInput] = useState("")
  const [q, setQ] = useState("")
  const [del, setDel] = useState<number | null>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => { const t = setTimeout(() => setQ(input.trim()), 300); return () => clearTimeout(t) }, [input])

  const query = useInfiniteQuery({
    queryKey: ["memories", q],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.memories(q, PAGE, pageParam),
    getNextPageParam: (last, all) => (last.length < PAGE ? undefined : all.length * PAGE),
  })
  const remove = useAction(api.deleteMemory, { invalidate: [["memories"], ["graph"], ["overview"]], ok: "Memory deleted" })
  const upload = useAction(api.uploadMemory, { invalidate: [["memories"], ["graph"], ["overview"]], ok: "Uploaded and indexed", onSuccess: () => { if (file.current) file.current.value = "" } })
  const items = query.data?.pages.flat() ?? []

  return (
    <>
      <PageTitle title="Memories" sub="Search everything the brain remembers that you can see."
        action={admin && (
          <>
            <input ref={file} type="file" hidden accept=".txt,.md,.pdf,.csv,.html,.htm,text/*,application/pdf" aria-label="Upload a document"
              onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
            <Button variant="primary" disabled={upload.isPending} onClick={() => file.current?.click()}>{upload.isPending ? "Uploading…" : "Upload document"}</Button>
          </>
        )} />
      <Input type="search" aria-label="Search memories" placeholder="Search memories…" value={input} onChange={(e) => setInput(e.target.value)} className="mb-4 max-w-md" />
      {query.isPending ? <Spinner /> : query.error ? <ErrorState error={query.error} retry={() => query.refetch()} /> : items.length === 0 ? (
        <Empty>{q ? `Nothing matches "${q}".` : "No memories yet."}</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((m) => (
            <li key={m.id}>
              <Card className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-sm">{m.text.length > 500 ? `${m.text.slice(0, 500)}…` : m.text}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone="primary">{m.scopeTag}</Badge><Badge>{m.source}</Badge>
                    {m.sourceRef && <span className="max-w-60 truncate">{m.sourceRef}</span>}<span>{ago(m.createdAt)}</span>
                  </p>
                </div>
                {admin && <Button size="sm" variant="danger" aria-label={`Delete memory ${m.id}`} onClick={() => setDel(m.id)}>Delete</Button>}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && <div className="mt-4 text-center"><Button disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more"}</Button></div>}
      <Confirm open={del !== null} onClose={() => setDel(null)} title="Delete memory?" body="This permanently removes the memory. The bot will no longer recall it." action="Delete" onYes={() => del !== null && remove.mutate(del)} />
    </>
  )
}
