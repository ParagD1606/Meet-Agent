import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { api, fieldErr, type Automation } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { describeCron, nextRuns } from "@/lib/cron"
import { ago, dateTime } from "@/lib/format"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { Dialog, confirmDialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { FormField, Input, Select, Switch, Textarea } from "@/ui/fields"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Segmented } from "@/ui/tabs"
import { Table } from "@/ui/table"

const PRESETS: [string, string][] = [["0 9 * * 1-5", "Weekdays 9:00"], ["0 9 * * 1", "Mondays 9:00"], ["0 17 * * 5", "Fridays 17:00"], ["0 * * * *", "Hourly"]]
interface Draft { kind: "digest" | "reminder"; prompt: string; repeat: "cron" | "once"; cron: string; runAt: string; dest: string }
const blank: Draft = { kind: "digest", prompt: "", repeat: "cron", cron: "0 9 * * 1-5", runAt: "", dest: "" }

function CronPreview({ expr }: { expr: string }) {
  const r = useMemo(() => { try { return { text: describeCron(expr), runs: nextRuns(expr, 3), err: null } } catch (e) { return { text: "", runs: [], err: e instanceof Error ? e.message : "Invalid schedule" } } }, [expr])
  if (r.err) return <p role="alert" className="text-xs text-danger">{r.err}</p>
  return <div className="rounded-md bg-sunken px-3 py-2 text-xs"><div className="font-medium">{r.text}</div>{r.runs.length > 0 && <div className="mt-1 text-muted">Next: {r.runs.map((d) => dateTime(d.toISOString())).join("  ·  ")}</div>}</div>
}

function NewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [d, setD] = useState<Draft>(blank)
  const create = useAction(api.createAutomation, { invalidate: [["automations"], ["overview"]], ok: "Automation created", inline: true, onSuccess: () => { onClose(); setD(blank) } })
  const cronBad = d.repeat === "cron" && (() => { try { nextRuns(d.cron, 1); return false } catch { return true } })()
  const submit = () => {
    const body: Partial<Automation> = { kind: d.kind, prompt: d.prompt.trim(), destChannelId: d.dest.trim() || null }
    if (d.repeat === "cron") body.cron = d.cron.trim(); else if (d.runAt) body.runAt = new Date(d.runAt).toISOString()
    create.mutate(body)
  }
  const valid = d.prompt.trim() && !cronBad && (d.repeat === "cron" || d.runAt)
  return (
    <Dialog open={open} onClose={onClose} title="New automation" width={560} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!valid} onClick={submit}>Create</Button></>}>
      <div className="flex flex-col gap-4">
        <FormField label="Type">{() => <Segmented label="Type" value={d.kind} onChange={(kind) => setD({ ...d, kind })} items={[{ id: "digest", label: "Digest" }, { id: "reminder", label: "Reminder" }]} />}</FormField>
        <FormField label={d.kind === "digest" ? "What should the digest cover?" : "Reminder text"} hint={d.kind === "digest" ? "The bot researches read-only with workspace connections and posts a summary." : "Posted exactly as written."} error={fieldErr(create.error, "prompt")}>
          {(p) => <Textarea {...p} rows={3} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} />}
        </FormField>
        <FormField label="Repeats">{() => <Segmented label="Repeats" value={d.repeat} onChange={(repeat) => setD({ ...d, repeat })} items={[{ id: "cron", label: "On a schedule" }, { id: "once", label: "Once" }]} />}</FormField>
        {d.repeat === "cron" ? (
          <FormField label="Schedule" hint="Cron: minute hour day month weekday. The minimum interval is one hour." error={fieldErr(create.error, "cron") ?? (cronBad ? "Not a valid cron expression" : null)}>
            {(p) => <>
              <Input {...p} className="font-mono" value={d.cron} onChange={(e) => setD({ ...d, cron: e.target.value })} />
              <div className="flex flex-wrap gap-1.5">{PRESETS.map(([c, l]) => <button type="button" key={c} onClick={() => setD({ ...d, cron: c })} className="rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg">{l}</button>)}</div>
              <CronPreview expr={d.cron} />
            </>}
          </FormField>
        ) : <FormField label="Run at" error={fieldErr(create.error, "runAt")}>{(p) => <Input {...p} type="datetime-local" value={d.runAt} onChange={(e) => setD({ ...d, runAt: e.target.value })} />}</FormField>}
        <FormField label="Destination channel ID" optional hint="Leave empty to DM yourself. The bot must be a member of the channel." error={fieldErr(create.error, "destChannelId")}>{(p) => <Input {...p} className="font-mono" placeholder="C0123456789" value={d.dest} onChange={(e) => setD({ ...d, dest: e.target.value })} />}</FormField>
        {create.error && !fieldErr(create.error, "prompt") && !fieldErr(create.error, "cron") && !fieldErr(create.error, "runAt") && !fieldErr(create.error, "destChannelId") && <p role="alert" className="text-sm text-danger">{create.error.message}</p>}
      </div>
    </Dialog>
  )
}

