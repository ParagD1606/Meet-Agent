import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type ModelSetting } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Async, Button, Card, Field, Input, PageTitle, Select, useAction } from "@/lib/ui"

const PROFILES = [
  { profile: "fast", label: "Fast", hint: "Triage, extraction and quick lookups." },
  { profile: "thorough", label: "Thorough", hint: "Answers, research and tool use." },
]
const PROVIDERS = ["anthropic", "openai", "google", "xai", "compat"]

/** GET may return an array of settings or an object keyed by profile. */
function normalise(d: unknown): Record<string, ModelSetting> {
  const out: Record<string, ModelSetting> = {}
  const arr = Array.isArray(d) ? d : d && typeof d === "object" ? Object.entries(d).map(([k, v]) => ({ profile: k, ...(v as object) })) : []
  for (const m of arr as Partial<ModelSetting>[]) if (m.profile) out[m.profile] = { profile: m.profile, provider: m.provider ?? "", model: m.model ?? "" }
  return out
}

function Row({ profile, label, hint, initial, admin }: { profile: string; label: string; hint: string; initial?: ModelSetting; admin: boolean }) {
  const [provider, setProvider] = useState(initial?.provider ?? "")
  const [model, setModel] = useState(initial?.model ?? "")
  const save = useAction(api.saveModel, { invalidate: [["models"]], ok: `${label} model saved` })
  return (
    <Card>
      <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); save.mutate({ profile, provider, model: model.trim() }) }}>
        <div className="sm:col-span-3"><h2 className="font-semibold">{label}</h2><p className="text-sm text-muted">{hint}</p></div>
        <Field label="Provider">{(id) => (
          <Select id={id} value={provider} disabled={!admin} onChange={(e) => setProvider(e.target.value)}>
            <option value="">Auto-detect from API key</option>
            {PROVIDERS.map((p) => <option key={p}>{p}</option>)}
          </Select>)}
        </Field>
        <Field label="Model">{(id) => <Input id={id} value={model} disabled={!admin} onChange={(e) => setModel(e.target.value)} placeholder="Provider default" />}</Field>
        {admin && <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>}
      </form>
    </Card>
  )
}

export function Models() {
  const { admin } = useMe()
  const q = useQuery({ queryKey: ["models"], queryFn: () => api.models().then(normalise) })
  return (
    <>
      <PageTitle title="Models" sub="Choose which model handles each kind of work. Leave blank to use the defaults for your API key." />
      <Async q={q}>
        {(m) => <div className="flex flex-col gap-4">{PROFILES.map((p) => <Row key={p.profile + JSON.stringify(m[p.profile])} {...p} initial={m[p.profile]} admin={admin} />)}</div>}
      </Async>
    </>
  )
}
