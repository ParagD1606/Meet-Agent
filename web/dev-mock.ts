// Standalone mock of the REST contract (server/CONTRACTS.md) so the UI runs without the server:
//   bun run build && bun dev-mock.ts   (PORT=3999 default)
// Cookie "role" = owner|member signs you in; GET /auth/slack signs in as owner; /mock/role/member switches role.
// MOCK_UNCONFIGURED=1 shows the setup wizard. MOCK_GRAPH=5000 sets the graph size (default 5200).
import { join } from "node:path"

const dist = join(import.meta.dir, "dist")
const now = () => new Date().toISOString()
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString()
let nid = 1000
const TOPICS = ["billing revamp", "SOC 2 audit", "onboarding flow", "pricing page", "data retention", "mobile release", "support rota", "incident review", "roadmap Q3", "hiring plan"]
const OWNERS = ["Priya", "Marcus", "Dana", "Ibrahim", "Lena"]

type Mem = { id: number; text: string; scopeTag: string; source: string; sourceRef: string | null; kind: string; createdAt: string; status: "active" | "superseded"; supersededBy: number | null; validAt: string; confidence: number }
const mk = (i: number): Mem => ({
  id: i + 1, text: `${TOPICS[i % TOPICS.length]}: owner is ${OWNERS[i % OWNERS.length]}, decision ${i + 1} agreed on the first Monday of the quarter.`,
  scopeTag: i % 9 === 0 ? "channel_C1" : i % 13 === 0 ? "user_U2" : "shared", source: i % 5 ? "slack" : "upload", sourceRef: i % 5 ? null : "roadmap.pdf",
  kind: i % 5 ? "fact" : "chunk", createdAt: ago(i * 37), status: "active", supersededBy: null, validAt: ago(i * 37), confidence: 0.6 + (i % 4) / 10,
})
const GN = Number(process.env.MOCK_GRAPH ?? 5200)
const db = {
  memories: Array.from({ length: GN }, (_, i) => mk(i)),
  skills: [
    { id: "s1", name: "weekly-report", description: "Write the weekly status report", body: "# Weekly report\nSummarise merged PRs and open risks.", enabled: true, scope: "org", version: 1, ownerUserId: null },
    { id: "s2", name: "incident-postmortem", description: "Draft a blameless postmortem from an incident thread", body: "Use the template...", enabled: false, scope: "user", version: 3, ownerUserId: "U1" },
  ] as any[],
  automations: [{ id: "a1", ownerUserId: "U1", kind: "digest", prompt: "Summarise yesterday's #eng activity", cron: "0 9 * * 1-5", destChannelId: "C1", enabled: true, lastRunAt: ago(300), lastStatus: "ok" },
    { id: "a2", ownerUserId: "U2", kind: "reminder", prompt: "Update the roadmap doc", cron: "0 17 * * 5", destChannelId: null, enabled: true, lastRunAt: ago(4000), lastStatus: "channel_not_found" }] as any[],
  meetings: [{ id: "mt_1", sourceFileId: "FHUDDLE1", channelId: "C1", threadTs: "1700001000.000100", title: "Product planning Huddle", status: "ready", participantIds: ["U1", "U2", "U3"], endedAt: ago(95), createdAt: ago(95), updatedAt: ago(94),
    transcript: "Ada Lovelace: We should ship the new onboarding checklist next Tuesday.\nMax Member: I will draft the checklist and share it for review by Friday.\nAda Lovelace: Great. We also need the release notes ready before launch.",
    summary: "## Decisions\nShip the onboarding checklist next Tuesday.\n\n## Discussion\nThe team agreed that the checklist needs review before release.\n\n## Open questions\nThe final release-notes owner is still to be confirmed.",
    tasks: [{ title: "Draft the onboarding checklist", description: "Prepare a reviewable first draft for the product team.", assigneeName: "Max Member", assigneeId: "U2", dueDate: "Friday", jiraKey: null, jiraUrl: null }, { title: "Prepare release notes", description: "Create release notes before the onboarding checklist launch.", assigneeName: null, assigneeId: null, dueDate: "Before launch", jiraKey: null, jiraUrl: null }] }] as any[],
  conns: [{ id: "c1", provider: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", scope: "org", ownerUserId: null, status: "connected", toolCount: 24, connectedAt: ago(9000) },
    { id: "c2", provider: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", scope: "user", ownerUserId: "U1", status: "error", error: "Token expired", toolCount: 0 }] as any[],
  tokens: [{ id: "t1", name: "Cursor", createdAt: ago(5000), lastUsedAt: ago(30) }] as any[],
  sync: [{ id: "y1", provider: "notion", lastSyncAt: ago(90), status: "idle", selection: { mode: "all" } }] as any[],
  prompt: "We are Acme. Be concise.",
  proactivity: { default: "own", channels: [{ id: "C1", name: "eng", mode: "default" }, { id: "C2", name: "random", mode: "quiet" }, { id: "C3", name: "company-brain", mode: "proactive" }] } as any,
  models: { provider: "anthropic", freeText: false, profile: "thorough", model: null,
    models: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", profile: "fast" }, { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", profile: "thorough" }],
    roles: { main: null, triage: "claude-haiku-4-5", extract: "claude-haiku-4-5", summarize: null, research: null }, fallback: null } as any,
  limits: { perTurnTokenCeiling: 400000, perUserDailyTokens: 2000000, orgDailyTokens: 20000000, concurrentTurns: 8, maxStepsByDepth: { direct: 2, memory: 4, tools: 12, deep: 30 } },
  blocks: { company: "Acme sells invoicing software to mid-size agencies. Product names: Ledger, Ledger Pro.", user: "Ada prefers short answers with links.", channel_C1: "#eng: services are TypeScript on Bun; deploys on Tuesdays." } as Record<string, string>,
  reviews: [
    { id: "rv_1", kind: "supersede", status: "pending", memoryId: 7, memory: { id: 7, text: "billing revamp: owner is Dana, ships in Q4." }, requestedBy: "U2", createdAt: ago(40), payload: { supersededIds: [1] } },
    { id: "rv_2", kind: "core_block", status: "pending", memoryId: null, memory: null, requestedBy: null, createdAt: ago(300), payload: { label: "company", tag: "shared", op: "replace", match: "Ledger Pro", text: "Ledger Pro and Ledger Teams" } },
    { id: "rv_3", kind: "low_confidence", status: "pending", memoryId: 9, memory: { id: 9, text: "Legal said retention could drop to 90 days." }, requestedBy: "U1", createdAt: ago(900), payload: {} },
  ] as any[],
}
db.memories[0]!.status = "superseded"; db.memories[0]!.supersededBy = 7
const users = [{ id: "U1", name: "Ada Lovelace", role: "owner" }, { id: "U2", name: "Max Member", role: "member" }]
const models = ["claude-sonnet-4-5", "claude-haiku-4-5"]
const turns = Array.from({ length: 40 }, (_, i) => {
  const input = 8000 + ((i * 937) % 9000), output = 300 + ((i * 131) % 900)
  return {
    id: `T${i}`, channelId: "C1", threadTs: `17000000${i}.000100`, userId: users[i % 2]!.id, trigger: ["mention", "dm", "chime", "automation"][i % 4], status: ["done", "done", "error", "waiting_approval", "running"][i % 5],
    toolCalls: Array.from({ length: i % 4 }, (_, k) => ({ name: ["search_memory", "web_search", "github.list_prs"][k % 3], args: { query: "billing" }, result: { hits: 3 }, durationMs: 220 + k * 400, ok: true })),
    inputTokens: input, outputTokens: output, cacheReadTokens: Math.round(input * 0.6), cacheWriteTokens: 900, costMicros: input * 3 + output * 15, model: models[i % 2], steps: 1 + (i % 4), depth: ["direct", "memory", "tools", "deep"][i % 4],
    promptBreakdown: { system: 900, coreBlocks: 700, skills: 200, toolSchemas: 1100, history: 2400, recall: 1800, toolResults: 600, user: 80 },
    error: i % 5 === 2 ? "Model timeout after 60s" : null, text: "Here is what I found about the billing revamp...", startedAt: ago(i * 25), finishedAt: i % 5 === 4 ? null : ago(i * 25 - 1), permalink: "https://example.slack.com/archives/C1/p1",
  }
})
const usage = (range: string) => {
  const days = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 }[range] ?? 7
  const byDay = Array.from({ length: days }, (_, i) => { const t = 20 + ((i * 7) % 30); return { day: new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10), turns: t, inputTokens: t * 9000, outputTokens: t * 600, costMicros: t * 36000 } })
  const share = (n: number) => ({ turns: Math.round(n / 10), inputTokens: n * 6, outputTokens: n / 2, costMicros: n * 20 })
  return { range, byDay, byUser: users.map((u, i) => ({ userId: u.id, name: u.name, ...share(120000 / (i + 1)) })), byModel: models.map((m, i) => ({ model: m, ...share(100000 / (i + 1)) })),
    byRole: ["mention", "dm", "chime", "automation"].map((r, i) => ({ role: r, ...share(80000 / (i + 1)) })), cacheHitRate: 0.58,
    avgBreakdown: turns[0]!.promptBreakdown, topTurns: [...turns].sort((a, b) => b.costMicros - a.costMicros).slice(0, 8) }
}
const market = [["github", "GitHub", ["developer tools", "code"]], ["linear", "Linear", ["project management"]], ["notion", "Notion", ["docs", "knowledge"]], ["sentry", "Sentry", ["monitoring"]], ["gmail", "Gmail", ["email"]], ["asana", "Asana", ["project management"]], ["stripe", "Stripe", ["payments"]], ["posthog", "PostHog", ["analytics"]], ["figma", "Figma", ["design"]], ["zendesk", "Zendesk", ["support"]], ["hubspot", "HubSpot", ["crm"]], ["slack-search", "Datadog", ["monitoring"]]]
  .map(([key, name, categories]: any, i) => ({ key, name, url: `https://mcp.${key}.com/mcp`, categories, connectMode: i % 5 === 4 ? "apikey" : "oauth", personalOnly: key === "gmail", iconDomain: `${key}.com` }))

