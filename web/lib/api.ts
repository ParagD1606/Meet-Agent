// Typed client for the REST contract (server/CONTRACTS.md, incl. Pass 2 addendum).
// Cookie auth; CSRF header on non-GET. Errors are { error, issues?: [{path,message}] }.

export type Role = "owner" | "admin" | "member"
export interface Me { id: string; name: string; role: Role; avatarUrl?: string | null }
export const isAdmin = (r?: Role) => r === "owner" || r === "admin"

export interface Issue { path: string; message: string }
export class ApiError extends Error {
  constructor(public status: number, message: string, public issues: Issue[] = [], public data?: unknown) { super(message) }
  /** Message for a given form field, from server `issues`. */
  field(path: string): string | null { return this.issues.find((i) => i.path === path || i.path.endsWith(`.${path}`))?.message ?? null }
}
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
export const fieldErr = (e: unknown, path: string) => (e instanceof ApiError ? e.field(path) : null)

let onUnauthorized: () => void = () => {}
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn }

const CODES: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  not_found: "That no longer exists.",
  invalid_body: "Some fields are invalid.",
  file_too_large: "That file is too large (20 MB max).",
  ingest_failed: "The file could not be read.",
  model_not_configured: "No model is configured on the server yet.",
  version_conflict: "Someone else changed this. Reload to see the latest.",
}

export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== "GET") headers["x-requested-with"] = "fetch"
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body) }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin", signal })
  if (res.status === 401) { onUnauthorized(); throw new ApiError(401, "Please sign in") }
  const text = await res.text()
  let data: unknown = null
  if (text) { try { data = JSON.parse(text) } catch { data = text } }
  if (!res.ok) {
    const d = data as { error?: unknown; message?: unknown; issues?: Issue[] } | string | null
    const raw = typeof d === "string" ? d : typeof d?.message === "string" ? d.message : typeof d?.error === "string" ? d.error : ""
    throw new ApiError(res.status, CODES[raw] ?? (raw || `Request failed (${res.status})`), typeof d === "object" && Array.isArray(d?.issues) ? d.issues : [], data)
  }
  return data as T
}

const get = <T,>(p: string) => request<T>("GET", p)
const send = <T,>(m: string, p: string, b?: unknown) => request<T>(m, p, b ?? {})
const qs = (o: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ""
}

/** Lists may arrive bare or wrapped ({items}|{rows}|{<key>}); normalise. */
export function list<T>(d: unknown, key?: string): T[] {
  if (Array.isArray(d)) return d as T[]
  const o = d as Record<string, unknown> | null
  if (o) for (const k of [key, "items", "rows", "data"]) if (k && Array.isArray(o[k])) return o[k] as T[]
  return []
}
export const count = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" ? v : 0)

// ---- setup
export type Check = boolean | { ok: boolean; detail?: string | null; error?: string | null }
export interface SetupStatus {
  model: boolean; embedding: boolean; slack: boolean
  workspace?: boolean | { id: string; name: string } | null
  ownerLocked?: boolean; teamPinned?: boolean
  publicUrl?: string; slackMode?: string
  checks?: Partial<Record<"db" | "boss" | "model" | "embedding" | "slack", Check>>
}
export const checkOk = (c: Check | undefined) => (c === undefined ? undefined : typeof c === "boolean" ? c : c.ok)
export const checkDetail = (c: Check | undefined) => (c && typeof c === "object" ? c.detail ?? c.error ?? null : null)

// ---- turns
export interface ToolCall { name: string; args?: unknown; result?: unknown; startedAt?: string; durationMs?: number | null; error?: string | null; ok?: boolean }
export type TurnStatus = "running" | "done" | "error" | "waiting_approval"
export interface Turn {
  id: string; channelId: string; threadTs?: string | null; userId?: string | null; trigger: string
  status: TurnStatus; toolCalls?: ToolCall[] | null
  inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheWriteTokens?: number | null
  costMicros?: number | null; model?: string | null; steps?: number | null; depth?: string | null
  promptBreakdown?: Partial<Record<string, number>> | null
  permalink?: string | null; error?: string | null; text?: string | null
  startedAt: string; finishedAt?: string | null
}
export interface TurnFilters { status?: string; trigger?: string; channel?: string; user?: string; limit?: number }
export interface UserRow { id: string; name: string; email?: string | null; avatarUrl?: string | null; role: Role }

