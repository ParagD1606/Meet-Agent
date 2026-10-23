import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type Proactivity as P, type ProactivityMode } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Async, Button, Card, Empty, Input, PageTitle, cn, useAction } from "@/lib/ui"

const MODES: { v: ProactivityMode; label: string }[] = [{ v: "default", label: "Default" }, { v: "proactive", label: "Proactive" }, { v: "quiet", label: "Quiet" }]

export function Proactivity() {
  const { admin } = useMe()
  const q = useQuery({ queryKey: ["proactivity"], queryFn: api.proactivity, enabled: admin })
  const [draft, setDraft] = useState<P | null>(null)
  const [filter, setFilter] = useState("")
  useEffect(() => { if (q.data) setDraft(q.data) }, [q.data])
  const save = useAction(api.saveProactivity, { invalidate: [["proactivity"]], ok: "Proactivity saved" })

  if (!admin) return <><PageTitle title="Proactivity" /><Empty>Only admins can change when the bot chimes in.</Empty></>
  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(q.data)
  const channels = (draft?.channels ?? []).filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
  return (
    <>
      <PageTitle title="Proactivity" sub="Control when the bot joins conversations uninvited. DMs and @mentions always work." />
      <Async q={q}>
        {() => draft && (
          <div className="flex flex-col gap-5">
            <Card>
              <fieldset>
                <legend className="mb-2 font-semibold">Default behaviour</legend>
                {([["all", "Proactive everywhere", "Chime in on any channel the bot is in (rate limited)."], ["own", "Only where invited", "Reply only to mentions and DMs; stay quiet otherwise."]] as const).map(([v, t, d]) => (
                  <label key={v} className="flex cursor-pointer items-start gap-3 py-1.5">
                    <input type="radio" name="default" className="mt-1" checked={draft.default === v} onChange={() => setDraft({ ...draft, default: v })} />
                    <span><span className="block text-sm font-medium">{t}</span><span className="text-xs text-muted">{d}</span></span>
                  </label>
                ))}
              </fieldset>
            </Card>
            <section aria-labelledby="chan">
              <div className="mb-2 flex items-center justify-between gap-3"><h2 id="chan" className="font-semibold">Channels</h2>
                <Input type="search" aria-label="Filter channels" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-48" /></div>
              {channels.length === 0 ? <Empty>No channels{filter ? " match" : ": invite the bot to a channel first"}.</Empty> : (
                <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                  {channels.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                      <span className="text-sm">#{c.name}</span>
                      <div role="radiogroup" aria-label={`Mode for ${c.name}`} className="flex rounded-lg border border-line p-0.5">
                        {MODES.map((m) => (
                          <button key={m.v} type="button" role="radio" aria-checked={c.mode === m.v}
                            onClick={() => setDraft({ ...draft, channels: draft.channels.map((x) => (x.id === c.id ? { ...x, mode: m.v } : x)) })}
                            className={cn("cursor-pointer rounded-md px-3 py-1 text-xs", c.mode === m.v ? "bg-primary text-primary-fg" : "text-muted hover:text-fg")}>{m.label}</button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div><Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? "Saving…" : "Save changes"}</Button></div>
          </div>
        )}
      </Async>
    </>
  )
}
