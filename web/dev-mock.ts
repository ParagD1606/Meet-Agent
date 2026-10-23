// Standalone mock of the REST contract so the UI runs without the server:
//   bun run build && bun dev-mock.ts   (PORT=3999 default)
// Cookie "role" = owner|member signs you in; GET /auth/slack signs in as owner; /mock/role/member switches role.
import { join } from "node:path"

const dist = join(import.meta.dir, "dist")
const now = () => new Date().toISOString()
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString()
let nid = 100
const db = {
  skills: [{ id: "s1", name: "weekly-report", description: "Write the weekly status report", body: "Summarise...", enabled: true }],
  automations: [{ id: "a1", ownerUserId: "U1", kind: "digest", prompt: "Summarise yesterday's #eng activity", cron: "0 9 * * 1-5", destChannelId: "C1", enabled: true, lastRunAt: ago(300), lastStatus: "ok" }],
  conns: [{ id: "c1", provider: "github", label: "GitHub", url: "https://api.githubcopilot.com/mcp/", scope: "org", ownerUserId: null, status: "connected" },
    { id: "c2", provider: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", scope: "user", ownerUserId: "U1", status: "pending" }],
  tokens: [{ id: "t1", name: "Cursor", createdAt: ago(5000) }],
  sync: [{ id: "y1", provider: "notion", lastSyncAt: ago(90), status: "idle" }],
  prompt: "We are Acme. Be concise.",
  proactivity: { default: "own", channels: [{ id: "C1", name: "eng", mode: "default" }, { id: "C2", name: "random", mode: "quiet" }, { id: "C3", name: "company-brain", mode: "proactive" }] },
  models: { fast: { provider: "anthropic", model: "claude-haiku-4-5" }, thorough: { provider: "", model: "" } } as Record<string, unknown>,
  memories: Array.from({ length: 70 }, (_, i) => ({ id: i + 1, text: `Decision ${i + 1}: we ship the billing revamp on the first Monday of the quarter, owner is Priya.`, scopeTag: i % 7 ? "shared" : "channel_C1", source: i % 5 ? "slack" : "upload", sourceRef: i % 5 ? null : "roadmap.pdf", createdAt: ago(i * 37) })),
}
const turns = Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, channelId: "C1", userId: "U1", trigger: ["mention", "dm", "chime", "automation"][i % 4], status: ["done", "done", "error", "waiting_approval", "running"][i % 5], toolCalls: new Array(i % 4), inputTokens: 1200 + i * 90, outputTokens: 300 + i * 11, error: i % 5 === 2 ? "Model timeout" : null, startedAt: ago(i * 25) }))
const graph = () => {
  const nodes = db.memories.slice(0, 60).map((m) => ({ id: m.id, label: m.text.slice(0, 40), scope: m.scopeTag, kind: m.source === "upload" ? "chunk" : "fact" }))
  const edges = nodes.flatMap((n, i) => (i > 0 ? [{ source: n.id, target: nodes[Math.floor(i / 2)]!.id, weight: 0.6 }] : []))
  return { nodes, edges }
}
const json = (d: unknown, status = 200) => Response.json(d, { status })

