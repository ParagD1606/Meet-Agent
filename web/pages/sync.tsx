import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, fieldErr, type SyncProvider, type SyncSource, type TokenProvider } from "@/lib/api"
import { useAction } from "@/lib/action"
import { ago } from "@/lib/format"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { Dialog, confirmDialog } from "@/ui/dialog"
import { EmptyState } from "@/ui/empty"
import { FormField, Input, Select, Textarea } from "@/ui/fields"
import { Async, PageHeader, Panel, Section } from "@/ui/page"
import { Table } from "@/ui/table"

const NAMES: Record<SyncProvider, string> = { gdrive: "Google Drive", onedrive: "OneDrive", notion: "Notion", github: "GitHub App", linear: "Linear", jira: "Jira", gmail: "Gmail", gcal: "Google Calendar" }
const OAUTH: SyncProvider[] = ["gdrive", "onedrive", "notion", "github"]
const TOKEN: TokenProvider[] = ["linear", "jira"]
const isPersonal = (s: SyncSource) => !!s.selection?.scopeTag?.startsWith("user_")
const IDS: Record<SyncProvider, { label: string; hint: string; ph: string }> = {
  github: { label: "Repositories", hint: "One owner/name per line, or * for every repo the GitHub App can read.", ph: "acme/api\nacme/web" },
  linear: { label: "Team keys", hint: "One per line, or * for all teams.", ph: "ENG\nOPS" },
  jira: { label: "Project keys", hint: "One per line, or * for all projects.", ph: "PLAT\nSUP" },
  gdrive: { label: "Folder IDs", hint: "One per line, or * for everything the account can see.", ph: "*" },
  onedrive: { label: "Folder IDs", hint: "One per line, or * for everything the account can see.", ph: "*" },
  notion: { label: "Page or database IDs", hint: "One per line, or * for everything the integration can see.", ph: "*" },
  gmail: { label: "", hint: "", ph: "" }, gcal: { label: "", hint: "", ph: "" },
}
const parseIds = (s: string) => s.split(/[\s,]+/).filter(Boolean)

function SelectionDialog({ src, onClose }: { src: SyncSource | null; onClose: () => void }) {
  const [mode, setMode] = useState<"all" | "selected">("all")
  const [ids, setIds] = useState("")
  const [seen, setSeen] = useState<string | null>(null)
  if (src && seen !== src.id) {
    const cur = src.selection?.ids ?? []
    setSeen(src.id); setMode(cur.length && !cur.includes("*") ? "selected" : "all"); setIds(cur.filter((i) => i !== "*").join("\n"))
  }
  const save = useAction((ids: string[]) => api.saveSyncSource(src!.id, { ids }), { invalidate: [["sync"]], ok: "Selection saved", onSuccess: onClose, inline: true })
  const list = parseIds(ids)
  const f = src ? IDS[src.provider] : IDS.gdrive
  return (
    <Dialog open={!!src} onClose={onClose} title={src ? `${NAMES[src.provider]} selection` : ""} description="Choose what gets pulled into shared memory. Nothing syncs until you choose, and changing this restarts the source from the beginning."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={mode === "selected" && list.length === 0} onClick={() => save.mutate(mode === "all" ? ["*"] : list)}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        <FormField label="Scope">{(p) => <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as "all" | "selected")}><option value="all">Everything the account can see</option><option value="selected">Only specific items</option></Select>}</FormField>
        {mode === "selected" && <FormField label={f.label} hint={f.hint} error={save.error?.message}>{(p) => <Textarea {...p} rows={5} className="font-mono" placeholder={f.ph} value={ids} onChange={(e) => setIds(e.target.value)} />}</FormField>}
      </div>
    </Dialog>
  )
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function jiraHostHint(raw: string): { error?: string; hint?: string } {
  if (!raw.trim()) return {}
  let u: URL
  try { u = new URL(raw.trim()) } catch { return { error: "Enter a full URL, such as https://acme.atlassian.net" } }
  if (u.protocol !== "https:") return { error: "The URL must start with https://" }
  if (!u.hostname.endsWith(".atlassian.net")) return { hint: "Jira Cloud hosts end in .atlassian.net. Other hosts only work if the server operator has allow-listed them." }
  return {}
}

