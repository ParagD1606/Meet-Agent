# Setup

## 1. Run it
```sh
cp .env.example .env     # ENCRYPTION_KEY (openssl rand -base64 32), SETUP_TOKEN, MODEL_API_KEY, Slack keys, PUBLIC_URL (https)
docker compose up --build
```
Open `PUBLIC_URL`. The Setup page checks model, embeddings and Slack and offers a ready manifest.

The image runs in production mode: `PUBLIC_URL` must be `https://`, and boot fails with a list of missing settings otherwise.

Key env vars (full list in `.env.example`): `DATABASE_URL`, `PUBLIC_URL`, `ENCRYPTION_KEY` (encrypts every stored token; losing it invalidates them), `SETUP_TOKEN` (claims ownership, see step 3), `MODEL_API_KEY` (provider inferred; use `MODEL_BASE_URL` + `MODEL_NAME` for OpenRouter/Ollama), `EMBEDDING_*` (dimension is fixed per database), `SLACK_MODE` (`socket` or `http`), `SLACK_TEAM_ID` (optional workspace pin), `SEARCH_PROVIDER` + `SEARCH_API_KEY` (optional web search).

## 2. Create the Slack app
Slack > Create New App > From a manifest, paste `docs/slack-app-manifest.yaml`. Its OAuth callbacks use `https://slack.derpx06.live`; configure that host to forward HTTPS traffic to the app at `localhost:3000` (for example, through your HTTPS tunnel or reverse proxy), or replace the host with your own. For HTTP mode, use `GET /api/setup/manifest` on your running server: it fills the request URLs for you. Scopes and events live in `server/src/slack/manifest.ts`; the YAML is emitted from them by `server/src/routes/manifest.ts`, and `test/mcp/manifest-yaml.test.ts` fails if the checked-in file drifts.

- **Socket mode** (default): create an app-level token with `connections:write` and set `SLACK_APP_TOKEN`; no public request URL is needed.
- **HTTP mode**: set `SLACK_SIGNING_SECRET`; `PUBLIC_URL` must be reachable by Slack.

Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, then open `PUBLIC_URL/slack/install` to install. The bot creates or adopts `#company-brain`, syncs users and channels, and sends a welcome message.

## 3. First sign-in
The first person to sign in with Slack becomes **owner**, but only after claiming the server with the setup token: open `PUBLIC_URL/auth/slack?setup_token=<SETUP_TOKEN>` and sign in. Without the token the server refuses the first sign-in, so set `SETUP_TOKEN` before first boot. Everyone after is a **member**. Owners promote members to admin under Configure.

## 4. Check
Setup > checks shows database, queue, model, embeddings and Slack status. Send the bot a DM; the Turns page shows the run.