Bun.serve({
  port: Number(process.env.PORT ?? 3999),
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    const role = /role=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1]
    const admin = role === "owner"
    if (p === "/auth/slack") return new Response(null, { status: 302, headers: { location: "/", "set-cookie": "role=owner; Path=/" } })
    if (p.startsWith("/mock/role/")) return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `role=${p.split("/").pop()}; Path=/` } })
    if (p === "/auth/logout") return new Response(null, { status: 204, headers: { "set-cookie": "role=; Path=/; Max-Age=0" } })
    if (p.startsWith("/api/")) {
      if (req.method !== "GET" && req.headers.get("x-requested-with") !== "fetch") return json({ error: "csrf" }, 403)
      const body = req.method === "GET" || req.method === "DELETE" || req.headers.get("content-type")?.startsWith("multipart") ? {} : ((await req.json().catch(() => ({}))) as Record<string, any>)
      if (p === "/api/setup/status") return json({ model: true, embedding: !!url.searchParams.get("x") || true, slack: process.env.MOCK_UNCONFIGURED ? false : true, workspace: true })
      if (p === "/api/setup/manifest") return new Response("display_information:\n  name: Company Brain\noauth_config:\n  redirect_urls:\n    - https://brain.example.com/slack/oauth/callback\n")
      if (!role) return json({ error: "unauthorized" }, 401)
      const adminOnly = () => (admin ? null : json({ error: "Admins only" }, 403))
      const m = (r: string) => new RegExp(`^${r}$`).exec(p)
      let x: RegExpExecArray | null
      if (p === "/api/me") return json({ id: "U1", name: admin ? "Ada Lovelace" : "Max Member", role: admin ? "owner" : "member", avatarUrl: null })
      if (p === "/api/overview") return json({ memoryCount: db.memories.length, connections: db.conns, automations: db.automations, recentTurns: turns.slice(0, 5) })
      if (p === "/api/graph") return json(graph())
      if (p === "/api/memories" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase(), off = +(url.searchParams.get("offset") ?? 0), lim = +(url.searchParams.get("limit") ?? 30)
        return json(db.memories.filter((e) => e.text.toLowerCase().includes(q)).slice(off, off + lim))
      }
      if (p === "/api/memories/upload") { const g = adminOnly(); if (g) return g; db.memories.unshift({ id: nid++, text: "Uploaded chunk", scopeTag: "shared", source: "upload", sourceRef: "file", createdAt: now() }); return json({ chunks: 1 }) }
      if ((x = m("/api/memories/(\\d+)")) && req.method === "DELETE") { const g = adminOnly(); if (g) return g; db.memories = db.memories.filter((e) => e.id !== +x![1]!); return json({ ok: true }) }
      if (p === "/api/settings/workspace-prompt") { if (req.method === "PUT") { const g = adminOnly(); if (g) return g; db.prompt = body.prompt } return json({ prompt: db.prompt }) }
      if (p === "/api/settings/proactivity") { const g = adminOnly(); if (g) return g; if (req.method === "PUT") Object.assign(db.proactivity, body); return json(db.proactivity) }
      if (p === "/api/settings/models") { if (req.method === "PUT") { const g = adminOnly(); if (g) return g; db.models[body.profile] = body } return json(db.models) }
      if (p === "/api/skills") { if (req.method === "POST") { const g = adminOnly(); if (g) return g; db.skills.push({ ...(body as any), id: `s${nid++}` }) } return json(db.skills) }
      if ((x = m("/api/skills/(\\w+)"))) { const g = adminOnly(); if (g) return g; db.skills = req.method === "DELETE" ? db.skills.filter((s) => s.id !== x![1]) : db.skills.map((s) => (s.id === x![1] ? (body as any) : s)); return json({ ok: true }) }
      if (p === "/api/automations") { if (req.method === "POST") db.automations.push({ ownerUserId: "U1", enabled: true, lastRunAt: null, lastStatus: null, ...(body as any), id: `a${nid++}` }); return json(db.automations) }
      if ((x = m("/api/automations/(\\w+)/run"))) { const a = db.automations.find((a) => a.id === x![1])!; a.lastRunAt = now(); a.lastStatus = "ok"; return json({ ok: true }) }
      if ((x = m("/api/automations/(\\w+)"))) { if (req.method === "DELETE") db.automations = db.automations.filter((a) => a.id !== x![1]); else Object.assign(db.automations.find((a) => a.id === x![1])!, body); return json({ ok: true }) }
      if (p === "/api/mcp/presets") return json(["github", "linear", "notion", "sentry", "plain", "posthog", "granola", "gmail", "google"].map((k) => ({ key: k, label: k[0]!.toUpperCase() + k.slice(1), url: `https://mcp.${k}.com/mcp`, authType: "oauth", personalOnly: k === "gmail" })))
      if (p === "/api/mcp/connections") { if (req.method === "POST") { const c = { id: `c${nid++}`, provider: body.provider ?? "custom", label: body.label, url: body.url ?? "https://x", scope: body.scope, ownerUserId: "U1", status: "pending" }; db.conns.push(c as any); return json(c) } return json(db.conns) }
      if ((x = m("/api/mcp/connections/(\\w+)/connect"))) return json({ authUrl: "/?connected=1" })
      if ((x = m("/api/mcp/connections/(\\w+)"))) { db.conns = db.conns.filter((c) => c.id !== x![1]); return json({ ok: true }) }
      if (p === "/api/turns") { const g = adminOnly(); return g ?? json(turns) }
      if (p === "/api/tokens") { const g = adminOnly(); if (g) return g; if (req.method === "POST") { db.tokens.push({ id: `t${nid++}`, name: body.name, createdAt: now() }); return json({ token: "brn_" + crypto.randomUUID().replaceAll("-", "") }) } return json(db.tokens) }
      if ((x = m("/api/tokens/(\\w+)"))) { db.tokens = db.tokens.filter((t) => t.id !== x![1]); return json({ ok: true }) }
      if (p === "/api/sync/sources") { const g = adminOnly(); if (g) return g; if (req.method === "POST") db.sync.push({ id: `y${nid++}`, provider: body.provider, lastSyncAt: null as any, status: "idle" }); return json(db.sync) }
      if (m("/api/sync/sources/(\\w+)/run")) return json({ ok: true })
      return json({ error: "not found" }, 404)
    }
    // static + SPA fallback
    const f = Bun.file(join(dist, p === "/" ? "index.html" : p))
    if (p !== "/" && (await f.exists())) return new Response(f)
    return new Response(Bun.file(join(dist, "index.html")))
  },
})
console.log(`mock on http://localhost:${process.env.PORT ?? 3999}`)
