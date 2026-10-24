# Setup

## 1. Run it
```sh
cp .env.example .env     # ENCRYPTION_KEY (openssl rand -base64 32), SETUP_TOKEN, MODEL_API_KEY, Slack keys, PUBLIC_URL (https)
docker compose up --build
```
Open `PUBLIC_URL`. The Setup page checks model, embeddings and Slack and offers a ready manifest.

For Google ADC with Vertex AI, set `MODEL_PROVIDER=vertex`, `GOOGLE_VERTEX_PROJECT`, and `GOOGLE_APPLICATION_CREDENTIALS` in `.env`. Keep the ADC JSON out of Git. Start the app with the read-only credential mount: `docker compose -f docker-compose.yml -f docker-compose.vertex.yml up --build`.

### Deploy to the Vortexa Learnloop VM

With `gcloud` authenticated, `.env` configured, and `application_default_credentials.json` in the repository root, run `./scripts/deploy-gce.sh`. It uploads the current working tree, builds the app on the VM, and routes `https://slack.derpx06.live` through Caddy to the app on localhost port 3001. It keeps the VM's existing site on port 3000 and persists Brain's database in `pgdata/`.

In Namecheap, add a CNAME record with host `slack` and target `derpx06.live`. The VM already allows HTTPS. After DNS resolves, Caddy obtains the TLS certificate automatically. Before first Slack sign-in, add `https://slack.derpx06.live/slack/oauth/callback` and `https://slack.derpx06.live/auth/slack/callback` to the Slack app's OAuth redirect URLs, then install the app at `https://slack.derpx06.live/slack/install`. Use the `SETUP_TOKEN` from `.env` for the first owner sign-in.

Vertex runs on the ADC JSON alone: the deploy script drops `MODEL_API_KEY`, `MODEL_BASE_URL`, `MODEL_NAME` and `EMBEDDING_API_KEY` from the server's `.env`, and boot needs only `MODEL_PROVIDER=vertex`, `GOOGLE_VERTEX_PROJECT` and `GOOGLE_APPLICATION_CREDENTIALS`. After deploying, the script runs `server/scripts/vertex-probe.ts` inside the container (chat, a multi-step tool call and embeddings). Run it by hand with `docker compose --project-name brain -f docker-compose.yml -f docker-compose.vertex.yml exec app bun server/scripts/vertex-probe.ts [model]`. If a model is not served to your project the probe says "publisher model not found"; pick another under Configure > Models.

The image runs in production mode: `PUBLIC_URL` must be `https://`, and boot fails with a list of missing settings otherwise.

### GitHub App (shared GitHub sync)

GitHub Sync uses one workspace GitHub App installation, rather than personal access tokens. Create a GitHub App, generate a private key, and keep that key only in the server `.env`:

```sh
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=company-brain
# base64 is recommended for an env file; PEM text with literal \n escapes also works
GITHUB_APP_PRIVATE_KEY="$(base64 < company-brain.private-key.pem | tr -d '\n')"
GITHUB_APP_CLIENT_ID=Iv1_your_github_app_client_id
GITHUB_APP_CLIENT_SECRET=your_github_app_client_secret
```

In the GitHub App settings, set **Setup URL** to `https://slack.derpx06.live/sync/oauth/github/callback` (replace the host if your `PUBLIC_URL` differs). Give the app **Contents: read**, **Issues: read and write**, and **Pull requests: read** permissions, then install it for the organization or repositories you want. Do not enable “Request user authorization during installation”; that uses a different callback flow.

For the personal GitHub integration, add `https://slack.derpx06.live/github/oauth/callback` as a **Redirect URI** in the same GitHub App, enable expiring user authorization tokens, and keep the Client ID and Client Secret only in the server environment. Each member then authorizes their own GitHub account from **Integrations**; their token can read only repositories that both they and the App installation can access.

After the next deploy, an admin selects **GitHub App** under **Configure → Sync → Connect a source** and installs the app. The app receives a short-lived installation token server-side; no GitHub token is entered in the browser. Choose repositories (or `*`) in **Selection**. Imported GitHub information is shared workspace memory, so every member can use it.

### Automatic deploys (GitHub Actions)