export interface Overview { memoryCount: number; connections: unknown; automations: unknown; recentTurns: Turn[] }

// ---- memory
export interface Memory {
  id: number; text: string; scopeTag: string; source: string; sourceRef?: string | null; kind?: string; createdAt: string
  status?: "active" | "superseded"; supersededBy?: number | null; validAt?: string | null; invalidAt?: string | null
  createdBy?: string | null; permalink?: string | null; confidence?: number | null; importance?: number | null; reviewState?: string | null
}
export interface MemoryPage { items: Memory[]; total: number }
export interface GraphNode { id: number; label: string; scope: string; kind: string; source?: string; createdAt?: string; status?: string }
export interface GraphData { nodes: GraphNode[]; edges: { source: number; target: number; weight: number }[]; total?: number; truncated?: boolean }
export interface CoreBlock { scopeTag: string; label: "company" | "channel" | "user"; text: string; charLimit: number; version: number }
export interface Review {
  id: string; kind: "supersede" | "low_confidence" | "core_block" | "shared_write"; status: "pending" | "approved" | "rejected"
  memoryId?: number | null; memory?: { id: number; text: string } | null; requestedBy?: string | null; createdAt: string
  /** kind-specific: core_block {label,tag,op,text,match}; supersede {supersededIds}; shared_write {wouldSupersede,...} */
  payload: Record<string, unknown>
}

// ---- behaviour
export interface Preset { key: string; label: string; url: string; authType?: string; personalOnly?: boolean }
export interface Connection {
  id: string; provider: string; label: string; url: string; scope: "org" | "user"
  ownerUserId?: string | null; status: "pending" | "connected" | "error"; error?: string | null; lastError?: string | null; reason?: string | null; toolCount?: number | null; connectedAt?: string | null
}
export interface MarketItem { key: string; name: string; url: string; categories: string[]; connectMode: "oauth" | "apikey"; personalOnly?: boolean; iconDomain?: string; connected?: boolean }
export interface MarketPage { items: MarketItem[]; total: number }
export interface Skill { id: string; name: string; description: string; body: string; enabled: boolean; scope?: "org" | "user"; version?: number; ownerUserId?: string | null }
export interface Automation {
  id: string; ownerUserId: string; kind: "digest" | "reminder"; prompt: string; cron?: string | null
  runAt?: string | null; destChannelId?: string | null; enabled: boolean; lastRunAt?: string | null; lastStatus?: string | null
}
export type MeetingStatus = "processing" | "ready" | "failed"
export interface MeetingTask {
  id: string; title: string; description: string; assigneeName: string | null; assigneeId: string | null; dueDate: string | null
  jiraKey?: string | null; jiraUrl?: string | null
  notification?: { status: "needs_assignee" | "pending" | "sent" | "acknowledged" | "declined" | "failed"; error?: string | null }
}
export interface Meeting {
  id: string; sourceFileId: string; channelId: string; threadTs?: string | null; platform?: string; title: string
  transcript?: string; summary?: string | null; decisions?: string[]; tasks: MeetingTask[]; participantIds: string[]; status: MeetingStatus
  startedAt?: string | null; endedAt?: string | null; createdAt: string; updatedAt: string
}
export type ProactivityMode = "default" | "proactive" | "quiet"
export interface ProactivityChannel { id: string; name: string; mode: ProactivityMode; observe?: boolean }
export interface Proactivity { default: "all" | "own"; channels: ProactivityChannel[] }
export type Role5 = "main" | "triage" | "extract" | "summarize" | "research"
export interface ModelOption { id: string; label: string; profile?: string }
export interface ModelSettings {
  provider: string | null; freeText?: boolean; models: ModelOption[]
  roles?: Partial<Record<Role5, { model: string | null } | string | null>>
  fallback?: { provider?: string | null; model: string | null } | string | null
  profile?: string; model?: string | null
}
export interface Limits {
  perTurnTokenCeiling: number; perUserDailyTokens: number; orgDailyTokens: number; concurrentTurns: number
  maxStepsByDepth: { direct: number; memory: number; tools: number; deep: number }
}
export interface ApiToken { id: string; name: string; createdAt: string; lastUsedAt?: string | null }
export interface SyncSource {
  id: string; provider: "gdrive" | "onedrive" | "notion"; lastSyncAt?: string | null; status?: string | null
  selection?: { mode?: "all" | "selected"; ids?: string[]; label?: string } | null; error?: string | null
}

