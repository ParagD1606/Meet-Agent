import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type ModelSettings, type Role5 } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { EmptyState } from "@/ui/empty"
import { FormField, Input, Select } from "@/ui/fields"
import { Async, PageHeader, Panel, Section } from "@/ui/page"
import { Segmented } from "@/ui/tabs"

const ROLES: { id: Role5; label: string; desc: string }[] = [
  { id: "main", label: "Answers", desc: "Replies, tool use and long answers." },
  { id: "triage", label: "Triage", desc: "Decides whether to chime in. Cheap and fast." },
  { id: "extract", label: "Extraction", desc: "Pulls facts out of threads and documents." },
  { id: "summarize", label: "Summaries", desc: "Thread summaries and memory consolidation." },
  { id: "research", label: "Research", desc: "Multi-step research runs." },
]
const roleModel = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && "model" in v ? String((v as { model: unknown }).model ?? "") : "")

function ModelPicker({ id, value, onChange, s, disabled }: { id?: string; value: string; onChange: (v: string) => void; s: ModelSettings; disabled?: boolean }) {
  if (s.freeText || s.models.length === 0) return <Input id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder="Model name, e.g. llama3.2" />
  return <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}><option value="">Provider default</option>{s.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select>
}

export default function Models() {
  const { admin } = useMe()
  const q = useQuery({ queryKey: ["models"], queryFn: api.models })
  const [profile, setProfile] = useState("thorough")
  const [model, setModel] = useState("")
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [fallback, setFallback] = useState("")
  useEffect(() => {
    const d = q.data
    if (!d) return
    setProfile(d.profile ?? "thorough"); setModel(d.model ?? "")
    setRoles(Object.fromEntries(ROLES.map((r) => [r.id, roleModel(d.roles?.[r.id])])))
    setFallback(roleModel(d.fallback))
  }, [q.data])
  const save = useAction(async (s: ModelSettings) => {
    let r = await api.saveModel({ profile, provider: s.provider ?? undefined, model: model || null })
    if (s.roles) for (const role of ROLES) if (roleModel(s.roles[role.id]) !== (roles[role.id] ?? "")) r = await api.saveModel({ role: role.id, model: roles[role.id] || null })
    if (s.fallback !== undefined && roleModel(s.fallback) !== fallback) r = await api.saveModel({ fallback: fallback || null })
    return r
  }, { invalidate: [["models"]], ok: "Model settings saved", inline: true })

  return (
    <>
      <PageHeader title="Models" desc="Which model does which job. Leave a field on the provider default unless you have a reason to change it." />
      <Async q={q} rows={4}>{(s) => !s.provider ? (
        <Panel><EmptyState icon="models" title="No model provider configured">Set an API key or base URL in the server environment and restart. The provider is detected from the key.</EmptyState></Panel>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(s) }}>
          <Section title="Provider"><div className="flex items-center gap-2 text-sm"><Badge tone="accent">{s.provider}</Badge><span className="text-muted">Detected from the server's API key. Change it in the environment.</span></div></Section>
          <Section title="Default behaviour">
            <Panel className="p-4"><div className="grid max-w-2xl gap-4 sm:grid-cols-2">
              <FormField label="Profile" hint="Fast favours latency and cost. Thorough favours quality.">{() => <Segmented label="Profile" value={profile as "fast" | "thorough"} onChange={setProfile} items={[{ id: "fast", label: "Fast" }, { id: "thorough", label: "Thorough" }]} />}</FormField>
              <FormField label="Model override" hint="Used for answers when set.">{(p) => <ModelPicker id={p.id} s={s} value={model} onChange={setModel} disabled={!admin} />}</FormField>
            </div></Panel>
          </Section>
          {s.roles && (
            <Section title="Per-job models" desc="Cheap models for triage, extraction and summaries keep token cost down.">
              <Panel className="divide">{ROLES.map((r) => (
                <div key={r.id} className="grid items-center gap-2 px-4 py-3 sm:grid-cols-[1fr_280px]">
                  <div><div className="text-sm font-medium">{r.label}</div><div className="text-xs text-muted">{r.desc}</div></div>
                  <ModelPicker s={s} value={roles[r.id] ?? ""} onChange={(v) => setRoles({ ...roles, [r.id]: v })} disabled={!admin} />
                </div>))}
                {s.fallback !== undefined && (
                  <div className="grid items-center gap-2 px-4 py-3 sm:grid-cols-[1fr_280px]">
                    <div><div className="text-sm font-medium">Fallback</div><div className="text-xs text-muted">Used when the main model errors or is rate limited.</div></div>
                    <ModelPicker s={s} value={fallback} onChange={setFallback} disabled={!admin} />
                  </div>)}
              </Panel>
            </Section>
          )}
          {save.error && <p role="alert" className="mb-3 text-sm text-danger">{save.error.message}</p>}
          {admin ? <Button type="submit" variant="primary" loading={save.isPending}>Save</Button> : <p className="text-sm text-muted">Only admins can change models.</p>}
        </form>
      )}</Async>
    </>
  )
}
