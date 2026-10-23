import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Automation } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Async, Badge, Button, Confirm, Field, Input, Modal, PageTitle, Select, Textarea, ago, useAction } from "@/lib/ui"

const CRONS = [["0 9 * * 1-5", "Weekdays at 09:00"], ["0 9 * * 1", "Mondays at 09:00"], ["0 17 * * 5", "Fridays at 17:00"], ["0 * * * *", "Every hour"]]
type Draft = { kind: "digest" | "reminder"; prompt: string; cron: string; runAt: string; destChannelId: string }
const blank: Draft = { kind: "digest", prompt: "", cron: CRONS[0]![0], runAt: "", destChannelId: "" }

export function Automations() {
  const { me, admin } = useMe()
  const q = useQuery({ queryKey: ["automations"], queryFn: api.automations })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [recurring, setRecurring] = useState(true)
  const [del, setDel] = useState<Automation | null>(null)
  const inv = { invalidate: [["automations"], ["overview"]] }
  const create = useAction(api.createAutomation, { ...inv, ok: "Automation created", onSuccess: () => setDraft(null) })
  const toggle = useAction((a: Automation) => api.patchAutomation(a.id, { enabled: !a.enabled }), inv)
  const run = useAction(api.runAutomation, { ...inv, ok: "Run started" })
  const remove = useAction(api.deleteAutomation, { ...inv, ok: "Automation deleted" })

  const submit = (d: Draft) => {
    const body: Partial<Automation> = { kind: d.kind, prompt: d.prompt.trim(), destChannelId: d.destChannelId.trim() || null }
    if (recurring) body.cron = d.cron.trim(); else body.runAt = new Date(d.runAt).toISOString()
    create.mutate(body)
  }
  return (
    <>
      <PageTitle title="Automations" sub="Scheduled digests and reminders. Digests run read-only against org connections and post to a channel (or DM you)."
        action={<Button variant="primary" onClick={() => setDraft(blank)}>New automation</Button>} />
      <Async q={q} empty="No automations yet.">
        {(rows) => (
          <ul className="flex flex-col gap-2">
            {rows.map((a) => {
              const mine = a.ownerUserId === me?.id
              return (
                <li key={a.id} className="rounded-xl border border-line bg-surface p-4">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone="primary">{a.kind}</Badge>
                    <Badge>{a.cron ? `cron ${a.cron}` : a.runAt ? `once ${new Date(a.runAt).toLocaleString()}` : "no schedule"}</Badge>
                    {!a.enabled && <Badge tone="warn">paused</Badge>}
                    {a.lastStatus && <Badge tone={/ok|success|done|sent/i.test(a.lastStatus) ? "ok" : "warn"}>{a.lastStatus}</Badge>}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{a.prompt}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="mr-auto text-xs text-muted">to {a.destChannelId ?? "owner DM"} · last run {ago(a.lastRunAt)}</span>
                    {(mine || admin) && <>
                      <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(a.id)}>Run now</Button>
                      <Button size="sm" onClick={() => toggle.mutate(a)}>{a.enabled ? "Pause" : "Resume"}</Button>
                      <Button size="sm" variant="danger" aria-label="Delete automation" onClick={() => setDel(a)}>Delete</Button>
                    </>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Async>
      <Modal open={!!draft} onClose={() => setDraft(null)} title="New automation">
        {draft && (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(draft) }}>
            <Field label="Type">{(id) => (
              <Select id={id} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft["kind"] })}>
                <option value="digest">Digest (the bot researches and summarises)</option><option value="reminder">Reminder (posts your text)</option>
              </Select>)}
            </Field>
            <Field label={draft.kind === "digest" ? "What should the digest cover?" : "Reminder text"}>{(id) => <Textarea id={id} required rows={3} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />}</Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} /> Repeats</label>
            {recurring ? (
              <Field label="Schedule (cron, minimum every hour)">{(id) => (
                <>
                  <Input id={id} required value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} className="font-mono" />
                  <div className="flex flex-wrap gap-1">{CRONS.map(([c, l]) => <button type="button" key={c} onClick={() => setDraft({ ...draft, cron: c! })} className="cursor-pointer rounded-md bg-raised px-2 py-1 text-xs hover:text-primary">{l}</button>)}</div>
                </>)}
              </Field>
            ) : (
              <Field label="Run at">{(id) => <Input id={id} type="datetime-local" required value={draft.runAt} onChange={(e) => setDraft({ ...draft, runAt: e.target.value })} />}</Field>
            )}
            <Field label="Destination channel ID" hint="Leave empty to DM yourself. The bot must be a member of the channel.">{(id) => <Input id={id} placeholder="C0123456789" value={draft.destChannelId} onChange={(e) => setDraft({ ...draft, destChannelId: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2"><Button onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" variant="primary" disabled={create.isPending}>Create</Button></div>
          </form>
        )}
      </Modal>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Delete automation?" body="It will stop running and cannot be restored." action="Delete" onYes={() => del && remove.mutate(del.id)} />
    </>
  )
}