export default function Automations() {
  const { me, admin } = useMe()
  const q = useQuery({ queryKey: ["automations"], queryFn: api.automations })
  const [open, setOpen] = useState(false)
  const inv = { invalidate: [["automations"], ["overview"]] }
  const toggle = useAction((a: Automation) => api.patchAutomation(a.id, { enabled: !a.enabled }), inv)
  const run = useAction(api.runAutomation, { ...inv, ok: "Run started" })
  const remove = useAction(api.deleteAutomation, { ...inv, ok: "Automation deleted" })
  const del = async (a: Automation) => { if (await confirmDialog({ title: "Delete this automation?", body: "It stops running and can't be restored.", confirmLabel: "Delete", danger: true })) remove.mutate(a.id) }
  return (
    <>
      <PageHeader title="Automations" desc="Scheduled digests and reminders. Digests run read-only against workspace connections and post to a channel, or DM you."
        actions={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New automation</Button>} />
      <Async q={q} rows={4}>{(rows) => rows.length === 0 ? (
        <Panel><EmptyState icon="clock" title="No automations yet" action={<Button variant="primary" onClick={() => setOpen(true)}>Create one</Button>}>Try a Monday digest of what shipped last week, or a Friday reminder to update the roadmap.</EmptyState></Panel>
      ) : (
        <Panel><Table caption="Automations" rows={rows} rowKey={(a) => a.id} columns={[
          { key: "p", header: "Automation", primary: true, cell: (a: Automation) => <div className="min-w-0 py-1"><div className="max-w-md truncate font-medium">{a.prompt}</div><div className="text-xs text-muted">{a.kind === "digest" ? "Digest" : "Reminder"} · {a.cron ? describeCron(a.cron) : a.runAt ? `Once, ${dateTime(a.runAt)}` : "No schedule"}</div></div> },
          { key: "dest", header: "Posts to", hideSm: true, cell: (a) => <span className="font-mono text-xs text-muted">{a.destChannelId ?? "Owner DM"}</span> },
          { key: "last", header: "Last run", hideSm: true, cell: (a) => <span className="flex items-center gap-2 text-muted">{ago(a.lastRunAt)}{a.lastStatus && <Badge tone={/ok|success|done|sent/i.test(a.lastStatus) ? "ok" : "warn"}>{a.lastStatus}</Badge>}</span> },
          { key: "on", header: "Active", cell: (a) => <Switch label="Active" checked={a.enabled} disabled={a.ownerUserId !== me?.id && !admin} onChange={() => toggle.mutate(a)} /> },
          { key: "a", header: <span className="sr-only">Actions</span>, end: true, cell: (a) => (a.ownerUserId === me?.id || admin) && <span className="flex justify-end gap-2"><Button size="sm" icon="play" loading={run.isPending && run.variables === a.id} onClick={() => run.mutate(a.id)}>Run now</Button><Button size="sm" variant="danger" aria-label="Delete automation" onClick={() => del(a)}>Delete</Button></span> },
        ]} /></Panel>
      )}</Async>
      <NewDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
