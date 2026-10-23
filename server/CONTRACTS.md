# Module contracts (read before writing code)

Stack: Bun + Hono + Drizzle/Postgres(pgvector) + `ai` SDK v5/6 + pg-boss. TS strict, ESM, no default exports.
Shared (already written, import freely; DO NOT edit): `src/config.ts`, `src/log.ts`, `src/crypto.ts` (`encrypt/decrypt/sha256/id`),
`src/llm.ts` (`getModel(profile?)`), `src/db/index.ts` (`db`, `pool`), `src/db/schema/index.ts` (all core tables),
`test/db.ts` (`resetDb()`, real Postgres via DATABASE_URL — never mock the DB).
If you need extra tables, add them ONLY in your own `src/db/schema/extra-<area>.ts` (areas: memory, slack, turn, platform). Do not run drizzle-kit; the integrator generates migrations. For tests that need your extra tables, the integrator's migration runs before final test pass; in the meantime write tests against core tables or create your extra tables with raw SQL in the test.
Write ONLY inside your own directories. Each module exports plain functions, no globals requiring init order except where stated.
Tests: `bun:test`, co-located in `server/test/<area>/*.test.ts`. Quality bar: production-ready, typed, no TODO stubs, errors handled, secrets encrypted, logs via `log`.
Env needed from outside (Slack/OAuth keys) may be absent in dev: feature must degrade gracefully (clear error/disabled), never crash at import time.

## memory/  (agent MEM)
- `scope.ts`: `type SlackScope={channelId:string;isPrivate:boolean;isIm:boolean;userId:string|null}`; `writeTag(s):string|null` (public→"shared", private channel→`channel_${id}`, DM→`user_${userId}`, DM w/o user→null); `readTags(s):Promise<string[]>` (always "shared"+own tag; DM also adds `channel_X` for every private channel in `channel_members` the user belongs to).
- `embed.ts`: `embed(texts:string[]):Promise<number[][]>` (batching, OpenAI-compatible embeddings API via EMBEDDING_*/MODEL_BASE_URL; throws clear error if unconfigured).
- `search.ts`: `searchMemory({tags:string[];query:string;limit?:number /*40*/}):Promise<MemoryHit[]>`; `MemoryHit={id:number;text:string;scopeTag:string;source:string;sourceRef:string|null;score:number;createdAt:Date}`. tags REQUIRED & non-empty (throw otherwise). Hybrid pgvector cosine + tsvector, reciprocal-rank fusion, threshold 0.3, active only.
- `supersede.ts`: `addFact({tag,text,source,sourceRef?}):Promise<{id:number;superseded:number[]}>` — dedupe near-duplicates, LLM contradiction check against nearest same-tag facts, mark old `status='superseded', superseded_by`, create `memory_edges` to similar facts.
- `writeback.ts`: `captureTurn({scope:SlackScope;transcript:string}):Promise<number>` LLM extracts durable facts (decisions, owners, deadlines) → `addFact` into `writeTag(scope)`; no-op when tag null.
- `ingest.ts`: `ingestDocument({tag:string;name:string;mimeType:string;data:Buffer|string;source:string;sourceRef?:string}):Promise<number>` — text/markdown/pdf(unpdf)/csv/html extraction, chunk (~800 tokens, overlap), embed, insert `kind='chunk'`; replaces prior chunks with same (source,sourceRef).
- `graph.ts`: `getGraph({tags,limit}):Promise<{nodes:{id:number;label:string;scope:string;kind:string}[];edges:{source:number;target:number;weight:number}[]}>`; `listMemories({tags,q?,limit,offset})`; `deleteMemory(id)`.