`.github/workflows/ci-cd.yml` runs type-checks, the web build and the full test suite (against a pgvector Postgres) on pull requests and manual runs. A push to `main` deploys immediately, without waiting for the tests, through `scripts/ci-deploy.sh` (to gate deploys on the tests again, see the comment at the top of the workflow): it uploads only the code, rebuilds the containers on the VM, waits for `/healthz`, runs the live Vertex probe, and rolls back to the previous image if any step fails. `.env` and `application_default_credentials.json` are never uploaded; they stay on the VM from the first `./scripts/deploy-gce.sh`, so GitHub needs only SSH access.

One-time setup:
1. `ssh-keygen -t ed25519 -N "" -C github-actions-deploy -f ./deploy_key` and authorize `deploy_key.pub` for `manas` on the VM (`~/.ssh/authorized_keys`; with OS Login enabled use `gcloud compute os-login ssh-keys add --key-file=deploy_key.pub` instead).
2. Repo > Settings > Secrets and variables > Actions, add `DEPLOY_HOST` (VM IP or hostname), `DEPLOY_USER` (`manas`), `DEPLOY_SSH_KEY` (contents of `deploy_key`) and `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan -t ed25519 <host>`). Delete the local `deploy_key` files afterwards.
3. Optional: Settings > Environments > `production` > required reviewers, to approve each deploy.

Run `./scripts/ci-deploy.sh` by hand with the same variables to test the connection. Use `./scripts/deploy-gce.sh` only when `.env` or the credentials file changes.

