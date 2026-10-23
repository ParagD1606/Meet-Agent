# Setup

## 1. Run it
```sh
cp .env.example .env     # ENCRYPTION_KEY (openssl rand -base64 32), MODEL_API_KEY, Slack keys, PUBLIC_URL
docker compose up --build
```
Open `PUBLIC_URL`. The Setup page checks model, embeddings and Slack and offers a ready manifest.

Key env vars (full list in `.env.example`): `DATABASE_URL`, `PUBLIC_URL`, `ENCRYPTION_KEY` (encrypts every stored token; losing it invalidates them), `MODEL_API_KEY` (provider inferred; use `MODEL_BASE_URL` + `MODEL_NAME` for OpenRouter/Ollama), `EMBEDDING_*` (dimension is fixed per database), `SLACK_MODE` (`socket` or `http`), `SEARCH_PROVIDER` + `SEARCH_API_KEY` (optional web search).

## 2. Create the Slack app
Slack > Create New App > From a manifest, paste `docs/slack-app-manifest.yaml` (replace `YOUR-DOMAIN`). For HTTP mode, use `GET /api/setup/manifest` on your running server: it fills the request URLs for you. The manifest is generated from `server/src/slack/manifest.ts`, which also drives the OAuth install, so scopes and events never drift.

- **Socket mode** (default): create an app-level token with `connections:write` and set `SLACK_APP_TOKEN`; no public request URL is needed.
- **HTTP mode**: set `SLACK_SIGNING_SECRET`; `PUBLIC_URL` must be reachable by Slack.

Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, then open `PUBLIC_URL/slack/install` to install. The bot creates or adopts `#company-brain`, syncs users and channels, and sends a welcome message.

## 3. First sign-in
The first person to sign in with Slack becomes **owner**; everyone after is a **member**. Owners promote members to admin under Configure.

## 4. Check
Setup > checks shows database, queue, model, embeddings and Slack status. Send the bot a DM; the Turns page shows the run.