function TokenForm() {
  const [provider, setProvider] = useState<TokenProvider>("linear")
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [ids, setIds] = useState("")
  const [touched, setTouched] = useState(false)
  const jira = provider === "jira"
  const host = jira ? jiraHostHint(baseUrl) : {}
  const errs = {
    token: touched && token.trim().length < 8 ? "Paste the full token (at least 8 characters)." : null,
    email: touched && jira && !EMAIL.test(email.trim()) ? "Enter the email of the Atlassian account that owns the token." : null,
    baseUrl: touched && jira && (!baseUrl.trim() || host.error) ? host.error ?? "Enter your Jira site URL." : null,
  }
  const invalid = token.trim().length < 8 || (jira && (!EMAIL.test(email.trim()) || !baseUrl.trim() || !!host.error))
  const add = useAction(async () => {
    const r = await api.connectTokenSource({ provider, token: token.trim(), ...(jira ? { email: email.trim(), baseUrl: baseUrl.trim().replace(/\/+$/, "") } : {}) })
    const sel = parseIds(ids)
    if (sel.length) await api.saveSyncSource(r.id, { ids: sel })
    return r
  }, { invalidate: [["sync"]], inline: true, ok: "Connected", onSuccess: () => { setToken(""); setIds(""); setTouched(false) } })
  const f = IDS[provider]
  const server = add.error && !add.error.message.startsWith("Some fields") ? add.error.message : null
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!invalid) add.mutate() }}>
      <Panel className="p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Provider">{(p) => <Select {...p} value={provider} onChange={(e) => { setProvider(e.target.value as TokenProvider); setIds(""); add.reset() }}>{TOKEN.map((k) => <option key={k} value={k}>{NAMES[k]}</option>)}</Select>}</FormField>
          <FormField label={provider === "linear" ? "API key" : "API token"} hint={provider === "linear" ? "A personal API key from Linear settings." : "Create one at id.atlassian.com under Security, API tokens."} error={errs.token ?? fieldErr(add.error, "token")}>
            {(p) => <Input {...p} type="password" autoComplete="off" spellCheck={false} className="font-mono" value={token} onChange={(e) => setToken(e.target.value)} />}
          </FormField>
          {jira && <FormField label="Atlassian email" error={errs.email ?? fieldErr(add.error, "email")}>{(p) => <Input {...p} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}</FormField>}
          {jira && <FormField label="Jira site URL" hint={host.hint ?? "For example https://acme.atlassian.net"} error={errs.baseUrl ?? fieldErr(add.error, "baseUrl")}>{(p) => <Input {...p} type="url" placeholder="https://acme.atlassian.net" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />}</FormField>}
          <FormField label={f.label} optional hint={`${f.hint} Leave empty to choose later; nothing syncs until you do.`} className="md:col-span-2">{(p) => <Textarea {...p} rows={3} className="font-mono" placeholder={f.ph} value={ids} onChange={(e) => setIds(e.target.value)} />}</FormField>
        </div>
      </Panel>
      {server && <p role="alert" className="mt-2 text-sm text-danger">{server}</p>}
      <div className="mt-3"><Button type="submit" variant="primary" loading={add.isPending}>Connect with token</Button></div>
    </form>
  )
}