Key env vars (full list in `.env.example`): `DATABASE_URL`, `PUBLIC_URL`, `ENCRYPTION_KEY` (encrypts every stored token; losing it invalidates them), `SETUP_TOKEN` (claims ownership, see step 3), either `MODEL_API_KEY` or Vertex ADC settings (`MODEL_PROVIDER=vertex`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_VERTEX_PROJECT`), `EMBEDDING_*` (dimension is fixed per database), `SLACK_MODE` (`socket` or `http`), `SLACK_TEAM_ID` (optional workspace pin), `SEARCH_PROVIDER` + `SEARCH_API_KEY` (optional web search).

## 2. Create or update the Slack app

For the live deployment, use the existing **Company Brain** app in the Slack API dashboard: **Your Apps → Company Brain → App Manifest → Edit**. Replace the manifest with `docs/slack-app-manifest.yaml` and save it. If creating the app for the first time, choose **Create New App → From a manifest** and paste the same file.

Under **OAuth & Permissions → Redirect URLs**, make sure both exact URLs are listed:

- `https://slack.derpx06.live/slack/oauth/callback`
- `https://slack.derpx06.live/auth/slack/callback`

This deployment uses Socket Mode. Keep the Event Subscriptions and Interactivity **Request URL** fields empty; the manifest enables the events and interactive actions through Socket Mode. In **Basic Information**, check the existing Client ID and Client Secret match `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in the server environment. In **Socket Mode**, keep an app-level token with the `connections:write` scope configured as `SLACK_APP_TOKEN`. Do not paste tokens or secrets into the manifest.

If Slack asks you to reinstall the app after saving changes, use **Install App → Reinstall to Workspace**. Scopes and events are maintained in `server/src/slack/manifest.ts`; `server/src/routes/manifest.ts` generates the runtime manifest, and `server/test/mcp/manifest-yaml.test.ts` checks that the checked-in scopes and events stay in sync.

- **Socket mode** (default): create an app-level token with `connections:write` and set `SLACK_APP_TOKEN`; no public request URL is needed.
- **HTTP mode**: set `SLACK_SIGNING_SECRET`; `PUBLIC_URL` must be reachable by Slack.

Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`, then open `PUBLIC_URL/slack/install` to install. The bot creates or adopts `#company-brain`, syncs users and channels, and sends a welcome message.

## 3. First sign-in
The first person to sign in with Slack becomes **owner**, but only after claiming the server with the setup token: open `PUBLIC_URL/auth/slack?setup_token=<SETUP_TOKEN>` and sign in. Set `SETUP_TOKEN` before first boot; in production, retrieve it from the private `.env` file because the app does not print it to logs. Everyone after is a **member**. Owners promote members to admin under Configure.

## 4. Check
Setup > checks shows database, queue, model, embeddings and Slack status. Send the bot a DM; the Turns page shows the run.

## 5. Tuning and environment

All of these are optional. Defaults suit most teams. (Sources: `server/src/memory/*.ts`, `server/src/manager/chase.ts`, `server/src/llm.ts`, `server/src/cost/index.ts`, `server/src/config.ts`, `server/src/routes/index.ts`.)

| Variable | Default | Effect | Use it when |
|---|---|---|---|
| `MEMORY_RERANK` | off (`1`/`true`/`on` enables) | LLM re-ranks recalled facts each turn | Leave off. Measured about 11x slower with no gain. |
| `MEMORY_FRESHNESS` | `normal` | `normal`: learn from a thread after 3 turns or 5 min idle, observe poll every 30 min. `fast`: every turn, 15 s idle, poll every 2 min (many more model calls). A value saved in the console (`PUT /api/settings/memory-freshness`) wins over the env | `fast` for demos only |
| `MEMORY_AMBIENT_MAX_PER_HOUR` | `60` | Cap on ambient extraction model calls per hour (per process); over it, messages stay buffered | Lower it to cap cost, raise it for faster learning in a busy workspace |
| `MEMORY_BACKFILL_CALLS_PER_RUN` | `20` | Slack API calls per history-backfill run (Learn-now uses 40). Resumable: the next run continues | Slow initial catch-up on a large workspace. Look-back is the `memory_backfill_days` setting (default 30, max 90). There is no daily-call cap variable. |
| `MEMORY_ENTITY_EXPANSION` | on (`0` disables) | Recall also pulls facts linked to entities named in the question | Set `0` only if recall drags in unrelated facts |
| `QUIET_HOURS` | off (`1` enables) | Holds chases, follow-ups and routed questions (`ask_teammate`) to the working window. Task assignment notices are never held | You want no nudges outside work hours |
| Workspace hours | UTC, 09:00-18:00, Mon-Fri | Timezone and window for quiet hours, chases and standups. Set under Pixel page > Workspace hours (`GET/PUT /api/settings/workspace-hours`) | Your team is not on UTC |
| `ASK_TIMEZONE` | `UTC` | Legacy: timezone for routed-question delivery windows, only when `QUIET_HOURS=1`. Still read in `server/src/slack/teammate.ts` but being removed | Do not rely on it; use Workspace hours |
| `WEB_DIST` | `web/dist` beside `server/` | Folder the server serves the console from | Custom image layout only |
| `MONTHLY_SPEND_ALERT_USD` | unset | One Slack message a month (UTC) to the home channel once model spend crosses it. Alert only: nothing is paused | Cost visibility |
| `MODEL_FALLBACK` | unset | `provider:model` retried once on a timeout, 429 or 5xx. The Models page can override it | Provider reliability |
| `FALLBACK_MODEL_API_KEY`, `FALLBACK_MODEL_BASE_URL` | unset | Key (when no `<PROVIDER>_API_KEY` fits the fallback) and OpenAI-compatible base URL for the fallback | Fallback on another provider |
| `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM` | key falls back to `MODEL_API_KEY`; `text-embedding-3-small`; `1536` | Embedding host, model and vector size (max 2000). `EMBEDDING_BASE_URL` (for example Ollama) never receives the chat key. Vertex uses the ADC JSON | Local or non-OpenAI embeddings. Fixed once memories exist |

### Single replica
Run one app container. These live in process memory, so a second replica would not share them: ambient extraction budget, run-now rate limit (6 starts per job per minute) and single-flight (one run per job), the huddle-sync single flight, and the freshness mode (re-read from the database only at boot). Scheduled jobs themselves are safe (pg-boss).

### Rollback
- Migrations are forward-only. Rolling back the image does not undo schema changes; to go back past a migration, restore a database backup taken before the deploy.
- The CI deploy script rolls back to the previous image itself when the health check or probe fails (see [operations](operations.md)).
- Changing `EMBEDDING_DIM` is refused while memories exist. With no memories it resizes the column; it also truncates the `entities` tables and the embedding cache (entities are rebuilt from facts later).
