import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { api, errMsg } from "@/lib/api"
import { Icon } from "@/lib/icons"
import { Button } from "@/ui/button"
import { FormField, Input, Textarea } from "@/ui/fields"
import { Panel } from "@/ui/page"
import { useToast } from "@/ui/toast"
import { CLEAN_SAMPLE, MESSY_SAMPLE } from "./samples"

const EXT = /\.(txt|vtt|srt|json)$/i
const MAX_BYTES = 5 * 1024 * 1024

/** Paste or upload a transcript and start analysis. */
export function NewMeeting({ onCreated }: { onCreated: (id: string) => void }) {
  const client = useQueryClient()
  const toast = useToast()
  const [title, setTitle] = useState("")
  const [date, setDate] = useState("")
  const [text, setText] = useState("")
  const [format, setFormat] = useState<string | undefined>()
  const [drag, setDrag] = useState(false)
  const [fileErr, setFileErr] = useState<string | null>(null)
  const pick = useRef<HTMLInputElement>(null)

  const create = useMutation({
    mutationFn: () => api.createMeeting({ title: title.trim() || "Untitled meeting", text, ...(format ? { format } : {}), ...(date ? { startedAt: new Date(`${date}T09:00:00`).toISOString() } : {}) }),
    onSuccess: ({ id }) => {
      client.invalidateQueries({ queryKey: ["meetings"] })
      toast.push({ kind: "success", title: "Analysing transcript", body: "Decisions and action items will appear for review." })
      setText(""); setTitle(""); setDate(""); setFormat(undefined)
      onCreated(id)
    },
  })

  const load = async (file: File | undefined) => {
    setFileErr(null)
    if (!file) return
    if (!EXT.test(file.name)) return setFileErr("Use a .txt, .vtt, .srt or .json file.")
    if (file.size > MAX_BYTES) return setFileErr("That file is over 5 MB.")
    setText(await file.text())
    setFormat(file.name.split(".").pop()!.toLowerCase())
    if (!title) setTitle(file.name.replace(EXT, "").replace(/[-_]+/g, " "))
  }
  const sample = (t: string, name: string) => { setText(t); setFormat(undefined); setTitle(name); setFileErr(null) }
  const err = create.error ? errMsg(create.error) : null

  return <Panel className="mb-4 p-4">
    <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) create.mutate() }} aria-label="New meeting">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base">New meeting</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">Try a sample:
          <Button size="sm" onClick={() => sample(CLEAN_SAMPLE, "Launch scope sync (sample)")}>Load sample transcript</Button>
          <Button size="sm" onClick={() => sample(MESSY_SAMPLE, "Audit and billing sync (messy sample)")}>Load messy sample</Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <FormField label="Title" optional>{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly product sync" />}</FormField>
        <FormField label="Meeting date" optional>{(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</FormField>
      </div>
      <div className="mt-3" onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void load(e.dataTransfer.files[0]) }}>
        <FormField label="Transcript or notes" hint="Paste text in 'Name: what they said' form, or drop a .txt, .vtt, .srt or .json file here." error={fileErr ?? err}>
          {(p) => <Textarea {...p} rows={6} value={text} onChange={(e) => { setText(e.target.value); setFormat(undefined) }} placeholder="Ada: Priya, please send the pricing copy to legal by Friday.&#10;Priya: Will do." className={drag ? "!border-accent !bg-accent-soft" : undefined} />}
        </FormField>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={pick} type="file" accept=".txt,.vtt,.srt,.json" hidden aria-label="Choose transcript file" onChange={(e) => { void load(e.target.files?.[0]); e.target.value = "" }} />
        <Button icon="upload" onClick={() => pick.current?.click()}>Choose file</Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!text.trim()}>Analyse meeting</Button>
        {text && <span className="text-xs text-muted"><Icon name="file" size={12} className="mr-1 inline" />{text.split("\n").filter(Boolean).length} lines{format ? ` (${format})` : ""}</span>}
      </div>
    </form>
  </Panel>
}
