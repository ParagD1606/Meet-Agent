import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { api, type Proactivity as P, type ProactivityMode } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { useDirtyGuard } from "@/lib/hooks"
import { Icon } from "@/lib/icons"
import { Button } from "@/ui/button"
import { EmptyState } from "@/ui/empty"
import { Input } from "@/ui/fields"
import { Async, PageHeader, Panel, Section } from "@/ui/page"
import { Segmented } from "@/ui/tabs"

const MODES: { id: ProactivityMode; label: string }[] = [{ id: "default", label: "Default" }, { id: "proactive", label: "Proactive" }, { id: "quiet", label: "Quiet" }]
const DEFAULTS = [
  { v: "own", title: "Only where invited", desc: "Reply to mentions and direct messages. Stay quiet otherwise." },
  { v: "all", title: "Proactive everywhere", desc: "May chime in on any channel the bot is in, rate limited per channel." },
] as const

export default function Proactivity() {
  const { admin } = useMe()
  const q = useQuery({ queryKey: ["proactivity"], queryFn: api.proactivity, enabled: admin })
  const [draft, setDraft] = useState<P | null>(null)
  const [filter, setFilter] = useState("")
  useEffect(() => { if (q.data) setDraft(q.data) }, [q.data])
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(q.data)
  useDirtyGuard(dirty)
  const save = useAction(api.saveProactivity, { invalidate: [["proactivity"]], ok: "Proactivity saved" })
  const channels = useMemo(() => (draft?.channels ?? []).filter((c) => c.name.toLowerCase().includes(filter.toLowerCase())), [draft, filter])

  if (!admin) return <><PageHeader title="Proactivity" /><Panel><EmptyState icon="lock" title="Admins only">Only admins can change when the bot joins conversations on its own.</EmptyState></Panel></>
  return (
    <>
      <PageHeader title="Proactivity" desc="Control when the bot speaks up uninvited. Direct messages and @mentions always work." actions={<Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => draft && save.mutate(draft)}>Save changes</Button>} />
      <Async q={q} rows={5}>
        {() => draft && (
          <>
            <Section title="Workspace default">
              <Panel>
                <fieldset className="divide">
                  <legend className="sr-only">Workspace default</legend>
                  {DEFAULTS.map((d) => (
                    <label key={d.v} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-hover">
                      <input type="radio" name="default" className="mt-1 accent-[var(--accent)]" checked={draft.default === d.v} onChange={() => setDraft({ ...draft, default: d.v })} />
                      <span><span className="block text-sm font-medium">{d.title}</span><span className="text-xs text-muted">{d.desc}</span></span>
                    </label>
                  ))}
                </fieldset>
              </Panel>
            </Section>
            <Section title="Channels" desc="Override the default per channel. Quiet channels are never observed for memory either." actions={<div className="relative"><Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-subtle" /><Input data-search type="search" aria-label="Filter channels" placeholder="Filter channels" className="w-48 pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>}>
              <Panel>
                {channels.length === 0 ? <EmptyState icon="hash" title={filter ? "No channels match" : "No channels yet"}>{filter ? "Try a different name." : "Invite the bot to a channel in Slack and it will show up here."}</EmptyState> : (
                  <ul className="divide">
                    {channels.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                        <span className="flex items-center gap-1.5 text-sm"><Icon name="hash" size={14} className="text-subtle" />{c.name}</span>
                        <Segmented label={`Mode for ${c.name}`} value={c.mode} items={MODES}
                          onChange={(mode) => setDraft({ ...draft, channels: draft.channels.map((x) => (x.id === c.id ? { ...x, mode } : x)) })} />
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </Section>
          </>
        )}
      </Async>
    </>
  )
}
