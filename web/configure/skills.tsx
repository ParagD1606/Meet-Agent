import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Skill } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Async, Badge, Button, Confirm, Field, Input, Modal, PageTitle, Textarea, useAction } from "@/lib/ui"

const blank: Omit<Skill, "id"> = { name: "", description: "", body: "", enabled: true }

export function Skills() {
  const { admin } = useMe()
  const q = useQuery({ queryKey: ["skills"], queryFn: api.skills })
  const [edit, setEdit] = useState<(Partial<Skill> & Omit<Skill, "id">) | null>(null)
  const [del, setDel] = useState<Skill | null>(null)
  const inv = { invalidate: [["skills"]] }
  const save = useAction((s: Partial<Skill> & Omit<Skill, "id">) => (s.id ? api.updateSkill(s as Skill) : api.createSkill(s)), { ...inv, ok: "Skill saved", onSuccess: () => setEdit(null) })
  const toggle = useAction((s: Skill) => api.updateSkill({ ...s, enabled: !s.enabled }), inv)
  const remove = useAction(api.deleteSkill, { ...inv, ok: "Skill deleted" })

  return (
    <>
      <PageTitle title="Skills" sub="Reusable playbooks. The bot sees each skill's name and description, and loads the full instructions only when relevant."
        action={admin && <Button variant="primary" onClick={() => setEdit(blank)}>New skill</Button>} />
      <Async q={q} empty="No skills yet.">
        {(rows) => (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {rows.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-sm font-medium">{s.name}{!s.enabled && <Badge>disabled</Badge>}</p>
                  <p className="truncate text-xs text-muted">{s.description}</p></div>
                {admin && (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => toggle.mutate(s)} disabled={toggle.isPending}>{s.enabled ? "Disable" : "Enable"}</Button>
                    <Button size="sm" onClick={() => setEdit(s)}>Edit</Button>
                    <Button size="sm" variant="danger" aria-label={`Delete ${s.name}`} onClick={() => setDel(s)}>Delete</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Async>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit skill" : "New skill"}>
        {edit && (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(edit) }}>
            <Field label="Name" hint="Lowercase with dashes, e.g. weekly-report">{(id) => <Input id={id} required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <Field label="Description" hint="When should the bot use this?">{(id) => <Input id={id} required value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />}</Field>
            <Field label="Instructions">{(id) => <Textarea id={id} required rows={8} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />}</Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} /> Enabled</label>
            <div className="flex justify-end gap-2"><Button onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" variant="primary" disabled={save.isPending}>Save</Button></div>
          </form>
        )}
      </Modal>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Delete skill?" body={`"${del?.name}" will be removed permanently.`} action="Delete" onYes={() => del && remove.mutate(del.id)} />
    </>
  )
}
