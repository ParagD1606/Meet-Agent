// Standalone mock of the REST contract (server/CONTRACTS.md) so the UI runs without the server:
//   bun run build && bun dev-mock.ts   (PORT=3999 default)
// Cookie "role" = owner|member signs you in; GET /auth/slack signs in as owner; /mock/role/member switches role.
// MOCK_UNCONFIGURED=1 shows the setup wizard. MOCK_GRAPH=5000 sets the graph size (default 5200).
import { join } from "node:path"
import { meetingRoutes } from "./dev-mock-meetings"

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
    tasks: [{ id: "mtask_1", title: "Draft the onboarding checklist", description: "Prepare a reviewable first draft for the product team.", assigneeName: "Max Member", assigneeId: "U2", dueDate: "Friday", jiraKey: null, jiraUrl: null, notification: { status: "sent" } }, { id: "mtask_2", title: "Prepare release notes", description: "Create release notes before the onboarding checklist launch.", assigneeName: null, assigneeId: null, dueDate: "Before launch", jiraKey: null, jiraUrl: null, notification: { status: "needs_assignee" } }] }] as any[],
  mcpWrites: true,
  trello: { configured: process.env.MOCK_TRELLO === "1", keyLast4: "ab12", boardId: "b1", listId: "l1", memberMap: { U2: "m1" } as Record<string, string> },
  gh: { configured: process.env.MOCK_GH !== "none", repo: process.env.MOCK_GH === "none" ? "" : "acme/web", assigneeMap: { U1: "ada" } as Record<string, string>, labels: ["pixel"], milestone: null as number | null, projectOwner: "", projectNumber: null as number | null,
    credential: { kind: process.env.MOCK_GH === "none" ? "none" : "app", appConfigured: true, installations: 1, hasPat: false, preferPat: false, appSlug: "pixel-app" } as any },
  conns: [{ id: "c1", provider: "notion", label: "Notion", url: "https://mcp.notion.com/mcp", scope: "org", ownerUserId: null, ownerName: null, status: "connected", toolCount: 26, readCount: 18, writeCount: 8, writesEnabled: true, allowWrites: null, connectedAt: ago(9000), lastVerifiedAt: ago(20) },
    { id: "c3", provider: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", scope: "user", ownerUserId: "U2", ownerName: "Max Member", status: "connected", toolCount: 41, readCount: 30, writeCount: 11, writesEnabled: true, connectedAt: ago(3000), lastVerifiedAt: ago(35) },
    { id: "c2", provider: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", scope: "user", ownerUserId: "U1", ownerName: "Ada Lovelace", status: "needs_reauth", error: "Authorization expired or was revoked. Reconnect to continue.", lastError: "Authorization expired or was revoked. Reconnect to continue.", toolCount: 18, readCount: 12, writeCount: 6, writesEnabled: true, connectedAt: ago(20000), lastVerifiedAt: ago(70) },
    { id: "c4", provider: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp", scope: "org", ownerUserId: null, status: "connected", toolCount: null, writesEnabled: false, allowWrites: false, connectedAt: ago(500), lastVerifiedAt: null }] as any[],
  tokens: [{ id: "t1", name: "Cursor", createdAt: ago(5000), lastUsedAt: ago(30) }] as any[],
  sync: [{ id: "y1", provider: "notion", connected: true, configured: true, lastSyncAt: ago(90), selection: { ids: ["*"] } }, { id: "y2", provider: "github", connected: true, configured: true, lastSyncAt: null, selection: null }, { id: "y3", provider: "gmail", connected: true, configured: true, lastSyncAt: ago(30), selection: { ids: ["*"], scopeTag: "user_U1" } }] as any[],
  freshness: "normal" as "normal" | "fast",
  hours: { timezone: "Asia/Kolkata", start: 9, end: 18, quietHours: false, backfillDays: 14 },
  observe: [{ id: "C1", name: "eng", isPrivate: false, observe: true }, { id: "C2", name: "random", isPrivate: false, observe: false }, { id: "C4", name: "leads", isPrivate: true, observe: true }] as any[],
  clog: [{ id: 3, runId: "r2", action: "merge", scopeTag: "shared", count: 4, createdAt: ago(300), undoneAt: null }, { id: 2, runId: "r2", action: "archive_stale", scopeTag: "shared", count: 11, createdAt: ago(301), undoneAt: null }, { id: 1, runId: "r1", action: "promote", scopeTag: "private", count: 1, createdAt: ago(1700), undoneAt: ago(1000) }] as any[],
  prompt: "We are Acme. Be concise.",
  persona: { name: "Pixel", role: "your team's AI teammate", tone: "friendly, warm, concise", greeting: "" } as any,
  cards: { ticket: true } as any,
  features: { digest: ["C1"], nudge: [], deadlines: ["C1", "C4"], autoreply: [], standup: [], risks: ["CZZ99999"] } as any,
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
      if (p === "/api/channels") return json([{ id: "C1", name: "eng", isPrivate: false, isIm: false, botIsMember: true, hasCoreBlock: true }, { id: "C2", name: "random", isPrivate: false, isIm: false, botIsMember: true, hasCoreBlock: false }, { id: "C3", name: "company-brain", isPrivate: false, isIm: false, botIsMember: false, hasCoreBlock: false }, { id: "C4", name: "leads", isPrivate: true, isIm: false, botIsMember: true, hasCoreBlock: true }])
      if (p === "/api/settings/persona") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") { if (/ignore/i.test(body.tone ?? "")) return json({ error: "invalid_persona", message: "tone looks like an instruction override" }, 400); db.persona = { ...body } } return json(req.method === "PUT" ? { persona: db.persona } : { persona: db.persona, defaults: { name: "Pixel", role: "your team's AI teammate", tone: "friendly, warm, concise", greeting: "" }, limits: { name: 40, role: 80, tone: 400, greeting: 200 } }) }
      if (p === "/api/settings/approvals") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") db.cards = body.cards; return json({ cards: db.cards, classes: ["ticket", "slack_post", "doc_edit", "email_calendar"] }) }
      if (p === "/api/settings/proactive-features") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") Object.assign(db.features, body); return json(db.features) }
      if (p === "/api/usage/cost") { const g = adminOnly(); if (g) return g; const n = +(sp.get("days") ?? 30); const byDay = Array.from({ length: n }, (_, i) => ({ day: new Date(Date.now() - (n - 1 - i) * 864e5).toISOString().slice(0, 10), usd: 1.2 + (i % 5), turns: 20 + i, models: { "claude-sonnet-4-5": 0.8 + (i % 5) * 0.6, "claude-haiku-4-5": 0.4 + (i % 3) * 0.2, "gpt-5": (i % 4) * 0.3 } })); return json({ days: n, totalUsd: byDay.reduce((a, d) => a + d.usd, 0), byDay, byModel: [{ model: "claude-sonnet-4-5", usd: 40, turns: 300, inputTokens: 900000, outputTokens: 90000 }, { model: "claude-haiku-4-5", usd: 9, turns: 500, inputTokens: 700000, outputTokens: 50000 }], month: { spentUsd: 41.5, alertUsd: 50 } }) }
      if (p === "/api/manager/commitments") { const g = adminOnly(); if (g) return g; const st = (sp.get("status") ?? "").split(",").filter(Boolean); const all = [{ id: "cm1", ownerId: "U2", ownerName: "Max Member", text: "Draft the onboarding checklist and share it for review", dueAt: ago(-3000), sourceType: "meeting", permalink: "https://example.slack.com/archives/C1/p1", channelId: "C1", status: "open", nudgeCount: 0, completedAt: null, createdAt: ago(900) }, { id: "cm2", ownerId: null, ownerName: "Priya", text: "Send the SOC 2 evidence to the auditor", dueAt: ago(2000), sourceType: "message", permalink: null, channelId: "C4", status: "overdue", nudgeCount: 2, completedAt: null, createdAt: ago(9000) }, { id: "cm3", ownerId: "U1", ownerName: "Ada Lovelace", text: "Publish release notes", dueAt: null, sourceType: "ticket", permalink: null, channelId: null, status: "done", nudgeCount: 1, completedAt: ago(100), createdAt: ago(5000) }]; return json({ commitments: all.filter((c) => !st.length || st.includes(c.status)) }) }
      if (p === "/api/integrations/targets") return json({ trello: !!db.trello.listId, github: db.gh.configured })
      if (p === "/api/settings/integrations/trello") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") { Object.assign(db.trello, { configured: true, keyLast4: (body.key ?? "0000abcd").slice(-4), boardId: body.boardId, listId: body.listId, memberMap: body.memberMap }) } return json(db.trello) }
      if (p === "/api/settings/integrations/trello/test") { const g = adminOnly(); return g ?? json({ ok: true, username: "pixelbot" }) }
      if (p === "/api/integrations/trello/boards") { const g = adminOnly(); return g ?? json({ boards: [{ id: "b1", name: "Product roadmap" }, { id: "b2", name: "Support" }] }) }
      if ((x = m("/api/integrations/trello/boards/(\\w+)/lists"))) { const g = adminOnly(); return g ?? json({ lists: [{ id: "l1", name: "Backlog" }, { id: "l2", name: "This sprint" }] }) }
      if ((x = m("/api/integrations/trello/boards/(\\w+)/members"))) { const g = adminOnly(); return g ?? json({ members: [{ id: "m1", name: "Max Member", username: "maxm" }, { id: "m2", name: "Ada Lovelace", username: "ada" }] }) }
      if (p === "/api/settings/integrations/github-issues") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") Object.assign(db.gh, { configured: true, repo: body.repo, assigneeMap: body.assigneeMap, labels: body.labels, milestone: body.milestone ?? null, projectOwner: body.projectOwner ?? "", projectNumber: body.projectNumber ?? null }); return json(db.gh) }
      if (p === "/api/settings/integrations/github-issues/test") { const g = adminOnly(); return g ?? json({ ok: false, repo: body.repo ?? db.gh.repo, credential: "app", message: "The GitHub App is missing: Organization projects: Read & write.", checks: [{ name: "credential", ok: true, message: "Using the GitHub App installed for sync" }, { name: "repository", ok: true, message: "Found acme/web" }, { name: "issues access", ok: true, message: "Issues can be read" }, { name: "app permissions", ok: false, message: "The GitHub App is missing: Organization projects: Read & write. Add it at https://github.com/settings/apps/pixel-app/permissions, then an organization owner must approve the updated permissions." }] }) }
      if (p === "/api/integrations/github/repos") { const g = adminOnly(); if (g) return g; const q = (sp.get("q") ?? "").toLowerCase(); const page = +(sp.get("page") ?? 1); const all = [{ fullName: "acme/web", private: true, hasIssues: true }, { fullName: "acme/api", private: true, hasIssues: true }, { fullName: "acme/docs", private: false, hasIssues: true }, ...Array.from({ length: 60 }, (_, i) => ({ fullName: `acme/service-${i}`, private: i % 3 === 0, hasIssues: true }))].filter((r) => r.fullName.includes(q)); return json({ credential: "app", total: all.length, repos: all.slice((page - 1) * 30, page * 30), page, hasMore: all.length > page * 30 }) }
      if (p === "/api/integrations/github/suggestions") { const g = adminOnly(); return g ?? json({ candidates: [{ login: "ada", name: "Ada Lovelace" }, { login: "maxm", name: "Max M" }, { login: "priya-p", name: null }], suggestions: [{ userId: "U2", userName: "Max Member", login: "maxm", confidence: "high", reason: "same email" }, { userId: "U3", userName: "Priya Patel", login: "priya-p", confidence: "medium", reason: "GitHub login matches the email name" }] }) }
      if (p === "/api/tasks/push") return json({ results: (body.ids ?? []).map((id: string) => ({ ref: id, title: id, status: "created", url: `https://trello.com/c/${id}` })), created: (body.ids ?? []).length, existing: 0, skipped: 0, failed: 0 })
      if (p === "/api/tasks/export" || /^\/api\/meetings\/\w+\/export$/.test(p)) return new Response("source,title\r\n#eng,Mock\r\n", { headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="tasks.csv"' } })
      if (p === "/api/people") return json({ people: [...users, { id: "U3", name: "Priya Patel" }].map((u: any) => ({ id: u.id, name: u.name, avatarUrl: null, title: null })) })
      if (p === "/api/memory/run" && req.method === "POST") { const g = adminOnly(); if (g) return g; if (body.job === "backfill-history") return json({ ok: false, error: "already_running", job: body.job }, 409); if (body.job === "backfill-prefix") return json({ ok: false, error: "rate_limited", job: body.job, retryAfterSec: 42 }, 429); return json({ ok: true, job: body.job, ms: 1234, counts: body.job === "sync" ? { huddles: { found: 2, imported: 1 }, sources: 3 } : { facts: 1, ambientFacts: 3 } }) }
      if (p === "/api/settings/memory-freshness") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") db.freshness = body.mode; return json({ mode: db.freshness, tuning: db.freshness === "fast" ? { captureEvery: 1, idleMs: 15000, ambientMax: 20, recallTtlMs: 5000, snapshotTtlMs: 300000, reflectCron: "* * * * *", observeCron: "*/2 * * * *" } : { captureEvery: 3, idleMs: 300000, ambientMax: 20, recallTtlMs: 60000, snapshotTtlMs: 21600000, reflectCron: "*/10 * * * *", observeCron: "*/30 * * * *" }, options: ["normal", "fast"] }) }
      if (p === "/api/consolidation-log") { const g = adminOnly(); return g ?? json(db.clog) }
      if ((x = m("/api/consolidation-log/(\\d+)/undo"))) { const g = adminOnly(); if (g) return g; const e = db.clog.find((e) => e.id === +x![1]!); if (!e) return json({ error: "not_found" }, 404); if (e.undoneAt) return json({ error: "already_undone" }, 409); e.undoneAt = now(); return json({ ok: true }) }
      if (p === "/api/channels/observe") { const g = adminOnly(); return g ?? json({ channels: db.observe }) }
      if ((x = m("/api/channels/(\\w+)/observe"))) { const g = adminOnly(); if (g) return g; const c = db.observe.find((c) => c.id === x![1]); if (!c) return json({ error: "not_found" }, 404); c.observe = body.observe; return json({ id: c.id, observe: c.observe }) }
      if (p === "/api/settings/workspace-hours") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") { if (body.backfillDays < 1 || body.backfillDays > 90) return json({ error: "invalid_body", issues: [{ path: "backfillDays", message: "Must be between 1 and 90" }] }, 400); Object.assign(db.hours, body) } return json(db.hours) }
      if (p === "/api/tasks" || (x = m("/api/tasks/(\\w+)"))) {
        const me = admin ? "U1" : "U2"
        const mkTask = (id: string, title: string, o: any): any => ({ id, title, status: "open", priority: "normal", dueAt: null, overdue: false, ownerId: "U2", ownerName: "Max Member", ownerAvatar: null, assignerId: "U1", assignerName: "Ada Lovelace", assignerAvatar: null, permalink: "https://example.slack.com/archives/C1/p1", channelId: "C1", channelName: "general", sourceType: "message", createdAt: ago(900), completedAt: null, ...o })
        const tasks: any[] = ((globalThis as any).__tasks ??= [
          mkTask("cm1", "Tales launch", { priority: "urgent", dueAt: ago(-1500) }),
          mkTask("cm2", "Send the SOC 2 evidence to the auditor", { ownerId: "U3", ownerName: "Priya Patel", status: "overdue", overdue: true, dueAt: ago(2000), channelId: "C4", channelName: "security" }),
          mkTask("cm3", "Draft the onboarding checklist", { dueAt: ago(-3000), sourceType: "meeting", status: "in_progress" }),
          mkTask("cm5", "Pick a vendor for the status page", { ownerId: null, ownerName: null, dueAt: ago(-6000), createdAt: ago(6000) }),
          mkTask("cm6", "Write the incident postmortem", { ownerId: "U3", ownerName: "Priya Patel", priority: "urgent", createdAt: ago(30000) }),
          mkTask("cm7", "Renew the domain", { dueAt: ago(-2000) }),
          mkTask("cm4", "Publish release notes", { ownerId: "U1", ownerName: "Ada Lovelace", assignerId: "U2", assignerName: "Max Member", status: "done", completedAt: ago(100) }),
        ])
        const flagsOf = (t: any) => {
          if (["done", "dropped"].includes(t.status)) return []
          const f: string[] = [], d = t.dueAt ? new Date(t.dueAt).getTime() : null, n = Date.now()
          if (d !== null && d <= n) f.push("overdue")
          if (!t.ownerId) f.push("unassigned")
          if (d === null) f.push("noDue")
          if (d !== null && d > n && d <= n + 3 * 86400000) f.push("dueSoon")
          if (t.status === "open" && n - new Date(t.createdAt).getTime() > 14 * 86400000) f.push("stale")
          if (t.priority === "urgent") f.push("urgent")
          return f
        }
        const all = tasks.map((t) => ({ ...t, overdue: !!t.dueAt && new Date(t.dueAt).getTime() <= Date.now() && !["done", "dropped"].includes(t.status), flags: flagsOf(t) }))
        const cnt = (f: string) => all.filter((t) => t.flags.includes(f)).length
        const counts = { total: all.length, open: all.filter((t) => !["done", "dropped"].includes(t.status)).length, overdue: cnt("overdue"), unassigned: cnt("unassigned"), noDue: cnt("noDue"), dueSoon: cnt("dueSoon"), done7d: all.filter((t) => t.status === "done").length }
        if (req.method === "GET") return json({ me, counts, tasks: all.map((t) => ({ ...t, canEdit: admin || t.ownerId === me || t.assignerId === me, canReassign: admin || t.assignerId === me })) })
        if (req.method === "POST") { const o = users.find((u: any) => u.id === body.ownerId); tasks.unshift(mkTask(`cm${tasks.length + 1}`, body.title, { ownerId: body.ownerId, ownerName: o?.name ?? body.ownerId, assignerId: me, assignerName: admin ? "Ada Lovelace" : "Max Member", priority: body.priority ?? "normal", dueAt: body.due ?? null, channelId: body.channelId ?? null, channelName: null })); return json({ ok: true, created: true }, 201) }
        const t = tasks.find((t) => t.id === x![1]); if (!t) return json({ error: "not_found" }, 404)
        if (body.status) { t.status = body.status; t.overdue = false }
        if ("due" in body) t.dueAt = body.due ?? null
        if (body.ownerId) { const o = users.find((u: any) => u.id === body.ownerId); t.ownerId = body.ownerId; t.ownerName = o?.name ?? body.ownerId }
        return json({ ok: true })
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
      { const r = meetingRoutes(req.method, p, sp, body, admin); if (r) return r }
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
      if ((x = m("/api/mcp/connections/(\\w+)/test"))) { const c = db.conns.find((c) => c.id === x![1]); return c?.status === "needs_reauth" ? json({ ok: false, needsReauth: true, toolCount: 0, readCount: 0, writeCount: 0, latencyMs: 180, error: c.error }) : json({ ok: true, needsReauth: false, toolCount: c?.toolCount ?? 12, readCount: c?.readCount ?? 9, writeCount: c?.writeCount ?? 3, latencyMs: 412 }) }
      if ((x = m("/api/mcp/connections/(\\w+)/workspace"))) { const g = adminOnly(); if (g) return g; const c = db.conns.find((c) => c.id === x![1]); if (c) { c.scope = "org"; c.ownerUserId = null; c.ownerName = null } return json(c) }
      if (p === "/api/settings/mcp-writes") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") db.mcpWrites = body.enabled; return json({ enabled: db.mcpWrites }) }
      if (req.method === "PATCH" && (x = m("/api/mcp/connections/(\\w+)"))) { const g = adminOnly(); if (g) return g; const c = db.conns.find((c) => c.id === x![1]); if (c) { c.allowWrites = body.allowWrites; c.writesEnabled = body.allowWrites ?? db.mcpWrites } return json(c) }
      if ((x = m("/api/mcp/connections/(\\w+)"))) { db.conns = db.conns.filter((c) => c.id !== x![1]); return json({ ok: true }) }
      if ((x = m("/api/turns/(\\w+)"))) { const g = adminOnly(); if (g) return g; const t = turns.find((t) => t.id === x![1]); return t ? json(t) : json({ error: "not_found" }, 404) }
      if (p === "/api/turns") {
        const g = adminOnly(); if (g) return g
        const st = sp.get("status"), tr = sp.get("trigger"), us = sp.get("user")
        return json(turns.filter((t) => (!st || t.status === st) && (!tr || t.trigger === tr) && (!us || t.userId === us)).slice(0, +(sp.get("limit") ?? 100)))
      }
      if (p === "/api/tokens") { const g = adminOnly(); if (g) return g; if (req.method === "POST") { db.tokens.push({ id: `t${nid++}`, name: body.name, createdAt: now() }); return json({ token: "cbt_" + crypto.randomUUID().replaceAll("-", "") }, 201) } return json(db.tokens) }
      if ((x = m("/api/tokens/(\\w+)"))) { db.tokens = db.tokens.filter((t) => t.id !== x![1]); return json({ ok: true }) }
      if (p === "/api/sync/sources/token") { const g = adminOnly(); if (g) return g; if (body.provider === "jira" && !String(body.baseUrl).includes(".atlassian.net")) return json({ error: "invalid_connection", message: "baseUrl must be on atlassian.net (or an allow-listed host)" }, 400); const id = `y${nid++}`; db.sync.push({ id, provider: body.provider, connected: true, configured: true, lastSyncAt: null, selection: null }); return json({ id }, 201) }
      if (p === "/api/sync/personal") return json({ id: `y${nid++}`, authUrl: "/?connected=1" }, 201)
      if (p === "/api/sync/sources") { const g = adminOnly(); if (g) return g; if (req.method === "POST") db.sync.push({ id: `y${nid++}`, provider: body.provider, connected: false, configured: true, lastSyncAt: null, selection: null }); return json(db.sync) }
      if ((x = m("/api/sync/sources/(\\w+)/run"))) return json({ ok: true })
      if ((x = m("/api/sync/sources/(\\w+)")) && req.method === "DELETE") { db.sync = db.sync.filter((s) => s.id !== x![1]); return json({ ok: true }) }
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