export default function SyncPage() {
  const q = useQuery({ queryKey: ["sync"], queryFn: api.syncSources, refetchInterval: 15_000 })
  const [provider, setProvider] = useState<SyncProvider>("gdrive")
  const [edit, setEdit] = useState<SyncSource | null>(null)
  const add = useAction(api.createSyncSource, { invalidate: [["sync"]], onSuccess: (r) => { if (r.authUrl) window.location.href = r.authUrl } })
  const mine = useAction(api.connectPersonal, { onSuccess: (r) => { if (r.authUrl) window.location.href = r.authUrl } })
  const run = useAction(api.runSync, { invalidate: [["sync"]], ok: "Sync started" })
  const del = useAction(api.deleteSyncSource, { invalidate: [["sync"]], ok: "Source removed" })
  const remove = async (s: SyncSource) => { if (await confirmDialog({ title: `Remove ${NAMES[s.provider]}?`, body: "It stops syncing and its stored credentials are deleted. Memories already imported stay.", confirmLabel: "Remove", danger: true })) del.mutate(s.id) }
  return (
    <>
      <PageHeader title="Sync" desc="Pull documents from external sources into shared memory every hour. Unchanged files are skipped, so repeat syncs are cheap." />
      <Section title="Connect a source" desc="GitHub uses the workspace GitHub App: an admin installs it once, then its selected repositories are shared with everyone. No member API keys are needed.">
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate(provider) }}>
          <Select aria-label="Source" className="w-48" value={provider} onChange={(e) => setProvider(e.target.value as SyncProvider)}>{OAUTH.map((k) => <option key={k} value={k}>{NAMES[k]}</option>)}</Select>
          <Button type="submit" variant="primary" loading={add.isPending}>Connect</Button>
        </form>
      </Section>
      <Section title="Connect with a token" desc="Linear and Jira use a token you paste instead of signing in. It is stored encrypted and only used to read.">
        <TokenForm />
      </Section>
      <Section title="Connect my own account" desc="Your Gmail and Calendar are private to you: what is learned is never shared with the workspace.">
        <div className="flex flex-wrap gap-2">
          {(["gmail", "gcal"] as const).map((k) => <Button key={k} loading={mine.isPending && mine.variables === k} onClick={() => mine.mutate(k)}>Connect mine: {NAMES[k]}</Button>)}
        </div>
      </Section>
      <Section title="Sources">
        <Async q={q} rows={3}>{(rows) => rows.length === 0 ? <Panel><EmptyState icon="sync" title="No sources connected">Connect one above. OAuth sources ask you to sign in; token sources need a pasted token.</EmptyState></Panel> : (
          <Panel><Table caption="Sync sources" rows={rows} rowKey={(s) => s.id} columns={[
            { key: "p", header: "Source", primary: true, cell: (s: SyncSource) => <span className="flex items-center gap-2 font-medium">{NAMES[s.provider] ?? s.provider}{isPersonal(s) && <Badge>Personal</Badge>}</span> },
            { key: "sel", header: "Importing", hideSm: true, cell: (s) => { const ids = s.selection?.ids; return <span className="text-muted">{!ids?.length ? "Not chosen yet" : ids.includes("*") ? "Everything" : `${ids.length} selected`}</span> } },
            { key: "st", header: "Status", cell: (s) => { const st = s.status ?? (s.connected === false ? "not connected" : "idle"); return <Badge tone={st === "error" || st === "not connected" ? "danger" : st === "running" ? "accent" : "neutral"} dot>{st}</Badge> } },
            { key: "last", header: "Last sync", hideSm: true, cell: (s) => <span className="text-muted" title={s.error ?? undefined}>{s.error ? s.error : s.lastSyncAt ? ago(s.lastSyncAt) : "never"}</span> },
            { key: "a", header: <span className="sr-only">Actions</span>, end: true, cell: (s) => <span className="flex flex-wrap justify-end gap-2">{!isPersonal(s) && <Button size="sm" onClick={() => setEdit(s)}>Selection</Button>}<Button size="sm" loading={run.isPending && run.variables === s.id} onClick={() => run.mutate(s.id)}>Sync now</Button><Button size="sm" variant="danger" aria-label={`Remove ${NAMES[s.provider]}`} loading={del.isPending && del.variables === s.id} onClick={() => remove(s)}>Remove</Button></span> },
          ]} /></Panel>
        )}</Async>
      </Section>
      <SelectionDialog src={edit} onClose={() => setEdit(null)} />
    </>
  )
}
