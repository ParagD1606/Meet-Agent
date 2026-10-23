# Brain

A Slack teammate that remembers what your team says, answers from it, and acts in your tools. Self-hosted: Bun + Hono + Postgres (pgvector). No third-party memory service. Guide for users and admins: [docs/guide](docs/guide/README.md).

## Run it (Docker)
```sh
cp .env.example .env     # set ENCRYPTION_KEY, SETUP_TOKEN, MODEL_API_KEY, Slack keys, PUBLIC_URL
docker compose up --build
```
The image runs with `NODE_ENV=production`, so boot refuses to start unless `ENCRYPTION_KEY` is 32 bytes (base64), `PUBLIC_URL` is `https://`, Slack has `SLACK_APP_TOKEN` (socket) or `SLACK_SIGNING_SECRET` (http), and embeddings have a key or `EMBEDDING_BASE_URL`. For a local trial, serve it over https (for example through a tunnel) and set `PUBLIC_URL` to that address.

Then open `PUBLIC_URL/` to see the Setup page. Install the Slack app at `PUBLIC_URL/slack/install`.

Local dev without Docker: Postgres with the `vector` extension, then `bun install && DATABASE_URL=... bun run dev` (leave `NODE_ENV` unset for relaxed checks).

## Configuration
Every variable is documented in [`.env.example`](.env.example) (source: `server/src/config.ts`). Points that are easy to get wrong:
- **Model**: provider is inferred from `MODEL_API_KEY` (`sk-ant-` Anthropic, `AIza` Google, `xai-` xAI, otherwise OpenAI). `MODEL_BASE_URL` + `MODEL_NAME` switch to any OpenAI-compatible endpoint. Per-role models (`main`, `triage`, `extract`, `summarize`, `research`), profile and override are set by an admin under Configure > Models and stored in the database. `MODEL_FALLBACK` (`provider:model`) is the env default; a retriable failure (timeout, 429, 5xx) is retried once on it.
- **Embeddings**: `EMBEDDING_DIM` (max 2000) is fixed per database. Changing it is refused while memories exist; re-embed to switch models. `EMBEDDING_BASE_URL` points at a dedicated OpenAI-compatible host (for example Ollama) and never receives the chat key.
- **Slack**: `SLACK_MODE=socket` needs `SLACK_APP_TOKEN`; `http` needs `SLACK_SIGNING_SECRET` and a public `PUBLIC_URL`. `SLACK_TEAM_ID` pins the deployment to one workspace. `SLACK_API_URL` overrides the Web API base for bot calls only.
- **Database pools**: `DB_POOL_MAX` (20) serves queries; `DB_LOCK_POOL_MAX` (25) holds one advisory lock per running turn so locks cannot starve queries. Size Postgres `max_connections` for both plus the job queue.
- **Search**: `SEARCH_PROVIDER` (`tavily`, `brave`, `firecrawl`) with `SEARCH_API_KEY`. Unset means web search is off.
- **Integrations**: `GOOGLE_*`, `MS_*`, `NOTION_*` client pairs enable sync sources and connectors.

## First owner
The first person to sign in becomes owner, but only after the setup token is presented, so whoever reaches the server first cannot take it. Set `SETUP_TOKEN`, then open `PUBLIC_URL/auth/slack?setup_token=<SETUP_TOKEN>` and sign in with Slack. When `SLACK_TEAM_ID` is set, only that workspace can claim it. Once an owner exists the token is no longer needed.

If `SETUP_TOKEN` is unset, a token is generated and printed in the boot log.

## Health
- `GET /healthz` returns `{"ok":true}` (liveness). The Docker `HEALTHCHECK` polls it.
- `GET /readyz` checks the database, the job queue and the model, and returns 503 until all three are up.

## Token efficiency and limits
- A depth router gives greetings no recall or tools, memory questions recall only, and only hard asks the full toolset and the 30-step cap.
- The prompt prefix (instructions, workspace prompt, skills index, core blocks) is byte-stable so provider caching hits. Recall is packed under about 2,500 tokens. Tool results over 3,000 characters are stored with a 1,500-character preview.
- Admin-editable limits (Configure > Usage and limits, stored in the database, not env): per-turn 400k tokens, per-user 2M/day, org 20M/day, 8 concurrent turns, steps 2/4/12/30 by depth. `0` disables a numeric cap.
- Rate limits: about 5 turns/minute per person (burst 10), 25 per channel burst, MCP 1 call/second per person. Unprompted replies are capped at 3 per channel per hour, 5 minutes apart.

Details: [docs/guide/tokens-and-limits.md](docs/guide/tokens-and-limits.md).

## Memory tiers
- **Core blocks**: three always-in-context notes (company 1,500 chars; channel and user 1,000 each), edited with `core_memory`.
- **Facts and recall**: facts and document chunks are searched by hybrid ranking, deduplicated, and packed under the recall budget. Every search takes an explicit scope list.
- **Episodes**: a finished or long-idle thread is summarized into 3-6 sentences in its scope.
- **Review queue**: admins approve or reject low-confidence facts, supersessions, shared writes and core-block edits.

Scopes: public channels write `shared`, private channels `channel_<id>`, DMs `user_<id>`. See [docs/guide/memory.md](docs/guide/memory.md).

## Layout
`server/src`: `slack/` ingress, triage, chime-in, onboarding · `turn/` agent loop, approvals, leasing · `mcp/` tool connectors · `memory/` search, writeback, supersede, episodes, review · `automations/`, `research/`, `skills/`, `jobs.ts` (pg-boss) · `routes/`, `auth/`, `mcp-server/`, `sync/` · `limits/` · `web/` React app. Module contracts: [`server/CONTRACTS.md`](server/CONTRACTS.md).

## Operations
- Back up Postgres (`pgdata` with Compose). Losing `ENCRYPTION_KEY` makes stored OAuth and bot tokens unreadable.
- Cron automations run in UTC with a 1-hour minimum interval.
- Migrations run at boot from `server/drizzle`, serialized by an advisory lock.
- Tests: `bun run test` needs `DATABASE_URL` pointing at a disposable pgvector database (tests truncate tables).