// ---- usage
export type UsageRange = "1d" | "7d" | "30d" | "90d"
export interface UsageRow { turns?: number; inputTokens: number; outputTokens: number; costMicros: number }
export interface Usage {
  byDay: (UsageRow & { day: string })[]
  byUser: (UsageRow & { userId: string | null; name?: string | null })[]
  byModel: (UsageRow & { model: string })[]
  byRole: (UsageRow & { role: string })[]
  cacheHitRate: number | null
  avgBreakdown: Partial<Record<string, number>>
  topTurns: { id: string; userId?: string | null; trigger?: string; depth?: string | null; steps?: number; model?: string | null; inputTokens: number; outputTokens: number; costMicros: number; startedAt: string; channelId?: string }[]
}

// ---- channels, Pixel, cost, commitments
export interface Channel { id: string; name: string | null; isPrivate: boolean; isIm: boolean; botIsMember: boolean; hasCoreBlock: boolean }
export interface Persona { name: string; role: string; tone: string; greeting: string }
export interface PersonaSettings { persona: Persona; defaults: Persona; limits: Record<keyof Persona, number> }
export const ACTION_CLASSES = ["ticket", "slack_post", "doc_edit", "email_calendar"] as const
export type ActionClass = (typeof ACTION_CLASSES)[number]
export type ApprovalCards = Partial<Record<ActionClass, boolean>>
export const FEATURES = ["digest", "nudge", "deadlines", "autoreply", "standup", "risks"] as const
export type Feature = (typeof FEATURES)[number]
export type ProactiveFeatures = Record<Feature, string[]>
export interface CostReport {
  days: number; totalUsd: number
  byDay: { day: string; usd: number; turns: number; models: Record<string, number> }[]
  byModel: { model: string; usd: number; turns: number; inputTokens: number; outputTokens: number }[]
  month?: { spentUsd: number; alertUsd: number | null }
}
export type CommitmentStatus = "open" | "done" | "dropped" | "overdue"
export interface Commitment {
  id: string; ownerId: string | null; ownerName: string | null; text: string; dueAt: string | null; sourceType: string
  permalink: string | null; channelId: string | null; status: CommitmentStatus; nudgeCount: number; completedAt: string | null; createdAt: string
}

