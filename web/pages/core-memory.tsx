import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type CoreBlock } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { useDirtyGuard } from "@/lib/hooks"
import { Button } from "@/ui/button"
import { cn } from "@/ui/cn"
import { FormField, Input, Textarea } from "@/ui/fields"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Segmented } from "@/ui/tabs"
import { useToast } from "@/ui/toast"

type Kind = "company" | "channel" | "user"
const COPY: Record<Kind, { title: string; desc: string }> = {
  company: { title: "Company", desc: "Facts every conversation should know: what the company does, product names, who owns what. Admins edit this block; changes by the bot go through review." },
  channel: { title: "Channel", desc: "Context for a single channel, such as the project it covers and its conventions. Only people in the channel can see it." },
  user: { title: "You", desc: "Things the bot should remember about you: your role, preferences and how you like answers. Only you can see this." },
}

function Editor({ scope, kind, admin }: { scope: string; kind: Kind; admin: boolean }) {
  const q = useQuery({ queryKey: ["core-block", scope], queryFn: () => api.coreBlock(scope), retry: false })
  const [text, setText] = useState("")
  const toast = useToast()
  useEffect(() => { if (q.data) setText(q.data.text) }, [q.data])
  const dirty = !!q.data && text !== q.data.text
  useDirtyGuard(dirty)
  const save = useAction((t: string) => api.saveCoreBlock(scope, t), {
    invalidate: [["core-block", scope]], inline: true,
    onSuccess: (r) => toast.push(r.queuedForReview ? { kind: "info", title: "Sent for review", body: "An admin needs to approve this change before it goes live." } : { kind: "success", title: "Core memory saved" }),
  })
  const canEdit = kind !== "company" || admin
  const b: CoreBlock | undefined = q.data
  const limit = b?.charLimit ?? 1000
  const over = text.length > limit
  return (
    <Async q={q} rows={4}>{() => (
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(text) }}>
        <FormField label={COPY[kind].title} hint={COPY[kind].desc} error={save.error?.message}>
          {(p) => <Textarea {...p} rows={12} value={text} readOnly={!canEdit} onChange={(e) => setText(e.target.value)} className={cn(over && "border-danger")} />}
        </FormField>
        <div className="mt-3 flex items-center gap-3">
          {canEdit ? <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || over}>Save</Button> : <span className="text-sm text-muted">Read-only. Ask an admin to change it.</span>}
          {dirty && <Button variant="ghost" onClick={() => setText(b!.text)}>Discard</Button>}
          <span className={cn("ml-auto text-xs tabular-nums", over ? "text-danger" : "text-muted")}>{text.length.toLocaleString()} / {limit.toLocaleString()}</span>
        </div>
      </form>
    )}</Async>
  )
}

export default function CoreMemory() {
  const { admin } = useMe()
  const [kind, setKind] = useState<Kind>("company")
  const [channel, setChannel] = useState("")
  const [applied, setApplied] = useState("")
  const scope = kind === "channel" ? (applied ? `channel_${applied}` : "") : kind
  return (
    <>
      <PageHeader title="Core memory" desc="Small, always-on notes included in every prompt. Keep them short: the character limit exists because these cost tokens on every turn." />
      <div className="mb-4"><Segmented label="Block" value={kind} onChange={setKind} items={(Object.keys(COPY) as Kind[]).map((k) => ({ id: k, label: COPY[k].title }))} /></div>
      <Panel className="max-w-3xl p-4">
        {kind === "channel" && (
          <form className="mb-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(channel.trim().replace(/^#/, "")) }}>
            <FormField label="Channel ID" hint="Find it in Slack: channel details, bottom of the About tab." className="flex-1">{(p) => <Input {...p} className="font-mono" placeholder="C0123456789" value={channel} onChange={(e) => setChannel(e.target.value)} />}</FormField>
            <Button type="submit" disabled={!channel.trim()}>Load</Button>
          </form>
        )}
        {scope ? <Editor key={scope} scope={scope} kind={kind} admin={admin} /> : <p className="py-6 text-center text-sm text-muted">Enter a channel ID to view or edit its block.</p>}
      </Panel>
    </>
  )
}
