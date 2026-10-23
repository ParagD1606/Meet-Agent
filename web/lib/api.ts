// Typed client for the REST contract (server/CONTRACTS.md). Cookie auth; CSRF header on non-GET.

export type Role = "owner" | "admin" | "member"
export interface Me { id: string; name: string; role: Role; avatarUrl?: string | null }
export const isAdmin = (r?: Role) => r === "owner" || r === "admin"

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

let onUnauthorized: () => void = () => {}
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn }

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== "GET") headers["x-requested-with"] = "fetch"
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body) }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" })
  if (res.status === 401) { onUnauthorized(); throw new ApiError(401, "Please sign in") }
  const text = await res.text()
  let data: unknown = null
  if (text) { try { data = JSON.parse(text) } catch { data = text } }
  if (!res.ok) {
    const d = data as { error?: unknown; message?: unknown } | string | null
    const msg = typeof d === "string" ? d : typeof d?.error === "string" ? d.error : typeof d?.message === "string" ? d.message : `Request failed (${res.status})`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

const get = <T,>(p: string) => request<T>("GET", p)
const send = <T,>(m: string, p: string, b?: unknown) => request<T>(m, p, b ?? {})

/** Lists may arrive bare or wrapped ({items}|{rows}|{<key>}); normalise. */
export function list<T>(d: unknown, key?: string): T[] {
  if (Array.isArray(d)) return d as T[]
  const o = d as Record<string, unknown> | null
  if (o) for (const k of [key, "items", "rows", "data"]) if (k && Array.isArray(o[k])) return o[k] as T[]
  return []
}
export const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" ? v : 0)

export interface SetupStatus { model: boolean; embedding: boolean; slack: boolean; workspace?: boolean }
export interface Turn {
  id: string; channelId: string; threadTs?: string | null; userId?: string | null; trigger: string
  status: "running" | "done" | "error" | "waiting_approval"; toolCalls?: unknown[]
  inputTokens?: number | null; outputTokens?: number | null; error?: string | null
  startedAt: string; finishedAt?: string | null
}
export interface Overview { memoryCount: number; connections: unknown; automations: unknown; recentTurns: Turn[] }
export interface GraphData {
  nodes: { id: number; label: string; scope: string; kind: string }[]
  edges: { source: number; target: number; weight: number }[]
}
export interface Memory { id: number; text: string; scopeTag: string; source: string; sourceRef?: string | null; kind?: string; createdAt: string }
export interface Preset { key: string; label: string; url: string; authType?: string; personalOnly?: boolean }
export interface Connection {
  id: string; provider: string; label: string; url: string; scope: "org" | "user"
  ownerUserId?: string | null; status: "pending" | "connected" | "error"
}
export interface Skill { id: string; name: string; description: string; body: string; enabled: boolean }
export interface Automation {
  id: string; ownerUserId: string; kind: "digest" | "reminder"; prompt: string; cron?: string | null
  runAt?: string | null; destChannelId?: string | null; enabled: boolean; lastRunAt?: string | null; lastStatus?: string | null
}
export type ProactivityMode = "default" | "proactive" | "quiet"
export interface Proactivity { default: "all" | "own"; channels: { id: string; name: string; mode: ProactivityMode }[] }
export interface ModelSetting { profile: string; provider: string; model: string }
export interface ApiToken { id: string; name: string; createdAt: string }
export interface SyncSource { id: string; provider: "gdrive" | "onedrive" | "notion"; lastSyncAt?: string | null; status?: string | null }

export const api = {
  me: () => get<Me | { user: Me }>("/api/me").then((m) => ("user" in m ? m.user : m)),
  setupStatus: () => get<SetupStatus>("/api/setup/status"),
  setupManifest: () => fetch("/api/setup/manifest").then(async (r) => { if (!r.ok) throw new ApiError(r.status, "Could not load manifest"); return r.text() }),
  overview: () => get<Overview>("/api/overview"),
  graph: (limit = 300) => get<GraphData>(`/api/graph?limit=${limit}`),
  memories: (q: string, limit: number, offset: number) =>
    get<unknown>(`/api/memories?${new URLSearchParams({ q, limit: String(limit), offset: String(offset) })}`).then((d) => list<Memory>(d, "memories")),
  deleteMemory: (id: number) => send("DELETE", `/api/memories/${id}`),
  uploadMemory: (file: File) => { const f = new FormData(); f.append("file", file); return request<unknown>("POST", "/api/memories/upload", f) },
  workspacePrompt: () => get<{ prompt: string }>("/api/settings/workspace-prompt"),
  saveWorkspacePrompt: (prompt: string) => send("PUT", "/api/settings/workspace-prompt", { prompt }),
  proactivity: () => get<Proactivity>("/api/settings/proactivity"),
  saveProactivity: (p: Proactivity) => send("PUT", "/api/settings/proactivity", p),
  models: () => get<unknown>("/api/settings/models"),
  saveModel: (m: ModelSetting) => send("PUT", "/api/settings/models", m),
  skills: () => get<unknown>("/api/skills").then((d) => list<Skill>(d, "skills")),
  createSkill: (s: Omit<Skill, "id">) => send<Skill>("POST", "/api/skills", s),
  updateSkill: (s: Skill) => send("PUT", `/api/skills/${s.id}`, s),
  deleteSkill: (id: string) => send("DELETE", `/api/skills/${id}`),
  automations: () => get<unknown>("/api/automations").then((d) => list<Automation>(d, "automations")),
  createAutomation: (a: Partial<Automation>) => send<Automation>("POST", "/api/automations", a),
  patchAutomation: (id: string, a: Partial<Automation>) => send("PATCH", `/api/automations/${id}`, a),
  deleteAutomation: (id: string) => send("DELETE", `/api/automations/${id}`),
  runAutomation: (id: string) => send("POST", `/api/automations/${id}/run`),
  presets: () => get<unknown>("/api/mcp/presets").then((d) => list<Preset>(d, "presets")),
  connections: () => get<unknown>("/api/mcp/connections").then((d) => list<Connection>(d, "connections")),
  createConnection: (c: { provider?: string; url?: string; label?: string; scope: "org" | "user" }) => send<Connection>("POST", "/api/mcp/connections", c),
  deleteConnection: (id: string) => send("DELETE", `/api/mcp/connections/${id}`),
  connect: (id: string) => send<{ authUrl: string }>("POST", `/api/mcp/connections/${id}/connect`),
  turns: (limit = 100) => get<unknown>(`/api/turns?limit=${limit}`).then((d) => list<Turn>(d, "turns")),
  tokens: () => get<unknown>("/api/tokens").then((d) => list<ApiToken>(d, "tokens")),
  createToken: (name: string) => send<{ token: string } & Partial<ApiToken>>("POST", "/api/tokens", { name }),
  deleteToken: (id: string) => send("DELETE", `/api/tokens/${id}`),
  syncSources: () => get<unknown>("/api/sync/sources").then((d) => list<SyncSource>(d, "sources")),
  createSyncSource: (provider: SyncSource["provider"]) => send<Partial<SyncSource> & { authUrl?: string }>("POST", "/api/sync/sources", { provider }),
  runSync: (id: string) => send("POST", `/api/sync/sources/${id}/run`),
}
