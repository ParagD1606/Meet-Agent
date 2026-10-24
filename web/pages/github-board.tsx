import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type GithubSuggestion } from "@/lib/api"
import { useAction } from "@/lib/action"
import { useDebounced } from "@/lib/hooks"
import { Icon } from "@/lib/icons"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { FormField, Input, Select } from "@/ui/fields"
import { Panel } from "@/ui/page"
import { useToast } from "@/ui/toast"

const REPO = /^[\w.-]+\/[\w.-]+$/
const TONE = { high: "ok", medium: "accent", low: "warn" } as const

/** Searchable, paginated list of the repositories the connection can access; typing owner/name is the fallback. */
function RepoPicker({ value, onChange, listable }: { value: string; onChange: (v: string) => void; listable: boolean }) {
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(!value)
  const dq = useDebounced(q.trim(), 250)
  const repos = useInfiniteQuery({
    queryKey: ["github-repos", dq], enabled: listable && open, retry: false, initialPageParam: 1,
    queryFn: ({ pageParam }) => api.githubRepos(dq, pageParam), getNextPageParam: (l) => (l.hasMore ? l.page + 1 : undefined),
  })
  const rows = repos.data?.pages.flatMap((p) => p.repos) ?? []
  const total = repos.data?.pages[0]?.total
  if (!listable || repos.error)
    return <FormField label="Repository" hint={repos.error ? `Could not list repositories (${repos.error.message}). Type owner/name.` : "owner/name"}>{(p) => <Input {...p} placeholder="acme/web" value={value} onChange={(e) => onChange(e.target.value)} />}</FormField>
  if (!open && value)
    return <FormField label="Repository">{() => <div className="flex items-center gap-2"><span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-sunken px-2.5 py-1.5 text-sm"><Icon name="link" size={14} />{value}</span><Button size="sm" onClick={() => setOpen(true)}>Change</Button></div>}</FormField>
  return (
    <FormField label="Repository" hint={total != null ? `All repositories the connection can access: ${total}${dq ? " match" : ""}` : "Loading repositories..."}>
      {(p) => <div>
        <div className="relative"><Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-subtle" /><Input {...p} type="search" className="pl-8" placeholder="Search repositories" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <ul className="mt-1.5 max-h-52 overflow-auto rounded-md border border-line" role="listbox" aria-label="Repositories">
          {rows.map((r) => (
            <li key={r.fullName}><button type="button" role="option" aria-selected={r.fullName === value} disabled={!r.hasIssues} title={r.hasIssues ? undefined : "Issues are disabled on this repository"} onClick={() => { onChange(r.fullName); setOpen(false) }}
              className="flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-sm last:border-0 hover:bg-hover disabled:opacity-50">
              <span className="flex-1 truncate">{r.fullName}</span>{r.private && <Badge>private</Badge>}{r.fullName === value && <Icon name="check" size={14} />}
            </button></li>))}
          {!rows.length && !repos.isPending && <li className="p-3 text-xs text-muted">No repositories match.</li>}
        </ul>
        {repos.hasNextPage && <Button size="sm" className="mt-1.5" loading={repos.isFetchingNextPage} onClick={() => repos.fetchNextPage()}>Show more</Button>}
      </div>}
    </FormField>
  )
}

export function GithubPanel() {
  const toast = useToast()
  const s = useQuery({ queryKey: ["github-issues-settings"], queryFn: api.githubSettings })
  const people = useQuery({ queryKey: ["people"], queryFn: api.people })
  const [f, setF] = useState({ repo: "", token: "", usePat: false, labels: "pixel", milestone: "", projectOwner: "", projectNumber: "", map: {} as Record<string, string> })
  const [seeded, setSeeded] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.testGithub>> | null>(null)
  if (s.data && !seeded) {
    setSeeded(true)
    setF({ repo: s.data.repo, token: "", usePat: s.data.credential.preferPat, labels: s.data.labels.join(", "), milestone: s.data.milestone ? String(s.data.milestone) : "", projectOwner: s.data.projectOwner, projectNumber: s.data.projectNumber ? String(s.data.projectNumber) : "", map: s.data.assigneeMap })
    setShowToken(s.data.credential.preferPat)
  }
  const cred = s.data?.credential
  const hasCred = !!cred && cred.kind !== "none"
  const repo = f.repo.trim()
  const repoOk = REPO.test(repo)
  const suggest = useQuery({ queryKey: ["github-suggest", repo], queryFn: () => api.githubSuggestions(repo), enabled: hasCred && repoOk, retry: false, staleTime: 120_000 })
  const labels = f.labels.split(",").map((l) => l.trim()).filter(Boolean)
  const num = (v: string) => (/^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : null)
  const body = () => ({ repo, token: f.token || undefined, usePat: showToken ? f.usePat || !!f.token : false, assigneeMap: f.map, labels, milestone: num(f.milestone), projectOwner: f.projectOwner.trim(), projectNumber: num(f.projectNumber) })
  const save = useAction(() => api.saveGithub(body()), {
    invalidate: [["github-issues-settings"], ["board-targets"], ["github-repos"], ["github-suggest"]], ok: "GitHub settings saved", inline: true, onSuccess: () => setF((v) => ({ ...v, token: "" })),
  })
  const test = useAction(() => api.testGithub({ repo: repo || undefined, token: f.token || undefined, projectOwner: f.projectOwner.trim(), projectNumber: num(f.projectNumber) }), {
    inline: true, onSuccess: (r) => { setResult(r); toast.push(r.ok ? { kind: "success", title: `GitHub works (${r.repo})`, body: "Nothing was created." } : { kind: "error", title: "GitHub check failed", body: r.message }) },
  })
  const can = repoOk && (hasCred || !!f.token)
  const sug = (suggest.data?.suggestions ?? []).filter((x) => f.map[x.userId] !== x.login)
  const byUser = new Map<string, GithubSuggestion>((suggest.data?.suggestions ?? []).map((x) => [x.userId, x]))
  const accept = () => setF((v) => { const m = { ...v.map }; for (const x of sug) if (!m[x.userId]) m[x.userId] = x.login; return { ...v, map: m } })
  const logins = suggest.data?.candidates
  const setLogin = (id: string, login: string) => setF((v) => { const m = { ...v.map }; if (login) m[id] = login; else delete m[id]; return { ...v, map: m } })
  return (
    <Panel className="mb-4 p-4">
      <div className="mb-3 flex items-center gap-2"><h2 className="text-sm font-semibold">GitHub</h2><Badge tone={s.data?.configured ? "ok" : "neutral"} dot>{s.data?.configured ? "Ready" : "Not set up"}</Badge></div>
      <p className="mb-4 text-sm text-muted">Tasks become GitHub issues (and optionally items on a Project board). Closing the issue or finishing the task keeps both in step.</p>

      {/* 1. connection */}
      <section aria-label="Connection" className="mb-4">
        <div className="text-sm font-medium">Connection</div>
        {cred?.kind === "app" && !showToken && <p className="mt-1 flex flex-wrap items-center gap-2 text-sm"><Icon name="check" size={14} className="text-ok" />Using the GitHub connection already set up for sync ({cred.installations} installation{cred.installations === 1 ? "" : "s"}).<button type="button" className="text-xs text-accent-text hover:underline" onClick={() => setShowToken(true)}>Use a personal access token instead</button></p>}
        {cred?.kind === "none" && !showToken && (
          <div className="mt-2 rounded-md border border-line bg-sunken p-3 text-sm">
            <p>{cred.appConfigured ? "GitHub is not connected yet." : "The GitHub App is not configured on this server."}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">{cred.appConfigured && <a className="btn btn-primary" href="/sync">Connect GitHub</a>}<button type="button" className="text-xs text-accent-text hover:underline" onClick={() => setShowToken(true)}>Or paste a personal access token</button></div>
          </div>)}
        {showToken && (
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <FormField label="Personal access token" hint={cred?.hasPat ? "Saved encrypted. Leave empty to keep it. Needs Issues: read and write (classic: the repo scope)." : "Needs Issues: read and write on the repository (classic token: the repo scope)."}>{(p) => <Input {...p} type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />}</FormField>
            {cred?.kind !== "none" && cred?.installations ? <div className="flex items-end"><button type="button" className="text-xs text-accent-text hover:underline" onClick={() => { setShowToken(false); setF({ ...f, token: "", usePat: false }) }}>Use the GitHub App connection instead</button></div> : null}
          </div>)}
        {cred?.kind === "pat" && !showToken && <p className="mt-1 text-sm">Using a personal access token. <button type="button" className="text-xs text-accent-text hover:underline" onClick={() => setShowToken(true)}>Change</button></p>}
      </section>

      {/* 2. repository + labels */}
      <div className="grid gap-3 sm:grid-cols-2">
        <RepoPicker value={f.repo} onChange={(v) => setF({ ...f, repo: v })} listable={hasCred} />
        <FormField label="Labels" hint="Comma separated. due:YYYY-MM-DD and priority:urgent are added automatically.">{(p) => <Input {...p} value={f.labels} onChange={(e) => setF({ ...f, labels: e.target.value })} />}</FormField>
      </div>

      {/* 3. owner mapping */}
      <section aria-label="Owner mapping" className="mt-4">
        <div className="flex flex-wrap items-center gap-2"><div className="text-sm font-medium">Owner mapping</div>{suggest.isFetching && <span className="text-xs text-muted">Looking for matches...</span>}
          {sug.length > 0 && <Button size="sm" variant="primary" className="ml-auto" onClick={accept}>Accept suggestions ({sug.length})</Button>}</div>
        <p className="text-xs text-muted">Matched by email, then GitHub login, then full name. Issues are assigned only when the owner is mapped; otherwise the issue stays unassigned and says "Owner: name".{suggest.error && ` Suggestions unavailable: ${suggest.error.message}`}</p>
        <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
          <table className="w-full text-sm"><tbody>{(people.data ?? []).map((p) => {
            const x = byUser.get(p.id)
            return (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5">{p.name ?? p.id}</td>
                <td className="px-3 py-1.5">{x && f.map[p.id] !== x.login && !f.map[p.id] ? <Badge tone={TONE[x.confidence]} className="whitespace-nowrap" >{x.login}: {x.confidence} ({x.reason})</Badge> : null}</td>
                <td className="w-2/5 px-3 py-1.5">{logins?.length
                  ? <Select aria-label={`GitHub login for ${p.name ?? p.id}`} value={f.map[p.id] ?? ""} onChange={(e) => setLogin(p.id, e.target.value)}><option value="">Not mapped</option>{f.map[p.id] && !logins.some((l) => l.login === f.map[p.id]) && <option value={f.map[p.id]}>{f.map[p.id]}</option>}{logins.map((l) => <option key={l.login} value={l.login}>{l.login}{l.name ? ` (${l.name})` : ""}</option>)}</Select>
                  : <Input aria-label={`GitHub login for ${p.name ?? p.id}`} placeholder="login" value={f.map[p.id] ?? ""} onChange={(e) => setLogin(p.id, e.target.value.trim())} />}</td>
              </tr>)
          })}</tbody></table>
          {!people.data?.length && <p className="p-3 text-xs text-muted">No people loaded.</p>}
        </div>
      </section>

      {/* 4. project board */}
      <details className="mt-4" open={!!f.projectOwner}>
        <summary className="cursor-pointer text-sm font-medium">Project board and milestone (optional)</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <FormField label="Project owner" hint="User or organization login">{(p) => <Input {...p} placeholder="acme" value={f.projectOwner} onChange={(e) => setF({ ...f, projectOwner: e.target.value })} />}</FormField>
          <FormField label="Project number" hint="From the project URL (.../projects/3)">{(p) => <Input {...p} inputMode="numeric" placeholder="3" value={f.projectNumber} onChange={(e) => setF({ ...f, projectNumber: e.target.value })} />}</FormField>
          <FormField label="Milestone number" optional>{(p) => <Input {...p} inputMode="numeric" value={f.milestone} onChange={(e) => setF({ ...f, milestone: e.target.value })} />}</FormField>
        </div>
        <p className="mt-2 text-xs text-muted">New issues are added to the project, with its Due date and Status "Todo" filled in when those fields exist. A project problem never blocks the issue. The connection needs project access (token: the project scope; GitHub App: Organization projects, read and write).</p>
      </details>

      {(save.error || test.error) && <p role="alert" className="mt-3 text-sm text-danger">{(save.error ?? test.error)!.message}</p>}
      {result?.checks && (
        <ul className="mt-3 flex flex-col gap-1 rounded-md border border-line p-3 text-sm" aria-label="Test results">
          {result.checks.map((c) => <li key={c.name} className="flex items-start gap-2"><Icon name={c.ok ? "check" : "x"} size={14} className={c.ok ? "mt-0.5 text-ok" : "mt-0.5 text-danger"} /><span><span className="font-medium capitalize">{c.name}</span>: <span className={c.ok ? "text-muted" : "text-danger"}>{c.message}</span></span></li>)}
        </ul>)}
      <div className="mt-4 flex gap-2"><Button variant="primary" loading={save.isPending} disabled={!can} onClick={() => save.mutate()}>Save</Button><Button loading={test.isPending} disabled={!can} onClick={() => test.mutate()}>Test</Button></div>
    </Panel>
  )
}