const json = (d: unknown, status = 200) => Response.json(d, { status })

Bun.serve({
  port: Number(process.env.PORT ?? 3999),
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    const sp = url.searchParams
    const role = /role=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1] || process.env.MOCK_ROLE // MOCK_ROLE=owner skips sign-in
    const admin = role === "owner"
    if (p === "/auth/slack") return new Response(null, { status: 302, headers: { location: "/", "set-cookie": "role=owner; Path=/" } })
    if (p.startsWith("/mock/role/")) return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `role=${p.split("/").pop()}; Path=/` } })
    if (p === "/auth/logout") return new Response(null, { status: 204, headers: { "set-cookie": "role=; Path=/; Max-Age=0" } })
    if (p === "/readyz") return json({ ok: true })
    if (p.startsWith("/api/")) {
      if (req.method !== "GET" && req.headers.get("x-requested-with") !== "fetch") return json({ error: "csrf" }, 403)
      const body = req.method === "GET" || req.method === "DELETE" || req.headers.get("content-type")?.startsWith("multipart") ? {} : ((await req.json().catch(() => ({}))) as Record<string, any>)
      if (p === "/api/setup/status") {
        const un = !!process.env.MOCK_UNCONFIGURED
        return json({ model: true, embedding: true, slack: !un, ownerLocked: !un, teamPinned: false, workspace: un ? null : { id: "T1", name: "Acme" }, publicUrl: "https://brain.example.com", slackMode: "http",
          checks: { db: true, boss: true, model: true, embedding: true, slack: !un } })
      }
      if (p === "/api/setup/manifest") return new Response("display_information:\n  name: Company Brain\noauth_config:\n  redirect_urls:\n    - https://brain.example.com/slack/oauth/callback\n")
      if (!role) return json({ error: "unauthorized" }, 401)
      const adminOnly = () => (admin ? null : json({ error: "forbidden" }, 403))
      const m = (r: string) => new RegExp(`^${r}$`).exec(p)
      let x: RegExpExecArray | null
      if (p === "/api/me") return json({ id: admin ? "U1" : "U2", name: admin ? "Ada Lovelace" : "Max Member", role: admin ? "owner" : "member", avatarUrl: null })
      if (p === "/api/users") { const g = adminOnly(); return g ?? json(users) }
      if (p === "/api/setup/test-message") { const g = adminOnly(); return g ?? json({ ok: true, ts: "1.2" }) }
      if (p === "/api/overview") return json({ memoryCount: db.memories.filter((e) => e.scopeTag === "shared" && e.status === "active").length, connections: db.conns.length, automations: db.automations.filter((a) => a.enabled).length, recentTurns: (admin ? turns : turns.filter((t) => t.userId === "U2")).slice(0, 10) })
      if (p === "/api/graph") {
        const limit = Math.min(5000, +(sp.get("limit") ?? 500)), kind = sp.get("kind"), source = sp.get("source"), q = (sp.get("q") ?? "").toLowerCase()
        const pool = db.memories.filter((e) => e.status === "active" && (!kind || e.kind === kind) && (!source || e.source === source) && (!q || e.text.toLowerCase().includes(q)))
        const nodes = pool.slice(0, limit).map((e) => ({ id: e.id, label: e.text, scope: e.scopeTag, kind: e.kind, source: e.source, createdAt: e.createdAt }))
        const edges = nodes.flatMap((n, i) => (i > 0 ? [{ source: n.id, target: nodes[Math.floor(Math.pow(Math.random(), 2) * i)]!.id, weight: 0.5 }] : []))
        return json({ nodes, edges, total: pool.length, truncated: pool.length > limit })
      }
      if (p === "/api/memories" && req.method === "GET") {
        const q = (sp.get("q") ?? "").toLowerCase(), off = +(sp.get("offset") ?? 0), lim = +(sp.get("limit") ?? 30), st = sp.get("status") ?? "active"
        const rows = db.memories.filter((e) => (st === "all" || e.status === st) && e.text.toLowerCase().includes(q))
        return json({ items: rows.slice(off, off + lim), total: rows.length })
      }
      if (p === "/api/memories/upload") { const g = adminOnly(); if (g) return g; db.memories.unshift({ ...mk(nid++), text: "Uploaded chunk from document", source: "upload", scopeTag: "shared" }); return json({ chunks: 1 }) }
      if ((x = m("/api/memories/(\\d+)/history"))) { const id = +x[1]!; const c = db.memories.find((e) => e.id === id); return c ? json(id === 7 || id === 1 ? [db.memories[0], db.memories[6]] : [c]) : json({ error: "not_found" }, 404) }
      if ((x = m("/api/memories/(\\d+)")) && req.method === "DELETE") { const g = adminOnly(); if (g) return g; db.memories = db.memories.filter((e) => e.id !== +x![1]!); return json({ ok: true }) }
      if (p === "/api/export/memories") return new Response("# Memories\n", { headers: { "content-type": "text/markdown" } })
      if (p === "/api/core-blocks") {
        const scope = sp.get("scope") ?? "company"
        if (scope !== "company" && scope !== "user" && !scope.startsWith("channel_")) return json({ error: "not_found" }, 404)
        if (req.method === "PUT") { if (scope === "company" && !admin) return json({ error: "forbidden" }, 403); if (body.text.length > 1500) return json({ error: "rejected", message: "Over the character limit" }, 400); db.blocks[scope] = body.text }
        const label = scope.split("_")[0]!
        return json(req.method === "PUT" ? { block: { scopeTag: scope, label, text: db.blocks[scope] ?? "", charLimit: 1500, version: 2 }, usage: "ok", queuedForReview: false } : { scopeTag: scope, label, text: db.blocks[scope] ?? "", charLimit: label === "company" ? 1500 : 1000, version: 1 })
      }
      if (p === "/api/reviews") { const g = adminOnly(); return g ?? json(db.reviews.filter((r) => r.status === (sp.get("status") ?? "pending"))) }
      if ((x = m("/api/reviews/(\\w+)/decide"))) { const g = adminOnly(); if (g) return g; const r = db.reviews.find((r) => r.id === x![1]); if (r) r.status = body.approve ? "approved" : "rejected"; return json({ ok: true }) }
      if (p === "/api/settings/workspace-prompt") { if (req.method === "PUT") { const g = adminOnly(); if (g) return g; db.prompt = body.prompt } return json({ prompt: db.prompt }) }
      if (p === "/api/settings/proactivity") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") Object.assign(db.proactivity, body); return json(db.proactivity) }
      if (p === "/api/settings/models") {
        if (req.method === "PUT") { const g = adminOnly(); if (g) return g; if (body.role) db.models.roles[body.role] = body.model; else if ("fallback" in body) db.models.fallback = body.fallback; else { db.models.profile = body.profile; db.models.model = body.model } }
        return json(db.models)
      }
      if (p === "/api/settings/limits") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") { if (body.concurrentTurns < 1) return json({ error: "invalid_body", issues: [{ path: "concurrentTurns", message: "Must be at least 1" }] }, 400); Object.assign(db.limits, body) } return json(db.limits) }
      if (p === "/api/usage") { const g = adminOnly(); return g ?? json(usage(sp.get("range") ?? "7d")) }
      if (p === "/api/skills/upload") { db.skills.push({ id: `s${nid++}`, name: "imported-skill", description: "Imported from SKILL.md", body: "...", enabled: true, scope: admin ? "org" : "user", version: 1, ownerUserId: "U1" }); return json(db.skills.at(-1)) }
      if (p === "/api/skills") {
        if (req.method === "POST") {
          if (!/^[a-z0-9-]+$/.test(body.name ?? "")) return json({ error: "invalid_body", issues: [{ path: "name", message: "Use lowercase letters, numbers and dashes" }] }, 400)
          if (body.scope === "org" && !admin) return json({ error: "forbidden" }, 403)
          db.skills.push({ ...body, id: `s${nid++}`, version: 1, ownerUserId: "U1" })
        }
        return json(db.skills)
      }
      if ((x = m("/api/skills/(\\w+)"))) { db.skills = req.method === "DELETE" ? db.skills.filter((s) => s.id !== x![1]) : db.skills.map((s) => (s.id === x![1] ? { ...s, ...body, version: s.version + 1 } : s)); return json({ ok: true }) }
      if (p === "/api/automations") {
        if (req.method === "POST") {
          if (body.cron && /^\*/.test(body.cron)) return json({ error: "invalid_body", issues: [{ path: "cron", message: "Minimum interval is one hour" }] }, 400)
          db.automations.push({ ownerUserId: "U1", enabled: true, lastRunAt: null, lastStatus: null, ...body, id: `a${nid++}` })
        }
        return json(db.automations)
      }
      if ((x = m("/api/automations/(\\w+)/run"))) { const a = db.automations.find((a) => a.id === x![1])!; a.lastRunAt = now(); a.lastStatus = "ok"; return json({ ok: true }) }
      if ((x = m("/api/automations/(\\w+)"))) { if (req.method === "DELETE") db.automations = db.automations.filter((a) => a.id !== x![1]); else Object.assign(db.automations.find((a) => a.id === x![1])!, body); return json({ ok: true }) }
      if (p === "/api/meetings") return json(db.meetings.map(({ transcript: _transcript, ...meeting }) => meeting))
      if ((x = m("/api/meetings/(\\w+)"))) { const meeting = db.meetings.find((meeting) => meeting.id === x![1]); return meeting ? json(meeting) : json({ error: "not_found" }, 404) }
      if (p === "/api/marketplace") { const q = (sp.get("q") ?? "").toLowerCase(); const items = market.filter((i) => !q || `${i.name} ${i.categories.join(" ")}`.toLowerCase().includes(q)).map((i) => ({ ...i, connected: db.conns.some((c) => c.provider === i.key && c.status === "connected") })); return json({ items, total: items.length }) }
      if ((x = m("/api/marketplace/([\\w-]+)/install"))) {
        if (body.scope === "org" && !admin) return json({ error: "forbidden" }, 403)
        const it = market.find((i) => i.key === x![1]); if (!it && x[1] !== "custom") return json({ error: "not_found" }, 404)
        if (x[1] === "custom" && !/^https:\/\//.test(body.url ?? "")) return json({ error: "invalid_url", message: "Use a public https:// URL" }, 400)
        const c = { id: `c${nid++}`, provider: it?.key ?? "custom", label: it?.name ?? body.label ?? "Custom", url: it?.url ?? body.url, scope: body.scope, ownerUserId: "U1", status: body.token ? "connected" : "pending" }
        db.conns.push(c); return json({ connection: c, ...(body.token ? {} : { authUrl: "/?connected=1" }) }, 201)
      }
      if (p === "/api/mcp/presets") return json([])
      if (p === "/api/mcp/connections") { if (req.method === "POST") { const c = { id: `c${nid++}`, provider: body.provider ?? "custom", label: body.label, url: body.url ?? "https://x", scope: body.scope, ownerUserId: "U1", status: "pending" }; db.conns.push(c); return json(c) } return json(db.conns) }
      if ((x = m("/api/mcp/connections/(\\w+)/connect"))) return json({ authUrl: "/?connected=1" })
      if ((x = m("/api/mcp/connections/(\\w+)"))) { db.conns = db.conns.filter((c) => c.id !== x![1]); return json({ ok: true }) }
      if ((x = m("/api/turns/(\\w+)"))) { const g = adminOnly(); if (g) return g; const t = turns.find((t) => t.id === x![1]); return t ? json(t) : json({ error: "not_found" }, 404) }
      if (p === "/api/turns") {
        const g = adminOnly(); if (g) return g
        const st = sp.get("status"), tr = sp.get("trigger"), us = sp.get("user")
        return json(turns.filter((t) => (!st || t.status === st) && (!tr || t.trigger === tr) && (!us || t.userId === us)).slice(0, +(sp.get("limit") ?? 100)))
      }
      if (p === "/api/tokens") { const g = adminOnly(); if (g) return g; if (req.method === "POST") { db.tokens.push({ id: `t${nid++}`, name: body.name, createdAt: now() }); return json({ token: "cbt_" + crypto.randomUUID().replaceAll("-", "") }, 201) } return json(db.tokens) }
      if ((x = m("/api/tokens/(\\w+)"))) { db.tokens = db.tokens.filter((t) => t.id !== x![1]); return json({ ok: true }) }
      if (p === "/api/sync/sources") { const g = adminOnly(); if (g) return g; if (req.method === "POST") db.sync.push({ id: `y${nid++}`, provider: body.provider, lastSyncAt: null, status: "idle", selection: { mode: "all" } }); return json(db.sync) }
      if ((x = m("/api/sync/sources/(\\w+)/run"))) return json({ ok: true })
      if ((x = m("/api/sync/sources/(\\w+)"))) { const s = db.sync.find((s) => s.id === x![1]); if (s) s.selection = body.selection; return json({ ok: true }) }
      return json({ error: "not_found" }, 404)
    }
    // static + SPA fallback
    const f = Bun.file(join(dist, p === "/" ? "index.html" : p))
    if (p !== "/" && (await f.exists())) return new Response(f)
    return new Response(Bun.file(join(dist, "index.html")))
  },
})
console.log(`mock on http://localhost:${process.env.PORT ?? 3999}`)
