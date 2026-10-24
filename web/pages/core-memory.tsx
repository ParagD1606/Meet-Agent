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
import { ChannelPicker, useChannels } from "@/ui/channel-picker"
import { Segmented } from "@/ui/tabs"
import { useToast } from "@/ui/toast"

type Kind = "company" | "channel" | "user"
const COPY: Record<Kind, { title: string; desc: string }> = {
  company: { title: "Company", desc: "Facts every conversation should know: what the company does, product names, who owns what. Admins edit this block; changes by the bot go through review." },
  channel: { title: "Channel", desc: "Context for a single channel, such as the project it covers and its conventions. Only people in the channel can see it." },
  user: { title: "You", desc: "Things the bot should remember about you: your role, preferences and how you like answers. Only you can see this." },
}

const EXAMPLE: Record<Kind, string> = {
  company: "Acme sells invoicing software to agencies. Products: Ledger, Ledger Pro. Support is owned by Dana.",
  channel: "Project: billing revamp. Conventions: decisions go in the thread, deploys on Tuesdays, owner is Priya.",
  user: "I'm Ada, head of product. Keep answers short, with links. I prefer bullet points over paragraphs.",
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
  const about = text.split("\n").find((l) => l.startsWith("About: "))
  const limit = b?.charLimit ?? 1000
  const over = text.length > limit
  return (
    <Async q={q} rows={4}>{() => (
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(text) }}>
        <FormField label={COPY[kind].title} hint={COPY[kind].desc} error={save.error?.message}>
          {(p) => <Textarea {...p} rows={12} placeholder={canEdit ? `Example: ${EXAMPLE[kind]}` : "Nothing here yet."} value={text} readOnly={!canEdit} onChange={(e) => setText(e.target.value)} className={cn(over && "border-danger")} />}
        </FormField>
        {about && kind === "channel" && <p className="mt-2 rounded-md border border-line bg-sunken px-3 py-2 text-xs text-muted"><span className="font-medium text-fg">{about}</span><br />This line is generated automatically from the channel's conversations and may be rewritten.</p>}
        {!text.trim() && canEdit && <p className="mt-2 text-xs text-muted">Empty for now. Short, factual lines work best, for example: <em>{EXAMPLE[kind]}</em></p>}
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
  const { channels, label } = useChannels()
  const withNotes = channels.filter((c) => c.hasCoreBlock)
  const scope = kind === "channel" ? (channel ? `channel_${channel}` : "") : kind
  return (
    <>
      <PageHeader title="Core memory" desc="Small, always-on notes included in every prompt. Keep them short: the character limit exists because these cost tokens on every turn." />
      <div className="mb-4"><Segmented label="Block" value={kind} onChange={setKind} items={(Object.keys(COPY) as Kind[]).map((k) => ({ id: k, label: COPY[k].title }))} /></div>
      <Panel className="max-w-3xl p-4">
        {kind === "channel" && (
          <div className="mb-4 flex flex-col gap-3">
            <div className="text-sm font-medium">Choose a channel</div>
            <ChannelPicker label="Channel" value={channel} onChange={setChannel} />
            {withNotes.length > 0 && (
              <div>
                <div className="eyebrow mb-1.5">Channels with notes ({withNotes.length})</div>
                <div className="flex flex-wrap gap-1.5">
                  {withNotes.map((c) => <button key={c.id} type="button" aria-pressed={c.id === channel} className={cn("rounded-full border border-line px-2.5 py-0.5 text-xs hover:bg-hover", c.id === channel && "bg-hover font-medium")} onClick={() => setChannel(c.id)}>{label(c.id)}</button>)}
                </div>
              </div>
            )}
            {channel && <h2 className="border-t border-line pt-3 text-base">{label(channel)}</h2>}
          </div>
        )}
        {scope ? <Editor key={scope} scope={scope} kind={kind} admin={admin} /> : <p className="py-6 text-center text-sm text-muted">Pick a channel to view or edit its notes. Example: <em>{EXAMPLE.channel}</em></p>}
      </Panel>
    </>
  )
}
