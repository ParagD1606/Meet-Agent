import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { useMe } from "@/lib/auth"
import { Async, Button, Field, PageTitle, Textarea, useAction } from "@/lib/ui"

export function WorkspacePrompt() {
  const { admin } = useMe()
  const q = useQuery({ queryKey: ["workspace-prompt"], queryFn: api.workspacePrompt })
  const [text, setText] = useState("")
  useEffect(() => { if (q.data) setText(q.data.prompt ?? "") }, [q.data])
  const save = useAction(api.saveWorkspacePrompt, { invalidate: [["workspace-prompt"]], ok: "Prompt saved" })
  return (
    <>
      <PageTitle title="Workspace prompt" sub="Standing instructions added to every conversation: your company's tone, terminology and rules." />
      <Async q={q}>
        {() => (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.mutate(text) }}>
            <Field label="Prompt">{(id) => <Textarea id={id} rows={12} value={text} readOnly={!admin} maxLength={8000} onChange={(e) => setText(e.target.value)} placeholder="e.g. We are Acme. Keep answers short and link sources." />}</Field>
            {admin ? <div><Button type="submit" variant="primary" disabled={save.isPending || text === (q.data?.prompt ?? "")}>{save.isPending ? "Saving…" : "Save"}</Button></div>
              : <p className="text-sm text-muted">Only admins can edit the workspace prompt.</p>}
          </form>
        )}
      </Async>
    </>
  )
}
