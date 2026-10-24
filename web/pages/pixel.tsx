import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { ACTION_CLASSES, FEATURES, api, fieldErr, type ActionClass, type ApprovalCards, type Feature, type Persona, type ProactiveFeatures, type WorkspaceHours } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useDirtyGuard } from "@/lib/hooks"
import { Button } from "@/ui/button"
import { ChannelPicker } from "@/ui/channel-picker"
import { FormField, Input, SettingRow, Select, Switch, Textarea } from "@/ui/fields"
import { Async, PageHeader, Panel, Section } from "@/ui/page"

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const FIELDS: { key: keyof Persona; label: string; hint: string; area?: boolean }[] = [
  { key: "name", label: "Name", hint: "What the bot calls itself in Slack." },
  { key: "role", label: "Role", hint: "One short phrase, such as \"your team's AI teammate\"." },
  { key: "tone", label: "Tone", hint: "How it sounds. Voice only: it never relaxes safety rules, permissions or approvals.", area: true },
  { key: "greeting", label: "Greeting", hint: "Optional. Leave empty to use \"Hi, I'm <name>. What can I help with?\"" },
]

/** Same rule as the server's personaGreeting: an empty greeting is derived from the name. */
const intro = (p: Persona) => p.greeting.trim() || `Hi, I'm ${p.name.trim() || "..."}. What can I help with?`

function PersonaCard() {
  const q = useQuery({ queryKey: ["persona"], queryFn: api.persona })
  const [d, setD] = useState<Persona | null>(null)
  useEffect(() => { if (q.data) setD(q.data.persona) }, [q.data])
  const dirty = !!d && !same(d, q.data?.persona)
  useDirtyGuard(dirty)
  const save = useAction(api.savePersona, { invalidate: [["persona"]], ok: "Persona saved", inline: true })
  return (
    <Async q={q} rows={4}>{(s) => d && (
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(d) }}>
        <Panel className="p-4">
          <div className="grid gap-4 md:grid-cols-2">
            {FIELDS.map((f) => (
              <FormField key={f.key} label={f.label} hint={`${f.hint} ${d[f.key].length}/${s.limits[f.key]}`} error={fieldErr(save.error, f.key)} className={f.area ? "md:col-span-2" : undefined}>
                {(p) => f.area
                  ? <Textarea {...p} rows={3} maxLength={s.limits[f.key]} value={d[f.key]} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />
                  : <Input {...p} maxLength={s.limits[f.key]} placeholder={s.defaults[f.key] || undefined} value={d[f.key]} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />}
              </FormField>
            ))}
          </div>
          <div className="mt-4 rounded-md border border-line bg-sunken px-3 py-2" aria-live="polite">
            <div className="eyebrow mb-1">Preview</div>
            <p className="text-sm"><span className="font-medium">{d.name.trim() || "..."}</span> <span className="text-muted">({d.role.trim() || "no role"})</span>: {intro(d)}</p>
          </div>
        </Panel>
        {save.error && !save.error.message.startsWith("Some fields") && <p role="alert" className="mt-2 text-sm text-danger">{save.error.message}</p>}
        <div className="mt-3 flex gap-2">
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !d.name.trim()}>Save persona</Button>
          <Button onClick={() => setD(s.defaults)} disabled={same(d, s.defaults)}>Reset to defaults</Button>
        </div>
      </form>
    )}</Async>
  )
}

const CLASS_COPY: Record<ActionClass, { title: string; desc: string }> = {
  ticket: { title: "Tickets", desc: "Creating or changing tickets in Jira, Linear and similar." },
  slack_post: { title: "Slack posts", desc: "Posting messages to channels on someone's behalf." },
  doc_edit: { title: "Document edits", desc: "Editing docs, pages and files in connected tools." },
  email_calendar: { title: "Email and calendar", desc: "Sending email and creating or changing events." },
}

function ApprovalsCard() {
  const q = useQuery({ queryKey: ["approvals"], queryFn: api.approvals })
  const [d, setD] = useState<ApprovalCards | null>(null)
  useEffect(() => { if (q.data) setD(q.data.cards) }, [q.data])
  const dirty = !!d && !same(ACTION_CLASSES.map((k) => !!d[k]), ACTION_CLASSES.map((k) => !!q.data?.cards[k]))
  useDirtyGuard(dirty)
  const save = useAction(api.saveApprovals, { invalidate: [["approvals"]], ok: "Approvals saved" })
  return (
    <Async q={q} rows={4}>{() => d && (
      <>
        <Panel className="divide px-4">
          {ACTION_CLASSES.map((k) => (
            <SettingRow key={k} title={CLASS_COPY[k].title} desc={CLASS_COPY[k].desc}>
              <Switch label={`Ask for approval before: ${CLASS_COPY[k].title}`} checked={!!d[k]} onChange={(v) => setD({ ...d, [k]: v })} />
            </SettingRow>
          ))}
        </Panel>
        <p className="mt-2 text-xs text-muted">Deletes and any action that isn't classified always get an approval card, whatever these are set to.</p>
        <div className="mt-3"><Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(d)}>Save approvals</Button></div>
      </>
    )}</Async>
  )
}

const FEATURE_COPY: Record<Feature, { title: string; desc: string }> = {
  digest: { title: "Digest", desc: "Posts a periodic summary of what happened in the channel." },
  nudge: { title: "Nudges", desc: "Reminds owners of open commitments." },
  deadlines: { title: "Deadlines", desc: "Flags upcoming and missed due dates." },
  autoreply: { title: "Auto-reply", desc: "Answers questions it can confidently answer without being mentioned." },
  standup: { title: "Standup", desc: "Collects and posts a daily standup." },
  risks: { title: "Risks", desc: "Posts risks it spots, such as overdue work with no owner." },
}

