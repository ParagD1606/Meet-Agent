import { useQuery } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { api, ApiError, fieldErr, type Skill } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { cn } from "@/ui/cn"
import { Dialog, confirmDialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { FormField, Input, Select, Switch, Textarea } from "@/ui/fields"
import { Async, PageHeader, Panel } from "@/ui/page"
import { Table } from "@/ui/table"
import { useToast } from "@/ui/toast"

type Draft = Partial<Skill> & { name: string; description: string; body: string; enabled: boolean; scope: "org" | "user" }
const blank = (admin: boolean): Draft => ({ name: "", description: "", body: "", enabled: true, scope: admin ? "org" : "user" })

function SkillDialog({ draft, setDraft, admin }: { draft: Draft | null; setDraft: (d: Draft | null) => void; admin: boolean }) {
  const save = useAction((s: Draft) => (s.id ? api.updateSkill(s as Skill) : api.createSkill(s)), { invalidate: [["skills"]], ok: "Skill saved", inline: true, onSuccess: () => setDraft(null) })
  const conflict = save.error instanceof ApiError && save.error.status === 409
  return (
    <Dialog open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? "Edit skill" : "New skill"} width={620}
      footer={<><Button onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => draft && save.mutate(draft)}>Save skill</Button></>}>
      {draft && (
        <div className="flex flex-col gap-4">
          {save.error && !fieldErr(save.error, "name") && !fieldErr(save.error, "description") && !fieldErr(save.error, "body") && <p role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">{conflict ? "Someone else changed this skill while you were editing. Close and reopen it to see their version." : save.error.message}</p>}
          <FormField label="Name" hint="Lowercase with dashes, for example weekly-report." error={fieldErr(save.error, "name")}>{(p) => <Input {...p} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="font-mono" />}</FormField>
          <FormField label="When to use it" hint="The bot sees only this line until it decides the skill is relevant." error={fieldErr(save.error, "description")}>{(p) => <Input {...p} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}</FormField>
          <FormField label="Instructions" hint="Markdown. Loaded in full only when the skill is used." error={fieldErr(save.error, "body")}>{(p) => <Textarea {...p} rows={10} className="font-mono text-xs" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />}</FormField>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {!draft.id && admin && <FormField label="Available to" className="w-52">{(p) => <Select {...p} value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as "org" | "user" })}><option value="org">Whole workspace</option><option value="user">Only me</option></Select>}</FormField>}
            <label className="flex items-center gap-2 text-sm"><Switch label="Enabled" checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />Enabled</label>
          </div>
        </div>
      )}
    </Dialog>
  )
}

export default function Skills() {
  const { me, admin } = useMe()
  const toast = useToast()
  const q = useQuery({ queryKey: ["skills"], queryFn: api.skills })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [over, setOver] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const inv = { invalidate: [["skills"]] }
  const toggle = useAction((s: Skill) => api.updateSkill({ ...s, enabled: !s.enabled }), inv)
  const remove = useAction(api.deleteSkill, { ...inv, ok: "Skill deleted" })
  const upload = useAction((f: File) => api.uploadSkill(f, admin ? "org" : "user"), { ...inv, ok: "Skill imported" })
  const canEdit = (s: Skill) => admin || (s.scope === "user" && s.ownerUserId === me?.id)
  const onFiles = (fs: File[]) => { const f = fs[0]; if (!f) return; if (!/\.md$/i.test(f.name)) { toast.push({ kind: "error", title: "Expected a SKILL.md file", body: "Upload a Markdown file with name and description in its front matter." }); return } upload.mutate(f) }
  const del = async (s: Skill) => { if (await confirmDialog({ title: `Delete "${s.name}"?`, body: "The bot will stop using it. This can't be undone.", confirmLabel: "Delete", danger: true })) remove.mutate(s.id) }

  return (
    <>
      <PageHeader title="Skills" desc="Reusable playbooks. The bot sees each skill's name and description, and loads the full instructions only when relevant."
        actions={<><input ref={file} type="file" hidden accept=".md,text/markdown" aria-label="Import SKILL.md" onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = "" }} />
          <Button icon="upload" loading={upload.isPending} onClick={() => file.current?.click()}>Import SKILL.md</Button><Button variant="primary" icon="plus" onClick={() => setDraft(blank(admin))}>New skill</Button></>} />
      <div onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]) }}
        className={cn("rounded-lg", over && "outline-2 outline-dashed outline-accent")}>
        <Async q={q} rows={4}>{(rows) => rows.length === 0 ? (
          <Panel><EmptyState icon="skills" title="No skills yet" action={<Button variant="primary" onClick={() => setDraft(blank(admin))}>Write a skill</Button>}>Skills teach the bot your recurring workflows, like how to write the weekly report. You can also drop a SKILL.md file here.</EmptyState></Panel>
        ) : (
          <Panel><Table caption="Skills" rows={rows} rowKey={(s) => s.id} columns={[
            { key: "n", header: "Skill", primary: true, sort: (s: Skill) => s.name, cell: (s) => <div className="min-w-0 py-1"><div className="font-mono text-[13px] font-medium">{s.name}</div><div className="max-w-xl truncate text-xs text-muted">{s.description}</div></div> },
            { key: "scope", header: "Scope", hideSm: true, cell: (s) => <Badge>{s.scope === "user" ? "Personal" : "Workspace"}</Badge> },
            { key: "on", header: "Enabled", cell: (s) => <Switch label={`Enable ${s.name}`} checked={s.enabled} disabled={!canEdit(s) || toggle.isPending} onChange={() => toggle.mutate(s)} /> },
            { key: "a", header: <span className="sr-only">Actions</span>, end: true, cell: (s) => canEdit(s) && <span className="flex justify-end gap-2"><Button size="sm" onClick={() => setDraft({ ...s, scope: s.scope ?? "org" })}>Edit</Button><Button size="sm" variant="danger" aria-label={`Delete ${s.name}`} onClick={() => del(s)}>Delete</Button></span> },
          ]} /></Panel>
        )}</Async>
      </div>
      <SkillDialog draft={draft} setDraft={setDraft} admin={admin} />
    </>
  )
}