## slack/  (agent SLACK)
- `client.ts`: `slackClient():Promise<WebClient>` (decrypts workspace bot token; throws if not installed), `botUserId()`.
- `index.ts`: `mountSlack(app:Hono):void` (routes: `GET /slack/install`, `GET /slack/oauth/callback`, `POST /slack/events` (HTTP mode, signature verified), `POST /slack/interactions`) and `startSlack():Promise<void>` (Socket Mode when SLACK_MODE=socket and tokens present; no-op otherwise). Install flow: OAuth v2, store encrypted token in `workspace`, create/adopt `#company-brain`, sync users/channels/members into tables, send onboarding.
- Ingress: dedupe via `events` table, ack fast, filter bot/self, route mention/DM/channel message/team_join/member_joined_channel/channel_left/user_change/reaction_added/app_home_opened. Keeps `channels`, `channel_members`, `users` tables in sync. Attachments: download Slack files (needs bot token), extract text (PDF via unpdf, text, images skipped w/ note) and pass in `TurnInput.files`.
- `triage.ts`: `triage(input):Promise<"ANSWER"|"ACK"|"INVESTIGATE"|"PASS">` (PASS on any failure), `chime.ts` budget (≤3/hour/channel, ≥5min gap via `chime_log`), `proactivity.ts` (setting `proactivity_default` = "all"|"own" + `channels.proactivity` overrides; #company-brain always proactive; DMs/mentions unaffected; only channels where `bot_is_member`).
- `people.ts`: `searchPeople(q):Promise<{id,name,title,email}[]>` from `users`.
- `onboarding.ts`/`journey/`: welcome DM, Home tab view, channel intro, team-invite card; staged "journey" (rungs/beats stored in `journey_state`) that nudges users to connect tools / try features, with guardrails (max 1 nudge/day/user, respects quiet). Exports `onUserJoined(userId)`, `onAppHome(userId)`, `journeyTick()` (called by jobs).
- Reactions: 👀 on receipt, ✅ when done; 👍/👎 reactions on bot messages recorded in `turns`-adjacent table `message_feedback` (extra-slack).
- Calls turn module only through `runTurn` and `handleBlockAction` below.

## turn/  (agent TURN)
- `index.ts`: `type TurnInput={trigger:"mention"|"dm"|"chime"|"automation"|"research";channelId:string;threadTs?:string;ts:string;userId:string|null;text:string;isPrivate:boolean;isIm:boolean;files?:{name:string;mimeType:string;text:string}[];readOnly?:boolean;orgConnectionsOnly?:boolean}`; `runTurn(input):Promise<void>` — serialized per (channel,thread) via `queue.ts` `enqueue(key,fn)` + pg advisory lock; creates `turns` row; builds context (thread history from Slack, `searchMemory` over `readTags`, workspace prompt + skills); streams reply (DM/assistant: chat.update streaming; channel: progress message updated then final); runs tool loop (ai SDK `generateText/streamText` with maxSteps≈20); calls `captureTurn`; records tokens/tool calls.
- `tools.ts`: `type ToolContext={turnId:string;userId:string|null;channelId:string;threadTs?:string;scope:SlackScope;readOnly:boolean;orgConnectionsOnly:boolean}`; `buildTools(ctx):Promise<ToolSet>` = memory_search, memory_remember, web_search/web_extract, people_search, load_skill, request_connection, plus MCP tools from `mcp/` (lazy-loaded by connection; reads prefer user's own connection then org; writes only user's own; if only a teammate has it → lease flow).
- `approval.ts`: write/consequential tools (classified in `mcp/policy.ts`) post Block Kit approve/deny card → `approvals` row (expiry 15 min) → turn pauses (`waiting_approval`) → `handleBlockAction(payload):Promise<boolean>` (true if handled; Slack agent calls it for every `block_actions`) resumes. Must survive restart: on boot `resumePending()` re-expires/continues.
- `lease/`: `leases` flow (teammate who owns connection gets DM card to allow a single request; one-use; expiry 10 min).
- `web/` tools: `tools/web/search.ts` `webSearch(q)` (tavily|brave|firecrawl by SEARCH_PROVIDER, returns [] + "not configured" message when absent), `extract.ts` `extractUrl(url)` (fetch + readability-lite, SSRF-guard: block private IPs, size/time limits).
- `mcp/`: `catalog.ts` `PRESETS` (github, linear, notion, sentry, plain, posthog, granola, gmail-personal-only, google) as `{key,label,url,authType,personalOnly?}`; `client.ts` (MCP SDK client w/ streamable HTTP, token refresh, tool listing cache); `oauth.ts` (OAuth 2.1 dynamic client registration + PKCE via SDK `OAuthClientProvider`); `connections.ts`: `listConnections(userId,role)`, `createConnection({provider|url,label,scope,ownerUserId})`, `startConnect(id):Promise<{authUrl:string}>`, `handleOAuthCallback(code,state)`, `deleteConnection(id,userId)`; `policy.ts` `classifyTool(name,description,annotations):"read"|"write"`; `mountMcp(app)` mounts `GET /mcp-oauth/callback`.

## platform/  (agent PLAT) — behavior engine
- `jobs.ts`: `getBoss()`, `startJobs():Promise<void>` (pg-boss schema `pgboss`; registers all workers/crons below), `stopJobs()`.
- `skills/skills.ts`: `listSkills()`, `createSkill/updateSkill/deleteSkill`, `getWorkspacePrompt():Promise<string>`, `setWorkspacePrompt(s)`, `skillsPromptSection():Promise<string>` (name+description list of enabled skills), `loadSkill(name):Promise<string|null>`. Seed one built-in skill.
- `automations/`: `createAutomation/list/update/delete/runNow(id)`, cron via pg-boss schedules (`cron-parser` validation, minimum interval 1h), reminder one-offs (`runAt`), per-owner cap 20 (admins exempt to manage others). Digest: run `runTurn({trigger:"automation",readOnly:true,orgConnectionsOnly:true,...})` into dest channel after verifying bot can post (`conversations.info` + membership); on ANY ambiguity skip run and set `lastStatus`. Reminder posts the owner's text via `slackClient()`. Private-channel destination: from API only admins, from Slack only channel members. Exports `automationTools(ctx)` (ai tools `schedule_automation`, `list_automations`, `cancel_automation`) for turn/tools.ts to import.
- `research/`: `startResearch({requesterId,channelId,threadTs,question}):Promise<string>`; pipeline plan→run (parallel sub-questions with memory+web+read-only MCP tools via `buildTools`)→synthesis→post result to thread; stored in `research_runs`; exports `researchTools(ctx)` (`start_research`) for turn/tools.ts. Watchlist = research run with cron (reuse automations).

## platform2/  (agent API) — auth, REST, outward MCP, sync
- `auth/`: Slack OpenID sign-in (`GET /auth/slack`, `/auth/slack/callback`, `POST /auth/logout`), session cookie (httpOnly, sameSite=Lax, `sessions` table, 30d), first-ever sign-in → role owner, later users member; `requireAuth(minRole?)` Hono middleware sets `c.var.user={id,name,role,avatarUrl}`; owner can change roles (`PUT /api/users/:id/role`). CSRF: require `x-requested-with: fetch` header on non-GET /api.
- `routes/index.ts`: `mountRoutes(app)`: REST below; static web (`../../web/dist`, SPA fallback) served last.
- `mcp-server/`: `POST /mcp` streamable-HTTP MCP server with tools `search_memory`, `list_recent`; Bearer API token (`api_tokens`, sha256 hash); read scope = "shared" only.
- `sync/`: `providers/{gdrive,onedrive,notion}.ts` each `{authUrl(state),exchange(code),listChanges(source,cursor),fetchDoc(...)}`; `runSync(sourceId)`; OAuth callbacks `/sync/oauth/:provider/callback`; ingest into tag "shared" via `memory/ingest`; jobs registered through `export function registerSyncJobs(boss)`; hourly cron.
### REST (all JSON, cookie auth, prefix /api; role = min role)
GET /api/me; GET /api/setup/status (model/embedding/slack configured booleans) + GET /api/setup/manifest (Slack app manifest YAML w/ PUBLIC_URL) [public until a workspace exists, then admin];
GET /api/overview → {memoryCount,connections,automations,recentTurns[]};
GET /api/graph?limit → memory/graph getGraph (tags per role: "shared" only for members; admins same);
GET /api/memories?q&limit&offset, DELETE /api/memories/:id [admin], POST /api/memories/upload multipart [admin];
GET|PUT /api/settings/workspace-prompt {prompt} [admin write]; GET|PUT /api/settings/proactivity {default:"all"|"own",channels:[{id,name,mode:"default"|"proactive"|"quiet"}]} [admin]; GET|PUT /api/settings/models {profile,provider,model};
GET|POST /api/skills, PUT|DELETE /api/skills/:id [admin write];
GET|POST /api/automations, PATCH|DELETE /api/automations/:id, POST /api/automations/:id/run;
GET /api/mcp/presets, GET|POST /api/mcp/connections, DELETE /api/mcp/connections/:id, POST /api/mcp/connections/:id/connect → {authUrl};
GET /api/turns?limit [admin]; GET|POST /api/tokens, DELETE /api/tokens/:id [admin]; GET|POST /api/sync/sources, POST /api/sync/sources/:id/run [admin].

## web/  (agent WEB)
React 19 + Tailwind 4 + wouter + @tanstack/react-query + d3-force (own graph canvas, NO supermemory packages). Built with `bun build` to `web/dist`. Pages: Sign-in, Setup, Home (overview + recent turns), Graph, Memories (search/upload), Configure/{Integrations,Models,Skills,Automations,Proactivity,WorkspacePrompt,Sync,Tokens}, Turns. Typed API client against the REST list above. Port style/components from `/home/manas/Documents/pulzion/company-brain/web` (shadcn-like radix components) where useful, minus any supermemory imports.

## Integrator (me) owns: `src/app.ts`, `src/index.ts`, migrations, Docker, README, final wiring + e2e.