function FeaturesCard() {
  const q = useQuery({ queryKey: ["proactive-features"], queryFn: api.proactiveFeatures })
  const [d, setD] = useState<ProactiveFeatures | null>(null)
  useEffect(() => { if (q.data) setD(q.data) }, [q.data])
  const dirty = !!d && !same(d, q.data)
  useDirtyGuard(dirty)
  const save = useAction(api.saveProactiveFeatures, { invalidate: [["proactive-features"]], ok: "Features saved" })
  return (
    <Async q={q} rows={4}>{() => d && (
      <>
        <div className="grid gap-4 md:grid-cols-2">
          {FEATURES.map((f) => (
            <Panel key={f} className="p-4">
              <h3 className="text-sm font-medium">{FEATURE_COPY[f].title} <span className="ml-1 text-xs font-normal text-muted">{d[f].length ? `${d[f].length} channel${d[f].length === 1 ? "" : "s"}` : "off"}</span></h3>
              <p className="mb-3 mt-0.5 text-xs text-muted">{FEATURE_COPY[f].desc}</p>
              <ChannelPicker multiple label={`Channels for ${FEATURE_COPY[f].title}`} value={d[f]} onChange={(ids) => setD({ ...d, [f]: ids })} />
            </Panel>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">Each feature is off until you pick at least one channel.</p>
        <div className="mt-3"><Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(d)}>Save features</Button></div>
      </>
    )}</Async>
  )
}

const ZONES: string[] = (() => { try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone") } catch { return ["UTC"] } })()
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`

function HoursCard() {
  const q = useQuery({ queryKey: ["workspace-hours"], queryFn: api.workspaceHours })
  const [d, setD] = useState<WorkspaceHours | null>(null)
  const [zq, setZq] = useState("")
  useEffect(() => { if (q.data) setD(q.data) }, [q.data])
  const dirty = !!d && !same(d, q.data)
  useDirtyGuard(dirty)
  const save = useAction(api.saveWorkspaceHours, { invalidate: [["workspace-hours"]], ok: "Workspace hours saved", inline: true })
  const tz = d?.timezone
  const zones = useMemo(() => {
    const f = zq.trim().toLowerCase().replace(/ /g, "_")
    const list = f ? ZONES.filter((z) => z.toLowerCase().includes(f)) : ZONES
    return tz && !list.includes(tz) ? [tz, ...list] : list
  }, [zq, tz])
  return (
    <Async q={q} rows={4}>{() => d && (
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(d) }}>
        <Panel className="p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <FormField label="Find a timezone" hint={`${zones.length} match${zones.length === 1 ? "" : "es"}. Type a city or region, such as "kolkata" or "europe".`}>{(p) => <Input {...p} type="search" value={zq} onChange={(e) => setZq(e.target.value)} />}</FormField>
            <FormField label="Timezone" error={fieldErr(save.error, "timezone")}>{(p) => <Select {...p} value={d.timezone} onChange={(e) => setD({ ...d, timezone: e.target.value })}>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</Select>}</FormField>
            <FormField label="Day starts" error={fieldErr(save.error, "start")}>{(p) => <Select {...p} value={d.start} onChange={(e) => setD({ ...d, start: +e.target.value })}>{HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select>}</FormField>
            <FormField label="Day ends" hint={d.end <= d.start ? "Ends before it starts: the working day runs past midnight." : undefined} error={fieldErr(save.error, "end")}>{(p) => <Select {...p} value={d.end} onChange={(e) => setD({ ...d, end: +e.target.value })}>{HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</Select>}</FormField>
            <FormField label="History backfill days" hint="How far back to learn from channel history (1 to 90)." error={fieldErr(save.error, "backfillDays")}>{(p) => <Input {...p} type="number" min={1} max={90} step={1} className="w-28" value={d.backfillDays} onChange={(e) => setD({ ...d, backfillDays: Math.round(+e.target.value) })} />}</FormField>
          </div>
          <div className="divide mt-2">
            <SettingRow title="Hold messages outside working hours" desc="Proactive posts (digests, nudges, standups) wait until the next working hour instead of going out at night.">
              <Switch label="Hold messages outside working hours" checked={d.quietHours} onChange={(v) => setD({ ...d, quietHours: v })} />
            </SettingRow>
          </div>
        </Panel>
        {save.error && !save.error.message.startsWith("Some fields") && <p role="alert" className="mt-2 text-sm text-danger">{save.error.message}</p>}
        <div className="mt-3"><Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty || !(d.backfillDays >= 1 && d.backfillDays <= 90)}>Save hours</Button></div>
      </form>
    )}</Async>
  )
}

export default function Pixel() {
  return (
    <>
      <PageHeader title="Pixel" desc="The bot's name and voice, which actions need your approval, and where its proactive features run." />
      <Section title="Persona" desc="Changes how it sounds and introduces itself."><PersonaCard /></Section>
      <Section title="Approvals" desc="Show an approval card before the bot does these things."><ApprovalsCard /></Section>
      <Section title="Proactive features" desc="Opt channels in, feature by feature."><FeaturesCard /></Section>
      <Section title="Workspace hours" desc="When your team works, and how far back the bot learns from history."><HoursCard /></Section>
    </>
  )
}