export const api = {
  me: () => get<Me | { user: Me }>("/api/me").then((m) => ("user" in m ? m.user : m)),
  users: () => get<unknown>("/api/users").then((d) => list<UserRow>(d, "users")),
  setupStatus: () => get<SetupStatus>("/api/setup/status"),
  setupManifest: () => fetch("/api/setup/manifest").then(async (r) => { if (!r.ok) throw new ApiError(r.status, "Could not load the manifest"); return r.text() }),
  testMessage: () => send<{ ok: boolean; error?: string; channel?: string }>("POST", "/api/setup/test-message"),
  overview: () => get<Overview>("/api/overview"),
  graph: (p: { limit: number; kind?: string; source?: string; q?: string }) => get<GraphData>(`/api/graph${qs(p)}`),
  memories: (p: { q?: string; limit: number; offset: number; status?: string }) =>
    get<unknown>(`/api/memories${qs(p)}`).then((d): MemoryPage => { const items = list<Memory>(d, "memories"); return { items, total: (d as { total?: number })?.total ?? items.length } }),
  memoryHistory: (id: number) => get<unknown>(`/api/memories/${id}/history`).then((d) => list<Memory>(d, "history")),
  deleteMemory: (id: number) => send("DELETE", `/api/memories/${id}`),
  uploadMemory: (file: File) => { const f = new FormData(); f.append("file", file); return request<{ name?: string; chunks?: number }>("POST", "/api/memories/upload", f) },
  exportMemoriesUrl: "/api/export/memories",
  coreBlock: (scope: string) => get<CoreBlock>(`/api/core-blocks${qs({ scope })}`),
  bootstrapCoreBlock: (scope: string) => send<{ queued: boolean; results: { scope: string; status: "written" | "unchanged" | "skipped" | "failed"; line?: string; reason?: string }[] }>("POST", "/api/core-blocks/bootstrap", { scope }),
  saveCoreBlock: (scope: string, text: string) => send<{ block: CoreBlock; usage?: string; queuedForReview?: boolean }>("PUT", `/api/core-blocks${qs({ scope })}`, { text }),
  channels: () => get<Channel[]>("/api/channels"),
  persona: () => get<PersonaSettings>("/api/settings/persona"),
  savePersona: (p: Persona) => send<{ persona: Persona }>("PUT", "/api/settings/persona", p),
  approvals: () => get<{ cards: ApprovalCards }>("/api/settings/approvals"),
  saveApprovals: (cards: ApprovalCards) => send<{ cards: ApprovalCards }>("PUT", "/api/settings/approvals", { cards }),
  proactiveFeatures: () => get<ProactiveFeatures>("/api/settings/proactive-features"),
  saveProactiveFeatures: (f: Partial<ProactiveFeatures>) => send<ProactiveFeatures>("PUT", "/api/settings/proactive-features", f),
  costReport: (days: number) => get<CostReport>(`/api/usage/cost${qs({ days })}`),
  commitments: (status: string) => get<unknown>(`/api/manager/commitments${qs({ status, limit: 200 })}`).then((d) => list<Commitment>(d, "commitments")),
  reviews: (status: "pending" | "approved" | "rejected" = "pending") => get<unknown>(`/api/reviews${qs({ status })}`).then((d) => list<Review>(d, "reviews")),
  decideReview: (id: number | string, approve: boolean) => send("POST", `/api/reviews/${id}/decide`, { approve }),
  workspacePrompt: () => get<{ prompt: string }>("/api/settings/workspace-prompt"),
  saveWorkspacePrompt: (prompt: string) => send("PUT", "/api/settings/workspace-prompt", { prompt }),
  proactivity: () => get<Proactivity>("/api/settings/proactivity"),
  saveProactivity: (p: Proactivity) => send<Proactivity>("PUT", "/api/settings/proactivity", p),
  models: () => get<ModelSettings>("/api/settings/models"),
  saveModel: (m: { role?: Role5; profile?: string; provider?: string; model?: string | null; fallback?: string | null }) => send<ModelSettings>("PUT", "/api/settings/models", m),
  limits: () => get<Limits>("/api/settings/limits"),
  saveLimits: (l: Limits) => send<Limits>("PUT", "/api/settings/limits", l),
  usage: (range: UsageRange) => get<Usage>(`/api/usage${qs({ range })}`),
  skills: () => get<unknown>("/api/skills").then((d) => list<Skill>(d, "skills")),
  createSkill: (s: Partial<Skill>) => send<Skill>("POST", "/api/skills", s),
  uploadSkill: (file: File, scope: "org" | "user") => { const f = new FormData(); f.append("file", file); f.append("scope", scope); return request<Skill>("POST", "/api/skills/upload", f) },
  updateSkill: (s: Partial<Skill> & { id: string }) => send<Skill>("PUT", `/api/skills/${s.id}`, { ...s, expectedVersion: s.version }),
  deleteSkill: (id: string) => send("DELETE", `/api/skills/${id}`),
  automations: () => get<unknown>("/api/automations").then((d) => list<Automation>(d, "automations")),
  createAutomation: (a: Partial<Automation>) => send<Automation>("POST", "/api/automations", a),
  patchAutomation: (id: string, a: Partial<Automation>) => send("PATCH", `/api/automations/${id}`, a),
  deleteAutomation: (id: string) => send("DELETE", `/api/automations/${id}`),
  runAutomation: (id: string) => send("POST", `/api/automations/${id}/run`),
  meetings: () => get<unknown>("/api/meetings").then((d) => list<Meeting>(d, "meetings")),
  meeting: (id: string) => get<Meeting>(`/api/meetings/${id}`),
  syncMeetings: () => send<{ found: number; imported: number; failed: number }>("POST", "/api/meetings/sync"),
  sendMeetingTaskDms: (id: string, taskIds?: string[]) => send<{ sent: number; skipped: number; failed: number }>("POST", `/api/meetings/${id}/task-dms`, taskIds ? { taskIds } : {}),
  updateMeetingTaskAssignee: (meetingId: string, taskId: string, assigneeId: string | null) => send<Meeting>("PATCH", `/api/meetings/${meetingId}/tasks/${taskId}`, { assigneeId }),
  meetingAssignees: (id: string, q = "") => get<{ id: string; name: string | null; avatarUrl?: string | null }[]>(`/api/meetings/${id}/assignees${qs({ q })}`),
  presets: () => get<unknown>("/api/mcp/presets").then((d) => list<Preset>(d, "presets")),
  marketplace: (q: string, limit = 60) => get<unknown>(`/api/marketplace${qs({ q, limit })}`).then((d): MarketPage => { const items = list<MarketItem>(d, "items"); return { items, total: (d as { total?: number })?.total ?? items.length } }),
  installMarketplace: (key: string, body: { scope: "org" | "user"; token?: string; label?: string; url?: string }) => send<{ connection?: Connection; authUrl?: string }>("POST", `/api/marketplace/${encodeURIComponent(key)}/install`, body),
  connections: () => get<unknown>("/api/mcp/connections").then((d) => list<Connection>(d, "connections")),
  createConnection: (c: { provider?: string; url?: string; label?: string; scope: "org" | "user" }) => send<Connection>("POST", "/api/mcp/connections", c),
  deleteConnection: (id: string) => send("DELETE", `/api/mcp/connections/${id}`),
  connect: (id: string) => send<{ authUrl: string }>("POST", `/api/mcp/connections/${id}/connect`),
  turns: (f: TurnFilters = {}) => get<unknown>(`/api/turns${qs({ ...f, limit: f.limit ?? 100 })}`).then((d) => list<Turn>(d, "turns")),
  turn: (id: string) => get<Turn>(`/api/turns/${encodeURIComponent(id)}`),
  tokens: () => get<unknown>("/api/tokens").then((d) => list<ApiToken>(d, "tokens")),
  extensionToken: () => send<{ token: string }>("POST", "/api/meetings/extension-token"),
  createToken: (name: string) => send<{ token: string } & Partial<ApiToken>>("POST", "/api/tokens", { name }),
  deleteToken: (id: string) => send("DELETE", `/api/tokens/${id}`),
  syncSources: () => get<unknown>("/api/sync/sources").then((d) => list<SyncSource>(d, "sources")),
  createSyncSource: (provider: SyncSource["provider"]) => send<Partial<SyncSource> & { authUrl?: string }>("POST", "/api/sync/sources", { provider }),
  saveSyncSource: (id: string, selection: SyncSource["selection"]) => send("PUT", `/api/sync/sources/${id}`, { selection }),
  runSync: (id: string) => send("POST", `/api/sync/sources/${id}/run`),
}
