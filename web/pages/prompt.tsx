import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, fieldErr } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useMe } from "@/lib/auth"
import { useDirtyGuard } from "@/lib/hooks"
import { Button } from "@/ui/button"
import { FormField, Textarea } from "@/ui/fields"
import { Async, PageHeader } from "@/ui/page"

const MAX = 8000

export default function Prompt() {
  const { admin } = useMe()
  const q = useQuery({ queryKey: ["workspace-prompt"], queryFn: api.workspacePrompt })
  const [text, setText] = useState("")
  useEffect(() => { if (q.data) setText(q.data.prompt ?? "") }, [q.data])
  const dirty = q.data != null && text !== (q.data.prompt ?? "")
  useDirtyGuard(dirty)
  const save = useAction(api.saveWorkspacePrompt, { invalidate: [["workspace-prompt"]], ok: "Prompt saved", inline: true })
  return (
    <>
      <PageHeader title="Workspace prompt" desc="Standing instructions added to every conversation: your tone, terminology and house rules. Keep it short, because it is sent with every turn." />
      <Async q={q} rows={5}>
        {() => (
          <form className="max-w-2xl" onSubmit={(e) => { e.preventDefault(); save.mutate(text) }}>
            <FormField label="Instructions" hint={`${text.length.toLocaleString()} of ${MAX.toLocaleString()} characters`} error={fieldErr(save.error, "prompt") ?? (save.error ? save.error.message : null)}>
              {(p) => <Textarea {...p} rows={14} value={text} readOnly={!admin} maxLength={MAX} onChange={(e) => setText(e.target.value)} placeholder="Example: We are Acme. Answer in plain language, link sources, and never share salary data." />}
            </FormField>
            <div className="mt-4 flex items-center gap-3">
              {admin ? <><Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>Save prompt</Button>{dirty && <Button variant="ghost" onClick={() => setText(q.data?.prompt ?? "")}>Discard changes</Button>}</>
                : <p className="text-sm text-muted">Only admins can edit the workspace prompt.</p>}
            </div>
          </form>
        )}
      </Async>
    </>
  )
}
