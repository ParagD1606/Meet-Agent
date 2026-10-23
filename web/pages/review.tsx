import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Review } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useUserNames } from "@/lib/auth"
import { ago } from "@/lib/format"
import { Badge, type Tone } from "@/ui/badge"
import { Button } from "@/ui/button"
import { EmptyState } from "@/ui/empty"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Segmented } from "@/ui/tabs"

const KIND: Record<Review["kind"], { label: string; tone: Tone; why: string }> = {
  supersede: { label: "Replaces a memory", tone: "accent", why: "The bot found newer information that contradicts an existing memory." },
  low_confidence: { label: "Low confidence", tone: "warn", why: "The bot wasn't sure this is true, so it is held back from recall." },
  core_block: { label: "Core memory edit", tone: "accent", why: "The bot wants to change an always-on core memory block." },
  shared_write: { label: "Shared write", tone: "neutral", why: "A member's note wants to become workspace-wide knowledge." },
}
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v))

function Body({ r }: { r: Review }) {
  const p = r.payload
  if (r.kind === "core_block") {
    return (
      <div className="text-sm">
        <div className="text-xs text-muted">{s(p.label)} block, operation: {s(p.op)}</div>
        {p.match ? <p className="mt-1 text-muted line-through decoration-line-strong">{s(p.match)}</p> : null}
        {p.text ? <p className="mt-1 whitespace-pre-wrap break-words">{s(p.text)}</p> : <p className="mt-1 text-muted">Removes the matching text.</p>}
      </div>
    )
  }
  const ids = (p.supersededIds ?? p.wouldSupersede) as number[] | undefined
  return (
    <div className="text-sm">
      <p className="whitespace-pre-wrap break-words">{r.memory?.text ?? s(p.text) ?? "Memory text unavailable"}</p>
      {ids && ids.length > 0 && <p className="mt-1 text-xs text-muted">{r.kind === "supersede" ? "Already replaced" : "Would replace"} {ids.length} earlier {ids.length === 1 ? "memory" : "memories"} ({ids.slice(0, 4).map((i) => `#${i}`).join(", ")}). Rejecting restores {ids.length === 1 ? "it" : "them"}.</p>}
    </div>
  )
}

export default function ReviewQueue() {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending")
  const q = useQuery({ queryKey: ["reviews", status], queryFn: () => api.reviews(status) })
  const names = useUserNames()
  const decide = useAction((v: { id: string; approve: boolean }) => api.decideReview(v.id, v.approve), {
    invalidate: [["reviews"], ["memories"], ["graph"], ["core-block"]], onSuccess: (_, v) => void v,
  })
  const [done, setDone] = useState<Record<string, string>>({})
  return (
    <>
      <PageHeader title="Review queue" desc="Changes the bot isn't allowed to make on its own. Approve to apply them, reject to discard." actions={<Segmented label="Status" value={status} onChange={setStatus} items={[{ id: "pending", label: "Pending" }, { id: "approved", label: "Approved" }, { id: "rejected", label: "Rejected" }]} />} />
      <Async q={q} rows={4}>{(rows) => rows.length === 0 ? (
        <Panel><EmptyState icon="review" title={status === "pending" ? "Nothing waiting for review" : `No ${status} items`}>{status === "pending" ? "When the bot proposes a risky change, it lands here." : "Decisions you make will be listed here."}</EmptyState></Panel>
      ) : (
        <Panel><ul className="divide">{rows.map((r) => {
          const k = KIND[r.kind] ?? { label: r.kind, tone: "neutral" as Tone, why: "" }
          const busy = decide.isPending && decide.variables?.id === r.id
          return (
            <li key={r.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted"><Badge tone={k.tone}>{k.label}</Badge><span>{names.name(r.requestedBy)} · {ago(r.createdAt)}</span>{done[r.id] && <Badge tone="ok">{done[r.id]}</Badge>}</div>
                <Body r={r} />
                <p className="mt-1.5 text-xs text-subtle">{k.why}</p>
              </div>
              {status === "pending" && !done[r.id] && (
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" disabled={busy} onClick={() => decide.mutate({ id: r.id, approve: false }, { onSuccess: () => setDone((d) => ({ ...d, [r.id]: "Rejected" })) })}>Reject</Button>
                  <Button size="sm" variant="primary" loading={busy} onClick={() => decide.mutate({ id: r.id, approve: true }, { onSuccess: () => setDone((d) => ({ ...d, [r.id]: "Approved" })) })}>Approve</Button>
                </div>
              )}
            </li>)
        })}</ul></Panel>
      )}</Async>
    </>
  )
}
