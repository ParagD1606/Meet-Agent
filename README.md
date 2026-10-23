# Brain

A Slack teammate that remembers what your team says, answers from it, and acts in your tools. Self-hosted: Bun + Hono + Postgres (pgvector). No third-party memory service, no Cloudflare.

## Run it
```sh
cp .env.example .env     # fill ENCRYPTION_KEY (openssl rand -base64 32), MODEL_API_KEY, Slack keys
docker compose up --build
```
Open `PUBLIC_URL/` → Setup page validates your keys and gives you a Slack app manifest. The first person to sign in with Slack becomes owner.

Local dev without Docker: Postgres with the `vector` extension, then `bun install && DATABASE_URL=... bun run dev`.

## Configuration
See `.env.example`. Provider is inferred from `MODEL_API_KEY` (Anthropic/OpenAI/Google/xAI); set `MODEL_BASE_URL` + `MODEL_NAME` for OpenRouter/Ollama. Embeddings dimension (`EMBEDDING_DIM`) is fixed per database: changing it needs a re-embed.
Slack: `SLACK_MODE=socket` (needs `SLACK_APP_TOKEN`) or `http` (needs a public `PUBLIC_URL` and `SLACK_SIGNING_SECRET`).

## Layout
`server/src`: `slack/` ingress, triage, chime-in, onboarding · `turn/` agent loop, approvals, leasing · `mcp/` tool connectors · `memory/` scoped hybrid search, fact writeback, supersede · `automations/`, `research/`, `skills/`, `jobs.ts` (pg-boss) · `routes/`, `auth/`, `mcp-server/`, `sync/` · `web/` React app. Module contracts: `CONTRACTS.md`.

## Operations notes
- Memory scopes: public → `shared`; private channel → `channel_{id}`; DM → `user_{id}` (DMs also read private channels the user belongs to). Every search requires an explicit scope list.
- Cron automations are evaluated in UTC, minimum interval 1h.
- Back up Postgres (`pgdata`); bot/OAuth tokens are AES-256-GCM encrypted with `ENCRYPTION_KEY` — losing the key invalidates them.
- Tests: `bun run test` (needs `DATABASE_URL` pointing at a disposable pgvector database; tests truncate tables).
